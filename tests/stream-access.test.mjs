import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {randomUUID} from 'node:crypto'
import {Readable} from 'node:stream'
import {createHarness} from './helpers.mjs'
import {createStreamAccessMonitor} from '../src/stream-access.mjs'

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function within(promise,ms=4000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Controlled stream did not settle in time')),ms)})])}finally{clearTimeout(timer)}}
async function until(predicate){const end=Date.now()+4000;while(!predicate()){if(Date.now()>end)throw new Error('Controlled stream state timed out');await delay(10)}}
const bytes=Buffer.alloc(65536,'x')

async function fixture(name){
  const h=await createHarness(name)
  const owner=await h.user(),viewer=await h.user()
  const workspace=(await owner.request('post','/workspaces',{name:'Stream authority'}).expect(201)).body
  const membership=await h.models.Membership.create({workspaceId:workspace.id,userId:viewer.user.id,role:'viewer'})
  const folder=(await owner.request('post',`/workspaces/${workspace.id}/folders`,{name:'Parent',parentId:null}).expect(201)).body
  const id=randomUUID(),key=`workspaces/${workspace.id}/objects/${id}/${randomUUID()}.sealed`
  await h.models.DriveNode.create({_id:id,workspaceId:workspace.id,parentId:folder.id,name:'private.txt',kind:'file',mimeType:'text/plain',size:bytes.length,createdBy:owner.user.id,objectKey:key,storageState:'ready'})
  const archiveId=randomUUID(),archiveKey=`workspaces/${workspace.id}/archives/${archiveId}-1.zip`
  const ws=await h.models.Workspace.findById(workspace.id)
  await h.models.Archive.create({_id:archiveId,workspaceId:workspace.id,nodeId:folder.id,requestedBy:viewer.user.id,status:'ready',buildAttempt:1,objectKey:archiveKey,filename:'private.zip',bytes:bytes.length,sourceMutationSequence:ws.contentVersion,expiresAt:new Date(Date.now()+60000)})
  const sources=[]
  h.storage.head=async objectKey=>objectKey===key||objectKey===archiveKey?{size:bytes.length,mimeType:objectKey===key?'text/plain':'application/zip'}:null
  h.storage.read=async()=>{
    let sent=false
    const stream=new Readable({read(){if(!sent){sent=true;this.push(bytes.subarray(0,8192))}}})
    sources.push(stream)
    return stream
  }
  const server=createServer(h.app)
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const base=`http://127.0.0.1:${server.address().port}/api/v1`
  async function client(user=viewer){
    const cookies=new Map();let csrf
    async function request(route,method='GET',body,extraHeaders={}){
      const headers={Origin:h.config.frontendOrigin,...(cookies.size?{Cookie:[...cookies].map(([key,value])=>`${key}=${value}`).join('; ')}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(body?{'Content-Type':'application/json'}:{}),...extraHeaders}
      const response=await fetch(base+route,{method,headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)})
      for(const cookie of response.headers.getSetCookie()){const[name,value]=cookie.split(';')[0].split('=');cookies.set(name,value)}
      return response
    }
    csrf=(await(await request('/auth/csrf-token')).json()).csrfToken
    const login=await request('/auth/login','POST',{email:user.user.email,password:user.password});assert.equal(login.status,200);await login.arrayBuffer()
    csrf=(await(await request('/auth/csrf-token')).json()).csrfToken
    return {request}
  }
  return {h,owner,viewer,workspace,membership,folder,id,key,archiveId,sources,client,
    file:`/workspaces/${workspace.id}/files/${id}/content`,
    syncZip:`/workspaces/${workspace.id}/folders/${folder.id}/archive`,
    readyZip:`/workspaces/${workspace.id}/archives/${archiveId}/content`,
    async close(){for(const source of sources)source.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await h.close()},
  }
}
async function started(response,status=200){assert.equal(response.status,status);const reader=response.body.getReader();const first=await within(reader.read());assert.ok(first.value?.length);return reader}
async function readRest(reader){for(;;){const result=await reader.read();if(result.done)return}}

test('an open private file stream stops when current session, identity or tenant authority is lost',async t=>{
  const cases={
    membership:async f=>{await f.owner.request('delete',`/workspaces/${f.workspace.id}/members/${f.membership._id}`).expect(204)},
    logout:async(f,client)=>{assert.equal((await client.request('/auth/logout','POST')).status,204)},
    expiry:async f=>{await f.h.models.Session.updateMany({userId:f.viewer.user.id},{$set:{expiresAt:new Date(Date.now()-1)}})},
    password:async f=>{await f.h.models.User.updateOne({_id:f.viewer.user.id},{$inc:{passwordVersion:1}})},
    disabled:async f=>{await f.h.models.User.updateOne({_id:f.viewer.user.id},{$set:{status:'disabled'}})},
    ancestor:async f=>{await f.owner.request('delete',`/workspaces/${f.workspace.id}/nodes/${f.folder.id}`).expect(204)},
    workspace:async f=>{await f.owner.request('delete',`/workspaces/${f.workspace.id}`).expect(204)},
  }
  for(const[name,change]of Object.entries(cases))await t.test(name,async()=>{
    const f=await fixture(`stream${name}`)
    try{
      const client=await f.client(),reader=await started(await client.request(f.file,'GET',undefined,name==='membership'?{Range:'bytes=0-32767'}:{}),name==='membership'?206:200)
      const end=readRest(reader);end.catch(()=>{})
      await change(f,client)
      await assert.rejects(within(end),error=>error.message!=='Controlled stream did not settle in time')
      assert.equal(f.sources[0].destroyed,true)
    }finally{await f.close()}
  })
})

test('both folder ZIP routes stop an already-started response after access or archive state changes',async t=>{
  for(const mode of ['syncZip','readyZip','cancelReady'])await t.test(mode,async()=>{
    const f=await fixture(`zip${mode}`)
    try{
      const client=await f.client(),reader=await started(await client.request(mode==='syncZip'?f.syncZip:f.readyZip))
      await until(()=>f.sources.length>0)
      const end=readRest(reader);end.catch(()=>{})
      if(mode==='cancelReady')assert.equal((await client.request(`/workspaces/${f.workspace.id}/archives/${f.archiveId}`,'DELETE')).status,204)
      else await f.owner.request('delete',`/workspaces/${f.workspace.id}/members/${f.membership._id}`).expect(204)
      await assert.rejects(within(end),error=>error.message!=='Controlled stream did not settle in time')
      assert.ok(f.sources.every(source=>source.destroyed))
    }finally{await f.close()}
  })
})

test('Owner to Viewer keeps an existing readable download valid',async()=>{
  const f=await fixture('streamreadrole')
  try{
    await f.h.models.Membership.updateOne({_id:f.membership._id},{$set:{role:'owner'}})
    await f.h.models.Workspace.updateOne({_id:f.workspace.id},{$set:{ownerCount:2}})
    const client=await f.client(f.owner),reader=await started(await client.request(f.file))
    const member=await f.h.models.Membership.findOne({workspaceId:f.workspace.id,userId:f.owner.user.id})
    await f.viewer.request('patch',`/workspaces/${f.workspace.id}/members/${member._id}/role`,{role:'viewer'}).expect(200)
    await delay(650)
    assert.equal(f.sources[0].destroyed,false)
    f.sources[0].push(bytes.subarray(8192));f.sources[0].push(null)
    await within(readRest(reader))
  }finally{await f.close()}
})

test('concurrent download capacity is released on cancellation and HEAD opens no storage stream',async()=>{
  const f=await fixture('streamcapacity')
  try{
    const client=await f.client(),head=await client.request(f.file,'HEAD')
    assert.equal(head.status,200);assert.equal(f.sources.length,0)
    const readers=await Promise.all(Array.from({length:4},async()=>started(await client.request(f.file))))
    const busy=await client.request(f.file);assert.equal(busy.status,503);await busy.arrayBuffer()
    await Promise.all(readers.map(reader=>reader.cancel()))
    await until(()=>f.sources.every(source=>source.destroyed))
    const reopened=await started(await client.request(f.file));await reopened.cancel()
  }finally{await f.close()}
})

test('monitor deadline fails closed and releases capacity if the database does not answer',async()=>{
  const f=await fixture('streamdeadline')
  const original=f.h.models.Session.collection.findOne
  try{
    const session=await f.h.models.Session.findOne({userId:f.viewer.user.id,revokedAt:null})
    f.h.models.Session.collection.findOne=()=>new Promise(()=>{})
    const input={models:f.h.models,req:{authSession:session,auth:{user:{_id:f.viewer.user.id}}},workspaceId:f.workspace.id,nodeId:f.id,nodeKind:'file',objectKey:f.key,onRevoke(){},validationTimeoutMs:30,initialValidationTimeoutMs:30}
    for(let index=0;index<6;index++)await assert.rejects(within(createStreamAccessMonitor(input).start(),1000),error=>error.status===503 && error.code==='STREAM_CHECK_UNAVAILABLE')
  }finally{f.h.models.Session.collection.findOne=original;await f.close()}
})

test('a slow first authority check waits before granting access while later checks keep their short deadline',async()=>{
  const f=await fixture('streamcoldstart')
  const original=f.h.models.Session.collection.findOne
  let monitor
  try{
    const session=await f.h.models.Session.findOne({userId:f.viewer.user.id,revokedAt:null})
    f.h.models.Session.collection.findOne=async function(...args){await delay(100);return original.apply(this,args)}
    let revokedWith,started=false
    monitor=createStreamAccessMonitor({models:f.h.models,req:{authSession:session,auth:{user:{_id:f.viewer.user.id}}},workspaceId:f.workspace.id,nodeId:f.id,nodeKind:'file',objectKey:f.key,intervalMs:10,validationTimeoutMs:30,onRevoke(error){revokedWith=error}})
    const start=monitor.start().then(()=>{started=true})
    await delay(50)
    assert.equal(started,false,'initial authority must finish before a stream may start')
    await within(start)
    assert.equal(started,true)
    await until(()=>Boolean(revokedWith))
    assert.equal(revokedWith.status,503)
    assert.equal(revokedWith.code,'STREAM_CHECK_UNAVAILABLE')
  }finally{monitor?.stop();f.h.models.Session.collection.findOne=original;await f.close()}
})

test('authority checks support an active file at the existing 64-level tree limit',async()=>{
  const f=await fixture('streamdeep')
  try{
    let parentId=f.folder.id
    const folders=[]
    for(let depth=2;depth<=63;depth++){
      const id=randomUUID();folders.push({_id:id,workspaceId:f.workspace.id,parentId,kind:'folder',name:`Depth ${depth}`,createdBy:f.owner.user.id});parentId=id
    }
    await f.h.models.DriveNode.insertMany(folders)
    await f.h.models.DriveNode.updateOne({_id:f.id},{$set:{parentId}})
    const client=await f.client(),reader=await started(await client.request(f.file))
    f.sources[0].push(bytes.subarray(8192));f.sources[0].push(null)
    await within(readRest(reader))
  }finally{await f.close()}
})
