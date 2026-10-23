import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Readable} from 'node:stream'
import {createHarness} from './helpers.mjs'
import {createArchiveProcessor} from '../src/archives.mjs'

const waitUntil=async predicate=>{const end=Date.now()+5000;while(!await predicate()){if(Date.now()>end)throw new Error('Timed out waiting for controlled archive state');await new Promise(resolve=>setTimeout(resolve,10))}}
const base=ws=>`/workspaces/${ws.id}`
async function setup(h){
  const owner=await h.user(),viewer=await h.user(),stranger=await h.user()
  const ws=(await owner.request('post','/workspaces',{name:'Archive tests'}).expect(201)).body
  await h.models.Membership.create({workspaceId:ws.id,userId:viewer.user.id,role:'viewer'})
  const folder=(await owner.request('post',`${base(ws)}/folders`,{name:'Root',parentId:null}).expect(201)).body
  const upload=(await owner.request('post',`${base(ws)}/files/uploads`,{name:'note.txt',parentId:folder.id,size:5,mimeType:'text/plain'}).expect(201)).body
  const url=new URL(upload.uploadUrl)
  await h.client().put(url.pathname+url.search).set('Origin',h.config.frontendOrigin).set(upload.headers).send(Buffer.from('hello')).expect(204)
  const file=(await owner.request('post',`${base(ws)}/files/uploads/${upload.uploadId}/complete`).expect(200)).body
  return{owner,viewer,stranger,ws,folder,file}
}
async function start(viewer,ws,folder){return(await viewer.request('post',`${base(ws)}/archives`,{nodeId:folder.id}).expect(202)).body}
const binary=(res,callback)=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>callback(null,Buffer.concat(chunks)))}

test('unchanged legacy workspaces without contentVersion can publish their first archive',async()=>{
  const h=await createHarness('archivelegacy')
  try{
    const {viewer,ws,folder}=await setup(h)
    await h.models.Workspace.updateOne({_id:ws.id},{$unset:{contentVersion:1}})
    const archive=await start(viewer,ws,folder)
    await h.worker.drainJobs()
    const row=await h.models.Archive.findById(archive.id)
    assert.equal(row.status,'ready');assert.equal(row.sourceMutationSequence,0)
    await viewer.request('get',`${base(ws)}/archives/${archive.id}/content`).expect(200)
  }finally{await h.close()}
})

test('expiry and workspace cleanup remove attempt keys beyond ten using bounded repeatable sweeps',async()=>{
  const h=await createHarness('archiveolder')
  try{
    const {viewer,owner,ws,folder}=await setup(h)
    const processor=createArchiveProcessor({models:h.models,storage:h.storage,config:h.config})
    for(const mode of ['expiry','workspace']){
      const archive=await start(viewer,ws,folder)
      const key=attempt=>`workspaces/${ws.id}/archives/${archive.id}-${attempt}.zip`
      for(const attempt of [11,24,25])await h.storage.writeArchive(key(attempt),Readable.from([Buffer.from('private zip bytes')]))
      await h.models.Archive.updateOne({_id:archive.id},{$set:{status:'ready',buildAttempt:25,objectKey:key(25),...(mode==='expiry'?{expiresAt:new Date(Date.now()-1)}:{})}})
      if(mode==='expiry')await processor.expire({targetId:archive.id,workspaceId:ws.id})
      else await processor.cancelWorkspace(ws.id)
      assert.equal(await h.storage.head(key(25)),null,'the actual current object is always removed immediately')
      assert.equal(await h.storage.head(key(11)),null)
      assert.ok(await h.storage.head(key(24)),'older attempts are swept in bounded batches')
      await processor.collect(20)
      assert.equal(await h.storage.head(key(24)),null)
      // A provider completion delayed beyond its original cleanup is collected on a later rotation.
      await h.storage.writeArchive(key(11),Readable.from([Buffer.from('late orphan')]))
      await processor.collect(20);await processor.collect(20)
      assert.equal(await h.storage.head(key(11)),null)
    }
    await owner.request('get',base(ws)).expect(200)
  }finally{await h.close()}
})

