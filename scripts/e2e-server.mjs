// Isolated test bootstrap; never points at an application database or public interface.
import {randomBytes,randomUUID} from 'node:crypto'
import {createConfig} from '../src/config.mjs'
import {connectDatabase} from '../src/models.mjs'
import {createStorage} from '../src/storage.mjs'
import {createMailer} from '../src/mailer.mjs'
import {createWorker} from '../src/worker.mjs'
import {createApp} from '../src/app.mjs'
import {startBackgroundWork,settleWithin} from '../src/background.mjs'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'

if(!process.argv.includes('--isolated-test-server'))throw new Error('Explicit --isolated-test-server flag is required.')
const name=`drive_e2e_${randomUUID().replaceAll('-','')}`
const directory=await mkdtemp(path.join(tmpdir(),'drive-e2e-'))
const config=createConfig({...process.env,NODE_ENV:'test',HOST:'127.0.0.1',PORT:'4100',API_ORIGIN:'http://127.0.0.1:4100',FRONTEND_ORIGIN:'http://127.0.0.1:4179',TRUSTED_PROXY_CIDRS:'',
  MONGODB_URI:`mongodb://127.0.0.1:27018/${name}?replicaSet=rs0&directConnection=true`,STORAGE_DRIVER:'local',LOCAL_STORAGE_PATH:directory,
  SMTP_HOST:'127.0.0.1',SMTP_PORT:'1025',SMTP_SECURE:'false',SMTP_USER:'',SMTP_PASSWORD:'',GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:'',
  OUTBOX_ENCRYPTION_KEY:randomBytes(32).toString('hex'),UPLOAD_SIGNING_KEY:randomBytes(32).toString('hex')})
const {models,connection}=await connectDatabase(config.mongodbUri)
const storage=createStorage({models,config}),mailer=createMailer({models,config}),worker=createWorker({models,config,storage,mailer})
const app=createApp({models,config,storage,mailer,rateLimit:false})
const server=app.listen(config.port,config.host,()=>console.log('Isolated E2E API ready on loopback:4100'))
const background=startBackgroundWork({worker,mailer,intervalMs:100})
let stopping=false
async function stop(){
  if(stopping)return;stopping=true
  await settleWithin(Promise.all([new Promise(resolve=>server.close(resolve)),background.stop()]))
  server.closeAllConnections();mailer.close();await storage.close()
  if(!/^drive_e2e_[a-f0-9]{32}$/.test(connection.name))throw new Error('Unsafe test database cleanup.')
  await connection.dropDatabase();await connection.close()
  const resolved=path.resolve(directory)
  if(!resolved.startsWith(path.resolve(tmpdir())+path.sep))throw new Error('Unsafe test object cleanup.')
  await rm(resolved,{recursive:true,force:true})
}
server.on('error',async()=>{await stop();process.exitCode=1})
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await stop();process.exit(0)})
