import test from 'node:test'
import assert from 'node:assert/strict'
import supertest from 'supertest'
import { createConfig } from '../src/config.mjs'
import { createApp } from '../src/app.mjs'
import { createHarness } from './helpers.mjs'

function env(overrides={}) {
  return {NODE_ENV:'test',MONGODB_URI:'mongodb://127.0.0.1:27018/unused',OUTBOX_ENCRYPTION_KEY:'1'.repeat(64),UPLOAD_SIGNING_KEY:'2'.repeat(64),...overrides}
}

test('configuration accepts HTTP(S) origins, valid SMTP ports and complete Google credential pairs',()=>{
  const config=createConfig(env({FRONTEND_ORIGIN:'https://app.example.com',API_ORIGIN:'https://api.example.com',SMTP_PORT:'587',GOOGLE_CLIENT_ID:'test-id',GOOGLE_CLIENT_SECRET:'test-secret'}))
  assert.equal(config.smtp.port,587)
  assert.equal(config.googleClientId,'test-id')
  assert.equal(config.googleClientSecret,'test-secret')
  assert.equal(createConfig(env()).googleClientId,'')
})

test('configuration rejects non-HTTP origins, invalid SMTP ports and partially configured OAuth',()=>{
  for(const field of ['FRONTEND_ORIGIN','API_ORIGIN']) {
    for(const value of ['ftp://example.com','ws://example.com','file:///tmp/example']) assert.throws(()=>createConfig(env({[field]:value})),/Origins must use HTTP or HTTPS/)
  }
  for(const value of ['0','-1','65536','1.5','smtp','Infinity','NaN']) assert.throws(()=>createConfig(env({SMTP_PORT:value})),/Invalid SMTP_PORT/)
  for(const pair of [{GOOGLE_CLIENT_ID:'test-id'},{GOOGLE_CLIENT_SECRET:'test-secret'},{GOOGLE_CLIENT_ID:'test-id',GOOGLE_CLIENT_SECRET:'   '}]) {
    assert.throws(()=>createConfig(env(pair)),/must be configured together/)
  }
})

test('proxy trust defaults to disabled and accepts only bounded explicit IP/CIDR lists',()=>{
  assert.deepEqual(createConfig(env()).trustedProxyCidrs,[])
  const config=createConfig(env({TRUSTED_PROXY_CIDRS:'127.0.0.1, 10.0.0.0/8, ::1, 2001:db8::/48, ::ffff:10.0.0.0/104'}))
  assert.deepEqual(config.trustedProxyCidrs,['127.0.0.1','10.0.0.0/8','::1','2001:db8::/48','::ffff:10.0.0.0/104'])
  assert.ok(Object.isFrozen(config.trustedProxyCidrs))
  const invalid=[true,false,1,[],['127.0.0.1'],'true','false','1','loopback','uniquelocal','*','proxy.example.com','127.1','0177.0.0.1','127.0.0.1/33','::1/129','127.0.0.1/24junk','127.0.0.1/255.255.255.0','fe80::1%eth0','0.0.0.0/0','::/0','::ffff:0.0.0.0/96','::/80','127.0.0.1,,::1',Array(33).fill('127.0.0.1').join(','),'x'.repeat(4097)]
  for(const value of invalid) assert.throws(()=>createConfig(env({TRUSTED_PROXY_CIDRS:value})),/TRUSTED_PROXY_CIDRS/)
})

test('allowlisted proxy clients receive independent rate limits and cannot forge a more distant hop',async t=>{
  const h=await createHarness('proxy-trust',{TRUSTED_PROXY_CIDRS:'127.0.0.1/32,::1/128'})
  t.after(()=>h.close())
  const app=createApp({models:h.models,config:h.config,storage:h.storage,mailer:h.mailer})
  const agent=supertest.agent(app)
  for(let attempt=0;attempt<30;attempt++) {
    await agent.get('/api/v1/auth/csrf-token').set('X-Forwarded-For',`198.51.100.${attempt}, 203.0.113.17`).expect(200)
  }
  const blocked=await agent.get('/api/v1/auth/csrf-token').set('X-Forwarded-For','198.51.100.250, 203.0.113.17').expect(429)
  assert.equal(blocked.body.error.code,'RATE_LIMITED')
  await agent.get('/api/v1/auth/csrf-token').set('X-Forwarded-For','203.0.113.18').expect(200)
  assert.equal(await h.models.RateLimit.countDocuments({}),2)
})

test('an untrusted socket cannot select a fresh rate limit bucket through X-Forwarded-For',async t=>{
  const h=await createHarness('proxy-untrust',{TRUSTED_PROXY_CIDRS:'10.0.0.0/8'})
  t.after(()=>h.close())
  const app=createApp({models:h.models,config:h.config,storage:h.storage,mailer:h.mailer})
  const agent=supertest.agent(app)
  for(let attempt=0;attempt<30;attempt++) await agent.get('/api/v1/auth/csrf-token').set('X-Forwarded-For',`198.51.100.${attempt}`).expect(200)
  await agent.get('/api/v1/auth/csrf-token').set('X-Forwarded-For','203.0.113.19').expect(429)
  assert.equal(await h.models.RateLimit.countDocuments({}),1)
})
