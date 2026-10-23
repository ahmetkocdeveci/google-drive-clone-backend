import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {existsSync} from 'node:fs'
import {createHarness} from './helpers.mjs'
import {startBackgroundWork} from '../src/background.mjs'

const frontend=new URL('../../google-drive-clone-frontend/app/services/http-drive-api.ts',import.meta.url)
test('cancelled ready downloads release real API archive slots so repeated retries remain available', {skip:!existsSync(frontend)}, async t=>{
  const {createHttpDriveApi}=await import(frontend.href)
  const h=await createHarness('cancelretry')
  t.after(()=>h.close())
  const owner=await h.user()
  const workspace=(await owner.request('post','/workspaces',{name:'Cancellation regression'}).expect(201)).body
  const folder=(await owner.request('post',`/workspaces/${workspace.id}/folders`,{name:'Folder',parentId:null}).expect(201)).body
  let deletes=0
  for(let attempt=0;attempt<4;attempt++) {
    const caller=new AbortController()
    const api=createHttpDriveApi({fetch:async(input,init)=>{
      const url=String(input),route=url.replace('/api/v1','')
      if(url.endsWith('/auth/csrf-token'))return Response.json({csrfToken:owner.csrf})
      if(init?.method==='DELETE') {
        const response=await owner.request('delete',route).expect(204)
        deletes++;assert.equal(init.signal.aborted,false)
        return new Response(null,{status:response.status})
      }
      // Control only readiness/body interruption; creation, cancellation and quota checks use real routes/MongoDB.
      if(url.endsWith('/content'))return new Response(new ReadableStream({start(stream){
        stream.enqueue(new Uint8Array([80,75]))
        init.signal.addEventListener('abort',()=>stream.error(init.signal.reason),{once:true})
        queueMicrotask(()=>caller.abort())
      }}))
      const response=await owner.request('post',route,JSON.parse(init.body)).expect(202)
      await h.models.Archive.updateOne({_id:response.body.id,workspaceId:workspace.id},{$set:{status:'ready'}})
      return Response.json({...response.body,status:'ready'},{status:202})
    }})
    await assert.rejects(api.downloadFolder(workspace.id,folder.id,{signal:caller.signal}),{name:'AbortError'})
    assert.equal(await h.models.Archive.countDocuments({workspaceId:workspace.id,status:{$in:['pending','running','ready']}}),0)
  }
  assert.equal(deletes,4)
  await owner.request('post',`/workspaces/${workspace.id}/archives`,{nodeId:folder.id}).expect(202)
})