test('archive jobs build private ZIP with progress, enforce requester/tenant access, cancel and expire bytes',async()=>{
  const h=await createHarness('archives')
  try{
    const {owner,viewer,stranger,ws,folder}=await setup(h),archive=await start(viewer,ws,folder),route=`${base(ws)}/archives/${archive.id}`
    await owner.request('get',route).expect(404);await stranger.request('get',route).expect(404)
    await viewer.request('get',`${route}/content`).expect(409)
    await h.worker.drainJobs()
    const ready=(await viewer.request('get',route).expect(200)).body
    assert.equal(ready.status,'ready');assert.equal(ready.totalFiles,1);assert.equal(ready.processedFiles,1)
    const zip=await viewer.request('get',`${route}/content`).buffer(true).parse(binary).expect(200)
    assert.equal(zip.body.readUInt32LE(0),0x04034b50)
    const range=await viewer.request('get',`${route}/content`).set('Range','bytes=0-3').buffer(true).parse(binary).expect(206)
    assert.equal(range.body.readUInt32LE(0),0x04034b50)
    await viewer.request('head',`${route}/content`).expect(200)
    const row=await h.models.Archive.findById(archive.id)
    assert.ok(await h.storage.head(row.objectKey))
    await viewer.request('delete',route).expect(204);await viewer.request('delete',route).expect(204)
    await h.worker.drainJobs();assert.equal(await h.storage.head(row.objectKey),null)
    const second=await start(viewer,ws,folder);await h.worker.drainJobs()
    const secondRow=await h.models.Archive.findById(second.id)
    await h.models.Archive.updateOne({_id:second.id},{$set:{expiresAt:new Date(Date.now()-1000)}})
    await viewer.request('get',`${base(ws)}/archives/${second.id}/content`).expect(410)
    await h.worker.drainJobs();assert.equal(await h.storage.head(secondRow.objectKey),null)
  }finally{await h.close()}
})

test('source edits invalidate pending/ready archives and workspace deletion removes only its archive',async()=>{
  const h=await createHarness('archivechange')
  try{
    const {owner,viewer,ws,folder,file}=await setup(h),first=await start(viewer,ws,folder)
    await owner.request('patch',`${base(ws)}/nodes/${file.id}`,{name:'changed.txt',version:file.version}).expect(200)
    await h.worker.drainJobs()
    const failed=(await viewer.request('get',`${base(ws)}/archives/${first.id}`).expect(200)).body
    assert.equal(failed.status,'failed');assert.equal(failed.errorCode,'ARCHIVE_SOURCE_CHANGED')
    const second=await start(viewer,ws,folder);await h.worker.drainJobs()
    const row=await h.models.Archive.findById(second.id)
    assert.equal(row.status,'ready')
    await owner.request('post',`${base(ws)}/folders`,{name:'Another folder',parentId:null}).expect(201)
    await viewer.request('get',`${base(ws)}/archives/${second.id}/content`).expect(409)
    await owner.request('delete',base(ws)).expect(204);await h.worker.drainJobs()
    assert.equal(await h.storage.head(row.objectKey),null)
  }finally{await h.close()}
})

test('revoking a member during archive streaming aborts storage and prevents publication',async()=>{
  const h=await createHarness('archiverevoke')
  const original=h.storage.read
  let entered=false,destroyed=false
  try{
    const {viewer,ws,folder}=await setup(h),archive=await start(viewer,ws,folder)
    h.storage.read=async(key,options)=>{
      if(!key.includes('/objects/'))return original.call(h.storage,key,options)
      entered=true
      return new Readable({read(){},destroy(error,done){destroyed=true;done(error)}})
    }
    const drain=h.worker.drainJobs();await waitUntil(()=>entered)
    await h.models.Membership.updateOne({workspaceId:ws.id,userId:viewer.user.id},{$set:{status:'removed'}})
    await drain
    assert.equal(destroyed,true)
    const row=await h.models.Archive.findById(archive.id)
    assert.equal(row.status,'failed');assert.equal(row.errorCode,'ARCHIVE_ACCESS_REVOKED')
    assert.equal(await h.storage.head(`workspaces/${ws.id}/archives/${archive.id}-1.zip`),null)
    await viewer.request('get',`${base(ws)}/archives/${archive.id}`).expect(404)
  }finally{h.storage.read=original;await h.close()}
})

