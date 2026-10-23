import test from 'node:test'
import assert from 'node:assert/strict'
import {startBackgroundWork,settleWithin} from '../src/background.mjs'
import {createHarness} from './helpers.mjs'

test('slow SMTP does not stall cleanup ticks; stop prevents subsequent work',async t=>{
  t.mock.timers.enable({apis:['setInterval']})
  let release,mailCalls=0,jobCalls=0
  const slowMail=new Promise(resolve=>{release=resolve})
  const background=startBackgroundWork({worker:{async drainJobs(){jobCalls++}},mailer:{async drain(){mailCalls++;await slowMail}},intervalMs:2000})
  t.after(async()=>{release();await background.stop()})
  const flush=()=>new Promise(resolve=>setImmediate(resolve))
  await flush()
  assert.equal(mailCalls,1);assert.equal(jobCalls,1)
  t.mock.timers.tick(2000);await flush()
  t.mock.timers.tick(2000);await flush()
  assert.equal(mailCalls,1);assert.equal(jobCalls,3)
  release();await background.stop()
  t.mock.timers.tick(10000);await flush()
  assert.equal(jobCalls,3);assert.equal(mailCalls,1)
})

test('shutdown wait is bounded when an external provider never returns',async()=>{
  const result=await settleWithin(new Promise(()=>{}),5)
  assert.equal(result,undefined)
})

test('audit records correlate to server request IDs and scoped outbox entries require tenant metadata',async t=>{
  const h=await createHarness('audit');t.after(()=>h.close())
  const owner=await h.user()
  const response=await owner.request('post','/workspaces',{name:'İzlenebilir alan'}).set('X-Request-Id','client-controlled-id').expect(201)
  const event=await h.models.AuditEvent.findOne({workspaceId:response.body.id,action:'workspace.created'}).lean()
  assert.equal(event.requestId,response.headers['x-request-id'])
  assert.notEqual(event.requestId,'client-controlled-id')
  assert.equal(event.actorId,owner.user.id)
  await assert.rejects(new h.models.Outbox({scope:'workspace',ciphertext:'encrypted-placeholder'}).validate(),error=>!!error.errors.workspaceId && !!error.errors.invitationId)
  await assert.rejects(new h.models.Outbox({scope:'identity',ciphertext:'encrypted-placeholder'}).validate(),error=>!!error.errors.userId && !!error.errors.verificationId)
})