test('real frontend HTTP adapter completes register, verify, workspace, invite, Owner audit, private upload and login', {skip:!existsSync(frontend)}, async t=>{
  const {createHttpDriveApi}=await import(frontend.href)
  let app
  const server=createServer((req,res)=>app(req,res))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  const origin=`http://127.0.0.1:${server.address().port}`
  const h=await createHarness('frontend',{API_ORIGIN:origin});app=h.app
  const background=startBackgroundWork({worker:h.worker,mailer:{async drain(){return 0}},intervalMs:50})
  t.after(async()=>{await background.stop();await h.close()})
  let signedPuts=0
  function client() {
    const cookies=new Map()
    return createHttpDriveApi({baseUrl:`${origin}/api/v1`,fetch:async(input,init={})=>{
      const address=new URL(String(input))
      assert.equal(address.origin,origin,'test transport never sends local credentials to another service')
      const headers=new Headers(init.headers)
      headers.set('Origin',h.config.frontendOrigin)
      if(init.credentials==='include' && cookies.size) headers.set('Cookie',[...cookies].map(([name,value])=>`${name}=${value}`).join('; '))
      if(init.method==='PUT') {signedPuts++;assert.equal(init.credentials,'omit');assert.equal(headers.has('Cookie'),false);assert.equal(headers.has('X-CSRF-Token'),false)}
      const response=await fetch(address,{...init,headers})
      if(init.credentials==='include') for(const cookie of response.headers.getSetCookie()) {
        const [name,value]=cookie.split(';')[0].split('=')
        if(/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(cookie)) cookies.delete(name)
        else cookies.set(name,value)
      }
      return response
    }})
  }
  async function register(api,email) {
    const session=await api.register({name:'Frontend Entegrasyon',email,password:'Frontend1234!'})
    assert.equal(session.user.emailVerified,false)
    await h.flushMail()
    const mail=h.mail.findLast(item=>item.to===email)
    const token=mail.text.match(/#token=([A-Za-z0-9_-]+)/)[1]
    assert.equal((await api.verifyEmail({token})).user.emailVerified,true)
    return session.user
  }
  const owner=client(),viewer=client()
  const first=await register(owner,'frontend-owner@example.com')
  await register(viewer,'frontend-viewer@example.com')
  const workspace=await owner.createWorkspace({name:'Gerçek frontend API',description:'Kalıcı MongoDB verileri'})
  assert.equal(workspace.role,'owner')
  assert.equal((await owner.listWorkspacesPage({limit:2})).items[0].id,workspace.id)
  const initialAudit=await owner.listAuditEventsPage(workspace.id,{limit:2})
  assert.equal(initialAudit.items[0].action,'workspace.created')
  assert.equal(initialAudit.items[0].actor.id,first.id)
  assert.equal(initialAudit.items[0].workspaceId,workspace.id)
  assert.equal(Object.hasOwn(initialAudit.items[0].actor,'email'),false)
  await assert.rejects(viewer.listAuditEventsPage(workspace.id),error=>error.status===404)
  const folder=await owner.createFolder(workspace.id,{name:'Belgeler',parentId:null})
  const {uploadFolderSelection}=await import(new URL('../../google-drive-clone-frontend/app/services/folder-upload.ts',import.meta.url).href)
  await uploadFolderSelection(owner,workspace.id,null,{directories:['Imported/Empty'],files:[{path:'Imported/Nested/proof.txt',file:new File(['Nested bytes'],'proof.txt',{type:'text/plain'})}]})
  const imported=(await owner.listNodes(workspace.id,{parentId:null})).find(node=>node.name==='Imported')
  const importedChildren=await owner.listNodes(workspace.id,{parentId:imported.id})
  assert.ok(importedChildren.some(node=>node.name==='Empty'))
  const nested=importedChildren.find(node=>node.name==='Nested')
  const proof=(await owner.listNodes(workspace.id,{parentId:nested.id}))[0]
  assert.equal(await(await owner.getContent(workspace.id,proof.id)).blob.text(),'Nested bytes')

  const bytes='Frontend adapter → gerçek özel dosya deposu'
  const [file]=await owner.uploadFiles(workspace.id,folder.id,[new File([bytes],'notlar.txt',{type:'text/plain'})])
  assert.equal(signedPuts,2)
  assert.equal(await (await owner.getContent(workspace.id,file.id)).blob.text(),bytes)
  await assert.rejects(viewer.getContent(workspace.id,file.id),error=>error.status===404)
  const invitation=await owner.inviteMember(workspace.id,{email:'frontend-viewer@example.com',role:'viewer'})
  assert.equal(invitation.demoToken,undefined)
  await h.flushMail()
  const inviteToken=h.mail.findLast(item=>item.to==='frontend-viewer@example.com').text.match(/#token=([A-Za-z0-9_-]+)/)[1]
  assert.equal((await viewer.inspectInvitation(inviteToken)).workspaceId,workspace.id)
  assert.equal((await viewer.acceptInvitation(inviteToken)).role,'viewer')
  await assert.rejects(uploadFolderSelection(viewer,workspace.id,null,{directories:['Denied import'],files:[]}),error=>error.status===403)
  await assert.rejects(viewer.listAuditEventsPage(workspace.id),error=>error.status===403)
  const auditPage=await owner.listAuditEventsPage(workspace.id,{limit:2})
  assert.equal(auditPage.items.length,2)
  assert.ok(auditPage.nextCursor)
  assert.ok(auditPage.items.every(event=>event.workspaceId===workspace.id))
  assert.equal((await viewer.listNodes(workspace.id,{parentId:folder.id}))[0].id,file.id)
  assert.equal((await viewer.listNodesPage(workspace.id,{parentId:folder.id,limit:2})).items[0].id,file.id)
  await assert.rejects(viewer.createFolder(workspace.id,{name:'Yasak',parentId:null}),error=>error.status===403)
  assert.equal(await (await viewer.getContent(workspace.id,file.id)).blob.text(),bytes)
  const zip=await viewer.downloadFolder(workspace.id,folder.id,{pollIntervalMs:20,timeoutMs:10000})
  assert.equal(new DataView(await zip.blob.arrayBuffer()).getUint32(0,true),0x04034b50)
  await owner.logout();assert.equal(await owner.getSession(),null)
  assert.equal((await owner.login({email:first.email,password:'Frontend1234!'})).user.id,first.id)
  assert.equal((await owner.listNodes(workspace.id,{parentId:folder.id}))[0].id,file.id,'re-login retains MongoDB metadata and private bytes')
})
