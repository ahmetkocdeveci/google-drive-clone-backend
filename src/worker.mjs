import {createArchiveProcessor} from './archives.mjs'

export function createWorker({models,storage,mailer,config=storage.config}) {
  const archives=createArchiveProcessor({models,storage,config})
  function uploadKey(upload) {
    const expected=`workspaces/${upload.workspaceId}/objects/${upload.nodeId}/${upload._id}`
    if(upload.objectKey!==expected) throw new Error('Invalid scoped object reference')
    return expected
  }
  async function removeNode(workspaceId,nodeId) {
    const node=await models.DriveNode.findOne({_id:nodeId,workspaceId})
    if(!node) return
    const children=models.DriveNode.find({workspaceId,parentId:nodeId}).select('_id').cursor()
    for await (const child of children) await removeNode(workspaceId,child._id)
    const uploads=await models.Upload.find({workspaceId,nodeId})
    for(const upload of uploads) {
      const key=uploadKey(upload)
      await storage.delete(key)
      await storage.delete(`${key}.sealed`)
    }
    if(node.objectKey) {
      const prefix=`workspaces/${workspaceId}/objects/${nodeId}/`
      if(!node.objectKey.startsWith(prefix) || !/^[a-f0-9-]{36}(?:\.sealed)?$/i.test(node.objectKey.slice(prefix.length))) throw new Error('Invalid scoped object reference')
      await storage.delete(node.objectKey)
    }
    await models.Workspace.db.transaction(async session=>{
      const workspace=await models.Workspace.findOneAndUpdate({_id:workspaceId},{$inc:{mutationSequence:1}},{session,returnDocument:'after'})
      if(!workspace) return
      const current=await models.DriveNode.findOne({_id:nodeId,workspaceId,status:{$ne:'deleted'}}).session(session)
      if(!current) return
      const pending=await models.Upload.find({workspaceId,nodeId,state:'initiated'}).session(session)
      const reserved=pending.reduce((sum,item)=>sum+item.size,0)
      const used=current.kind==='file' && current.storageState==='ready'?current.size:0
      await models.Upload.updateMany({workspaceId,nodeId,state:{$in:['initiated','completed']}},{$set:{state:'cancelled'}},{session})
      await models.DriveNode.updateOne({_id:nodeId,workspaceId},{$set:{status:'deleted',storageState:'deleted'}},{session})
      await models.Workspace.updateOne({_id:workspaceId},{$inc:{storageUsed:-used,storageReserved:-reserved}},{session})
    },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},readPreference:'primary'})
  }
  async function perform(job) {
    const {workspaceId,targetId}=job
    if(job.type==='node-cleanup') return removeNode(workspaceId,targetId)
    if(job.type==='archive-build') return archives.build(job)
    if(job.type==='archive-expiry') return archives.expire(job)
    if(job.type==='workspace-cleanup') {
      await archives.cancelWorkspace(workspaceId)
      const roots=models.DriveNode.find({workspaceId,parentId:null}).select('_id').cursor()
      for await(const node of roots) await removeNode(workspaceId,node._id)
      await models.Workspace.db.transaction(async session=>{
        await models.Workspace.findOneAndUpdate({_id:workspaceId,status:'deleting'},{$inc:{mutationSequence:1}},{session})
        await models.Membership.updateMany({workspaceId,status:'active'},{$set:{status:'removed'},$inc:{version:1}},{session})
        await models.Invitation.updateMany({workspaceId,status:'pending'},{$set:{status:'revoked'},$inc:{version:1}},{session})
        await models.Workspace.updateOne({_id:workspaceId,status:'deleting'},{$set:{status:'deleted',storageUsed:0,storageReserved:0}},{session})
      },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},readPreference:'primary'})
      return
    }
    if(job.type==='upload-expiry') {
      const upload=await models.Workspace.db.transaction(async session=>{
        await models.Workspace.findOneAndUpdate({_id:workspaceId},{$inc:{mutationSequence:1}},{session})
        const current=await models.Upload.findOne({_id:targetId,workspaceId}).session(session)
        if(!current) return null
        if(current.state==='completed') return current.toObject()
        if(current.expiresAt>new Date() && current.state==='initiated') throw new Error('Not yet expired')
        const changed=await models.Upload.findOneAndUpdate({_id:targetId,workspaceId,state:'initiated',expiresAt:{$lte:new Date()}},{$set:{state:'expired'}},{session,returnDocument:'after'})
        if(changed) {
          await models.Workspace.updateOne({_id:workspaceId},{$inc:{storageReserved:-changed.size}},{session})
          await models.DriveNode.updateOne({_id:changed.nodeId,workspaceId,status:'pending-upload'},{$set:{status:'deleted',storageState:'deleted'}},{session})
        }
        return (changed || current).toObject()
      },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},readPreference:'primary'})
      if(!upload) return
      // Claim expiry under the same workspace lock as finalize before touching bytes.
      const key=uploadKey(upload)
      await storage.delete(key)
      if(upload.state!=='completed') await storage.delete(`${key}.sealed`)
      return
    }
    throw new Error('Unknown job type')
  }
  async function drainJobs(limit=20) {
      let processed=0
      for(;processed<limit;processed++) {
        const now=new Date()
        const job=await models.Job.findOneAndUpdate({availableAt:{$lte:now},$or:[{status:'pending'},{status:'running',leaseUntil:{$lte:now}}]},{$set:{status:'running',leaseUntil:new Date(Date.now()+120000)},$inc:{attempts:1}},{returnDocument:'after',sort:{createdAt:1}})
        if(!job) break
        const claim={_id:job._id,workspaceId:job.workspaceId,status:'running',attempts:job.attempts}
        const renew=setInterval(()=>{void models.Job.updateOne(claim,{$set:{leaseUntil:new Date(Date.now()+120000)}}).catch(()=>{})},30000)
        try { await perform(job); await models.Job.updateOne(claim,{$set:{status:'done',leaseUntil:null}}) }
        catch { await models.Job.updateOne(claim,{$set:{status:job.attempts>=10?'failed':'pending',leaseUntil:null,availableAt:new Date(Date.now()+Math.min(3600000,1000*2**job.attempts))}}) }
        finally { clearInterval(renew) }
      }
      // A promotion/PUT already in flight can finish after cancellation. Repeat
      // orphan removal; no finalized active object's bytes are ever collected.
      const orphans=await models.Upload.find({state:{$in:['expired','cancelled','completed']},expiresAt:{$lt:new Date(Date.now()-600000)}}).sort({updatedAt:1}).limit(limit).lean()
      for(const upload of orphans) {
        try {
          const key=uploadKey(upload)
          await storage.delete(key)
          if(upload.state!=='completed') await storage.delete(`${key}.sealed`)
          await models.Upload.updateOne({_id:upload._id,workspaceId:upload.workspaceId,state:{$in:['expired','cancelled','completed']}},{$set:{updatedAt:new Date()}})
        } catch { /* A later pass retries provider failures without exposing keys. */ }
      }
      await storage.cleanupTemporaryObjects?.()
      await archives.collect(limit)
      return processed
  }
  return {
    drainJobs,
    async drain(limit=20) {
      const [processed]=await Promise.all([drainJobs(limit),mailer.drain(limit)])
      return processed
    },
  }
}
