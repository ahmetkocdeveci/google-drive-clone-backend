import { Router } from 'express';
import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { HttpError } from './errors.mjs';

const scrypt = promisify(scryptCallback);
const SCRYPT_OPTIONS = Object.freeze({ N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
const SESSION_BYTES = 32;
const VERIFICATION_TTL_MS = 60 * 60 * 1000;
const VERIFICATION_RESEND_INTERVAL_MS = 60 * 1000;
const OAUTH_TTL_MS = 10 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const transactionOptions = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' };
const emailSchema = z.string().trim().max(254).email().transform(value => value.toLowerCase());
const passwordSchema = z.string().min(8).max(128);
const tokenSchema = z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/);
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
// Missing accounts still perform the expensive password derivation.
const DUMMY_PASSWORD_HASH = '$scrypt$v=1$N=131072,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
let passwordDerivations = 0;
const passwordWaiters = [];

async function derivePassword(password, salt) {
  // Bound memory use independently of the HTTP rate limiter: each derivation uses ~128 MiB.
  if (passwordDerivations >= 2) {
    if (passwordWaiters.length >= 16) throw new HttpError(503, 'AUTH_BUSY', 'Giriş servisi şu anda yoğun. Biraz sonra tekrar dene.');
    await new Promise(resolve => passwordWaiters.push(resolve));
  } else passwordDerivations += 1;
  try { return await scrypt(password, salt, 64, SCRYPT_OPTIONS); }
  finally {
    const next = passwordWaiters.shift();
    if (next) next();
    else passwordDerivations -= 1;
  }
}

function randomToken() { return randomBytes(SESSION_BYTES).toString('base64url'); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
const passwordVersion = user => user.passwordVersion ?? 1;
const versionFilter = version => version === 1 ? { $or: [{ passwordVersion: 1 }, { passwordVersion: { $exists: false } }] } : { passwordVersion: version };
function googleAuthorizationUrl(config, { state, nonce, codeVerifier }) {
  const target = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  target.search = new URLSearchParams({ client_id: config.googleClientId, redirect_uri: `${config.apiOrigin}/api/v1/auth/google/callback`, response_type: 'code', scope: 'openid email profile', state, nonce, code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
  return target.toString();
}
function validation(schema, input) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, 'INVALID_INPUT', 'Gönderilen bilgileri kontrol et.');
  return parsed.data;
}
function equalText(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.length === second.length && timingSafeEqual(first, second);
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derivePassword(password, salt);
  return `$scrypt$v=1$N=131072,r=8,p=1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  // Parameters are allowlisted so a corrupted record cannot demand arbitrary RAM/CPU.
  const match = typeof stored === 'string' && stored.match(/^\$scrypt\$v=1\$N=131072,r=8,p=1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/);
  const candidate = match || DUMMY_PASSWORD_HASH.match(/^\$scrypt\$v=1\$N=131072,r=8,p=1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/);
  const key = await derivePassword(password, Buffer.from(candidate[1], 'base64url'));
  const expected = Buffer.from(candidate[2], 'base64url');
  return Boolean(match) && key.length === expected.length && timingSafeEqual(key, expected);
}

export function userDto(user) {
  return { id: String(user._id), name: user.name, email: user.emailNormalized, emailVerified: Boolean(user.emailVerifiedAt) };
}

function cookieOptions(config) {
  return { httpOnly: true, secure: config.production, sameSite: 'lax', path: '/', maxAge: config.sessionTtlMs };
}
function setSessionCookie(res, config, token) { res.cookie(config.cookieName, token, cookieOptions(config)); }
function clearSessionCookie(res, config) {
  const { maxAge: _maxAge, ...options } = cookieOptions(config);
  res.clearCookie(config.cookieName, options);
}
function cookieValue(header, name) {
  if (typeof header !== 'string' || header.length > 16384) return null;
  const matches = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  // Ambiguous duplicate cookies are rejected, including differently scoped cookies.
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export function createSessionMiddleware({ models, config }) {
  return async function sessionMiddleware(req, res, next) {
    req.auth = null;
    req.authSession = null;
    req.csrfToken = null;
    const token = cookieValue(req.headers.cookie, config.cookieName);
    if (token) {
      const session = await models.Session.findOne({ tokenHash: digest(token), expiresAt: { $gt: new Date() }, revokedAt: null }).lean();
      if (session) {
        const user = session.userId ? await models.User.findOne({ _id: session.userId, status: 'active' }).lean() : null;
        if (!session.userId || (user && passwordVersion(session) === passwordVersion(user))) {
          req.authSession = session;
          req.csrfToken = session.csrfToken;
          req.auth = user ? { user, session } : null;
        }
      }
    }
    next();
  };
}

export function requireAuth(req, _res, next) {
  if (!req.auth?.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Devam etmek için giriş yap.'));
  next();
}

export function requireVerified(req, _res, next) {
  if (!req.auth?.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Devam etmek için giriş yap.'));
  if (!req.auth.user.emailVerifiedAt) return next(new HttpError(403, 'EMAIL_NOT_VERIFIED', 'Önce e-posta adresini doğrula.'));
  next();
}

export function requireCsrf(req, _res, next) {
  if (!req.authSession || !equalText(req.get('X-CSRF-Token'), req.authSession.csrfToken)) {
    return next(new HttpError(403, 'CSRF_INVALID', 'Güvenli istek anahtarı geçersiz. Sayfayı yenileyip tekrar dene.'));
  }
  next();
}

export function safeReturnTo(input) {
  // A local path only. Backslashes and controls can change URL parser semantics.
  return typeof input === 'string' && input.length <= 2048 && /^\/(?!\/)/.test(input) && !/[\\\u0000-\u0020\u007f]/.test(input)
    ? input : '/workspaces';
}

async function createSession(models, config, userId, previousId, mongoSession, version = 1) {
  const token = randomToken();
  const record = {
    _id: randomUUID(), tokenHash: digest(token), csrfToken: randomToken(),
    userId, passwordVersion: version, expiresAt: new Date(Date.now() + config.sessionTtlMs), revokedAt: null,
  };
  await models.Session.create([record], { session: mongoSession });
  if (previousId) await models.Session.deleteOne({ _id: previousId }, { session: mongoSession });
  return { token, record };
}

async function ensureAnonymousSession(req, res, models, config) {
  if (req.authSession) return req.authSession;
  const { token, record } = await createSession(models, config, null, null, undefined);
  setSessionCookie(res, config, token);
  req.authSession = record;
  req.csrfToken = record.csrfToken;
  return record;
}

function duplicateAccount(error) {
  if (error?.code === 11000) throw new HttpError(409, 'ACCOUNT_EXISTS', 'Bu e-posta adresiyle bir hesap var. Giriş yapmayı dene.');
  throw error;
}

export function createAuthRouter({ models, config, mailer }) {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  router.get('/csrf-token', async (req, res) => {
    const session = await ensureAnonymousSession(req, res, models, config);
    res.json({ csrfToken: session.csrfToken });
  });

  router.get('/me', requireAuth, (req, res) => res.json({ user: userDto(req.auth.user) }));
  router.get('/providers', (_req, res) => res.json({ google: Boolean(config.googleClientId && config.googleClientSecret) }));

  router.post('/register', requireCsrf, async (req, res) => {
    const input = validation(z.object({
      name: z.string().trim().min(2).max(100).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
      email: emailSchema,
      password: passwordSchema,
    }).strict(), req.body);
    const passwordHash = await hashPassword(input.password);
    const token = randomToken();
    let result;
    try {
      await models.User.db.transaction(async mongoSession => {
        const [user] = await models.User.create([{
          _id: randomUUID(), name: input.name, emailNormalized: input.email,
          passwordHash, emailVerifiedAt: null, status: 'active',
        }], { session: mongoSession });
        await models.Verification.create([{
          _id: randomUUID(), userId: user._id, tokenHash: digest(token),
          expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS), consumedAt: null,
        }], { session: mongoSession });
        await mailer.enqueueVerification({ user, token }, mongoSession);
        const session = await createSession(models, config, user._id, req.authSession?._id, mongoSession);
        result = { user, session };
      }, transactionOptions);
    } catch (error) { duplicateAccount(error); }
    setSessionCookie(res, config, result.session.token);
    res.status(201).json({ user: userDto(result.user) });
  });

  router.post('/login', requireCsrf, async (req, res) => {
    const input = validation(z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict(), req.body);
    const user = await models.User.findOne({ emailNormalized: input.email, status: 'active' }).select('+passwordHash').lean();
    const valid = await verifyPassword(input.password, user?.passwordHash);
    if (!user || !valid) throw new HttpError(401, 'INVALID_CREDENTIALS', 'E-posta veya şifre hatalı.');
    let session, authenticatedUser;
    await models.User.db.transaction(async mongoSession => {
      // Recheck status inside the transaction before establishing the session.
      const active = await models.User.findOneAndUpdate({ _id: user._id, status: 'active', ...versionFilter(passwordVersion(user)) }, { $inc: { authMutationSequence: 1 } }, { session: mongoSession, returnDocument: 'after' }).lean();
      if (!active) throw new HttpError(401, 'INVALID_CREDENTIALS', 'E-posta veya şifre hatalı.');
      session = await createSession(models, config, active._id, req.authSession?._id, mongoSession, passwordVersion(active));
      authenticatedUser = active;
    }, transactionOptions);
    setSessionCookie(res, config, session.token);
    res.json({ user: userDto(authenticatedUser) });
  });

  router.post('/logout', requireCsrf, async (req, res) => {
    if (req.authSession) await models.Session.deleteOne({ _id: req.authSession._id });
    clearSessionCookie(res, config);
    res.status(204).end();
  });

  router.post('/password-reset/request', requireCsrf, async (req, res) => {
    const { email } = validation(z.object({ email: emailSchema }).strict(), req.body);
    const token = randomToken();
    await models.User.db.transaction(async session => {
      const user = await models.User.findOneAndUpdate({ emailNormalized: email, status: 'active', passwordHash: { $exists: true, $ne: null } }, { $inc: { authMutationSequence: 1 } }, { session, returnDocument: 'after' });
      if (!user) return;
      if (await models.PasswordReset.exists({ userId: user._id, createdAt: { $gt: new Date(Date.now() - 60000) } }).session(session)) return;
      await models.PasswordReset.updateMany({ userId: user._id, consumedAt: null }, { $set: { consumedAt: new Date() } }, { session });
      const [reset] = await models.PasswordReset.create([{ _id: randomUUID(), userId: user._id, passwordVersion: passwordVersion(user), tokenHash: digest(token), expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS), consumedAt: null }], { session });
      await mailer.enqueuePasswordReset({ user, token, reset }, session);
    }, transactionOptions);
    res.status(202).end();
  });

  router.post('/password-reset/confirm', requireCsrf, async (req, res) => {
    const { token, password } = validation(z.object({ token: tokenSchema, password: passwordSchema }).strict(), req.body);
    const candidate = await models.PasswordReset.findOne({ tokenHash: digest(token), consumedAt: null, expiresAt: { $gt: new Date() } }).lean();
    if (!candidate) throw new HttpError(404, 'RESET_UNAVAILABLE', 'Şifre sıfırlama bağlantısı geçersiz veya süresi dolmuş.');
    const passwordHash = await hashPassword(password);
    await models.User.db.transaction(async session => {
      const user = await models.User.findOneAndUpdate({ _id: candidate.userId, status: 'active', ...versionFilter(passwordVersion(candidate)) }, { $inc: { authMutationSequence: 1 } }, { session, returnDocument: 'after' });
      if (!user) throw new HttpError(404, 'RESET_UNAVAILABLE', 'Şifre sıfırlama bağlantısı geçersiz veya süresi dolmuş.');
      const reset = await models.PasswordReset.findOneAndUpdate({ _id: candidate._id, userId: user._id, tokenHash: digest(token), consumedAt: null, expiresAt: { $gt: new Date() } }, { $set: { consumedAt: new Date() } }, { session, returnDocument: 'after' });
      if (!reset) throw new HttpError(404, 'RESET_UNAVAILABLE', 'Şifre sıfırlama bağlantısı geçersiz veya süresi dolmuş.');
      await models.User.updateOne({ _id: user._id }, { $set: { passwordHash, passwordVersion: passwordVersion(user) + 1, emailVerifiedAt: user.emailVerifiedAt || new Date() } }, { session });
      await models.Verification.updateMany({ userId: user._id, consumedAt: null }, { $set: { consumedAt: new Date() } }, { session });
      await models.PasswordReset.updateMany({ userId: user._id, consumedAt: null }, { $set: { consumedAt: new Date() } }, { session });
      const sessions = await models.Session.find({ $or: [{ userId: user._id }, { _id: req.authSession._id }] }).select('_id').session(session).lean();
      const ids = sessions.map(item => item._id);
      await models.OAuthAttempt.updateMany({ consumedAt: null, $or: [{ userId: user._id }, { sessionId: { $in: ids } }] }, { $set: { consumedAt: new Date() } }, { session });
      await models.Session.deleteMany({ _id: { $in: ids } }, { session });
    }, transactionOptions);
    clearSessionCookie(res, config);
    res.status(204).end();
  });

  router.get('/identities', requireAuth, requireVerified, async (req, res) => {
    const user = await models.User.findOne({ _id: req.auth.user._id, status: 'active' }).select('+passwordHash').lean();
    if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'Devam etmek için giriş yap.');
    res.json({ google: Boolean(await models.AuthIdentity.exists({ userId: user._id, provider: 'google' })), hasPassword: Boolean(user.passwordHash) });
  });

  router.post('/google/link/start', requireAuth, requireVerified, requireCsrf, async (req, res) => {
    if (!config.googleClientId || !config.googleClientSecret) throw new HttpError(503, 'GOOGLE_NOT_CONFIGURED', 'Google ile giriş henüz yapılandırılmadı.');
    const input = validation(z.object({ password: z.string().min(1).max(128).optional() }).strict(), req.body || {});
    const credential = await models.User.findOne({ _id: req.auth.user._id, status: 'active' }).select('+passwordHash').lean();
    if (await models.AuthIdentity.exists({ userId: req.auth.user._id, provider: 'google' })) throw new HttpError(409, 'GOOGLE_ALREADY_LINKED', 'Google hesabın zaten bağlı.');
    if (!credential?.passwordHash || !input.password || !await verifyPassword(input.password, credential.passwordHash)) throw new HttpError(403, 'REAUTHENTICATION_REQUIRED', 'Google hesabını bağlamak için mevcut şifreni doğrula.');
    const state = randomToken(), nonce = randomToken(), codeVerifier = randomBytes(48).toString('base64url');
    await models.User.db.transaction(async session => {
      const user = await models.User.findOneAndUpdate({ _id: credential._id, status: 'active', emailVerifiedAt: { $ne: null }, ...versionFilter(passwordVersion(credential)) }, { $inc: { authMutationSequence: 1 } }, { session, returnDocument: 'after' });
      if (!user || !await models.Session.exists({ _id: req.authSession._id, userId: user._id, expiresAt: { $gt: new Date() }, revokedAt: null, ...versionFilter(passwordVersion(user)) }).session(session)) throw new HttpError(401, 'UNAUTHENTICATED', 'Devam etmek için giriş yap.');
      if (await models.AuthIdentity.exists({ userId: user._id, provider: 'google' }).session(session)) throw new HttpError(409, 'GOOGLE_ALREADY_LINKED', 'Google hesabın zaten bağlı.');
      await models.OAuthAttempt.create([{ _id: randomUUID(), intent: 'link', userId: user._id, passwordVersion: passwordVersion(user), authMutationSequence: user.authMutationSequence, stateHash: digest(state), sessionId: req.authSession._id, nonce, codeVerifier, returnTo: '/account', expiresAt: new Date(Date.now() + OAUTH_TTL_MS), consumedAt: null }], { session });
    }, transactionOptions);
    res.json({ authorizationUrl: googleAuthorizationUrl(config, { state, nonce, codeVerifier }) });
  });

  router.post('/email-verification/confirm', requireAuth, requireCsrf, async (req, res) => {
    const { token } = validation(z.object({ token: tokenSchema }).strict(), req.body);
    let result;
    await models.User.db.transaction(async mongoSession => {
      const verification = await models.Verification.findOneAndUpdate({
        tokenHash: digest(token), userId: req.auth.user._id,
        consumedAt: null, expiresAt: { $gt: new Date() },
      }, { $set: { consumedAt: new Date() } }, { session: mongoSession, returnDocument: 'after' });
      if (!verification) throw new HttpError(404, 'VERIFICATION_UNAVAILABLE', 'Doğrulama bağlantısı geçersiz veya süresi dolmuş.');
      result = await models.User.findOneAndUpdate({ _id: req.auth.user._id, status: 'active' }, {
        $set: { emailVerifiedAt: new Date() },
      }, { session: mongoSession, returnDocument: 'after' });
      if (!result) throw new HttpError(401, 'UNAUTHENTICATED', 'Devam etmek için giriş yap.');
    }, transactionOptions);
    // The session and CSRF token remain stable; verification only updates identity state.
    res.json({ user: userDto(result) });
  });

  router.post('/email-verification/resend', requireAuth, requireCsrf, async (req, res) => {
    const token = randomToken();
    await models.User.db.transaction(async mongoSession => {
      // A User write serializes two resends and conflicts with concurrent confirmation.
      const user = await models.User.findOneAndUpdate({
        _id: req.auth.user._id, status: 'active', emailVerifiedAt: null,
      }, { $inc: { authMutationSequence: 1 } }, { session: mongoSession, returnDocument: 'after' });
      if (!user) {
        const existing = await models.User.findOne({ _id: req.auth.user._id, status: 'active' }).session(mongoSession).lean();
        if (!existing) throw new HttpError(401, 'UNAUTHENTICATED', 'Devam etmek için giriş yap.');
        return; // Verified users do not need another email.
      }
      const recent = await models.Verification.findOne({
        userId: user._id, createdAt: { $gt: new Date(Date.now() - VERIFICATION_RESEND_INTERVAL_MS) },
      }).sort({ createdAt: -1 }).select('createdAt').session(mongoSession).lean();
      if (recent) {
        const remaining = VERIFICATION_RESEND_INTERVAL_MS - (Date.now() - recent.createdAt.getTime());
        res.set('Retry-After', String(Math.max(1, Math.ceil(remaining / 1000))));
        throw new HttpError(429, 'VERIFICATION_RESEND_LIMIT', 'Yeni doğrulama bağlantısı istemek için bir dakika bekle.');
      }
      await models.Verification.updateMany({ userId: user._id, consumedAt: null }, {
        $set: { consumedAt: new Date() },
      }, { session: mongoSession });
      await models.Verification.create([{
        _id: randomUUID(), userId: user._id, tokenHash: digest(token),
        expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS), consumedAt: null,
      }], { session: mongoSession });
      await mailer.enqueueVerification({ user, token }, mongoSession);
    }, transactionOptions);
    res.status(204).end();
  });

  router.get('/google/start', async (req, res) => {
    if (!config.googleClientId || !config.googleClientSecret) {
      throw new HttpError(503, 'GOOGLE_NOT_CONFIGURED', 'Google ile giriş henüz yapılandırılmadı. E-posta ve şifre ile devam edebilirsin.');
    }
    const session = await ensureAnonymousSession(req, res, models, config);
    const state = randomToken();
    const nonce = randomToken();
    const codeVerifier = randomBytes(48).toString('base64url');
    await models.OAuthAttempt.create({
      _id: randomUUID(), stateHash: digest(state), sessionId: session._id,
      nonce, codeVerifier, returnTo: safeReturnTo(req.query.returnTo),
      expiresAt: new Date(Date.now() + OAUTH_TTL_MS), consumedAt: null,
      intent: 'login', ...(req.auth ? { userId: req.auth.user._id, passwordVersion: passwordVersion(req.auth.user) } : {}),
    });
    res.redirect(302, googleAuthorizationUrl(config, { state, nonce, codeVerifier }));
  });

  router.get('/google/callback', async (req, res) => {
    let linkAttempt = false;
    const fail = async code => {
      const allowed = new Set(['google_cancelled', 'google_failed', 'google_account_link_required', 'google_state_invalid', 'google_unavailable']);
      let accountContext = false;
      if (linkAttempt && req.auth) {
        try { accountContext = Boolean(await models.Session.exists({ _id: req.authSession._id, userId: req.auth.user._id, expiresAt: { $gt: new Date() }, revokedAt: null, ...versionFilter(passwordVersion(req.auth.user)) })); } catch { /* A missing session or unavailable identity service returns to login. */ }
      }
      const destination = new URL(accountContext ? '/account' : '/login', config.frontendOrigin);
      destination.searchParams.set('authError', allowed.has(code) ? code : 'google_failed');
      return res.redirect(303, destination.toString());
    };
    try {
    if (!config.googleClientId || !config.googleClientSecret) throw new HttpError(503, 'GOOGLE_NOT_CONFIGURED', 'Google ile giriş henüz yapılandırılmadı.');
    const parsedState = tokenSchema.safeParse(req.query.state);
    if (!parsedState.success) throw new HttpError(400, 'OAUTH_STATE_INVALID', 'Giriş oturumu geçersiz.');
    const state = parsedState.data;
    if (!req.authSession) throw new HttpError(400, 'OAUTH_STATE_INVALID', 'Giriş oturumu geçersiz. Yeniden giriş yap.');
    const attempt = await models.OAuthAttempt.findOneAndUpdate({
      stateHash: digest(state), sessionId: req.authSession._id, consumedAt: null, expiresAt: { $gt: new Date() },
    }, { $set: { consumedAt: new Date() } }, { returnDocument: 'after' }).lean();
    if (!attempt) {
      if (req.auth) linkAttempt = (await models.OAuthAttempt.findOne({ stateHash: digest(state), sessionId: req.authSession._id }).select('intent').lean())?.intent === 'link';
      throw new HttpError(400, 'OAUTH_STATE_INVALID', 'Giriş oturumu geçersiz. Yeniden giriş yap.');
    }
    linkAttempt = attempt.intent === 'link';
    if (linkAttempt && (!req.auth || req.auth.user._id !== attempt.userId || passwordVersion(req.auth.user) !== attempt.passwordVersion)) throw new HttpError(400, 'OAUTH_STATE_INVALID', 'Giriş oturumu geçersiz.');
    // Consent errors consume the same browser-bound state as a successful callback.
    if (req.query.error !== undefined) return fail(req.query.error === 'access_denied' ? 'google_cancelled' : 'google_failed');
    const { code } = validation(z.object({ code: z.string().min(1).max(4096) }), req.query);
    let claims;
    try {
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', signal: AbortSignal.timeout(10000), redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: config.googleClientId, client_secret: config.googleClientSecret,
          redirect_uri: `${config.apiOrigin}/api/v1/auth/google/callback`,
          grant_type: 'authorization_code', code_verifier: attempt.codeVerifier,
        }),
      });
      if (!response.ok) throw new Error('Provider exchange failed');
      const payload = await response.json();
      if (typeof payload.id_token !== 'string') throw new Error('Provider identity missing');
      const verified = await jwtVerify(payload.id_token, googleKeys, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: config.googleClientId, algorithms: ['RS256'], maxTokenAge: '10 minutes', clockTolerance: 30,
        requiredClaims: ['exp', 'iat', 'sub', 'aud', 'iss', 'nonce', 'email', 'email_verified'],
      });
      claims = verified.payload;
      if (!equalText(claims.nonce, attempt.nonce) || claims.email_verified !== true || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new Error('Provider identity invalid');
      if (!emailSchema.safeParse(claims.email).success) throw new Error('Provider email invalid');
      if ((claims.azp !== undefined && claims.azp !== config.googleClientId) || (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== config.googleClientId)) throw new Error('Provider authorized party invalid');
    } catch {
      // Never include provider responses, authorization codes or tokens in errors/logs.
      throw new HttpError(400, 'GOOGLE_AUTH_FAILED', 'Google ile giriş doğrulanamadı. Yeniden dene.');
    }
    let result;
    try {
      await models.User.db.transaction(async mongoSession => {
        if (!await models.Session.exists({ _id: attempt.sessionId, expiresAt: { $gt: new Date() }, revokedAt: null }).session(mongoSession)) throw new HttpError(400, 'OAUTH_STATE_INVALID', 'Giriş oturumu geçersiz.');
        if (linkAttempt) {
          const user = await models.User.findOneAndUpdate({ _id: attempt.userId, status: 'active', emailVerifiedAt: { $ne: null }, authMutationSequence: attempt.authMutationSequence, ...versionFilter(attempt.passwordVersion) }, { $inc: { authMutationSequence: 1 } }, { session: mongoSession, returnDocument: 'after' });
          if (!user) throw new HttpError(400, 'OAUTH_STATE_INVALID', 'Giriş oturumu geçersiz.');
          const identity = await models.AuthIdentity.findOne({ provider: 'google', subject: claims.sub }).session(mongoSession).lean();
          if (identity && identity.userId !== user._id) throw new HttpError(409, 'ACCOUNT_LINK_REQUIRED', 'Bu Google hesabı başka hesaba bağlı.');
          const existing = await models.AuthIdentity.findOne({ provider: 'google', userId: user._id }).session(mongoSession).lean();
          if (existing && existing.subject !== claims.sub) throw new HttpError(409, 'ACCOUNT_LINK_REQUIRED', 'Google hesabın zaten bağlı.');
          if (!identity) await models.AuthIdentity.create([{ _id: randomUUID(), userId: user._id, provider: 'google', subject: claims.sub }], { session: mongoSession });
          const session = await createSession(models, config, user._id, req.authSession._id, mongoSession, passwordVersion(user));
          result = { user, session };
          return;
        }
        const identity = await models.AuthIdentity.findOne({ provider: 'google', subject: claims.sub }).session(mongoSession).lean();
        let user;
        if (identity) {
          user = await models.User.findOneAndUpdate({ _id: identity.userId, status: 'active' }, { $inc: { authMutationSequence: 1 } }, { session: mongoSession, returnDocument: 'after' });
          if (!user) throw new HttpError(403, 'ACCOUNT_UNAVAILABLE', 'Bu hesapla giriş yapılamıyor.');
        } else {
          const email = emailSchema.parse(claims.email);
          const existing = await models.User.findOne({ emailNormalized: email }).session(mongoSession).lean();
          if (existing) throw new HttpError(409, 'ACCOUNT_LINK_REQUIRED', 'Bu e-posta ile hesabın zaten var. Önce e-posta ve şifre ile giriş yap.');
          const candidateName = typeof claims.name === 'string' ? claims.name.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100) : '';
          const emailDomain = email.slice(email.lastIndexOf('@') + 1);
          const hostedDomain = typeof claims.hd === 'string' ? claims.hd.toLowerCase() : '';
          // Google is authoritative for Gmail and its hosted email domains, not arbitrary third-party mailboxes.
          const authoritativeEmail = emailDomain === 'gmail.com' || (hostedDomain !== '' && hostedDomain === emailDomain);
          [user] = await models.User.create([{
            _id: randomUUID(), name: candidateName || email.split('@')[0], emailNormalized: email,
            emailVerifiedAt: authoritativeEmail ? new Date() : null, status: 'active',
          }], { session: mongoSession });
          await models.AuthIdentity.create([{
            _id: randomUUID(), userId: user._id, provider: 'google', subject: claims.sub,
          }], { session: mongoSession });
          if (!authoritativeEmail) {
            const verificationToken = randomToken();
            await models.Verification.create([{
              _id: randomUUID(), userId: user._id, tokenHash: digest(verificationToken),
              expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS), consumedAt: null,
            }], { session: mongoSession });
            await mailer.enqueueVerification({ user, token: verificationToken }, mongoSession);
          }
        }
        const session = await createSession(models, config, user._id, req.authSession._id, mongoSession, passwordVersion(user));
        result = { user, session };
      }, transactionOptions);
    } catch (error) { duplicateAccount(error); }
    setSessionCookie(res, config, result.session.token);
    res.redirect(303, new URL(linkAttempt ? '/account?linked=google' : safeReturnTo(attempt.returnTo), config.frontendOrigin).toString());
    } catch (error) {
      const failures = {
        GOOGLE_NOT_CONFIGURED: 'google_unavailable', OAUTH_STATE_INVALID: 'google_state_invalid',
        ACCOUNT_LINK_REQUIRED: 'google_account_link_required', ACCOUNT_EXISTS: 'google_account_link_required',
      };
      // This is a browser navigation: expose only an allowlisted code at our own frontend.
      return fail(failures[error?.code] || 'google_failed');
    }
  });

  return router;
}
