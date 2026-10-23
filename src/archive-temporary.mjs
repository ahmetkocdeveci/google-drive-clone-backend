import {mkdtemp,opendir,stat,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'

const active=new Set()
let lastSweep=0
export async function createArchiveTemporary(kind){
  if(!['output','manifest'].includes(kind))throw new Error('Unknown archive temporary kind')
  const directory=await mkdtemp(path.join(tmpdir(),`ortak-drive-archive-${kind}-`))
  active.add(path.resolve(directory));return directory
}
export async function removeArchiveTemporary(directory){
  const resolved=path.resolve(directory),root=path.resolve(tmpdir())
  if(path.dirname(resolved)!==root || !/^ortak-drive-archive-(output|manifest)-[a-zA-Z0-9]{6}$/.test(path.basename(resolved)))throw new Error('Unsafe archive temporary directory')
  try{await rm(resolved,{recursive:true,force:true})}finally{active.delete(resolved)}
}
export async function cleanupArchiveTemporary({now=Date.now(),minimumAgeMs=24*3600000,force=false}={}){
  if(!force && now-lastSweep<60000)return 0
  lastSweep=now
  const root=path.resolve(tmpdir()),entries=await opendir(root);let examined=0,removed=0
  for await(const entry of entries){
    if(++examined>5000 || removed>=20)break
    if(!entry.isDirectory() || !/^ortak-drive-archive-(output|manifest)-[a-zA-Z0-9]{6}$/.test(entry.name))continue
    const directory=path.resolve(root,entry.name)
    if(active.has(directory))continue
    try{if((await stat(directory)).mtimeMs<now-minimumAgeMs){await removeArchiveTemporary(directory);removed++}}
    catch(error){if(error.code!=='ENOENT')throw error}
  }
  return removed
}
