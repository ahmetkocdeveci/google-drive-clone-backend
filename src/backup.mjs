import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto'
import {createReadStream,createWriteStream,constants} from 'node:fs'
import {mkdir,open,readFile,rename,stat,rm,opendir,lstat,access,appendFile,copyFile} from 'node:fs/promises'
import {Readable,Transform} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import path from 'node:path'

const magic=Buffer.from('ODBACK01')
const keyBytes=key=>{if(!/^[a-f0-9]{64}$/i.test(key || ''))throw new Error('BACKUP_ENCRYPTION_KEY must be a separate 32-byte hex key.');return Buffer.from(key,'hex')}
const exists=async file=>{try{await access(file);return true}catch(error){if(error.code==='ENOENT')return false;throw error}}
export const validObjectKey=key=>typeof key==='string' && /^workspaces\/[a-zA-Z0-9-]+\/(?:objects\/[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+(?:\.sealed)?|archives\/[a-zA-Z0-9-]+\.zip)$/.test(key)
export function validateMongoToolsConfiguration(value,expectedUri){
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==1 || typeof value.uri!=='string' || value.uri!==expectedUri)throw new Error('Mongo tools uri must exactly match MONGODB_URI; no alternate credentials/options are accepted.')
  return {uri:expectedUri}
}
export function validateLocalMongoContainer(value){
  if(!value?.running || !/^[a-f0-9]{64}$/.test(value.id || '') || !value.ports?.['27018/tcp']?.some(binding=>binding.HostIp==='127.0.0.1' && binding.HostPort==='27018'))throw new Error('Docker Mongo tools must use the running container publishing exactly 127.0.0.1:27018.')
  return value.id
}
async function seal(stream,file,key){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',keyBytes(key),iv),digest=createHash('sha256');let size=0
  cipher.setAAD(magic)
  const handle=await open(file,'wx',0o600)
  try{await handle.write(Buffer.concat([magic,iv]))}finally{await handle.close()}
  const measure=new Transform({transform(chunk,_encoding,callback){digest.update(chunk);size+=chunk.length;callback(null,chunk)}})
  await pipeline(stream,measure,cipher,createWriteStream(file,{flags:'r+',start:20}))
  await appendFile(file,cipher.getAuthTag())
  return {size,sha256:digest.digest('hex')}
}
async function unseal(file,destination,key,expected){
  const info=await stat(file);if(info.size<36)throw new Error('Invalid backup file.')
  const handle=await open(file,'r'),header=Buffer.alloc(20),tag=Buffer.alloc(16)
  try{await handle.read(header,0,20,0);await handle.read(tag,0,16,info.size-16)}finally{await handle.close()}
  if(!header.subarray(0,8).equals(magic))throw new Error('Unknown backup format.')
  const decipher=createDecipheriv('aes-256-gcm',keyBytes(key),header.subarray(8));decipher.setAAD(magic);decipher.setAuthTag(tag)
  const temporary=`${destination}.partial`,digest=createHash('sha256');let size=0
  try{
    const measure=new Transform({transform(chunk,_encoding,callback){digest.update(chunk);size+=chunk.length;callback(null,chunk)}})
    const input=info.size===36?Readable.from([]):createReadStream(file,{start:20,end:info.size-17})
    await pipeline(input,decipher,measure,createWriteStream(temporary,{flags:'wx',mode:0o600}))
    const sha256=digest.digest('hex')
    if(expected && (size!==expected.size || sha256!==expected.sha256))throw new Error('Backup integrity mismatch.')
    await rename(temporary,destination)
  }finally{await rm(temporary,{force:true})}
}
export async function* localObjects(root){
  try{if((await lstat(root)).isSymbolicLink())throw new Error('Symlinks are forbidden in object backups.')}catch(error){if(error.code!=='ENOENT')throw error}
  async function* walk(directory){
    let entries
    try{entries=await opendir(directory)}catch(error){if(error.code==='ENOENT')return;throw error}
    for await(const entry of entries){
      const full=path.join(directory,entry.name)
      if(entry.isSymbolicLink())throw new Error('Symlinks are forbidden in object backups.')
      if(entry.isDirectory())yield*walk(full)
      else if(entry.isFile()){
        const key=path.relative(root,full).split(path.sep).join('/')
        // Temporary unpublished uploads are intentionally excluded.
        if(key.endsWith('.tmp'))continue
        if(!validObjectKey(key))throw new Error('Unexpected object path; backup stopped.')
        if((await lstat(full)).isSymbolicLink())throw new Error('Symlinks are forbidden.')
        yield {key,read:()=>createReadStream(full)}
      }
    }
  }
  yield*walk(path.resolve(root))
}
export async function createBackup({directory,key,databaseName,dump,objects}){
  keyBytes(key)
  if(!/^[a-zA-Z0-9_-]{1,63}$/.test(databaseName))throw new Error('Invalid database name.')
  if(await exists(directory))throw new Error('Backup destination must not exist.')
  await mkdir(directory,{recursive:false,mode:0o700})
  // A complete, authenticated manifest is the commit marker; partial backups cannot restore.
  const manifest={version:1,createdAt:new Date().toISOString(),databaseName,database:null,objects:[]}
  manifest.database=await seal(await dump(),path.join(directory,'database.enc'),key)
  let index=0
  for await(const object of objects){
    if(!validObjectKey(object.key))throw new Error('Invalid object key.')
    const file=`object-${String(index++).padStart(9,'0')}.enc`
    manifest.objects.push({key:object.key,file,...await seal(await object.read(),path.join(directory,file),key)})
  }
  await seal(Readable.from([JSON.stringify(manifest)]),path.join(directory,'manifest.enc'),key)
  return {objects:manifest.objects.length,databaseBytes:manifest.database.size}
}
export async function restoreBackup({directory,key,temporaryDirectory,targetDatabase,objectDirectory,assertDatabaseAbsent,restore}){
  keyBytes(key)
  if(!/^[a-zA-Z0-9_-]{1,63}$/.test(targetDatabase))throw new Error('Invalid target database name.')
  if(await exists(objectDirectory))throw new Error('Restore object directory must not exist.')
  await assertDatabaseAbsent(targetDatabase)
  if(await exists(temporaryDirectory))throw new Error('Restore temporary directory must not exist.')
  await mkdir(temporaryDirectory,{mode:0o700})
  try{
    const manifestFile=path.join(temporaryDirectory,'manifest.json')
    await unseal(path.join(directory,'manifest.enc'),manifestFile,key)
    const info=await stat(manifestFile);if(info.size>64*1024**2)throw new Error('Manifest too large.')
    const manifest=JSON.parse(await readFile(manifestFile,'utf8'))
    if(manifest.version!==1 || !/^[a-zA-Z0-9_-]{1,63}$/.test(manifest.databaseName) || !Array.isArray(manifest.objects))throw new Error('Invalid manifest.')
    const seen=new Set()
    for(const item of manifest.objects){
      if(!validObjectKey(item.key) || !/^object-\d{9}\.enc$/.test(item.file) || seen.has(item.key))throw new Error('Invalid manifest object.')
      seen.add(item.key)
    }
    const dumpFile=path.join(temporaryDirectory,'database.archive')
    await unseal(path.join(directory,'database.enc'),dumpFile,key,manifest.database)
    const staged=path.join(temporaryDirectory,'objects');await mkdir(staged)
    // Authenticate every object before touching the target database.
    for(const item of manifest.objects){const target=path.join(staged,...item.key.split('/'));await mkdir(path.dirname(target),{recursive:true});await unseal(path.join(directory,item.file),target,key,item)}
    await assertDatabaseAbsent(targetDatabase)
    await restore({stream:createReadStream(dumpFile),sourceDatabase:manifest.databaseName,targetDatabase})
    // Never replace an existing destination, including an empty directory.
    await mkdir(objectDirectory,{mode:0o700})
    for(const item of manifest.objects){
      const target=path.join(objectDirectory,...item.key.split('/'))
      await mkdir(path.dirname(target),{recursive:true})
      await copyFile(path.join(staged,...item.key.split('/')),target,constants.COPYFILE_EXCL)
    }
    return {objects:manifest.objects.length,sourceDatabase:manifest.databaseName,targetDatabase}
  }finally{
    const resolved=path.resolve(temporaryDirectory)
    if(resolved===path.parse(resolved).root)throw new Error('Unsafe restore temporary directory.')
    await rm(resolved,{recursive:true,force:true})
  }
}
