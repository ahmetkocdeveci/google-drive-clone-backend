import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {randomUUID} from 'node:crypto'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import path from 'node:path'
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import mongoose from 'mongoose'
import {S3Client,ListObjectsV2Command,GetObjectCommand} from '@aws-sdk/client-s3'
import {createConfig} from '../src/config.mjs'
import {createBackup,restoreBackup,localObjects,validObjectKey,validateMongoToolsConfiguration,validateLocalMongoContainer} from '../src/backup.mjs'

const [command,...raw]=process.argv.slice(2),args=new Map()
for(let index=0;index<raw.length;index++){if(!raw[index].startsWith('--'))throw new Error('Use named arguments.');const name=raw[index].slice(2);args.set(name,raw[index+1]?.startsWith('--') || !raw[index+1]?true:raw[++index])}
const required=name=>{const value=args.get(name);if(typeof value!=='string' || !value)throw new Error(`--${name} is required.`);return value}
const config=createConfig(),key=process.env.BACKUP_ENCRYPTION_KEY
if(args.get('maintenance-confirmed')!==true)throw new Error('Stop every API and worker, then pass --maintenance-confirmed. Never back up a live writer.')
let reachable=false
try{await fetch(`${config.apiOrigin}/health`,{signal:AbortSignal.timeout(3000)});reachable=true}catch{}
if(reachable)throw new Error('API is reachable. Stop API and all workers before continuing.')
const database=new URL(config.mongodbUri).pathname.slice(1)
const container=args.get('docker-container')
let nativeConfigurationDirectory,nativeConfigurationFile,dockerContainerId
function tool(name,extra){
  if(container){
    const uri=new URL(config.mongodbUri)
    if(uri.hostname!=='127.0.0.1' || uri.username || uri.password || uri.port!=='27018' || !dockerContainerId)throw new Error('Docker tools are limited to the validated local development replica set.')
    return [process.env.DOCKER_BIN || 'docker',['exec','-i',dockerContainerId,name,'--host','127.0.0.1','--port','27018',...extra]]
  }
  if(!nativeConfigurationFile)throw new Error('Validated native tools configuration is required.')
  return [name,['--config',nativeConfigurationFile,...extra]]
}
function run(name,extra){
  const [program,parameters]=tool(name,extra),child=spawn(program,parameters,{stdio:['pipe','pipe','ignore'],windowsHide:true})
  const done=new Promise((resolve,reject)=>{child.once('error',()=>reject(new Error(`${name} could not start.`)));child.once('close',code=>code===0?resolve():reject(new Error(`${name} failed; inspect the database tools configuration.`)))})
  // Attach immediately so tool failure cannot become an unhandled rejection.
  done.catch(()=>{})
  return {child,done}
}
let s3,connection
try{
  if(container){
    if(typeof container!=='string' || !/^[a-zA-Z0-9_-]+$/.test(container))throw new Error('Invalid Docker container name.')
    let inspected
    try{
      const {stdout}=await promisify(execFile)(process.env.DOCKER_BIN || 'docker',['inspect','--format','{"id":{{json .Id}},"running":{{json .State.Running}},"ports":{{json .NetworkSettings.Ports}}}',container],{windowsHide:true,timeout:10000,maxBuffer:32768})
      inspected=JSON.parse(stdout)
    }catch{throw new Error('Could not validate the local Mongo container port mapping.')}
    dockerContainerId=validateLocalMongoContainer(inspected)
  }else{
    // JSON is a YAML subset accepted by MongoDB tools. A single source URI also
    // binds the absence guard, dump and restore to exactly the same cluster.
    let parsed
    try{parsed=JSON.parse(await readFile(required('mongo-tools-config'),'utf8'))}catch{throw new Error('Mongo tools configuration must be a JSON object containing only uri.')}
    validateMongoToolsConfiguration(parsed,config.mongodbUri)
    nativeConfigurationDirectory=await mkdtemp(path.join(tmpdir(),'drive-mongo-tools-'))
    nativeConfigurationFile=path.join(nativeConfigurationDirectory,'config.json')
    await writeFile(nativeConfigurationFile,JSON.stringify({uri:config.mongodbUri}),{flag:'wx',mode:0o600})
  }
  if(command==='create'){
    let objects=localObjects(config.localStoragePath)
    if(config.storageDriver==='s3'){
      s3=new S3Client({...config.s3,requestHandler:{connectionTimeout:10000,requestTimeout:60000}})
      objects=(async function*(){let token;do{
        const page=await s3.send(new ListObjectsV2Command({Bucket:config.s3.bucket,Prefix:'workspaces/',ContinuationToken:token}))
        for(const item of page.Contents || []){if(!validObjectKey(item.Key)){if(item.Key.endsWith('.tmp'))continue;throw new Error('Unexpected bucket object key.')};yield{key:item.Key,read:async()=> (await s3.send(new GetObjectCommand({Bucket:config.s3.bucket,Key:item.Key}))).Body}}
        token=page.NextContinuationToken
      }while(token)})()
    }
    const result=await createBackup({directory:path.resolve(required('destination')),key,databaseName:database,objects,dump:async()=>{
      const {child,done}=run('mongodump',['--db',database,'--archive']);child.stdin.end()
      return Readable.from((async function*(){try{yield*child.stdout;await done}finally{child.kill()}})())
    }})
    console.log(JSON.stringify({status:'backup-complete',...result}))
  }else if(command==='restore'){
    const targetDatabase=required('database'),objectDirectory=path.resolve(required('objects'))
    connection=await mongoose.createConnection(config.mongodbUri,{serverSelectionTimeoutMS:10000}).asPromise()
    const result=await restoreBackup({directory:path.resolve(required('source')),key,targetDatabase,objectDirectory,temporaryDirectory:path.join(path.dirname(objectDirectory),`.restore-${randomUUID()}`),
      assertDatabaseAbsent:async name=>{const result=await connection.db.admin().listDatabases({nameOnly:true,filter:{name}});if(result.databases.length)throw new Error('Target database already exists; restore refuses to overwrite it.')},
      restore:async({stream,sourceDatabase,targetDatabase})=>{
        const {child,done}=run('mongorestore',['--archive','--stopOnError','--nsFrom',`${sourceDatabase}.*`,'--nsTo',`${targetDatabase}.*`])
        try{await Promise.all([pipeline(stream,child.stdin),done])}finally{child.kill()}
      }})
    console.log(JSON.stringify({status:'restore-complete',...result}))
  }else throw new Error('Command must be create or restore.')
}catch(error){console.error(error.message);process.exitCode=1}
finally{
  await connection?.close();s3?.destroy()
  if(nativeConfigurationDirectory){
    const resolved=path.resolve(nativeConfigurationDirectory)
    if(!resolved.startsWith(path.resolve(tmpdir())+path.sep))throw new Error('Unsafe tools configuration cleanup.')
    await rm(resolved,{recursive:true,force:true})
  }
}
