import {randomUUID,randomBytes} from 'node:crypto'
import assert from 'node:assert/strict'
import {createConfig} from '../src/config.mjs'

const config=createConfig()
if(config.production || !config.apiOrigin.startsWith('http://127.0.0.1:')) throw new Error('This smoke check is limited to the local development environment.')
const cookies=new Map()
let csrf
async function request(path,method='GET',body) {
  const headers=new Headers({Origin:config.frontendOrigin})
  if(cookies.size)headers.set('Cookie',[...cookies].map(([key,value])=>`${key}=${value}`).join('; '))
  if(csrf)headers.set('X-CSRF-Token',csrf)
  if(body)headers.set('Content-Type','application/json')
  const result=await fetch(`${config.apiOrigin}/api/v1${path}`,{method,headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)})
  for(const item of result.headers.getSetCookie()){const [key,value]=item.split(';')[0].split('=');cookies.set(key,value)}
  assert.ok(result.ok,`${method} ${path}: HTTP ${result.status}`)
  const text=await result.text()
  return text?JSON.parse(text):null
}
csrf=(await request('/auth/csrf-token')).csrfToken
const email=`local-check-${randomUUID()}@example.test`,password=randomBytes(24).toString('base64url')
await request('/auth/register','POST',{name:'Yerel API Kontrolü',email,password})
csrf=(await request('/auth/csrf-token')).csrfToken
async function waitForMessage(fragment){
for(let attempt=0;attempt<24;attempt++) {
  const response=await fetch('http://127.0.0.1:8025/api/v1/messages',{signal:AbortSignal.timeout(5000)})
  assert.ok(response.ok,'Local test mailbox is available')
  const messages=await response.json()
  for(const record of messages.messages.filter(item=>item.To?.some(recipient=>recipient.Address===email))){
    const message=await(await fetch(`http://127.0.0.1:8025/api/v1/message/${record.ID}`,{signal:AbortSignal.timeout(5000)})).json()
    if(message.Text.includes(fragment))return message
  }
  await new Promise(resolve=>setTimeout(resolve,500))
}
throw new Error('SMTP message did not arrive in local Mailpit.')
}
const message=await waitForMessage('/verify-email#')
assert.ok(message,'SMTP delivered the verification message into local Mailpit')
const token=message.Text.match(/#token=([A-Za-z0-9_-]+)/)?.[1]
assert.ok(token,'Verification message contains a fragment link')
assert.equal((await request('/auth/email-verification/confirm','POST',{token})).user.emailVerified,true)
const workspace=await request('/workspaces','POST',{name:'Yerel bağlantı kontrolü'})
assert.equal(workspace.role,'owner')
await request(`/workspaces/${workspace.id}`,'DELETE')
await request('/auth/logout','POST')
csrf=(await request('/auth/csrf-token')).csrfToken
assert.equal((await request('/auth/login','POST',{email,password})).user.emailVerified,true)
csrf=(await request('/auth/csrf-token')).csrfToken
await request('/auth/password-reset/request','POST',{email})
const resetMessage=await waitForMessage('/reset-password#')
const resetToken=resetMessage.Text.match(/#token=([A-Za-z0-9_-]+)/)?.[1]
assert.ok(resetToken,'Password reset message contains its fragment link')
const newPassword=randomBytes(24).toString('base64url')
await request('/auth/password-reset/confirm','POST',{token:resetToken,password:newPassword})
cookies.clear();csrf=undefined
csrf=(await request('/auth/csrf-token')).csrfToken
assert.equal((await request('/auth/login','POST',{email,password:newPassword})).user.emailVerified,true)
csrf=(await request('/auth/csrf-token')).csrfToken
await request('/auth/logout','POST')
console.log('Yerel API + gerçek SMTP/Mailpit: kayıt, doğrulama, Owner workspace, parola sıfırlama ve yeni parolayla giriş başarılı. Test kimlik bilgileri yazdırılmadı.')
