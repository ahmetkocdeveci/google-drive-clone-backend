import { Router } from 'express'
import {createHash,timingSafeEqual} from 'node:crypto'
import {statfs} from 'node:fs/promises'
import {tmpdir} from 'node:os'

export function createOperations({models,config,storage}) {
  const counts=new Map(), started=Date.now()
  const observe=(req,res,next)=>{
    const start=performance.now()
    res.once('finish',()=>{
      // Route templates contain no user IDs, paths, email addresses or tokens.
      const route=req.route?.path
      const label=typeof route==='string'?`${req.baseUrl || ''}${route}`:'unmatched'
      const key=JSON.stringify([req.method,label,String(res.statusCode)])
      if(counts.size>=256 && !counts.has(key))return
      const value=counts.get(key) || {count:0,seconds:0}
      value.count++;value.seconds+=(performance.now()-start)/1000;counts.set(key,value)
    })
    next()
  }
  const router=Router()
  let readiness=null,readyUntil=0,readyValue=false
  router.get('/health/ready',async(_req,res)=>{
    if(Date.now()>=readyUntil){
      if(!readiness)readiness=(async()=>{
        try{await models.Workspace.db.db.admin().command({ping:1,maxTimeMS:3000});await storage.checkHealth();readyValue=true}catch{readyValue=false}
        readyUntil=Date.now()+(readyValue?5000:1000)
      })().finally(()=>{readiness=null})
      await readiness
    }
    res.status(readyValue?200:503).json({status:readyValue?'ready':'unavailable'})
  })
  const authorize=(req,res,next)=>{
    const supplied=req.get('Authorization') || ''
    const hash=value=>createHash('sha256').update(value).digest()
    if(!config.operationsToken || !timingSafeEqual(hash(supplied),hash(`Bearer ${config.operationsToken}`)))return res.status(401).json({error:{code:'UNAUTHORIZED',message:'Kimlik doğrulama gerekli.'}})
    next()
  }
  async function snapshot(){
    const queues={}
    for(const [name,model,statuses] of [['jobs',models.Job,['pending','running','failed']],['mail',models.Outbox,['pending','sending','failed']],['archives',models.Archive,['pending','running','ready','failed']]]){
      queues[name]={}
      const grouped=await model.aggregate([{$match:{status:{$in:statuses}}},{$group:{_id:'$status',count:{$sum:1},oldest:{$min:'$createdAt'}}}]).option({maxTimeMS:3000})
      for(const status of statuses){const row=grouped.find(item=>item._id===status);queues[name][status]={count:row?.count || 0,oldestAgeSeconds:row?Math.max(0,(Date.now()-row.oldest.getTime())/1000):0}}
    }
    const disk=await statfs(tmpdir())
    return {uptimeSeconds:(Date.now()-started)/1000,heapUsedBytes:process.memoryUsage().heapUsed,scratchAvailableBytes:disk.bavail*disk.bsize,queues}
  }
  router.get('/ops/status',authorize,async(_req,res)=>res.json(await snapshot()))
  router.get('/metrics',authorize,async(_req,res)=>{
    const status=await snapshot(), lines=[]
    const metric=(name,help,type)=>lines.push(`# HELP ${name} ${help}`,`# TYPE ${name} ${type}`)
    metric('drive_uptime_seconds','Application uptime.','gauge');lines.push(`drive_uptime_seconds ${status.uptimeSeconds}`)
    metric('drive_heap_used_bytes','Node.js heap memory in use.','gauge');lines.push(`drive_heap_used_bytes ${status.heapUsedBytes}`)
    metric('drive_scratch_available_bytes','Free space for private archive scratch files.','gauge');lines.push(`drive_scratch_available_bytes ${status.scratchAvailableBytes}`)
    metric('drive_queue_items','Durable queue items by state.','gauge')
    for(const [queue,states]of Object.entries(status.queues))for(const[state,value]of Object.entries(states))lines.push(`drive_queue_items{queue="${queue}",state="${state}"} ${value.count}`)
    metric('drive_queue_oldest_age_seconds','Age of oldest queue item by state.','gauge')
    for(const [queue,states]of Object.entries(status.queues))for(const[state,value]of Object.entries(states))lines.push(`drive_queue_oldest_age_seconds{queue="${queue}",state="${state}"} ${value.oldestAgeSeconds}`)
    metric('drive_http_requests_total','Completed HTTP requests by route template.','counter')
    for(const[key,value]of counts){const[method,route,status]=JSON.parse(key);lines.push(`drive_http_requests_total{method=${JSON.stringify(method)},route=${JSON.stringify(route)},status=${JSON.stringify(status)}} ${value.count}`)}
    metric('drive_http_request_duration_seconds_sum','Total completed request duration by route template.','counter')
    for(const[key,value]of counts){const[method,route,status]=JSON.parse(key);lines.push(`drive_http_request_duration_seconds_sum{method=${JSON.stringify(method)},route=${JSON.stringify(route)},status=${JSON.stringify(status)}} ${value.seconds}`)}
    res.type('text/plain; version=0.0.4; charset=utf-8').send(`${lines.join('\n')}\n`)
  })
  return {observe,router}
}
