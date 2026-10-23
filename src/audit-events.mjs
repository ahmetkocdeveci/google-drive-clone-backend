import {Router} from 'express'
import {z} from 'zod'
import {requireAuth,requireVerified} from './auth.mjs'
import {HttpError} from './errors.mjs'
import {resolveWorkspace} from './tenant.mjs'
import {parsePageQuery,decodeCursor,encodeCursor,keysetAfter} from './pagination.mjs'

const identifier=z.string().uuid()
const queryInput=z.object({limit:z.string().optional(),cursor:z.string().optional()}).strict()
const invalid=()=>new HttpError(400,'INVALID_INPUT','İstek alanlarını kontrol et.')

export function createAuditRouter({models,config}){
  const router=Router()
  router.use('/workspaces/:wid/audit-events',requireAuth,requireVerified)
  async function list(req,res){
    const parsedId=identifier.safeParse(req.params.wid)
    if(!parsedId.success)throw invalid()
    const workspaceId=parsedId.data,userId=req.auth.user._id
    const scope={models,workspaceId,userId,permission:'audit:read'}
    const {workspace}=await resolveWorkspace(scope)
    const parsedQuery=queryInput.safeParse(req.query)
    if(!parsedQuery.success)throw invalid()
    const {limit,cursor}=parsePageQuery(parsedQuery.data)
    const binding={kind:'audit-events',workspaceId,userId,limit,authorizationVersion:workspace.authorizationVersion,revision:workspace.mutationSequence}
    const position=decodeCursor({config,binding,cursor})
    const after=keysetAfter({field:'createdAt',direction:'desc',position,valueType:'date'})
    const found=await models.AuditEvent.find({workspaceId,...after})
      .select('_id workspaceId action targetId actorId createdAt')
      .sort({createdAt:-1,_id:1}).limit(limit+1).lean()
    const rows=found.slice(0,limit)
    const actors=await models.User.find({_id:{$in:[...new Set(rows.map(row=>row.actorId))]}}).select('_id name').lean()
    const names=new Map(actors.map(actor=>[actor._id,actor.name]))
    const items=rows.map(row=>({
      id:row._id,workspaceId:row.workspaceId,action:row.action,
      ...(row.targetId?{targetId:row.targetId}:{}),
      actor:{id:row.actorId,name:names.get(row.actorId) || 'Silinmiş kullanıcı'},
      createdAt:row.createdAt.toISOString(),
    }))
    // A role change while the bounded page is being assembled must not return
    // records under a permission that the caller has already lost.
    const current=await resolveWorkspace(scope)
    if(current.workspace.authorizationVersion!==workspace.authorizationVersion || current.workspace.mutationSequence!==workspace.mutationSequence)throw new HttpError(409,'PAGINATION_STALE','Liste değişmiş. Listeyi yenileyip tekrar dene.')
    const last=rows.at(-1)
    res.json({items,nextCursor:found.length>limit?encodeCursor({config,binding,position:{value:last.createdAt,id:last._id}}):null})
  }
  router.get('/workspaces/:wid/audit-events',list)
  router.get('/workspaces/:wid/audit-events/page',list)
  return router
}
