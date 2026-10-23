import express from 'express'
import helmet from 'helmet'
import { createHash, randomUUID } from 'node:crypto'
import { ZodError } from 'zod'
import { createAuthRouter, createSessionMiddleware, requireCsrf } from './auth.mjs'
import { createWorkspaceRouter } from './workspaces.mjs'
import { createFilesRouter } from './files.mjs'
import { HttpError } from './errors.mjs'
import { requestContext } from './request-context.mjs'
import { createOperations } from './operations.mjs'
import { createArchivesRouter } from './archives.mjs'
import { createAuditRouter } from './audit-events.mjs'
import { createEdgeProxyGuard } from './edge-proxy.mjs'

export function createApp({models,config,mailer,storage,rateLimit=true,logger=console}) {
  const app=express()
  app.disable('x-powered-by')
  app.set('query parser','simple')
  if(config.trustedProxyCidrs?.length) app.set('trust proxy',config.trustedProxyCidrs)
  const operations=createOperations({models,config,storage})
  app.use(operations.observe)
  app.use((req,_res,next)=>{
    req.requestId=randomUUID()
    requestContext.run({requestId:req.requestId},next)
  })
  app.use(helmet({crossOriginResourcePolicy:{policy:'same-site'}}))
  app.use(createEdgeProxyGuard(config))
  app.use((req,res,next)=>{
    res.set({'X-Request-Id':req.requestId,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'})
    const requestOrigin=req.get('Origin')
    if (requestOrigin && ![config.frontendOrigin,config.apiOrigin].includes(requestOrigin)) return next(new HttpError(403,'ORIGIN_FORBIDDEN','Bu kaynaktan istek kabul edilmiyor.'))
    if (requestOrigin) res.set({'Access-Control-Allow-Origin':requestOrigin,'Access-Control-Allow-Credentials':'true',Vary:'Origin','Access-Control-Expose-Headers':'Content-Disposition, Content-Length, Content-Range, X-Request-Id'})
    if(req.method==='OPTIONS') {
      res.set({'Access-Control-Allow-Methods':'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-CSRF-Token, Range','Access-Control-Max-Age':'600'})
      return res.status(204).end()
    }
    if(!['GET','HEAD'].includes(req.method) && !requestOrigin && !req.path.toLowerCase().startsWith('/api/v1/storage/uploads/')) return next(new HttpError(403,'ORIGIN_REQUIRED','Origin başlığı gerekli.'))
    next()
  })
  if(rateLimit) app.use('/api/v1',async(req,res,next)=>{
    const sensitive=/^\/auth\/(login|register|csrf-token|google\/(?:start|link)|email-verification\/resend|password-reset)/i.test(req.path)
    const interval=sensitive?15*60000:60000, limit=sensitive?30:300
    const window=Math.floor(Date.now()/interval)
    const key=createHash('sha256').update(`${req.edgeClientIp || req.ip}:${sensitive?'auth':'api'}:${window}`).digest('hex')
    let record
    try { record=await models.RateLimit.findOneAndUpdate({key},{$inc:{count:1},$setOnInsert:{expiresAt:new Date((window+1)*interval)}},{returnDocument:'after',upsert:true}) }
    catch(error) { if(error.code!==11000) throw error; record=await models.RateLimit.findOneAndUpdate({key},{$inc:{count:1}},{returnDocument:'after'}) }
    if(record.count>limit) { res.set('Retry-After',String(Math.ceil(((window+1)*interval-Date.now())/1000))); return next(new HttpError(429,'RATE_LIMITED','Çok fazla istek gönderdin. Biraz sonra tekrar dene.')) }
    next()
  })
  let objectTransfers=0
  app.use((req,res,next)=>{
    if(!((req.method==='PUT' && req.path.toLowerCase().startsWith('/api/v1/storage/uploads/')) || (req.method==='POST' && /\/files\/uploads\/[^/]+\/complete\/?$/i.test(req.path)))) return next()
    if(objectTransfers>=4) return next(new HttpError(503,'STORAGE_BUSY','Dosya servisi yoğun. Biraz sonra tekrar dene.'))
    objectTransfers++
    let released=false
    const release=()=>{if(!released){released=true;objectTransfers--}}
    res.once('finish',release);res.once('close',release)
    next()
  })
  // Raw, bounded, capability-signed object PUTs never receive API session authority.
  app.use('/api/v1',storage.router)
  app.use(express.json({limit:'32kb',strict:true}))
  app.use(operations.router)
  app.get('/health',async(_req,res)=>{
    await models.Workspace.db.db.admin().command({ping:1})
    res.json({status:'ok'})
  })
  app.use('/api/v1',createSessionMiddleware({models,config}))
  app.use('/api/v1',(req,res,next)=> ['GET','HEAD'].includes(req.method)?next():requireCsrf(req,res,next))
  app.use('/api/v1/auth',createAuthRouter({models,config,mailer}))
  app.use('/api/v1',createWorkspaceRouter({models,config,mailer}))
  app.use('/api/v1',createFilesRouter({models,config,storage}))
  app.use('/api/v1',createArchivesRouter({models,config,storage}))
  app.use('/api/v1',createAuditRouter({models,config}))
  app.use((_req,_res,next)=>next(new HttpError(404,'NOT_FOUND','Kaynak bulunamadı.')))
  app.use((error,req,res,_next)=>{
    if(res.headersSent) { res.destroy(); return }
    let status=500,code='INTERNAL_ERROR',message='İstek tamamlanamadı. Lütfen tekrar dene.'
    if(error instanceof HttpError) ({status,code,message}=error)
    else if(error instanceof ZodError || error.type==='entity.parse.failed') {status=400;code='INVALID_INPUT';message='Gönderilen bilgileri kontrol et.'}
    else if(error.type==='entity.too.large') {status=413;code='BODY_TOO_LARGE';message='İstek boyutu sınırı aşıldı.'}
    else if(error.code===11000) {status=409;code='CONFLICT';message='Kayıt zaten mevcut. Bilgileri yenileyip tekrar dene.'}
    else if(error.name==='MongoServerSelectionError') {status=503;code='SERVICE_UNAVAILABLE';message='Servis geçici olarak kullanılamıyor.'}
    if(status>=500) logger.error(JSON.stringify({requestId:req.requestId,status,code}))
    res.status(status).json({error:{code,message,requestId:req.requestId}})
  })
  return app
}
