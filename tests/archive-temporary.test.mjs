import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,utimes,stat,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {createArchiveTemporary,removeArchiveTemporary,cleanupArchiveTemporary} from '../src/archive-temporary.mjs'

test('archive scratch recovery deletes old generated orphan directories while retaining active/fresh/unrelated data',async()=>{
  const active=await createArchiveTemporary('output'),fresh=await mkdtemp(path.join(tmpdir(),'ortak-drive-archive-manifest-')),old=await mkdtemp(path.join(tmpdir(),'ortak-drive-archive-output-')),unrelated=await mkdtemp(path.join(tmpdir(),'drive-unrelated-'))
  const past=new Date(Date.now()-48*3600000)
  try{
    for(const directory of [active,fresh,old,unrelated])await writeFile(path.join(directory,'private.txt'),'private bytes')
    for(const directory of [active,old,unrelated])await utimes(directory,past,past)
    await cleanupArchiveTemporary({force:true})
    await assert.rejects(stat(old),error=>error.code==='ENOENT')
    for(const directory of [active,fresh,unrelated])assert.ok((await stat(directory)).isDirectory())
  }finally{
    await removeArchiveTemporary(active)
    for(const directory of [fresh,old,unrelated]){const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(tmpdir()));await rm(resolved,{recursive:true,force:true})}
  }
})
