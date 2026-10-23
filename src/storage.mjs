import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto'
import { mkdir, writeFile, stat, rename, rm, copyFile, link, opendir } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { Router } from 'express'
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { HttpError, notFound } from './errors.mjs'
import {createArchiveTemporary,removeArchiveTemporary,cleanupArchiveTemporary} from './archive-temporary.mjs'

function createTransferGate(limit=4) {
  let active=0
  return async callback=>{
    if(active>=limit) throw new HttpError(503,'STORAGE_BUSY','Dosya servisi yoğun. Biraz sonra tekrar dene.')
    active++
    try { return await callback() } finally { active-- }
  }
}

async function collect(stream,limit) {
  const chunks=[]; let bytes=0
  for await (const chunk of stream) { bytes+=chunk.length; if(bytes>limit) throw new HttpError(413,'UPLOAD_TOO_LARGE','Dosya boyutu sınırı aşıldı.'); chunks.push(chunk) }
  return Buffer.concat(chunks)
}
function archiveBound(config) {
  let bytes=0
  return new Transform({transform(chunk,_encoding,done){bytes+=chunk.length;done(bytes>(config.maxAsyncArchiveBytes||1024**3)+64*1024**2?new HttpError(413,'ARCHIVE_TOO_LARGE','Arşiv boyutu sınırı aşıldı.'):null,chunk)}})
}
const archiveKey = key => /^workspaces\/[a-f0-9-]{36}\/archives\/[a-f0-9-]{36}-[0-9]{1,10}\.zip$/i.test(key)
export function createStorage({models,config}) {
  if (config.storageDriver==='s3') return createS3Storage(config)
  const root = config.localStoragePath
  const transfer=createTransferGate()
  let lastTemporarySweep=0
  const objectPath = key => {
    if (!archiveKey(key) && !/^workspaces\/[a-zA-Z0-9-]+\/objects\/[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+(?:\.sealed)?$/.test(key)) throw new Error('Invalid server object key')
    return path.join(root,...key.split('/'))
  }
  const signature = (upload,exp) => createHmac('sha256',Buffer.from(config.uploadSigningKey,'hex')).update(`${upload._id}:${upload.workspaceId}:${upload.objectKey}:${upload.size}:${upload.mimeType}:${exp}`).digest('hex')
  const router = Router()
  router.put('/storage/uploads/:id',async(req,res)=>transfer(async()=>{
    const upload = await models.Upload.findOne({_id:req.params.id,state:'initiated'})
    const exp = String(req.query.expires || ''), sig=String(req.query.signature || '')
    if (!upload || !/^\d{13}$/.test(exp) || !/^[a-f0-9]{64}$/.test(sig) || Number(exp)<=Date.now() || upload.expiresAt<=new Date()) throw notFound()
    if (!timingSafeEqual(Buffer.from(sig,'hex'),Buffer.from(signature(upload,exp),'hex'))) throw notFound()
    if (req.get('Content-Type')!==upload.mimeType || Number(req.get('Content-Length'))!==upload.size) throw new HttpError(400,'UPLOAD_MISMATCH','Dosya türü veya boyutu beklenen değerle eşleşmiyor.')
    const bytes = await collect(req,Math.min(config.maxUploadBytes,upload.size))
    if (bytes.length!==upload.size || Number(exp)<=Date.now()) throw new HttpError(400,'UPLOAD_MISMATCH','Dosya eksik veya yükleme süresi doldu.')
    // A replay can only replace staging bytes; finalized objects have a separate key.
    const target = objectPath(upload.objectKey), temporary=`${target}.${randomUUID()}.tmp`
    await mkdir(path.dirname(target),{recursive:true})
    try {
      await writeFile(temporary,bytes,{flag:'wx',mode:0o600})
      if (!await models.Upload.exists({_id:upload._id,workspaceId:upload.workspaceId,state:'initiated',expiresAt:{$gt:new Date()}})) throw notFound()
      await rename(temporary,target)
    } finally { await rm(temporary,{force:true}) }
    res.status(204).end()
  }))
  return {
    router,config,
    async checkHealth(){await mkdir(root,{recursive:true});const probe=path.join(root,`.health-${randomUUID()}`);try{await writeFile(probe,'ok',{flag:'wx',mode:0o600})}finally{await rm(probe,{force:true})}},
    async writeArchive(key,source,{signal}={}) {return transfer(async()=>{
      if(!archiveKey(key))throw new Error('Invalid archive key')
      const destination=objectPath(key),temporary=`${destination}.${randomUUID()}.tmp`
      await mkdir(path.dirname(destination),{recursive:true})
      try{await pipeline(source,archiveBound(config),createWriteStream(temporary,{flags:'wx',mode:0o600}),{signal});try{await link(temporary,destination)}catch(error){if(error.code!=='EEXIST')throw error}return{size:(await stat(destination)).size,mimeType:'application/zip'}}finally{await rm(temporary,{force:true})}
    })},
    async createUpload({upload,expiresInSeconds=300}) {
      const expires = String(Math.min(upload.expiresAt.getTime(),Date.now()+expiresInSeconds*1000))
      return {uploadUrl:`${config.apiOrigin}/api/v1/storage/uploads/${upload._id}?expires=${expires}&signature=${signature(upload,expires)}`,headers:{'Content-Type':upload.mimeType}}
    },
    async head(key) {
      try {
        const value=await stat(objectPath(key))
        if(archiveKey(key))return{size:value.size,mimeType:'application/zip'}
        const [,workspaceId,,nodeId,rawId]=key.split('/')
        const upload=await models.Upload.findOne({_id:rawId.replace(/\.sealed$/,''),workspaceId,nodeId}).select('mimeType').lean()
        if(!upload) return null
        return {size:value.size,mimeType:upload.mimeType}
      }
      catch(error) { if(error.code==='ENOENT') return null; throw error }
    },
    async promoteUpload(upload) { return transfer(async()=>{
      const objectKey=`${upload.objectKey}.sealed`, destination=objectPath(objectKey)
      await mkdir(path.dirname(destination),{recursive:true})
      const temporary=`${destination}.${randomUUID()}.tmp`
      try {
        await copyFile(objectPath(upload.objectKey),temporary)
        if((await stat(temporary)).size!==upload.size) throw new HttpError(409,'UPLOAD_MISMATCH','Dosya boyutu eşleşmiyor.')
        // Publish a complete inode atomically, without replacing an existing seal.
        try { await link(temporary,destination) } catch(error) { if(error.code!=='EEXIST') throw error }
      } catch(error) {
        if(error.code==='ENOENT') {
          try { await stat(destination) } catch { throw new HttpError(409,'UPLOAD_INCOMPLETE','Dosya henüz yüklenmedi.') }
        } else throw error
      } finally { await rm(temporary,{force:true}) }
      const info=await stat(destination)
      if(info.size!==upload.size) throw new HttpError(409,'UPLOAD_MISMATCH','Dosya boyutu eşleşmiyor.')
      return {objectKey,size:info.size,mimeType:upload.mimeType}
    }) },
    async read(key,options={}) { return createReadStream(objectPath(key),options) },
    async delete(key) { await rm(objectPath(key),{force:true}) },
    async cleanupTemporaryObjects() {
      await cleanupArchiveTemporary()
      if(Date.now()-lastTemporarySweep<60000) return 0
      lastTemporarySweep=Date.now()
      const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
      const id=new RegExp(`^${uuid}$`,'i')
      const temporary=new RegExp(`^${uuid}(?:\\.sealed)?\\.${uuid}\\.tmp$`,'i')
      const archiveTemporary=new RegExp(`^${uuid}-[0-9]{1,10}\\.zip\\.${uuid}\\.tmp$`,'i')
      let removed=0
      async function walk(directory,depth=0) {
        let entries
        try { entries=await opendir(directory) } catch(error) {if(error.code==='ENOENT')return;throw error}
        for await(const entry of entries) {
          if(entry.isSymbolicLink()) continue
          const target=path.join(directory,entry.name)
          const allowed=depth===0?entry.name==='workspaces':depth===1||depth===3?id.test(entry.name):depth===2?['objects','archives'].includes(entry.name):false
          if(entry.isDirectory() && depth<4 && allowed) await walk(target,depth+1)
          else if(entry.isFile() && ((depth===4 && temporary.test(entry.name)) || (depth===3 && archiveTemporary.test(entry.name)))) {
            try {if((await stat(target)).mtimeMs<Date.now()-600000){await rm(target,{force:true});removed++}}
            catch(error){if(error.code!=='ENOENT')throw error}
          }
        }
      }
      await walk(root)
      return removed
    },
    async close() {},
  }
}

function createS3Storage(config) {
  const {bucket,...clientConfig}=config.s3
  // A presigned PUT has no body yet. Automatic CRC32 would sign the checksum
  // of an empty body and reject every nonempty browser upload.
  const client=new S3Client({...clientConfig,requestChecksumCalculation:'WHEN_REQUIRED',requestHandler:{connectionTimeout:10000,requestTimeout:60000,socketTimeout:60000}})
  const transfer=createTransferGate()
  const commandInput = key => ({Bucket:bucket,Key:key})
  async function head(key) {
    try { const item=await client.send(new HeadObjectCommand(commandInput(key))); return {size:item.ContentLength,mimeType:item.ContentType,etag:item.ETag} }
    catch(error) { if(error.$metadata?.httpStatusCode===404) return null; throw error }
  }
  return {
    router:Router(),config,
    async checkHealth(){await client.send(new HeadBucketCommand({Bucket:bucket}))},
    async writeArchive(key,source,{signal}={}) {return transfer(async()=>{
      if(!archiveKey(key))throw new Error('Invalid archive key')
      const directory=await createArchiveTemporary('output'),temporary=path.join(directory,'archive.zip')
      let body
      try{
        await pipeline(source,archiveBound(config),createWriteStream(temporary,{flags:'wx',mode:0o600}),{signal})
        const size=(await stat(temporary)).size
        body=createReadStream(temporary)
        try{await client.send(new PutObjectCommand({...commandInput(key),Body:body,ContentLength:size,ContentType:'application/zip',IfNoneMatch:'*'}),{abortSignal:signal})}catch(error){if(error.$metadata?.httpStatusCode!==412)throw error}
        const info=await head(key);if(!info||info.mimeType!=='application/zip')throw new Error('Archive publication failed');return info
      }finally{body?.destroy();await removeArchiveTemporary(directory)}
    })},
    async createUpload({upload,expiresInSeconds=300}) {
      const command=new PutObjectCommand({...commandInput(upload.objectKey),ContentType:upload.mimeType,ContentLength:upload.size})
      return {uploadUrl:await getSignedUrl(client,command,{expiresIn:expiresInSeconds,signableHeaders:new Set(['content-type'])}),headers:{'Content-Type':upload.mimeType}}
    },
    head,
    async promoteUpload(upload) { return transfer(async()=>{
      const objectKey=`${upload.objectKey}.sealed`
      let info=await head(objectKey)
      if (!info) {
        const source=await head(upload.objectKey)
        if (!source || source.size!==upload.size || source.mimeType!==upload.mimeType) throw new HttpError(409,'UPLOAD_MISMATCH','Yüklenen dosya beklenen boyut veya türde değil.')
        const response=await client.send(new GetObjectCommand({...commandInput(upload.objectKey),IfMatch:source.etag}))
        const bytes=await collect(response.Body,config.maxUploadBytes)
        if(bytes.length!==upload.size) throw new HttpError(409,'UPLOAD_MISMATCH','Dosya boyutu eşleşmiyor.')
        try { await client.send(new PutObjectCommand({...commandInput(objectKey),Body:bytes,ContentType:upload.mimeType,IfNoneMatch:'*'})) }
        catch(error) { if(error.$metadata?.httpStatusCode!==412) throw error }
        info=await head(objectKey)
      }
      if (!info || info.size!==upload.size || info.mimeType!==upload.mimeType) throw new HttpError(409,'UPLOAD_MISMATCH','Dosya boyutu veya türü eşleşmiyor.')
      return {objectKey,size:info.size,mimeType:info.mimeType}
    }) },
    async read(key,{start,end,signal}={}) {
      const result=await client.send(new GetObjectCommand({...commandInput(key),...(start!==undefined?{Range:`bytes=${start}-${end??''}`}:{})}),{abortSignal:signal})
      return result.Body
    },
    async delete(key) { await client.send(new DeleteObjectCommand(commandInput(key))) },
    async cleanupTemporaryObjects(){return cleanupArchiveTemporary()},
    async close() { client.destroy() },
  }
}
