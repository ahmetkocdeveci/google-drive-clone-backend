import {createConfig} from './config.mjs'
import {connectDatabase} from './models.mjs'
import {createStorage} from './storage.mjs'
import {createMailer} from './mailer.mjs'
import {createWorker} from './worker.mjs'
import {startBackgroundWork,settleWithin} from './background.mjs'
const config=createConfig(),{connection,models}=await connectDatabase(config.mongodbUri)
const storage=createStorage({models,config}),mailer=createMailer({models,config}),worker=createWorker({models,storage,mailer,config})
const background=startBackgroundWork({worker,mailer})
let shuttingDown=false
async function shutdown(){if(shuttingDown)return;shuttingDown=true;await settleWithin(background.stop());mailer.close();await storage.close();await connection.close();process.exit(0)}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,shutdown)
