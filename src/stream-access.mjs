import {HttpError} from './errors.mjs'
import {permissions} from './tenant.mjs'

const revoked=()=>new HttpError(403,'STREAM_ACCESS_REVOKED','İndirme erişimi artık geçerli değil.')
const unavailable=()=>new HttpError(503,'STREAM_CHECK_UNAVAILABLE','İndirme erişimi şu anda doğrulanamıyor. Biraz sonra tekrar dene.')
const activeByModels=new WeakMap()

/** Re-check long-lived response authority using fresh, tenant-scoped records. */
export function createStreamAccessMonitor({models,req,workspaceId,nodeId,nodeKind,objectKey,contentVersion,validateExtra,signal,onRevoke,intervalMs=250,validationTimeoutMs=1000,initialValidationTimeoutMs=5000}){
  const sessionId=req.authSession?._id,userId=req.auth?.user?._id,tokenHash=req.authSession?.tokenHash
  const active=activeByModels.get(models) || {total:0,users:new Map()}
  activeByModels.set(models,active)
  let stopped=false,timer=null,currentProbe=null,reserved=false
  const stop=()=>{
    if(stopped)return
    stopped=true;clearTimeout(timer);currentProbe?.abort()
    if(reserved){reserved=false;active.total--;const remaining=(active.users.get(userId) || 1)-1;if(remaining)active.users.set(userId,remaining);else active.users.delete(userId)}
    signal?.removeEventListener('abort',stop)
  }
  signal?.addEventListener('abort',stop,{once:true})
  if(signal?.aborted)stop()

  async function validate(timeoutMs){
    signal?.throwIfAborted()
    if(stopped)throw revoked()
    const probe=new AbortController();currentProbe=probe
    let deadline
    const timeout=new Promise((_,reject)=>{deadline=setTimeout(()=>{probe.abort();reject(unavailable())},timeoutMs)})
    const options={signal:probe.signal,maxTimeMS:timeoutMs}
    const check=async()=>{
      if(!sessionId || !userId || !tokenHash)throw revoked()
      const lineage=models.DriveNode.collection.aggregate([
        {$match:{_id:nodeId,workspaceId,status:'active'}},
        {$graphLookup:{from:models.DriveNode.collection.name,startWith:'$parentId',connectFromField:'parentId',connectToField:'_id',as:'ancestors',maxDepth:63,restrictSearchWithMatch:{workspaceId,status:'active',kind:'folder'}}},
        {$project:{_id:1,parentId:1,kind:1,objectKey:1,storageState:1,ancestors:{_id:1,parentId:1}}},
      ],options)
      const [session,user,workspace,membership,node]=await Promise.all([
        models.Session.collection.findOne({_id:sessionId,userId,tokenHash,revokedAt:null,expiresAt:{$gt:new Date()}},{...options,projection:{passwordVersion:1}}),
        models.User.collection.findOne({_id:userId,status:'active',emailVerifiedAt:{$ne:null}},{...options,projection:{passwordVersion:1}}),
        models.Workspace.collection.findOne({_id:workspaceId,status:'active'},{...options,projection:{contentVersion:1}}),
        models.Membership.collection.findOne({workspaceId,userId,status:'active'},{...options,projection:{role:1}}),
        (async()=>{try{return await lineage.next()}finally{await lineage.close()}})(),
      ])
      if(!session)throw revoked()
      if(!user || (session.passwordVersion ?? 1)!==(user.passwordVersion ?? 1))throw revoked()
      if(!workspace || !membership || !permissions[membership.role]?.includes('content:read'))throw revoked()
      if(contentVersion!==undefined && (workspace.contentVersion ?? 0)!==contentVersion)throw revoked()
      if(!node || (nodeKind && node.kind!==nodeKind))throw revoked()
      if(objectKey!==undefined && (node.kind!=='file' || node.storageState!=='ready' || node.objectKey!==objectKey))throw revoked()
      const ancestors=new Map(node.ancestors.map(ancestor=>[ancestor._id,ancestor]))
      let nextId=node.parentId ?? null,depth=0
      const seen=new Set([nodeId])
      while(nextId!==null){
        if(++depth>64 || seen.has(nextId))throw revoked()
        seen.add(nextId)
        const ancestor=ancestors.get(nextId)
        if(!ancestor)throw revoked()
        nextId=ancestor.parentId ?? null
      }
      await validateExtra?.({options,userId})
      probe.signal.throwIfAborted()
    }
    try{await Promise.race([check(),timeout])}
    finally{clearTimeout(deadline);if(currentProbe===probe)currentProbe=null}
  }
  function schedule(){
    if(stopped)return
    timer=setTimeout(async()=>{
      try{await validate(validationTimeoutMs);schedule()}
      catch(error){if(!stopped){stop();onRevoke(error)}}
    },intervalMs)
    timer.unref?.()
  }
  return {
    async start(){try{
      if(stopped)throw revoked()
      if(reserved)throw new Error('Stream monitor already started')
      if(active.total>=32 || (active.users.get(userId) || 0)>=4)throw new HttpError(503,'STREAM_BUSY','İndirme servisi yoğun. Açık indirmeler tamamlandıktan sonra tekrar dene.')
      reserved=true;active.total++;active.users.set(userId,(active.users.get(userId) || 0)+1)
      // No bytes are released before this first check. Allow cold database reads
      // longer than the short deadline used to revoke an already-open stream.
      await validate(initialValidationTimeoutMs);schedule()
    }catch(error){stop();throw error}},
    stop,
  }
}
