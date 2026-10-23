import test from 'node:test'
import assert from 'node:assert/strict'
import supertest from 'supertest'
import express from 'express'
import { createConfig } from '../src/config.mjs'
import { createApp } from '../src/app.mjs'

function fixture(edge = 'a'.repeat(64)) {
  const config = createConfig({ NODE_ENV: 'test', MONGODB_URI: 'mongodb://127.0.0.1/unused', OUTBOX_ENCRYPTION_KEY: '1'.repeat(64), UPLOAD_SIGNING_KEY: '2'.repeat(64), ...(edge ? { EDGE_PROXY_TOKEN: edge } : {}) })
  const counts = new Map()
  const models = {
    RateLimit: { async findOneAndUpdate({ key }) { const count = (counts.get(key) || 0) + 1; counts.set(key, count); return { count } } },
    Workspace: { db: { db: { admin: () => ({ command: async () => ({ ok: 1 }) }) } } },
  }
  const app = createApp({ config, models, storage: { router: express.Router() }, mailer: {}, logger: { error() {} } })
  return { app, config, counts, client: supertest(app) }
}
function through(request, ip = '203.0.113.8') { return request.set('X-Drive-Edge-Token', 'a'.repeat(64)).set('X-Drive-Client-IP', ip) }

test('edge configuration is optional but nonempty values must be strong hex keys', () => {
  assert.equal(fixture(null).config.edgeProxyToken, null)
  assert.equal(fixture().config.edgeProxyToken, 'a'.repeat(64))
  for (const invalid of ['short', 'x'.repeat(64), 'a'.repeat(63)]) assert.throws(() => fixture(invalid), /EDGE_PROXY_TOKEN/)
})

test('direct API access, forged key and invalid client addresses fail before rate limit or session creation', async () => {
  const h = fixture()
  await h.client.get('/api/v1/auth/providers').expect(403)
  await h.client.get('/API/v1/auth/providers').expect(403)
  await h.client.get('/api/v1/auth/providers').set('X-Drive-Edge-Token', 'b'.repeat(64)).set('X-Drive-Client-IP', '203.0.113.8').expect(403)
  for (const invalid of ['', 'spoof', '203.0.113.8, 198.51.100.1', 'fe80::1%eth0']) await through(h.client.get('/api/v1/auth/providers'), invalid).expect(403)
  assert.equal(h.counts.size, 0)
  const valid = await through(h.client.get('/api/v1/auth/providers')).expect(200)
  assert.deepEqual(valid.body, { google: false })
  await h.client.get('/health').expect(200)
})

test('authenticated edge address controls rate limits while spoofed forwarding headers do not', async () => {
  const h = fixture()
  for (let index = 0; index < 30; index++) await through(h.client.get('/api/v1/auth/providers').set('X-Forwarded-For', `198.51.100.${index}`)).expect(200)
  // Provider discovery uses the normal API bucket (300/min); Google start uses the auth bucket.
  assert.equal(h.counts.size, 1)
  await through(h.client.get('/api/v1/auth/providers'), '203.0.113.9').expect(200)
  await through(h.client.get('/api/v1/auth/providers'), '2001:db8::1').expect(200)
  assert.equal(h.counts.size, 3)
  for (let index = 0; index < 30; index++) await through(h.client.get('/api/v1/auth/google/start').set('X-Forwarded-For', `198.51.100.${index}`)).expect(503)
  const blocked = await through(h.client.get('/api/v1/auth/google/start').set('X-Forwarded-For', '198.51.100.99')).expect(429)
  assert.equal(blocked.body.error.code, 'RATE_LIMITED')
  await through(h.client.get('/api/v1/auth/google/start'), '203.0.113.9').expect(503)
})

test('edge trust does not replace browser Origin, CSRF or user authentication', async () => {
  const h = fixture()
  const origin = await through(h.client.get('/api/v1/auth/providers').set('Origin', 'https://evil.example')).expect(403)
  assert.equal(origin.body.error.code, 'ORIGIN_FORBIDDEN')
  const missing = await through(h.client.post('/api/v1/auth/logout')).expect(403)
  assert.equal(missing.body.error.code, 'ORIGIN_REQUIRED')
  const csrf = await through(h.client.post('/api/v1/auth/logout').set('Origin', h.config.frontendOrigin)).expect(403)
  assert.equal(csrf.body.error.code, 'CSRF_INVALID')
  const identity = await through(h.client.get('/api/v1/auth/me')).expect(401)
  assert.equal(identity.body.error.code, 'UNAUTHENTICATED')
})

test('forwarded client header is ignored entirely when no edge key is configured', async () => {
  const h = fixture(null)
  await h.client.get('/api/v1/auth/providers').set('X-Drive-Client-IP', '203.0.113.8').expect(200)
  await h.client.get('/api/v1/auth/providers').set('X-Drive-Client-IP', '203.0.113.9').expect(200)
  assert.equal(h.counts.size, 1)
})
