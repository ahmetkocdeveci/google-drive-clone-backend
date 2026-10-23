import { createConfig } from './config.mjs'
import { connectDatabase } from './models.mjs'
import { createStorage } from './storage.mjs'
import { createMailer } from './mailer.mjs'
import { createWorker } from './worker.mjs'
import { createApp } from './app.mjs'
import {startBackgroundWork,settleWithin} from './background.mjs'
const config=createConfig()
const {connection,models}=await connectDatabase(config.mongodbUri)
const storage=createStorage({models,config}), mailer=createMailer({models,config})
const app=createApp({models,config,storage,mailer})
const server=app.listen(config.port,config.host,()=>console.log(`Ortak Drive API: ${config.apiOrigin}/api/v1`))
server.requestTimeout=60000
const worker=createWorker({models,storage,mailer,config})
const background=startBackgroundWork({worker,mailer})
let shuttingDown=false
async function shutdown(){
  if(shuttingDown)return
  shuttingDown=true
  await settleWithin(Promise.all([new Promise(resolve=>server.close(resolve)),background.stop()]))
  server.closeAllConnections()
  mailer.close();await storage.close();await connection.close();process.exit(0)
}
process.once('SIGINT',shutdown)
process.once('SIGTERM',shutdown)
