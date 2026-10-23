import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEnv } from 'node:util'
import { createDeploymentSettings, serializeSettings } from '../scripts/prepare-northflank.mjs'

const source = { MONGODB_URI: 'mongodb+srv://user:encoded%23pass@cluster.example.net/drive', OUTBOX_ENCRYPTION_KEY: '1'.repeat(64), UPLOAD_SIGNING_KEY: '2'.repeat(64), STORAGE_DRIVER: 's3', S3_BUCKET: 'current-private-bucket', S3_REGION: 'auto', S3_ENDPOINT: 'https://storage.example.com', S3_ACCESS_KEY_ID: 'access-id', S3_SECRET_ACCESS_KEY: 'secret-key', SMTP_HOST: 'smtp.example.com', SMTP_USER: 'owner@example.com', SMTP_PASSWORD: 'password', SMTP_PORT: '465', SMTP_SECURE: 'true', MAIL_FROM: 'Ortak Drive <owner@example.com>', GOOGLE_CLIENT_ID: 'google-id', GOOGLE_CLIENT_SECRET: 'google-secret', UNRELATED_SECRET: 'must-not-copy' }
const options = { source, publicOrigin: 'https://chosen-app.pages.dev', upstreamOrigin: 'https://chosen-api.code.run', reuseCurrentData: true, edgeKey: '3'.repeat(64) }

test('deployment preserves the database/bucket/encryption-key pair and produces same-origin API settings', () => {
  const before = structuredClone(source)
  const { backend, cloudflare } = createDeploymentSettings(options)
  for (const name of ['MONGODB_URI', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'OUTBOX_ENCRYPTION_KEY']) assert.equal(backend[name], source[name])
  assert.equal(backend.API_ORIGIN, options.publicOrigin)
  assert.equal(backend.FRONTEND_ORIGIN, options.publicOrigin)
  assert.equal(backend.NODE_ENV, 'production')
  assert.equal(backend.TRUSTED_PROXY_CIDRS, '')
  assert.equal(backend.EDGE_PROXY_TOKEN, cloudflare.EDGE_PROXY_TOKEN)
  assert.equal(cloudflare.UPSTREAM_API_ORIGIN, options.upstreamOrigin)
  assert.equal(backend.UNRELATED_SECRET, undefined)
  assert.deepEqual(source, before)
  assert.deepEqual(parseEnv(serializeSettings(backend)), backend)
})

test('deployment refuses accidental data reuse, invalid origins, previews and incomplete providers', () => {
  assert.throws(() => createDeploymentSettings({ ...options, reuseCurrentData: false }), /DATA_REUSE/)
  for (const publicOrigin of ['http://chosen-app.pages.dev', 'https://chosen-app.pages.dev/', 'https://branch.chosen-app.pages.dev', 'https://chosen-app.pages.dev/path', 'https://different.example.com']) assert.throws(() => createDeploymentSettings({ ...options, publicOrigin }))
  assert.throws(() => createDeploymentSettings({ ...options, upstreamOrigin: 'https://api.example.com' }), /INVALID_ORIGIN/)
  assert.throws(() => createDeploymentSettings({ ...options, edgeKey: 'weak' }), /EDGE_PROXY_TOKEN/)
  assert.throws(() => createDeploymentSettings({ ...options, source: { ...source, SMTP_PASSWORD: '' } }), /PROVIDER_SETUP/)
})

test('serialization preserves punctuation and rejects values that cannot be represented safely', () => {
  for (const value of ['value#with=punctuation', 'İsim <owner@example.com>', '"Display Name" <owner@example.com>', "value'with'quotes", 'back\\slash']) assert.equal(parseEnv(serializeSettings({ VALUE: value })).VALUE, value)
  for (const value of ['line\nbreak', 'line\rbreak', 'null\0byte', 'both\'and"quotes']) assert.throws(() => serializeSettings({ VALUE: value }))
})
