import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {randomBytes,randomUUID} from 'node:crypto'
import path from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {createHarness} from './helpers.mjs'
import {createBackup,restoreBackup,localObjects} from '../src/backup.mjs'

test('real Mongo dump plus private objects restore into a fresh database without changing source',async()=>{
  const h=await createHarness('backupmongo'),root=await mkdtemp(path.join(tmpdir(),'drive-backup-mongo-'))
  const docker=process.env.DOCKER_BIN || (process.platform==='win32'?'C:/Users/ahmet/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe':'docker')
  const container=process.env.MONGO_TOOLS_CONTAINER || 'ortak-drive-dev-mongo-1'
  const target=`drive_restore_test_${randomUUID().replaceAll('-','')}`,source=h.models.Workspace.db.name
  const targetDb=h.models.Workspace.db.getClient().db(target)
  const run=(name,args)=>{
    const child=spawn(docker,['exec','-i',container,name,'--host','127.0.0.1','--port','27018',...args],{stdio:['pipe','pipe','ignore'],windowsHide:true})
    const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(`${name} failed (${code})`))) });done.catch(()=>{})
    return {child,done}
  }
  try{
    const id=randomUUID(),objectKey=`workspaces/${id}/objects/${randomUUID()}/${randomUUID()}.sealed`
    await h.models.Workspace.create({_id:id,name:'Restore drill',createdBy:randomUUID()})
    await mkdir(path.dirname(path.join(h.config.localStoragePath,...objectKey.split('/'))),{recursive:true})
    await writeFile(path.join(h.config.localStoragePath,...objectKey.split('/')),'real private object')
    const key=randomBytes(32).toString('hex'),directory=path.join(root,'backup')
    await createBackup({directory,key,databaseName:source,objects:localObjects(h.config.localStoragePath),dump:async()=>{
      const {child,done}=run('mongodump',['--db',source,'--archive']);child.stdin.end()
      return Readable.from((async function*(){try{yield*child.stdout;await done}finally{child.kill()}})())
    }})
    await restoreBackup({directory,key,targetDatabase:target,objectDirectory:path.join(root,'restored'),temporaryDirectory:path.join(root,'temporary'),
      assertDatabaseAbsent:async name=>{const result=await targetDb.admin().listDatabases({nameOnly:true,filter:{name}});if(result.databases.length)throw new Error('database exists')},
      restore:async({stream,sourceDatabase,targetDatabase})=>{const{child,done}=run('mongorestore',['--archive','--stopOnError','--nsFrom',`${sourceDatabase}.*`,'--nsTo',`${targetDatabase}.*`]);try{await Promise.all([pipeline(stream,child.stdin),done])}finally{child.kill()}}})
    assert.equal((await targetDb.collection('workspaces').findOne({_id:id})).name,'Restore drill')
    assert.equal(await h.models.Workspace.countDocuments({_id:id}),1)
    assert.equal(await readFile(path.join(root,'restored',...objectKey.split('/')),'utf8'),'real private object')
    const indexes=await targetDb.collection('memberships').indexes();assert.ok(indexes.some(index=>index.unique))
  }finally{
    assert.match(target,/^drive_restore_test_[a-f0-9]{32}$/);await targetDb.dropDatabase()
    await h.close()
    const resolved=path.resolve(root);assert.ok(resolved.startsWith(path.resolve(tmpdir())+path.sep));await rm(resolved,{recursive:true,force:true})
  }
})
