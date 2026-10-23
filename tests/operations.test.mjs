import test from 'node:test'
import assert from 'node:assert/strict'
import {createHarness} from './helpers.mjs'

test('operations endpoints require their own secret and expose aggregate data only',async()=>{
  const h=await createHarness('operations')
  try{
    const user=await h.user()
    await user.agent.get('/ops/status').expect(401)
    await user.agent.get('/metrics').set('Authorization','Bearer wrong').expect(401)
    const state=await user.agent.get('/ops/status').set('Authorization',`Bearer ${h.config.operationsToken}`).expect(200)
    assert.equal(state.body.queues.jobs.failed.count,0)
    assert.ok(!JSON.stringify(state.body).includes(user.user.email))
    const metrics=await user.agent.get('/metrics').set('Authorization',`Bearer ${h.config.operationsToken}`).expect(200)
    assert.match(metrics.text,/drive_http_requests_total/)
    assert.ok(!metrics.text.includes(user.user.id))
    const original=h.storage.checkHealth
    h.storage.checkHealth=async()=>{throw new Error('private provider error')}
    const unavailable=await user.agent.get('/health/ready').expect(503)
    assert.deepEqual(unavailable.body,{status:'unavailable'})
    h.storage.checkHealth=original
  }finally{await h.close()}
})

test('readiness uses one storage probe for concurrent checks and caches the healthy result',async()=>{
  const h=await createHarness('readycache')
  try{
    await h.storage.checkHealth()
    let release,started,calls=0
    const gate=new Promise(resolve=>{release=resolve}),entered=new Promise(resolve=>{started=resolve})
    h.storage.checkHealth=async()=>{calls++;started();await gate}
    const requests=Array.from({length:5},()=>h.client().get('/health/ready').expect(200).then(response=>response))
    await entered;release()
    await Promise.all(requests)
    await h.client().get('/health/ready').expect(200)
    assert.equal(calls,1)
  }finally{await h.close()}
})