test('a replaced worker lease cannot fail, overwrite or delete the newer archive attempt',async()=>{
  const h=await createHarness('archivelease')
  const original=h.storage.read
  let entered=false
  try{
    const {viewer,ws,folder}=await setup(h),archive=await start(viewer,ws,folder)
    h.storage.read=async(key,options)=>{if(!key.includes('/objects/'))return original.call(h.storage,key,options);entered=true;return new Readable({read(){}})}
    const oldDrain=h.worker.drainJobs();await waitUntil(()=>entered)
    const job=await h.models.Job.findOne({workspaceId:ws.id,type:'archive-build',targetId:archive.id})
    await h.models.Job.updateOne({_id:job._id},{$set:{leaseUntil:new Date(Date.now()-1)}})
    h.storage.read=original
    const newDrain=h.worker.drainJobs();await newDrain;await oldDrain
    const row=await h.models.Archive.findById(archive.id)
    assert.equal(row.status,'ready');assert.equal(row.buildAttempt,2)
    assert.ok(await h.storage.head(row.objectKey))
    assert.equal(await h.storage.head(`workspaces/${ws.id}/archives/${archive.id}-1.zip`),null)
    await viewer.request('get',`${base(ws)}/archives/${archive.id}/content`).expect(200)
  }finally{h.storage.read=original;await h.close()}
})

test('archive bounds fail promptly without waiting on a destroyed manifest writer',async()=>{
  const h=await createHarness('archivebound')
  try{
    const {viewer,ws,folder}=await setup(h),archive=await start(viewer,ws,folder)
    const job=await h.models.Job.findOneAndUpdate({targetId:archive.id,type:'archive-build'},{$set:{status:'running',attempts:1}},{returnDocument:'after'})
    const processor=createArchiveProcessor({models:h.models,storage:h.storage,config:{...h.config,maxAsyncArchiveNodes:1}})
    await processor.build(job)
    const failed=await h.models.Archive.findById(archive.id)
    assert.equal(failed.status,'failed');assert.equal(failed.errorCode,'ARCHIVE_TOO_LARGE')
  }finally{await h.close()}
})

test('node cursor traverses more than 500 results and bounded hidden search candidates without leaks',async()=>{
  const h=await createHarness('nodepage')
  try{
    const owner=await h.user(),stranger=await h.user(),ws=(await owner.request('post','/workspaces',{name:'Paging'}).expect(201)).body
    const rows=Array.from({length:507},(_,index)=>({_id:randomUUID(),workspaceId:ws.id,name:`node-${String(index).padStart(4,'0')}`,kind:'folder',createdBy:owner.user.id}))
    await h.models.DriveNode.insertMany(rows)
    let cursor,ids=[]
    do{const page=(await owner.request('get',`${base(ws)}/nodes/page?parentId=root&limit=100${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`).expect(200)).body;ids.push(...page.items.map(row=>row.id));cursor=page.nextCursor}while(cursor)
    assert.equal(ids.length,507);assert.equal(new Set(ids).size,507)
    const first=(await owner.request('get',`${base(ws)}/nodes/page?parentId=root&limit=2`).expect(200)).body
    await owner.request('get',`${base(ws)}/nodes/page?parentId=root&limit=3&cursor=${encodeURIComponent(first.nextCursor)}`).expect(409)
    await stranger.request('get',`${base(ws)}/nodes/page?parentId=root&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`).expect(404)
    await owner.request('post',`${base(ws)}/folders`,{name:'new',parentId:null}).expect(201)
    await owner.request('get',`${base(ws)}/nodes/page?parentId=root&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`).expect(409)
  }finally{await h.close()}
})

test('global node search continues past 5000 hidden candidates while each page scan stays bounded',async()=>{
  const h=await createHarness('hiddensearch')
  try{
    const owner=await h.user(),ws=(await owner.request('post','/workspaces',{name:'Search'}).expect(201)).body,parentId=randomUUID()
    await h.models.DriveNode.create({_id:parentId,workspaceId:ws.id,name:'removed ancestor',kind:'folder',status:'deleting',createdBy:owner.user.id})
    const hidden=Array.from({length:5001},(_,index)=>({_id:randomUUID(),workspaceId:ws.id,parentId,name:`match-${String(index).padStart(5,'0')}`,kind:'folder',createdBy:owner.user.id}))
    await h.models.DriveNode.insertMany(hidden)
    const visible=await h.models.DriveNode.create({workspaceId:ws.id,name:'match-visible',kind:'folder',createdBy:owner.user.id})
    let cursor,pages=0,items=[]
    do{const page=(await owner.request('get',`${base(ws)}/nodes/page?search=match&limit=2${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`).expect(200)).body;items.push(...page.items);cursor=page.nextCursor;pages++;assert.ok(pages<10)}while(cursor)
    assert.ok(pages>=6);assert.deepEqual(items.map(row=>row.id),[visible._id])
  }finally{await h.close()}
})
