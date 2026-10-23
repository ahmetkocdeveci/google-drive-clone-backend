import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import supertest from 'supertest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createAuthRouter, createSessionMiddleware, hashPassword, verifyPassword, requireCsrf, requireAuth, requireVerified, safeReturnTo, userDto } from '../src/auth.mjs';
import { createHarness } from './helpers.mjs';
import { createApp } from '../src/app.mjs';

function assertGoogleError(response, frontendOrigin, code) {
  assert.equal(response.status, 303);
  const location = new URL(response.headers.location);
  assert.equal(location.origin, frontendOrigin);
  assert.equal(location.pathname, '/login');
  assert.deepEqual([...location.searchParams.entries()], [['authError', code]]);
  assert.equal(location.hash, '');
}

test('scrypt uses a random salt, verifies a password and rejects a different password', async () => {
  const password = 'A sufficiently long password!';
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.match(first, /^\$scrypt\$v=1\$N=131072,r=8,p=1\$/);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword('different password', first), false);
});

test('missing and unsafe hash parameters never authenticate', async () => {
  assert.equal(await verifyPassword('anything', undefined), false);
  assert.equal(await verifyPassword('anything', '$scrypt$v=1$N=999999999,r=8,p=1$bad$bad'), false);
});

test('CSRF requires both a loaded session and its exact token', () => {
  const run = (session, token) => {
    let outcome;
    requireCsrf({ authSession: session, get: () => token }, {}, error => { outcome = error || null; });
    return outcome;
  };
  assert.equal(run({ csrfToken: 'correct-token' }, 'correct-token'), null);
  assert.equal(run(null, 'correct-token').status, 403);
  assert.equal(run({ csrfToken: 'correct-token' }, undefined).status, 403);
  assert.equal(run({ csrfToken: 'correct-token' }, 'incorrect-key').status, 403);
  assert.equal(run({ csrfToken: 'correct-token' }, 'short').status, 403);
});

test('auth and verification gates distinguish absent identity and unverified email', () => {
  function run(middleware, auth) {
    let outcome;
    middleware({ auth }, {}, error => { outcome = error || null; });
    return outcome;
  }
  assert.equal(run(requireAuth, null).status, 401);
  assert.equal(run(requireAuth, { user: { _id: 'id' } }), null);
  assert.equal(run(requireVerified, null).status, 401);
  assert.equal(run(requireVerified, { user: { _id: 'id', emailVerifiedAt: null } }).status, 403);
  assert.equal(run(requireVerified, { user: { _id: 'id', emailVerifiedAt: new Date() } }), null);
});

test('OAuth return paths stay on the frontend origin', () => {
  assert.equal(safeReturnTo('/workspaces/a/files?parentId=b'), '/workspaces/a/files?parentId=b');
  for (const unsafe of ['https://example.com', '//example.com', '/\\example.com', '/\nexample.com', '/ evil', ['//example.com'], undefined]) {
    assert.equal(safeReturnTo(unsafe), '/workspaces');
  }
});

test('session DTO excludes the password hash and database internals', () => {
  assert.deepEqual(userDto({ _id: 'u1', name: 'Ahmet', emailNormalized: 'ahmet@example.com', emailVerifiedAt: null, passwordHash: 'secret', status: 'active' }), {
    id: 'u1', name: 'Ahmet', email: 'ahmet@example.com', emailVerified: false,
  });
});

