import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomBytes,randomUUID} from 'node:crypto'
import {generateKeyPair,exportJWK,SignJWT} from 'jose'
import {createHarness} from './helpers.mjs'

const googleConfig={GOOGLE_CLIENT_ID:'advanced-client',GOOGLE_CLIENT_SECRET:'advanced-secret'}
const hash=value=>createHash('sha256').update(value).digest('hex')
const resetToken=mail=>mail.text.match(/\/reset-password#token=([A-Za-z0-9_-]+)/)?.[1]
async function csrf(h,agent){return (await agent.get('/api/v1/auth/csrf-token').expect(200)).body.csrfToken}
async function post(h,agent,path,body){const key=await csrf(h,agent);return agent.post(`/api/v1/auth${path}`).set('Origin',h.config.frontendOrigin).set('X-CSRF-Token',key).send(body)}
async function requestReset(h,agent,email){return post(h,agent,'/password-reset/request',{email})}
async function resetLink(h,email){await h.flushMail();const mail=h.mail.findLast(item=>item.to===email&&resetToken(item));assert.ok(mail);return resetToken(mail)}
let signingKeys
async function provider(t,h,{beforeExchange}={}){
  if(!signingKeys){const keys=await generateKeyPair('RS256');signingKeys={...keys,jwk:{...await exportJWK(keys.publicKey),kid:'advanced-test-key',alg:'RS256',use:'sig'}}}
  let idToken
  t.mock.method(globalThis,'fetch',async url=>{
    if(String(url)==='https://oauth2.googleapis.com/token'){await beforeExchange?.();return Response.json({id_token:idToken})}
    if(String(url)==='https://www.googleapis.com/oauth2/v3/certs')return Response.json({keys:[signingKeys.jwk]})
    throw new Error('Unexpected external URL')
  })
  return {async token(url,subject,email='linked-google@gmail.com'){
    const auth=new URL(url)
    idToken=await new SignJWT({sub:subject,email,email_verified:true,nonce:auth.searchParams.get('nonce')}).setProtectedHeader({alg:'RS256',kid:signingKeys.jwk.kid}).setIssuer('https://accounts.google.com').setAudience(h.config.googleClientId).setIssuedAt().setExpirationTime('5 minutes').sign(signingKeys.privateKey)
    return {state:auth.searchParams.get('state'),code:'local-provider-code'}
  }}
}
function errorRedirect(response,h,path,code){assert.equal(response.status,303);const url=new URL(response.headers.location);assert.equal(url.origin,h.config.frontendOrigin);assert.equal(url.pathname,path);assert.deepEqual([...url.searchParams],[['authError',code]])}

test('Google login resumes an invitation through encrypted browser-bound context and still requires explicit acceptance',async t=>{
  const h=await createHarness('oauth-invite',googleConfig);t.after(()=>h.close());const fake=await provider(t,h)
  const owner=await h.user(),workspace=(await owner.request('post','/workspaces',{name:'OAuth invitation'})).body
  assert.equal((await owner.request('post',`/workspaces/${workspace.id}/invitations`,{email:'resume-invite@gmail.com',role:'viewer'})).status,201)
  await h.flushMail();const token=h.mail.findLast(item=>item.to==='resume-invite@gmail.com').text.match(/#token=([A-Za-z0-9_-]+)/)[1]
  const agent=h.client(),start=await post(h,agent,'/google/start',{returnTo:'/invitations/accept',invitationToken:token})
  assert.equal(start.status,200);assert.ok(!start.body.authorizationUrl.includes(token))
  const query=await fake.token(start.body.authorizationUrl,'resume-invitation','resume-invite@gmail.com')
  const attempt=await h.models.OAuthAttempt.findOne({stateHash:hash(query.state)}).lean()
  assert.ok(attempt.invitationContext);assert.ok(!JSON.stringify(attempt).includes(token))
  const response=await agent.get('/api/v1/auth/google/callback').query(query).expect(303)
  const destination=new URL(response.headers.location)
  assert.equal(destination.origin,h.config.frontendOrigin);assert.equal(destination.pathname,'/invitations/accept');assert.equal(new URLSearchParams(destination.hash.slice(1)).get('token'),token)
  const consumed=await h.models.OAuthAttempt.findById(attempt._id).lean();assert.ok(consumed.consumedAt);assert.equal(consumed.invitationContext,undefined)
  assert.equal(await h.models.Membership.countDocuments({workspaceId:workspace.id,status:'active'}),1)
  const key=await csrf(h,agent)
  await agent.post('/api/v1/invitations/inspect').set('Origin',h.config.frontendOrigin).set('X-CSRF-Token',key).send({token}).expect(200)
  await agent.post('/api/v1/invitations/accept').set('Origin',h.config.frontendOrigin).set('X-CSRF-Token',key).send({token}).expect(200)
  assert.equal(await h.models.Membership.countDocuments({workspaceId:workspace.id,status:'active',role:'viewer'}),1)
  const replay=await agent.get('/api/v1/auth/google/callback').query(query).expect(303);assert.equal(new URL(replay.headers.location).hash,'')
})

test('Google invitation start requires CSRF, hides tokens from Google and restores consent cancellation only to the same session',async t=>{
  const h=await createHarness('oauth-cancel',googleConfig);t.after(()=>h.close())
  const agent=h.client(),token=randomBytes(32).toString('base64url'),body={returnTo:'/invitations/accept',invitationToken:token}
  await agent.post('/api/v1/auth/google/start').set('Origin',h.config.frontendOrigin).send(body).expect(403)
  const key=await csrf(h,agent)
  await agent.post('/api/v1/auth/google/start').set('Origin','https://attacker.example').set('X-CSRF-Token',key).send(body).expect(403)
  assert.equal((await post(h,agent,'/google/start',{...body,returnTo:'/workspaces'})).status,400)
  assert.equal((await post(h,agent,'/google/start',{...body,extra:true})).status,400)
  await agent.get('/api/v1/auth/google/start').query(body).expect(400)
  const start=await post(h,agent,'/google/start',body),url=new URL(start.body.authorizationUrl),state=url.searchParams.get('state')
  assert.equal(url.origin,'https://accounts.google.com');assert.ok(!start.body.authorizationUrl.includes(token))
  const stranger=h.client();await csrf(h,stranger)
  const denied=await stranger.get('/api/v1/auth/google/callback').query({state,error:'access_denied'}).expect(303)
  assert.equal(new URL(denied.headers.location).hash,'')
  const cancelled=await agent.get('/api/v1/auth/google/callback').query({state,error:'access_denied'}).expect(303)
  const destination=new URL(cancelled.headers.location)
  assert.equal(destination.pathname,'/login');assert.equal(destination.searchParams.get('authError'),'google_cancelled');assert.equal(destination.searchParams.get('returnTo'),'/invitations/accept')
  assert.equal(new URLSearchParams(destination.hash.slice(1)).get('invitationToken'),token)
  assert.equal((await h.models.OAuthAttempt.findOne({stateHash:hash(state)}).lean()).invitationContext,undefined)
})

test('tampered, swapped and expired OAuth invitation context cannot recover a token',async t=>{
  const h=await createHarness('oauth-tamper',googleConfig);t.after(()=>h.close());const agent=h.client()
  async function start(){const response=await post(h,agent,'/google/start',{returnTo:'/invitations/accept',invitationToken:randomBytes(32).toString('base64url')});assert.equal(response.status,200);const state=new URL(response.body.authorizationUrl).searchParams.get('state');return {state,attempt:await h.models.OAuthAttempt.findOne({stateHash:hash(state)}).lean()}}
  const first=await start(),second=await start()
  await h.models.OAuthAttempt.updateOne({_id:second.attempt._id},{$set:{invitationContext:first.attempt.invitationContext}})
  const swapped=await agent.get('/api/v1/auth/google/callback').query({state:second.state,error:'access_denied'}).expect(303)
  assert.equal(new URL(swapped.headers.location).searchParams.get('authError'),'google_state_invalid');assert.equal(new URL(swapped.headers.location).hash,'')
  await h.models.OAuthAttempt.updateOne({_id:first.attempt._id},{$set:{expiresAt:new Date(Date.now()-1000)}})
  const expired=await agent.get('/api/v1/auth/google/callback').query({state:first.state,error:'access_denied'}).expect(303)
  assert.equal(new URL(expired.headers.location).hash,'');assert.equal(new URL(expired.headers.location).searchParams.get('authError'),'google_state_invalid')
})

test('password reset is generic, single-use, verifies mailbox and revokes all sessions and pending OAuth',async t=>{
  const h=await createHarness('reset-main');t.after(()=>h.close())
  const account=await h.user({email:'reset-main@example.com',verified:false})
  const another=h.client();assert.equal((await post(h,another,'/login',{email:account.user.email,password:account.password})).status,200)
  const existing=await h.models.Session.findOne({userId:account.user.id}).lean()
  await h.models.OAuthAttempt.create({stateHash:hash('pending-state'),sessionId:existing._id,intent:'link',userId:account.user.id,nonce:'nonce',codeVerifier:'verifier',returnTo:'/account',expiresAt:new Date(Date.now()+600000)})
  const recovery=h.client()
  const missing=await requestReset(h,recovery,'unknown@example.com');assert.equal(missing.status,202);assert.equal(missing.text,'')
  assert.equal((await requestReset(h,recovery,account.user.email)).status,202)
  assert.equal((await requestReset(h,recovery,account.user.email)).status,202)
  assert.equal(await h.models.PasswordReset.countDocuments({}),1)
  const token=await resetLink(h,account.user.email)
  const record=await h.models.PasswordReset.findOne({userId:account.user.id}).lean();assert.equal(record.tokenHash,hash(token));assert.equal(record.passwordVersion,1)
  assert.ok(h.mail.find(item=>resetToken(item)).text.includes('#token='))
  const changed=await post(h,recovery,'/password-reset/confirm',{token,password:'Replacement123!'})
  assert.equal(changed.status,204);assert.match(changed.headers['set-cookie'][0],/Expires=Thu, 01 Jan 1970/i)
  assert.equal(await h.models.Session.countDocuments({userId:account.user.id}),0)
  assert.equal(await h.models.OAuthAttempt.countDocuments({userId:account.user.id,consumedAt:null}),0)
  assert.equal(await h.models.Verification.countDocuments({userId:account.user.id,consumedAt:null}),0)
  const user=await h.models.User.findById(account.user.id).select('+passwordHash').lean();assert.equal(user.passwordVersion,2);assert.ok(user.emailVerifiedAt);assert.notEqual(user.passwordHash,'Replacement123!')
  await account.agent.get('/api/v1/auth/me').expect(401);await another.get('/api/v1/auth/me').expect(401);await recovery.get('/api/v1/auth/me').expect(401)
  assert.equal((await post(h,recovery,'/password-reset/confirm',{token,password:'Again123!'})).status,404)
  assert.equal((await post(h,recovery,'/login',{email:account.user.email,password:account.password})).status,401)
  const signed=await post(h,recovery,'/login',{email:account.user.email,password:'Replacement123!'});assert.equal(signed.status,200);assert.equal(signed.body.user.emailVerified,true)
  const stale=randomBytes(32).toString('base64url');await h.models.Session.create({tokenHash:hash(stale),csrfToken:'stale',userId:user._id,passwordVersion:1,expiresAt:new Date(Date.now()+600000)})
  await h.client().get('/api/v1/auth/me').set('Cookie',`${h.config.cookieName}=${stale}`).expect(401)
})

test('reset request replaces older tokens and expiry is enforced before TTL cleanup',async t=>{
  const h=await createHarness('reset-expire');t.after(()=>h.close())
  const account=await h.user({email:'reset-expire@example.com'}),agent=h.client()
  await requestReset(h,agent,account.user.email);const old=await resetLink(h,account.user.email)
  await h.models.PasswordReset.collection.updateMany({userId:account.user.id},{$set:{createdAt:new Date(Date.now()-61000)}})
  await requestReset(h,agent,account.user.email);const current=await resetLink(h,account.user.email);assert.notEqual(current,old)
  assert.equal((await post(h,agent,'/password-reset/confirm',{token:old,password:'Replacement123!'})).status,404)
  await h.models.PasswordReset.updateOne({tokenHash:hash(current)},{$set:{expiresAt:new Date(Date.now()-1000)}})
  assert.equal((await post(h,agent,'/password-reset/confirm',{token:current,password:'Replacement123!'})).status,404)
  assert.equal((await h.models.User.findById(account.user.id).lean()).passwordVersion,1)
  await agent.post('/api/v1/auth/password-reset/request').set('Origin',h.config.frontendOrigin).send({email:account.user.email}).expect(403)
})

test('two simultaneous reset confirmations change credentials exactly once',async t=>{
  const h=await createHarness('reset-race');t.after(()=>h.close())
  const account=await h.user({email:'reset-race@example.com'}),agent=h.client()
  await requestReset(h,agent,account.user.email);const token=await resetLink(h,account.user.email),key=await csrf(h,agent)
  const invoke=()=>agent.post('/api/v1/auth/password-reset/confirm').set('Origin',h.config.frontendOrigin).set('X-CSRF-Token',key).send({token,password:'Replacement123!'})
  const result=await Promise.all([invoke(),invoke()]);assert.deepEqual(result.map(item=>item.status).sort(),[204,404]);assert.equal((await h.models.User.findById(account.user.id).lean()).passwordVersion,2)
})

test('credentials read before a completed reset cannot create a new session',async t=>{
  const h=await createHarness('reset-loginrace');t.after(()=>h.close())
  const account=await h.user({email:'reset-loginrace@example.com'}),recovery=h.client(),loginAgent=h.client()
  await requestReset(h,recovery,account.user.email);const token=await resetLink(h,account.user.email),key=await csrf(h,loginAgent)
  let release,notify;const gate=new Promise(resolve=>{release=resolve}),read=new Promise(resolve=>{notify=resolve});let intercepted=false
  const original=h.models.User.findOne.bind(h.models.User)
  t.mock.method(h.models.User,'findOne',(filter,...args)=>{
    const query=original(filter,...args)
    if(filter.emailNormalized===account.user.email&&!intercepted){intercepted=true;const exec=query.exec.bind(query);query.exec=async(...params)=>{const result=await exec(...params);notify();await gate;return result}}
    return query
  })
  const pending=loginAgent.post('/api/v1/auth/login').set('Origin',h.config.frontendOrigin).set('X-CSRF-Token',key).send({email:account.user.email,password:account.password}).then(result=>result)
  try{await read;assert.equal((await post(h,recovery,'/password-reset/confirm',{token,password:'Replacement123!'})).status,204)}finally{release()}
  assert.equal((await pending).status,401);assert.equal(await h.models.Session.countDocuments({userId:account.user.id}),0)
})

test('explicit Google linking requires reauthentication, preserves local email and rotates session',async t=>{
  const h=await createHarness('link-main',googleConfig);t.after(()=>h.close());const fake=await provider(t,h)
  const account=await h.user({email:'local-account@example.com'}),unverified=await h.user({email:'not-verified@example.com',verified:false})
  assert.deepEqual((await account.agent.get('/api/v1/auth/identities').expect(200)).body,{google:false,hasPassword:true})
  assert.equal((await account.request('post','/auth/google/link/start',{})).status,403)
  assert.equal((await account.request('post','/auth/google/link/start',{password:'Wrong123!'})).status,403)
  assert.equal((await unverified.request('post','/auth/google/link/start',{password:unverified.password})).status,403)
  await account.agent.post('/api/v1/auth/google/link/start').set('Origin',h.config.frontendOrigin).send({password:account.password}).expect(403)
  const oldSession=await h.models.Session.findOne({userId:account.user.id}).lean()
  const start=await account.request('post','/auth/google/link/start',{password:account.password}).expect(200)
  const authorization=new URL(start.body.authorizationUrl);assert.equal(authorization.origin,'https://accounts.google.com')
  const query=await fake.token(start.body.authorizationUrl,'explicit-subject')
  const callback=await account.agent.get('/api/v1/auth/google/callback').query(query).expect(303)
  assert.equal(callback.headers.location,`${h.config.frontendOrigin}/account?linked=google`)
  assert.equal(await h.models.Session.countDocuments({_id:oldSession._id}),0)
  const identity=await h.models.AuthIdentity.findOne({provider:'google',subject:'explicit-subject'}).lean();assert.equal(identity.userId,account.user.id)
  const user=(await account.agent.get('/api/v1/auth/me').expect(200)).body.user;assert.equal(user.email,account.user.email);assert.equal(user.id,account.user.id)
  assert.deepEqual((await account.agent.get('/api/v1/auth/identities').expect(200)).body,{google:true,hasPassword:true})
  assert.equal((await post(h,account.agent,'/google/link/start',{password:account.password})).status,409)
  const browser=h.client(),login=await browser.get('/api/v1/auth/google/start').expect(302)
  await browser.get('/api/v1/auth/google/callback').query(await fake.token(login.headers.location,'explicit-subject')).expect(303)
  assert.equal((await browser.get('/api/v1/auth/me').expect(200)).body.user.id,account.user.id)
})

test('a Google identity owned by another user cannot be linked and a revoked session invalidates pending linking',async t=>{
  const h=await createHarness('link-conflict',googleConfig);t.after(()=>h.close());const fake=await provider(t,h)
  const account=await h.user({email:'link-a@example.com'}),other=await h.user({email:'link-b@example.com'})
  await h.models.AuthIdentity.create({userId:other.user.id,provider:'google',subject:'already-owned'})
  const start=await account.request('post','/auth/google/link/start',{password:account.password}).expect(200),query=await fake.token(start.body.authorizationUrl,'already-owned')
  errorRedirect(await account.agent.get('/api/v1/auth/google/callback').query(query),h,'/account','google_account_link_required')
  assert.equal(await h.models.AuthIdentity.countDocuments({userId:account.user.id}),0)
  errorRedirect(await account.agent.get('/api/v1/auth/google/callback').query(query),h,'/account','google_state_invalid')
  const next=await account.request('post','/auth/google/link/start',{password:account.password}).expect(200),expired=await fake.token(next.body.authorizationUrl,'new-subject')
  await account.request('post','/auth/logout').expect(204)
  errorRedirect(await account.agent.get('/api/v1/auth/google/callback').query(expired),h,'/login','google_state_invalid')
  assert.equal(await h.models.AuthIdentity.countDocuments({userId:account.user.id}),0)
})

test('Google linking state is bound to its browser and cancellation consumes it without reflecting provider text',async t=>{
  const h=await createHarness('link-binding',googleConfig);t.after(()=>h.close());const fake=await provider(t,h)
  const account=await h.user(),other=await h.user()
  const start=await account.request('post','/auth/google/link/start',{password:account.password}).expect(200)
  const query=await fake.token(start.body.authorizationUrl,'bound-subject')
  errorRedirect(await other.agent.get('/api/v1/auth/google/callback').query(query),h,'/login','google_state_invalid')
  assert.equal(await h.models.OAuthAttempt.countDocuments({stateHash:hash(query.state),consumedAt:null}),1)
  errorRedirect(await account.agent.get('/api/v1/auth/google/callback').query({state:query.state,error:'access_denied',error_description:'private-token-provider-details'}),h,'/account','google_cancelled')
  assert.equal(await h.models.AuthIdentity.countDocuments({userId:account.user.id}),0)
  errorRedirect(await account.agent.get('/api/v1/auth/google/callback').query(query),h,'/account','google_state_invalid')
})

test('password reset during Google exchange prevents a stale callback from linking or recreating a session',async t=>{
  const h=await createHarness('link-reset-race',googleConfig);t.after(()=>h.close())
  let release,notify;const gate=new Promise(resolve=>{release=resolve}),exchange=new Promise(resolve=>{notify=resolve})
  const fake=await provider(t,h,{beforeExchange:async()=>{notify();await gate}})
  const account=await h.user(),recovery=h.client()
  await requestReset(h,recovery,account.user.email);const reset=await resetLink(h,account.user.email)
  const start=await account.request('post','/auth/google/link/start',{password:account.password}).expect(200)
  const query=await fake.token(start.body.authorizationUrl,'stale-link-subject')
  const callback=account.agent.get('/api/v1/auth/google/callback').query(query).then(result=>result)
  try{await exchange;assert.equal((await post(h,recovery,'/password-reset/confirm',{token:reset,password:'Replacement123!'})).status,204)}finally{release()}
  errorRedirect(await callback,h,'/login','google_state_invalid')
  assert.equal(await h.models.AuthIdentity.countDocuments({userId:account.user.id}),0)
  assert.equal(await h.models.Session.countDocuments({userId:account.user.id}),0)
})

test('disabled and Google-only accounts get the same recovery response without a password reset mail',async t=>{
  const h=await createHarness('reset-filter');t.after(()=>h.close())
  const disabled=await h.user(),googleOnly=await h.user(),recovery=h.client()
  await h.models.User.updateOne({_id:disabled.user.id},{$set:{status:'disabled'}})
  await h.models.User.updateOne({_id:googleOnly.user.id},{$unset:{passwordHash:1}})
  for(const email of [disabled.user.email,googleOnly.user.email,'unknown@example.com']){
    const result=await requestReset(h,recovery,email);assert.equal(result.status,202);assert.equal(result.text,'')
  }
  assert.equal(await h.models.PasswordReset.countDocuments({}),0)
  await h.flushMail();assert.equal(h.mail.filter(resetToken).length,0)
})
