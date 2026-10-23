import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { sealOAuthInvitation, openOAuthInvitation } from '../src/oauth-invitation.mjs';

test('OAuth invitation context is encrypted, randomized and bound to session and state', () => {
  const config = { outboxEncryptionKey: randomBytes(32).toString('hex') };
  const attempt = { sessionId: 'session-a', stateHash: 'state-a' };
  const token = randomBytes(32).toString('base64url');
  const first = sealOAuthInvitation(config, token, attempt);
  assert.notEqual(first, sealOAuthInvitation(config, token, attempt));
  assert.ok(!first.includes(token));
  assert.equal(openOAuthInvitation(config, first, attempt), token);
  assert.throws(() => openOAuthInvitation(config, first, { ...attempt, sessionId: 'session-b' }));
  assert.throws(() => openOAuthInvitation(config, first, { ...attempt, stateHash: 'state-b' }));
  assert.throws(() => openOAuthInvitation({ outboxEncryptionKey: randomBytes(32).toString('hex') }, first, attempt));
  const bytes = Buffer.from(first, 'base64url'); bytes[bytes.length - 1] ^= 1;
  assert.throws(() => openOAuthInvitation(config, bytes.toString('base64url'), attempt));
});
