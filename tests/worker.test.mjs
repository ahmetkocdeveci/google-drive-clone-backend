import test from 'node:test'
import assert from 'node:assert/strict'
import supertest from 'supertest'
import {createHarness} from './helpers.mjs'
import {createApp} from '../src/app.mjs'

async function upload(h,owner,workspaceId,bytes,parentId=null) {
  const initiated=await owner.request('post',`/workspaces/${workspaceId}/files/uploads`,{name:'kalıcı.txt',parentId,size:bytes.length,mimeType:'text/plain'}).expect(201)
  const address=new URL(initiated.body.uploadUrl)
  await h.client().put(address.pathname+address.search).set('Origin',h.config.frontendOrigin).set(initiated.body.headers).send(bytes).expect(204)
  const completed=await owner.request('post',`/workspaces/${workspaceId}/files/uploads/${initiated.body.uploadId}/complete`).expect(200)
  return {node:completed.body,uploadId:initiated.body.uploadId}
}

test('expiry cleanup preserves finalized bytes; subtree cleanup releases quota exactly once',async t=>{
  const h=await createHarness('worker');t.after(()=>h.close())
  const owner=await h.user(), ws=(await owner.request('post','/workspaces',{name:'Kalıcı dosyalar'}).expect(201)).body
  const folder=(await owner.request('post',`/workspaces/${ws.id}/folders`,{name:'Ana klasör',parentId:null}).expect(201)).body
  const bytes=Buffer.from('MongoDB üzerinde kalıcı dosya')
  const completed=await upload(h,owner,ws.id,bytes,folder.id)
  const expiring=(await owner.request('post',`/workspaces/${ws.id}/files/uploads`,{name:'yarım.txt',parentId:folder.id,size:11,mimeType:'text/plain'}).expect(201)).body
  const past=new Date(Date.now()-1000)
  await h.models.Upload.updateOne({_id:completed.uploadId,workspaceId:ws.id},{$set:{expiresAt:past}})
  await h.models.Upload.updateOne({_id:expiring.uploadId,workspaceId:ws.id},{$set:{expiresAt:past}})
  await h.models.Job.updateMany({workspaceId:ws.id,type:'upload-expiry'},{$set:{availableAt:past}})
  await h.worker.drain(100)
  const content=await owner.request('get',`/workspaces/${ws.id}/files/${completed.node.id}/content`).expect(200)
  assert.equal(content.text,bytes.toString())
  let stored=await h.models.Workspace.findById(ws.id).lean()
  assert.equal(stored.storageUsed,bytes.length);assert.equal(stored.storageReserved,0)
  assert.equal((await h.models.Upload.findOne({_id:expiring.uploadId,workspaceId:ws.id})).state,'expired')
  await owner.request('post',`/workspaces/${ws.id}/files/uploads/${expiring.uploadId}/complete`).expect(409)
  await owner.request('delete',`/workspaces/${ws.id}/nodes/${folder.id}`).expect(204)
  await owner.request('get',`/workspaces/${ws.id}/files/${completed.node.id}/content`).expect(404)
  await h.worker.drain(100)
  await h.worker.drain(100)
  stored=await h.models.Workspace.findById(ws.id).lean()
  assert.equal(stored.storageUsed,0);assert.equal(stored.storageReserved,0)
  assert.equal(await h.models.DriveNode.countDocuments({workspaceId:ws.id,status:{$ne:'deleted'}}),0)
  assert.equal(await h.models.Job.countDocuments({workspaceId:ws.id,status:'failed'}),0)
})

test('workspace cleanup is scoped and leaves another workspace data intact',async t=>{
  const h=await createHarness('deletews');t.after(()=>h.close())
  const owner=await h.user()
  const a=(await owner.request('post','/workspaces',{name:'Silinecek alan'}).expect(201)).body
  const b=(await owner.request('post','/workspaces',{name:'Korunacak alan'}).expect(201)).body
  const gone=await upload(h,owner,a.id,Buffer.from('giden'))
  const kept=await upload(h,owner,b.id,Buffer.from('kalan'))
  await owner.request('delete',`/workspaces/${a.id}`).expect(204)
  await owner.request('get',`/workspaces/${a.id}/files/${gone.node.id}/content`).expect(404)
  await h.worker.drain(100)
  assert.equal((await h.models.Workspace.findById(a.id)).status,'deleted')
  assert.equal(await h.models.Membership.countDocuments({workspaceId:a.id,status:'active'}),0)
  const content=await owner.request('get',`/workspaces/${b.id}/files/${kept.node.id}/content`).expect(200)
  assert.equal(content.text,'kalan')
})

test('outbox encrypts tokens, drops stale invites and expired verification before SMTP',async t=>{
  const h=await createHarness('outbox');t.after(()=>h.close())
  const owner=await h.user()
  const ws=(await owner.request('post','/workspaces',{name:'Davet testi'}).expect(201)).body
  const first=(await owner.request('post',`/workspaces/${ws.id}/invitations`,{email:'team@example.com',role:'viewer'}).expect(201)).body
  const queued=await h.models.Outbox.findOne({workspaceId:ws.id,invitationId:first.id,status:'pending'}).lean()
  assert.ok(queued.ciphertext);assert.equal(queued.ciphertext.includes('team@example.com'),false);assert.equal(queued.ciphertext.includes('#token='),false)
  await owner.request('post',`/workspaces/${ws.id}/invitations`,{email:'team@example.com',role:'editor'}).expect(201)
  await h.flushMail()
  assert.equal(h.mail.filter(item=>item.to==='team@example.com').length,1)
  assert.equal((await h.models.Outbox.findById(queued._id)).status,'cancelled')
  const pending=await h.user({email:'expired-verification@example.com',verified:false})
  await h.models.Verification.updateMany({userId:pending.user.id},{$set:{expiresAt:new Date(Date.now()-1000)}})
  await h.flushMail()
  assert.equal(h.mail.filter(item=>item.to===pending.user.email).length,0)
  assert.equal((await h.models.Outbox.findOne({userId:pending.user.id})).status,'cancelled')
})

test('MongoDB-backed rate limit returns429 and never trusts forged proxy IP headers',async t=>{
  const h=await createHarness('limits');t.after(()=>h.close())
  const app=createApp({models:h.models,config:h.config,storage:h.storage,mailer:h.mailer})
  const agent=supertest.agent(app)
  for(let i=0;i<30;i++) await agent.get('/api/v1/auth/csrf-token').set('X-Forwarded-For',`198.51.100.${i}`).expect(200)
  const limited=await agent.get('/api/v1/auth/csrf-token').set('X-Forwarded-For','203.0.113.1').expect(429)
  assert.ok(Number(limited.headers['retry-after'])>0)
  assert.equal(limited.body.error.code,'RATE_LIMITED')
})
