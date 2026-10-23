import { createHmac, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function key(config) {
  return createHmac('sha256', Buffer.from(config.outboxEncryptionKey, 'hex')).update('oauth-invitation-context:v1').digest();
}
function binding(attempt) { return Buffer.from(`v1:${attempt.sessionId}:${attempt.stateHash}:/invitations/accept`); }

export function sealOAuthInvitation(config, token, attempt) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(config), iv);
  cipher.setAAD(binding(attempt));
  const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function openOAuthInvitation(config, context, attempt) {
  if (typeof context !== 'string' || context.length > 512 || !/^[A-Za-z0-9_-]+$/.test(context)) throw new Error('Invalid OAuth invitation context');
  const bytes = Buffer.from(context, 'base64url');
  if (bytes.length < 60) throw new Error('Invalid OAuth invitation context');
  const cipher = createDecipheriv('aes-256-gcm', key(config), bytes.subarray(0, 12));
  cipher.setAAD(binding(attempt));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
}
