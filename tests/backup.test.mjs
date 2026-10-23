import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {randomBytes} from 'node:crypto'
import {Readable} from 'node:stream'
import {createBackup,restoreBackup,localObjects,validateMongoToolsConfiguration,validateLocalMongoContainer} from '../src/backup.mjs'

test('native database tools cannot bypass the destination guard using a different cluster or credentials',()=>{
  const uri='mongodb://127.0.0.1:27018/source?replicaSet=rs0'
  assert.deepEqual(validateMongoToolsConfiguration({uri},uri),{uri})
  assert.throws(()=>validateMongoToolsConfiguration({uri:'mongodb://another-cluster/source'},uri),/exactly match/)
  assert.throws(()=>validateMongoToolsConfiguration({uri,password:'override'},uri),/alternate/)
  assert.throws(()=>validateMongoToolsConfiguration({uri:undefined},undefined))
})

test('Docker database tools are bound to the same running loopback container used by the destination guard',()=>{
  const value={id:'a'.repeat(64),running:true,ports:{'27018/tcp':[{HostIp:'127.0.0.1',HostPort:'27018'}]}}
  assert.equal(validateLocalMongoContainer(value),value.id)
  assert.throws(()=>validateLocalMongoContainer({...value,running:false}))
  assert.throws(()=>validateLocalMongoContainer({...value,ports:{'27018/tcp':[{HostIp:'127.0.0.1',HostPort:'27019'}]}}))
  assert.throws(()=>validateLocalMongoContainer({...value,ports:{'27018/tcp':[{HostIp:'0.0.0.0',HostPort:'27018'}]}}))
  assert.throws(()=>validateLocalMongoContainer({...value,ports:{}}))
})

test('encrypted backup authenticates database and private bytes before isolated restore',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'drive-backup-test-')),key=randomBytes(32).toString('hex'),objects=path.join(root,'source'),backup=path.join(root,'backup')
  try{
    const objectKey='workspaces/abc/objects/def/ghi.sealed'
    await mkdir(path.join(objects,'workspaces/abc/objects/def'),{recursive:true})
    await writeFile(path.join(objects,...objectKey.split('/')),'private file bytes')
    await createBackup({directory:backup,key,databaseName:'source',dump:async()=>Readable.from(['mongo dump bytes']),objects:localObjects(objects)})
    assert.ok(!(await readFile(path.join(backup,'database.enc'))).includes(Buffer.from('mongo dump bytes')))
    let restored=false
    const options={directory:backup,key,targetDatabase:'new_database',objectDirectory:path.join(root,'restored'),temporaryDirectory:path.join(root,'temporary'),assertDatabaseAbsent:async()=>{},restore:async({stream,sourceDatabase})=>{assert.equal(sourceDatabase,'source');const chunks=[];for await(const chunk of stream)chunks.push(chunk);assert.equal(Buffer.concat(chunks).toString(),'mongo dump bytes');restored=true}}
    await assert.rejects(restoreBackup({...options,key:randomBytes(32).toString('hex')}))
    assert.equal(restored,false)
    await restoreBackup(options)
    assert.equal(restored,true)
    assert.equal(await readFile(path.join(root,'restored',...objectKey.split('/')),'utf8'),'private file bytes')
    await assert.rejects(restoreBackup(options),/must not exist/)
    const encrypted=await readFile(path.join(backup,'object-000000000.enc'));encrypted[21]^=1;await writeFile(path.join(backup,'object-000000000.enc'),encrypted)
    restored=false
    await assert.rejects(restoreBackup({...options,objectDirectory:path.join(root,'tampered')}))
    assert.equal(restored,false)
  }finally{const resolved=path.resolve(root);assert.ok(resolved.startsWith(path.resolve(tmpdir())+path.sep));await rm(resolved,{recursive:true,force:true})}
})
