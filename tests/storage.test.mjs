import test from 'node:test'
import assert from 'node:assert/strict'
import {createStorage} from '../src/storage.mjs'
import {createServer} from 'node:http'
import {createHash,createHmac,timingSafeEqual} from 'node:crypto'
import {randomUUID} from 'node:crypto'
import {mkdtemp,mkdir,writeFile,readFile,utimes,stat,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {Readable} from 'node:stream'

test('presigned S3 PUT binds content length/type without an incorrect empty-body checksum',async t=>{
  const storage=createStorage({models:{},config:{storageDriver:'s3',maxUploadBytes:26214400,s3:{bucket:'review-bucket',region:'us-east-1',endpoint:'http://127.0.0.1:9999',forcePathStyle:true,credentials:{accessKeyId:'test',secretAccessKey:'test'}}}})
  t.after(()=>storage.close())
  const upload={_id:'review-upload',objectKey:'workspaces/test/objects/test/review-upload',size:5,mimeType:'text/plain',expiresAt:new Date(Date.now()+60000)}
  const signed=await storage.createUpload({upload,expiresInSeconds:60})
  const url=new URL(signed.uploadUrl)
  assert.equal(url.searchParams.get('x-amz-checksum-crc32'),null,'the checksum of an empty body must not be imposed on the real file')
  assert.equal(url.searchParams.get('x-amz-sdk-checksum-algorithm'),null)
  const headers=url.searchParams.get('X-Amz-SignedHeaders').split(';')
  assert.ok(headers.includes('content-length'))
  assert.ok(headers.includes('content-type'))
  assert.equal(signed.headers['Content-Type'],'text/plain')
  assert.equal(url.searchParams.get('X-Amz-Expires'),'60')
  assert.equal(url.pathname,'/review-bucket/workspaces/test/objects/test/review-upload')
})

// This fixture verifies the actual SigV4 URL and S3 wire protocol on loopback.
// It does not substitute for a live provider/credentials deployment check.
async function s3Fixture(t) {
  const objects=new Map(),heldReads=[]
  let hold=false,onHeld=()=>{}
  const encode=value=>encodeURIComponent(value).replace(/[!'()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  const hash=value=>createHash('sha256').update(value).digest('hex')
  const hmac=(key,value)=>createHmac('sha256',key).update(value).digest()
  function signedUrlValid(req,url) {
    const actual=url.searchParams.get('X-Amz-Signature') || ''
    if(!/^[a-f0-9]{64}$/.test(actual)) return false
    const [id,...parts]=url.searchParams.get('X-Amz-Credential').split('/')
    if(id!=='test')return false
    const headers=url.searchParams.get('X-Amz-SignedHeaders')
    const canonicalHeaders=headers.split(';').map(name=>`${name}:${String(req.headers[name] || '').trim().replace(/\s+/g,' ')}\n`).join('')
    const query=[...url.searchParams].filter(([key])=>key!=='X-Amz-Signature').map(([key,value])=>[encode(key),encode(value)]).sort(([a,av],[b,bv])=>a<b?-1:a>b?1:av<bv?-1:av>bv?1:0).map(pair=>pair.join('=')).join('&')
    const canonical=[req.method,url.pathname,query,canonicalHeaders,headers,url.searchParams.get('X-Amz-Content-Sha256') || 'UNSIGNED-PAYLOAD'].join('\n')
    const scope=parts.join('/'),date=url.searchParams.get('X-Amz-Date')
    let key=Buffer.from('AWS4test')
    for(const part of parts)key=hmac(key,part)
    const expected=hmac(key,`AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`)
    return timingSafeEqual(Buffer.from(actual,'hex'),expected)
  }
  const server=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://fixture')
      const error=(status,code)=>{res.writeHead(status,{'Content-Type':'application/xml'});res.end(`<Error><Code>${code}</Code></Error>`)}
      const signed=url.searchParams.has('X-Amz-Signature')
      if(signed ? !signedUrlValid(req,url) : !/^AWS4-HMAC-SHA256 Credential=test\//.test(req.headers.authorization || '')) return error(403,'AccessDenied')
      if(req.method==='HEAD' && /^\/review-bucket\/?$/.test(url.pathname)){res.writeHead(200);return res.end()}
      const item=objects.get(url.pathname)
      if(req.method==='PUT') {
        if(req.headers['if-none-match']==='*' && item)return error(412,'PreconditionFailed')
        const chunks=[];for await(const bytes of req)chunks.push(bytes)
        const body=Buffer.concat(chunks),etag=`"${createHash('md5').update(body).digest('hex')}"`
        objects.set(url.pathname,{body,etag,mimeType:req.headers['content-type']})
        res.writeHead(200,{ETag:etag});return res.end()
      }
      if(req.method==='DELETE'){objects.delete(url.pathname);res.writeHead(204);return res.end()}
      if(!item)return error(404,'NoSuchKey')
      if(req.headers['if-match'] && req.headers['if-match']!==item.etag)return error(412,'PreconditionFailed')
      let body=item.body,status=200
      const headers={'Content-Type':item.mimeType,ETag:item.etag}
      if(req.headers.range){const [,a,b]=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);const start=Number(a),end=b?Number(b):body.length-1;headers['Content-Range']=`bytes ${start}-${end}/${body.length}`;body=body.subarray(start,end+1);status=206}
      headers['Content-Length']=String(body.length)
      res.writeHead(status,headers)
      if(req.method==='HEAD')return res.end()
      if(hold){res.flushHeaders();heldReads.push(()=>res.end(body));onHeld(heldReads.length);return}
      res.end(body)
    } catch {res.writeHead(500);res.end()}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const endpoint=`http://127.0.0.1:${server.address().port}`
  const storage=createStorage({models:{},config:{storageDriver:'s3',maxUploadBytes:26214400,s3:{bucket:'review-bucket',region:'us-east-1',endpoint,forcePathStyle:true,credentials:{accessKeyId:'test',secretAccessKey:'test'}}}})
  t.after(async()=>{for(const release of heldReads)release();await storage.close();await new Promise(resolve=>server.close(resolve))})
  return {storage,objects,endpoint,holdReads(callback){hold=true;onHeld=callback},release(){hold=false;for(const release of heldReads)release()}}
}

test('S3 adapter wire flow enforces its signed upload, seals immutable bytes and supports ranges',async t=>{
  const {storage,endpoint}=await s3Fixture(t)
  const upload={_id:'upload',objectKey:'workspaces/ws/objects/node/upload',size:5,mimeType:'text/plain',expiresAt:new Date(Date.now()+60000)}
  const signed=await storage.createUpload({upload,expiresInSeconds:60})
  assert.equal((await fetch(signed.uploadUrl,{method:'PUT',headers:signed.headers,body:'hello'})).status,200)
  assert.equal((await fetch(signed.uploadUrl,{method:'PUT',headers:{'Content-Type':'text/html'},body:'hello'})).status,403)
  assert.equal((await fetch(signed.uploadUrl,{method:'PUT',headers:signed.headers,body:'oversized'})).status,403)
  assert.equal((await fetch(`${endpoint}/review-bucket/${upload.objectKey}`)).status,403)
  assert.deepEqual({...await storage.head(upload.objectKey),etag:undefined},{size:5,mimeType:'text/plain',etag:undefined})
  const sealed=await storage.promoteUpload(upload)
  assert.equal(sealed.objectKey,`${upload.objectKey}.sealed`)
  assert.equal((await fetch(signed.uploadUrl,{method:'PUT',headers:signed.headers,body:'OTHER'})).status,200)
  const read=async options=>{const chunks=[];for await(const bytes of await storage.read(sealed.objectKey,options))chunks.push(bytes);return Buffer.concat(chunks).toString()}
  assert.equal(await read(),'hello')
  assert.equal(await read({start:1,end:3}),'ell')
  assert.deepEqual(await storage.promoteUpload(upload),sealed)
  await storage.delete(sealed.objectKey)
  assert.equal(await storage.head(sealed.objectKey),null)
})

test('storage promotion holds its memory limit until provider operations actually finish',async t=>{
  const fixture=await s3Fixture(t)
  let ready
  const held=new Promise(resolve=>{ready=resolve})
  fixture.holdReads(count=>{if(count===4)ready()})
  const uploads=Array.from({length:5},(_,i)=>({_id:`upload${i}`,objectKey:`workspaces/ws/objects/node/upload${i}`,size:5,mimeType:'text/plain',expiresAt:new Date(Date.now()+60000)}))
  for(const upload of uploads) fixture.objects.set(`/review-bucket/${upload.objectKey}`,{body:Buffer.from('hello'),mimeType:'text/plain',etag:'"fixture"'})
  const pending=uploads.slice(0,4).map(upload=>fixture.storage.promoteUpload(upload))
  await held
  await assert.rejects(fixture.storage.promoteUpload(uploads[4]),error=>error.status===503 && error.code==='STORAGE_BUSY')
  fixture.release()
  assert.equal((await Promise.all(pending)).length,4)
  assert.equal((await fixture.storage.promoteUpload(uploads[4])).size,5)
})

test('S3 archive output streams bounded private bytes and publishes once using an attempt key',async t=>{
  const {storage}=await s3Fixture(t)
  await storage.checkHealth()
  const key=`workspaces/${randomUUID()}/archives/${randomUUID()}-1.zip`
  const result=await storage.writeArchive(key,Readable.from([Buffer.from('zip bytes')]))
  assert.equal(result.size,9);assert.equal(result.mimeType,'application/zip')
  await storage.writeArchive(key,Readable.from([Buffer.from('different bytes')]))
  const chunks=[];for await(const chunk of await storage.read(key))chunks.push(chunk)
  assert.equal(Buffer.concat(chunks).toString(),'zip bytes')
  const controller=new AbortController();controller.abort()
  await assert.rejects(storage.writeArchive(key.replace('-1.zip','-2.zip'),Readable.from(['cancelled']),{signal:controller.signal}))
  assert.equal(await storage.head(key.replace('-1.zip','-2.zip')),null)
  await storage.delete(key);assert.equal(await storage.head(key),null)
})

test('local crash recovery removes only old generated temporary objects and retains private file bytes',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'ortak-crash-test-'))
  const storage=createStorage({models:{},config:{storageDriver:'local',localStoragePath:root,uploadSigningKey:'a'.repeat(64)}})
  t.after(async()=>{await storage.close();await rm(root,{recursive:true,force:true})})
  const directory=path.join(root,'workspaces',randomUUID(),'objects',randomUUID())
  await mkdir(directory,{recursive:true})
  const old=path.join(directory,`${randomUUID()}.sealed.${randomUUID()}.tmp`)
  const fresh=path.join(directory,`${randomUUID()}.${randomUUID()}.tmp`)
  const active=path.join(directory,`${randomUUID()}.sealed`)
  const unrelated=path.join(root,'unrelated.tmp')
  const archiveDirectory=path.join(root,'workspaces',randomUUID(),'archives');await mkdir(archiveDirectory,{recursive:true})
  const archiveOld=path.join(archiveDirectory,`${randomUUID()}-1.zip.${randomUUID()}.tmp`)
  for(const target of [old,fresh,active,unrelated,archiveOld])await writeFile(target,'private bytes')
  const past=new Date(Date.now()-1200000)
  for(const target of [old,active,unrelated,archiveOld])await utimes(target,past,past)
  assert.equal(await storage.cleanupTemporaryObjects(),2)
  await assert.rejects(stat(old),error=>error.code==='ENOENT')
  await assert.rejects(stat(archiveOld),error=>error.code==='ENOENT')
  for(const target of [fresh,active,unrelated])assert.equal(await readFile(target,'utf8'),'private bytes')
})
