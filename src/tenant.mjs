import { HttpError, notFound } from './errors.mjs'
import { getRequestContext } from './request-context.mjs'
export const permissions = Object.freeze({
  owner:['workspace:read','workspace:update','workspace:delete','content:read','content:create','content:update','content:delete','members:read','members:invite','members:update-role','members:remove','invitations:read','invitations:revoke','audit:read'],
  editor:['workspace:read','content:read','content:create','content:update','content:delete'],
  viewer:['workspace:read','content:read'],
})
export async function resolveWorkspace({models,workspaceId,userId,permission,session=null}) {
  const workspace = await models.Workspace.findOne({_id:workspaceId,status:'active'}).session(session)
  const membership = await models.Membership.findOne({workspaceId,userId,status:'active'}).session(session)
  if (!workspace || !membership) throw notFound()
  if (!permissions[membership.role]?.includes(permission)) throw new HttpError(403,'FORBIDDEN','Bu işlem için yetkin yok.')
  return {workspace,membership}
}
export async function mutateWorkspace(input,callback) {
  return input.models.Workspace.db.transaction(async session => {
    // Every tenant mutation writes the same document before reading membership.
    // Concurrent demotion/removal therefore causes a write conflict and a full retry.
    const workspace = await input.models.Workspace.findOneAndUpdate({_id:input.workspaceId,status:'active'},{$inc:{mutationSequence:1}},{returnDocument:'after',session})
    if (!workspace) throw notFound()
    const context = await resolveWorkspace({...input,session})
    return callback(context,session)
  },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},readPreference:'primary'})
}
export async function workspaceDto({models,context,session=null}) {
  const {workspace,membership} = context
  const memberCount = await models.Membership.countDocuments({workspaceId:workspace._id,status:'active'}).session(session)
  const ownerCount = await models.Membership.countDocuments({workspaceId:workspace._id,status:'active',role:'owner'}).session(session)
  return {id:workspace._id,name:workspace.name,description:workspace.description,color:workspace.color,role:membership.role,capabilities:[...permissions[membership.role]],memberCount,ownerCount,storageUsed:workspace.storageUsed,storageLimit:workspace.storageLimit,createdAt:workspace.createdAt.toISOString()}
}
export function memberDto(member,user,currentUserId) {
  return {id:member._id,userId:member.userId,workspaceId:member.workspaceId,name:user.name,email:user.emailNormalized,role:member.role,joinedAt:member.createdAt.toISOString(),isCurrentUser:member.userId===currentUserId}
}
export async function audit({models,workspaceId,actorId,action,targetId,session,requestId=getRequestContext()?.requestId}) {
  await models.AuditEvent.create([{workspaceId,actorId,action,targetId,requestId}],{session})
}
