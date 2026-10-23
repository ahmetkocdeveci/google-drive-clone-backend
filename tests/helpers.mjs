import supertest from 'supertest'
import {randomBytes,randomUUID} from 'node:crypto'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {createConfig} from '../src/config.mjs'
import {connectDatabase} from '../src/models.mjs'
import {createStorage} from '../src/storage.mjs'
import {createMailer} from '../src/mailer.mjs'
import {createWorker} from '../src/worker.mjs'
import {createApp} from '../src/app.mjs'

export async function createHarness(name,overrides={}) {
  const uri=new URL(process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27018/ortak_drive_test?replicaSet=rs0&directConnection=true')
  uri.pathname=`/ortak_drive_test_${name.replace(/[^a-z0-9]/gi,'').slice(0,12)}_${randomUUID().replaceAll('-','').slice(0,24)}`
  const directory=await mkdtemp(path.join(tmpdir(),'ortak-drive-test-'))
  const config=createConfig({...overrides,NODE_ENV:'test',MONGODB_URI:uri.toString(),OUTBOX_ENCRYPTION_KEY:randomBytes(32).toString('hex'),UPLOAD_SIGNING_KEY:randomBytes(32).toString('hex'),LOCAL_STORAGE_PATH:directory})
  let database
  try { database=await connectDatabase(config.mongodbUri) }
  catch(error) { await rm(directory,{recursive:true,force:true}); throw error }
  const {connection,models}=database
  const mail=[]
  const mailer=createMailer({models,config,transport:{async sendMail(item){mail.push(item)}}})
  const storage=createStorage({models,config}), worker=createWorker({models,storage,mailer,config})
  const app=createApp({models,config,mailer,storage,rateLimit:false})
  return {
    app,models,config,mail,mailer,storage,worker,
    client(){return supertest.agent(app)},
    async flushMail(){await mailer.drain(100)},
    async user({name='Test Kullanıcı',email=`${randomUUID()}@example.com`,password='Test1234!',verified=true}={}) {
      const agent=supertest.agent(app)
      let csrf=(await agent.get('/api/v1/auth/csrf-token')).body.csrfToken
      const registered=await agent.post('/api/v1/auth/register').set('Origin',config.frontendOrigin).set('X-CSRF-Token',csrf).send({name,email,password}).expect(201)
      csrf=(await agent.get('/api/v1/auth/csrf-token')).body.csrfToken
      let user=registered.body.user
      if(verified){
        await mailer.drain(100)
        const message=mail.findLast(item=>item.to===email.toLowerCase() && item.text.includes('/verify-email#'))
        if(!message)throw new Error('Verification mail not delivered')
        const token=new URL(message.text.match(/https?:\/\/\S+/)[0]).hash.slice('#token='.length)
        user=(await agent.post('/api/v1/auth/email-verification/confirm').set('Origin',config.frontendOrigin).set('X-CSRF-Token',csrf).send({token}).expect(200)).body.user
      }
      return {agent,user,csrf,password,request(method,route,body){
        const request=agent[method.toLowerCase()](`/api/v1${route}`).set('Origin',config.frontendOrigin).set('X-CSRF-Token',csrf)
        return body===undefined?request:request.send(body)
      }}
    },
    async close(){mailer.close();await storage.close();await connection.dropDatabase();await connection.close();await rm(directory,{recursive:true,force:true})},
  }
}
