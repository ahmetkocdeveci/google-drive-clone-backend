import test from 'node:test'
import assert from 'node:assert/strict'
import { testSmtp } from '../scripts/test-smtp.mjs'

test('SMTP check verifies without sending by default', async () => {
  let verified = false
  const result = await testSmtp({ config: { smtp: {} }, transport: {
    async verify() { verified = true },
    async sendMail() { assert.fail('verification must not send mail') },
  } })
  assert.equal(verified, true)
  assert.deepEqual(result, { verified: true, submitted: false })
})

test('explicit self-test sends one fixed message only to the configured sender', async () => {
  const messages = []
  const result = await testSmtp({ config: { smtp: { auth: { user: 'TEST.I@gmail.com' } } }, sendToSelf: true, transport: {
    async verify() {},
    async sendMail(message) { messages.push(message); return { accepted: ['test.i@gmail.com'], rejected: [] } },
  } })
  assert.equal(messages.length, 1)
  assert.equal(messages[0].to, 'test.i@gmail.com')
  assert.equal(messages[0].from.address, messages[0].to)
  assert.equal(messages[0].disableFileAccess, true)
  assert.equal(messages[0].disableUrlAccess, true)
  assert.deepEqual(result, { verified: true, submitted: true })
})

test('self-test refuses a missing sender and reports SMTP rejection', async () => {
  await assert.rejects(testSmtp({ config: { smtp: {} }, sendToSelf: true, transport: {
    async verify() { assert.fail('invalid sender must fail before network') },
  } }), /SENDER_REQUIRED/)
  await assert.rejects(testSmtp({ config: { smtp: { auth: { user: 'test@gmail.com' } } }, sendToSelf: true, transport: {
    async verify() {},
    async sendMail() { return { accepted: [], rejected: ['test@gmail.com'] } },
  } }), /SMTP_NOT_ACCEPTED/)
})