test('real HTTP auth enforces CSRF, verification, cookie rotation and database expiry', async t => {
  const h = await createHarness('auth');
  t.after(() => h.close());
  const anonymous = h.client();
  const origin = h.config.frontendOrigin;
  const bootstrap = await anonymous.get('/api/v1/auth/csrf-token').expect(200);
  const csrf = bootstrap.body.csrfToken;
  assert.match(csrf, /^[A-Za-z0-9_-]{43}$/);
  const cookie = bootstrap.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Path=\//i);
  const oldCookie = cookie.split(';')[0];
  const token = oldCookie.split('=')[1];
  const oldSession = await h.models.Session.findOne({ tokenHash: createHash('sha256').update(token).digest('hex') }).lean();
  assert.ok(oldSession);
  assert.notEqual(oldSession.tokenHash, token);
  assert.equal(oldSession.userId, null);
  await anonymous.get('/api/v1/auth/me').expect(401);

  const registration = { name: 'Ahmet Auth', email: 'AHMET.AUTH@EXAMPLE.COM', password: 'A long auth password!' };
  await anonymous.post('/api/v1/auth/register').set('Origin', origin).send(registration).expect(403);
  await anonymous.post('/api/v1/auth/register').set('Origin', 'https://attacker.example').set('X-CSRF-Token', csrf).send(registration).expect(403);
  await anonymous.post('/api/v1/auth/register').set('Origin', origin).set('X-CSRF-Token', csrf).send({ ...registration, emailVerified: true }).expect(400);
  const registered = await anonymous.post('/api/v1/auth/register').set('Origin', origin).set('X-CSRF-Token', csrf).send(registration).expect(201);
  assert.equal(registered.body.user.email, 'ahmet.auth@example.com');
  assert.equal(registered.body.user.emailVerified, false);
  assert.equal(registered.body.user.passwordHash, undefined);
  assert.equal(await h.models.Session.countDocuments({ _id: oldSession._id }), 0);
  await h.client().get('/api/v1/auth/me').set('Cookie', oldCookie).expect(401);
  const authenticatedCookie = registered.headers['set-cookie'][0].split(';')[0];
  await h.client().get('/api/v1/auth/me').set('Cookie', `${authenticatedCookie}; ${authenticatedCookie}`).expect(401);
  const user = await h.models.User.findById(registered.body.user.id).select('+passwordHash').lean();
  assert.match(user.passwordHash, /^\$scrypt\$/);
  assert.notEqual(user.passwordHash, registration.password);
  await anonymous.get('/api/v1/workspaces').expect(403);

  const authenticatedCsrf = (await anonymous.get('/api/v1/auth/csrf-token').expect(200)).body.csrfToken;
  assert.notEqual(authenticatedCsrf, csrf);
  await h.flushMail();
  const mail = h.mail.find(item => item.to.includes('ahmet.auth@example.com'));
  assert.ok(mail, 'verification email must be delivered by the outbox');
  const verificationToken = mail.text.match(/#token=([A-Za-z0-9_-]+)/)?.[1];
  assert.ok(verificationToken, 'verification URL uses a fragment');
  const verificationRecord = await h.models.Verification.findOne({ userId: user._id }).lean();
  assert.equal(verificationRecord.tokenHash, createHash('sha256').update(verificationToken).digest('hex'));
  const verified = await anonymous.post('/api/v1/auth/email-verification/confirm').set('Origin', origin).set('X-CSRF-Token', authenticatedCsrf).send({ token: verificationToken }).expect(200);
  assert.equal(verified.body.user.emailVerified, true);
  await anonymous.post('/api/v1/auth/email-verification/confirm').set('Origin', origin).set('X-CSRF-Token', authenticatedCsrf).send({ token: verificationToken }).expect(404);
  await anonymous.get('/api/v1/workspaces').expect(200);
  const live = await h.models.Session.findOne({ userId: user._id }).lean();
  await h.models.Session.updateOne({ _id: live._id }, { $set: { revokedAt: new Date() } });
  await anonymous.get('/api/v1/auth/me').expect(401);
  await h.models.Session.updateOne({ _id: live._id }, { $set: { revokedAt: null } });
  await h.models.User.updateOne({ _id: user._id }, { $set: { status: 'disabled' } });
  await anonymous.get('/api/v1/auth/me').expect(401);
  await h.models.User.updateOne({ _id: user._id }, { $set: { status: 'active' } });
  await anonymous.get('/api/v1/auth/me').expect(200);
  await h.models.Session.updateOne({ _id: live._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal(await h.models.Session.countDocuments({ _id: live._id }), 1, 'expiry must not rely on the asynchronous TTL worker');
  await anonymous.get('/api/v1/auth/me').expect(401);
  const fresh = await anonymous.get('/api/v1/auth/csrf-token').expect(200);
  const loginCsrf = fresh.body.csrfToken;
  await anonymous.post('/api/v1/auth/login').set('Origin', origin).set('X-CSRF-Token', loginCsrf).send({ email: registration.email, password: 'Incorrect password!' }).expect(401);
  const signedIn = await anonymous.post('/api/v1/auth/login').set('Origin', origin).set('X-CSRF-Token', loginCsrf).send({ email: registration.email, password: registration.password }).expect(200);
  assert.equal(signedIn.body.user.id, user._id);
  const logoutCsrf = (await anonymous.get('/api/v1/auth/csrf-token').expect(200)).body.csrfToken;
  await anonymous.post('/api/v1/auth/logout').set('Origin', origin).set('X-CSRF-Token', logoutCsrf).expect(204);
  await anonymous.get('/api/v1/auth/me').expect(401);
});

test('a verification token cannot verify another account; expired tokens fail before TTL deletion', async t => {
  const h = await createHarness('auth-verify');
  t.after(() => h.close());
  const first = await h.user({ name: 'First Auth', email: 'first-auth@example.com', verified: false });
  const second = await h.user({ name: 'Second Auth', email: 'second-auth@example.com', verified: false });
  await h.flushMail();
  const mail = h.mail.find(item => item.to.includes('first-auth@example.com'));
  const token = mail?.text.match(/#token=([A-Za-z0-9_-]+)/)?.[1];
  assert.ok(token);
  assert.equal((await second.request('post', '/auth/email-verification/confirm', { token })).status, 404);
  assert.equal((await h.models.User.findById(second.user.id).lean()).emailVerifiedAt, null);
  await h.models.Verification.updateOne({ userId: first.user.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await first.request('post', '/auth/email-verification/confirm', { token })).status, 404);
  const providers = await h.client().get('/api/v1/auth/providers').expect(200);
  assert.deepEqual(providers.body, { google: false });
  await first.agent.get('/api/v1/auth/google/start').expect(503);
  const unavailable = await h.client().get('/api/v1/auth/google/callback').expect(303);
  assertGoogleError(unavailable, h.config.frontendOrigin, 'google_unavailable');
});

test('Google authorization binds state to the browser, uses PKCE and consumes state before an exchange failure', async t => {
  const h = await createHarness('auth-google');
  t.after(() => h.close());
  const config = { ...h.config, googleClientId: 'test-client-id', googleClientSecret: 'test-client-secret' };
  const app = express();
  app.use(createSessionMiddleware({ models: h.models, config }));
  app.use(createAuthRouter({ models: h.models, config }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: { code: error.code } }));
  const browser = supertest.agent(app);
  const providers = await browser.get('/providers').expect(200);
  assert.deepEqual(providers.body, { google: true });
  const start = await browser.get('/google/start').query({ returnTo: '//attacker.example' }).expect(302);
  const authorization = new URL(start.headers.location);
  assert.equal(authorization.origin, 'https://accounts.google.com');
  assert.equal(authorization.pathname, '/o/oauth2/v2/auth');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('response_type'), 'code');
  assert.equal(authorization.searchParams.get('redirect_uri'), `${config.apiOrigin}/api/v1/auth/google/callback`);
  const state = authorization.searchParams.get('state');
  const attempt = await h.models.OAuthAttempt.findOne({ stateHash: createHash('sha256').update(state).digest('hex') }).lean();
  assert.ok(attempt);
  assert.equal(attempt.returnTo, '/workspaces');
  assert.equal(attempt.nonce, authorization.searchParams.get('nonce'));
  assert.equal(createHash('sha256').update(attempt.codeVerifier).digest('base64url'), authorization.searchParams.get('code_challenge'));
  assert.notEqual(attempt.stateHash, state);

  const outsider = supertest.agent(app);
  await outsider.get('/csrf-token').expect(200);
  const wrongBrowser = await outsider.get('/google/callback').query({ state, code: 'unused-code' }).expect(303);
  assertGoogleError(wrongBrowser, config.frontendOrigin, 'google_state_invalid');
  assert.equal((await h.models.OAuthAttempt.findById(attempt._id).lean()).consumedAt, null);

  let providerCalls = 0;
  // The real provider requires external credentials; exercise failure/replay without contacting it.
  t.mock.method(globalThis, 'fetch', async () => { providerCalls += 1; throw new Error('Exchange unavailable'); });
  const failed = await browser.get('/google/callback').query({ state, code: 'unused-code' }).expect(303);
  assertGoogleError(failed, config.frontendOrigin, 'google_failed');
  assert.equal(providerCalls, 1);
  assert.ok((await h.models.OAuthAttempt.findById(attempt._id).lean()).consumedAt);
  const replay = await browser.get('/google/callback').query({ state, code: 'unused-code' }).expect(303);
  assertGoogleError(replay, config.frontendOrigin, 'google_state_invalid');
  assert.equal(providerCalls, 1);

  const another = await browser.get('/google/start').expect(302);
  const expiredState = new URL(another.headers.location).searchParams.get('state');
  await h.models.OAuthAttempt.updateOne({ stateHash: createHash('sha256').update(expiredState).digest('hex') }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const expired = await browser.get('/google/callback').query({ state: expiredState, code: 'unused-code' }).expect(303);
  assertGoogleError(expired, config.frontendOrigin, 'google_state_invalid');
  assert.equal(providerCalls, 1);

  const cancelledStart = await browser.get('/google/start').expect(302);
  const cancelledState = new URL(cancelledStart.headers.location).searchParams.get('state');
  const cancelled = await browser.get('/google/callback').query({ state: cancelledState, error: 'access_denied', error_description: 'Untrusted provider description', code: 'must-not-be-exchanged' }).expect(303);
  assertGoogleError(cancelled, config.frontendOrigin, 'google_cancelled');
  assert.ok((await h.models.OAuthAttempt.findOne({ stateHash: createHash('sha256').update(cancelledState).digest('hex') }).lean()).consumedAt);
  const cancelledReplay = await browser.get('/google/callback').query({ state: cancelledState, error: 'access_denied' }).expect(303);
  assertGoogleError(cancelledReplay, config.frontendOrigin, 'google_state_invalid');

  const unknownStart = await browser.get('/google/start').expect(302);
  const unknownState = new URL(unknownStart.headers.location).searchParams.get('state');
  const unknown = await browser.get('/google/callback').query({ state: unknownState, error: 'provider-internal-secret', error_description: 'never echo this value' }).expect(303);
  assertGoogleError(unknown, config.frontendOrigin, 'google_failed');
  const missingState = await browser.get('/google/callback').query({ error: 'access_denied' }).expect(303);
  assertGoogleError(missingState, config.frontendOrigin, 'google_state_invalid');
  assert.equal(providerCalls, 1, 'consent errors never exchange an authorization code');
});

test('auth rate limits also cover the mixed-case routes accepted by Express', async t => {
  const h = await createHarness('auth-limit');
  t.after(() => h.close());
  const app = createApp({ models: h.models, config: h.config, storage: h.storage, rateLimit: true });
  const browser = supertest.agent(app);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await browser.get('/api/v1/AUTH/CSRF-TOKEN').expect(200);
  }
  const blocked = await browser.get('/api/v1/auth/csrf-token').expect(429);
  assert.equal(blocked.body.error.code, 'RATE_LIMITED');
  assert.ok(Number(blocked.headers['retry-after']) > 0);
});

test('verification resend revokes old links, enforces cooldown and serializes simultaneous requests', async t => {
  const h = await createHarness('auth-resend');
  t.after(() => h.close());
  const account = await h.user({ name: 'Resend User', email: 'resend@example.com', verified: false });
  await h.flushMail();
  const oldToken = h.mail.findLast(item => item.to === account.user.email).text.match(/#token=([A-Za-z0-9_-]+)/)[1];
  const anonymous = h.client();
  const anonymousCsrf = (await anonymous.get('/api/v1/auth/csrf-token').expect(200)).body.csrfToken;
  await anonymous.post('/api/v1/auth/email-verification/resend').set('Origin', h.config.frontendOrigin).set('X-CSRF-Token', anonymousCsrf).expect(401);
  await account.agent.post('/api/v1/auth/email-verification/resend').set('Origin', h.config.frontendOrigin).expect(403);
  const throttled = await account.request('post', '/auth/email-verification/resend').expect(429);
  assert.equal(throttled.body.error.code, 'VERIFICATION_RESEND_LIMIT');
  assert.ok(Number(throttled.headers['retry-after']) > 0);

  await h.models.Verification.collection.updateMany({ userId: account.user.id }, { $set: {
    createdAt: new Date(Date.now() - 61000), expiresAt: new Date(Date.now() - 1000),
  } });
  await account.request('post', '/auth/email-verification/confirm', { token: oldToken }).expect(404);
  const parallel = await Promise.all([
    account.request('post', '/auth/email-verification/resend'),
    account.request('post', '/auth/email-verification/resend'),
  ]);
  assert.deepEqual(parallel.map(response => response.status).sort(), [204, 429]);
  assert.equal(await h.models.Verification.countDocuments({ userId: account.user.id, consumedAt: null, expiresAt: { $gt: new Date() } }), 1);
  const original = await h.models.Verification.findOne({ tokenHash: createHash('sha256').update(oldToken).digest('hex') }).lean();
  if (original) assert.ok(original.consumedAt, 'the old token is revoked in the resend transaction');
  await h.flushMail();
  assert.equal(h.mail.length, 2, 'only the successful resend enqueues another email');
  const replacement = h.mail.findLast(item => item.to === account.user.email).text.match(/#token=([A-Za-z0-9_-]+)/)[1];
  assert.notEqual(replacement, oldToken);
  await account.request('post', '/auth/email-verification/confirm', { token: oldToken }).expect(404);
  await account.request('post', '/auth/email-verification/confirm', { token: replacement }).expect(200);
  const verificationCount = await h.models.Verification.countDocuments({ userId: account.user.id });
  await account.request('post', '/auth/email-verification/resend').expect(204);
  assert.equal(await h.models.Verification.countDocuments({ userId: account.user.id }), verificationCount);
  await h.flushMail();
  assert.equal(h.mail.length, 2, 'verified accounts do not receive another verification email');
});

test('verification resend also recovers an account whose verification record was already cleaned up', async t => {
  const h = await createHarness('auth-missing');
  t.after(() => h.close());
  const account = await h.user({ name: 'Missing Link', email: 'missing-link@example.com', verified: false });
  await h.models.Verification.deleteMany({ userId: account.user.id });
  await account.request('post', '/auth/email-verification/resend').expect(204);
  await h.flushMail();
  assert.equal(h.mail.length, 1, 'the invalid original outbox item is cancelled');
  const token = h.mail[0].text.match(/#token=([A-Za-z0-9_-]+)/)[1];
  const confirmed = await account.request('post', '/auth/email-verification/confirm', { token }).expect(200);
  assert.equal(confirmed.body.user.emailVerified, true);
});

test('concurrent confirmation and resend produce one consistent verification outcome', async t => {
  const h = await createHarness('auth-race');
  t.after(() => h.close());
  const account = await h.user({ name: 'Verify Race', email: 'verify-race@example.com', verified: false });
  await h.flushMail();
  const token = h.mail[0].text.match(/#token=([A-Za-z0-9_-]+)/)[1];
  await h.models.Verification.collection.updateMany({ userId: account.user.id }, { $set: { createdAt: new Date(Date.now() - 61000) } });
  const [confirmation, resend] = await Promise.all([
    account.request('post', '/auth/email-verification/confirm', { token }),
    account.request('post', '/auth/email-verification/resend'),
  ]);
  assert.equal(resend.status, 204);
  assert.ok([200, 404].includes(confirmation.status));
  const user = await h.models.User.findById(account.user.id).lean();
  const activeTokens = await h.models.Verification.countDocuments({ userId: user._id, consumedAt: null, expiresAt: { $gt: new Date() } });
  await h.flushMail();
  if (confirmation.status === 200) {
    assert.ok(user.emailVerifiedAt);
    assert.equal(activeTokens, 0);
    assert.equal(h.mail.length, 1, 'a completed confirmation prevents another verification email');
  } else {
    assert.equal(user.emailVerifiedAt, null);
    assert.equal(activeTokens, 1);
    assert.equal(h.mail.length, 2);
    const replacement = h.mail[1].text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    await account.request('post', '/auth/email-verification/confirm', { token: replacement }).expect(200);
  }
});

test('Google email ownership requires an authoritative domain or a separate verification challenge', async t => {
  const h = await createHarness('auth-google-own', { GOOGLE_CLIENT_ID: 'audit-client', GOOGLE_CLIENT_SECRET: 'audit-secret' });
  t.after(() => h.close());
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'auth-audit-key', alg: 'RS256', use: 'sig' };
  let currentIdToken;
  t.mock.method(globalThis, 'fetch', async input => {
    if (String(input) === 'https://oauth2.googleapis.com/token') return Response.json({ id_token: currentIdToken });
    if (String(input) === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] });
    throw new Error('Unexpected external request');
  });
  async function googleLogin({ email, subject, hd, expectedError }) {
    const browser = h.client();
    const start = await browser.get('/api/v1/auth/google/start').expect(302);
    const authorization = new URL(start.headers.location);
    currentIdToken = await new SignJWT({
      sub: subject, email, email_verified: true, name: 'Google Audit',
      nonce: authorization.searchParams.get('nonce'), ...(hd ? { hd } : {}),
    }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer('https://accounts.google.com')
      .setAudience(h.config.googleClientId).setIssuedAt().setExpirationTime('5 minutes').sign(privateKey);
    const callback = await browser.get('/api/v1/auth/google/callback').query({ state: authorization.searchParams.get('state'), code: 'local-audit-code' }).expect(303);
    if (expectedError) assertGoogleError(callback, h.config.frontendOrigin, expectedError);
    const user = !expectedError ? (await browser.get('/api/v1/auth/me').expect(200)).body.user : null;
    return { browser, user, callback };
  }
  const thirdParty = await googleLogin({ email: 'external-owner@example.com', subject: 'third-party-subject' });
  assert.equal(thirdParty.user.emailVerified, false, 'email_verified alone is insufficient for a non-Google-hosted mailbox');
  await thirdParty.browser.get('/api/v1/workspaces').expect(403);
  const csrf = (await thirdParty.browser.get('/api/v1/auth/csrf-token')).body.csrfToken;
  await thirdParty.browser.post('/api/v1/invitations/accept').set('Origin', h.config.frontendOrigin).set('X-CSRF-Token', csrf).send({ token: 'x'.repeat(43) }).expect(403);
  await h.flushMail();
  assert.equal(h.mail.length, 1);
  const token = h.mail[0].text.match(/#token=([A-Za-z0-9_-]+)/)[1];
  await thirdParty.browser.post('/api/v1/auth/email-verification/confirm').set('Origin', h.config.frontendOrigin).set('X-CSRF-Token', csrf).send({ token }).expect(200);
  const returning = await googleLogin({ email: 'external-owner@example.com', subject: 'third-party-subject' });
  assert.equal(returning.user.id, thirdParty.user.id, 'provider subject keeps the identity stable');
  assert.equal(returning.user.emailVerified, true, 'a completed local email challenge remains valid');
  const gmail = await googleLogin({ email: 'audit-owner@gmail.com', subject: 'gmail-subject' });
  assert.equal(gmail.user.emailVerified, true);
  const workspace = await googleLogin({ email: 'audit-owner@company.example', subject: 'workspace-subject', hd: 'company.example' });
  assert.equal(workspace.user.emailVerified, true);
  const mismatch = await googleLogin({ email: 'other-owner@company.example', subject: 'mismatched-domain-subject', hd: 'another.example' });
  assert.equal(mismatch.user.emailVerified, false, 'hosted domain must correspond to the claimed email domain');
  await googleLogin({ email: 'external-owner@example.com', subject: 'different-provider-subject', expectedError: 'google_account_link_required' });
  assert.equal(await h.models.User.countDocuments({ emailNormalized: 'external-owner@example.com' }), 1);
});

test('login returns verification state committed while credentials were being checked', async t => {
  const h = await createHarness('auth-loginrace');
  t.after(() => h.close());
  const account = await h.user({ email: 'login-race@example.com', verified: false });
  await h.flushMail();
  const token = h.mail[0].text.match(/#token=([A-Za-z0-9_-]+)/)[1];
  const browser = h.client();
  const csrf = (await browser.get('/api/v1/auth/csrf-token')).body.csrfToken;
  let credentialsRead, continueLogin;
  const read = new Promise(resolve => { credentialsRead = resolve; });
  const resume = new Promise(resolve => { continueLogin = resolve; });
  const originalFind = h.models.User.findOne.bind(h.models.User);
  let intercepted = false;
  t.mock.method(h.models.User, 'findOne', (filter, ...args) => {
    const query = originalFind(filter, ...args);
    if (filter.emailNormalized === account.user.email && !intercepted) {
      intercepted = true;
      const originalExec = query.exec.bind(query);
      query.exec = async (...execArgs) => {
        const record = await originalExec(...execArgs);
        credentialsRead();
        await resume;
        return record;
      };
    }
    return query;
  });
  const login = browser.post('/api/v1/auth/login').set('Origin', h.config.frontendOrigin).set('X-CSRF-Token', csrf)
    .send({ email: account.user.email, password: account.password }).then(response => response);
  try {
    await read;
    await account.request('post', '/auth/email-verification/confirm', { token }).expect(200);
  } finally { continueLogin(); }
  const response = await login;
  assert.equal(response.status, 200);
  assert.equal(response.body.user.emailVerified, true);
});
