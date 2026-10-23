import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerified } from './auth.mjs'
import { HttpError } from './errors.mjs'
import { audit, memberDto, mutateWorkspace, resolveWorkspace, workspaceDto } from './tenant.mjs'
import {parsePageQuery,encodeCursor,decodeCursor,keysetAfter} from './pagination.mjs'

const identifier = z.string().uuid()
const role = z.enum(['owner', 'editor', 'viewer'])
const inviteRole = z.enum(['editor', 'viewer'])
const email = z.string().trim().email().max(254).transform(value => value.toLowerCase())
const workspaceInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
}).strict()
const workspaceUpdate = workspaceInput.partial().refine(value => Object.keys(value).length > 0, 'En az bir alan gerekli.')
const tokenInput = z.object({ token: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/) }).strict()
const listLimit = 1000

const hashToken = token => createHash('sha256').update(token).digest('hex')
const missing = () => new HttpError(404, 'NOT_FOUND', 'Kaynak bulunamadı.')
const inviteUnavailable = () => new HttpError(404, 'INVITATION_UNAVAILABLE', 'Davet bulunamadı veya artık kullanılamıyor.')
const asDate = value => new Date(value).toISOString()
function parse(schema, value) {
  const result = schema.safeParse(value)
  if (!result.success) throw new HttpError(400, 'VALIDATION_ERROR', 'İstek alanlarını kontrol edin.')
  return result.data
}
function ids(req, ...names) {
  return names.map(name => parse(identifier, req.params[name]))
}
async function bounded(query) {
  const rows = await query.limit(listLimit + 1)
  if (rows.length > listLimit) throw new HttpError(400, 'LIST_LIMIT_EXCEEDED', 'Bu liste için sayfalama gerekli. Sistem yöneticisine başvurun.')
  return rows
}
async function invitationDto(models, invitation, session) {
  const user = await models.User.findById(invitation.invitedBy).session(session ?? null)
  return {
    id: invitation._id,
    workspaceId: invitation.workspaceId,
    email: invitation.emailNormalized,
    role: invitation.role,
    status: invitation.status === 'pending' && invitation.expiresAt <= new Date() ? 'expired' : invitation.status,
    expiresAt: asDate(invitation.expiresAt),
    createdAt: asDate(invitation.createdAt),
    invitedBy: { id: invitation.invitedBy, name: user?.name ?? 'Eski üye' },
  }
}
async function activeMember(models, workspaceId, memberId, session) {
  const membership = await models.Membership.findOne({ _id: memberId, workspaceId, status: 'active' }).session(session ?? null)
  if (!membership) throw missing()
  return membership
}
async function updateAuthorization(models, workspaceId, ownerDelta, session) {
  await models.Workspace.updateOne(
    { _id: workspaceId, status: 'active' },
    { $inc: { authorizationVersion: 1, ownerCount: ownerDelta } },
    { session },
  )
}
async function guardLastOwner(models, membership, nextRole, session) {
  if (membership.role !== 'owner' || nextRole === 'owner') return
  const owners = await models.Membership.countDocuments({ workspaceId: membership.workspaceId, status: 'active', role: 'owner' }).session(session)
  if (owners <= 1) throw new HttpError(409, 'LAST_OWNER', 'Son Owner çıkarılamaz veya rolü düşürülemez. Önce başka bir üyeyi Owner yapın.')
}

/** All tenant mutations acquire the shared Workspace write lock in mutateWorkspace. */
export function createWorkspaceRouter({ models, config, mailer }) {
  const router = Router()
  router.use(requireAuth, requireVerified)

  router.get('/workspaces/page',async(req,res)=>{
    const {limit,cursor}=parsePageQuery(req.query)
    const userId=req.auth.user._id,binding={kind:'workspaces',userId,limit,passwordVersion:req.auth.user.passwordVersion || 1}
    const position=decodeCursor({config,binding,cursor})
    const after=keysetAfter({field:'createdAt',position,valueType:'date'})
    const memberships=await models.Membership.aggregate([
      {$match:{userId,status:'active',...after}},
      {$lookup:{from:models.Workspace.collection.name,localField:'workspaceId',foreignField:'_id',as:'workspace'}},
      {$unwind:'$workspace'},{$match:{'workspace.status':'active'}},
      {$sort:{createdAt:1,_id:1}},{$limit:limit+1},
    ])
    const rows=memberships.slice(0,limit),items=[]
    for(const membership of rows)items.push(await workspaceDto({models,context:{workspace:membership.workspace,membership}}))
    const last=rows.at(-1)
    res.json({items,nextCursor:memberships.length>limit?encodeCursor({config,binding,position:{value:last.createdAt,id:last._id}}):null})
  })

  router.get('/workspaces/:wid/members/page',async(req,res)=>{
    const [workspaceId]=ids(req,'wid'),userId=req.auth.user._id
    const {workspace}=await resolveWorkspace({models,workspaceId,userId,permission:'members:read'})
    const {limit,cursor}=parsePageQuery(req.query),binding={kind:'members',workspaceId,userId,limit,revision:workspace.mutationSequence,authorizationVersion:workspace.authorizationVersion}
    const position=decodeCursor({config,binding,cursor}),after=keysetAfter({field:'createdAt',position,valueType:'date'})
    const found=await models.Membership.find({workspaceId,status:'active',...after}).sort({createdAt:1,_id:1}).limit(limit+1)
    const rows=found.slice(0,limit),items=[]
    for(const membership of rows){const user=await models.User.findById(membership.userId);if(user)items.push(memberDto(membership,user,userId))}
    const last=rows.at(-1)
    res.json({items,nextCursor:found.length>limit?encodeCursor({config,binding,position:{value:last.createdAt,id:last._id}}):null})
  })

  router.get('/workspaces/:wid/invitations/page',async(req,res)=>{
    const [workspaceId]=ids(req,'wid'),userId=req.auth.user._id
    const {workspace}=await resolveWorkspace({models,workspaceId,userId,permission:'invitations:read'})
    const {limit,cursor}=parsePageQuery(req.query),binding={kind:'invitations',workspaceId,userId,limit,revision:workspace.mutationSequence,authorizationVersion:workspace.authorizationVersion}
    const position=decodeCursor({config,binding,cursor}),after=keysetAfter({field:'createdAt',direction:'desc',position,valueType:'date'})
    const found=await models.Invitation.find({workspaceId,...after}).sort({createdAt:-1,_id:1}).limit(limit+1),rows=found.slice(0,limit),items=[]
    for(const invitation of rows)items.push(await invitationDto(models,invitation))
    const last=rows.at(-1)
    res.json({items,nextCursor:found.length>limit?encodeCursor({config,binding,position:{value:last.createdAt,id:last._id}}):null})
  })

  router.get('/workspaces', async (req, res) => {
    // The initial tenant directory is the sole membership lookup without a known
    // workspace: its userId comes from the authenticated session, never the body.
    const memberships = await bounded(models.Membership.find({ userId: req.auth.user._id, status: 'active' }).sort({ createdAt: 1, _id: 1 }))
    const result = []
    for (const membership of memberships) {
      const workspace = await models.Workspace.findOne({ _id: membership.workspaceId, status: 'active' })
      if (workspace) result.push(await workspaceDto({ models, context: { workspace, membership } }))
    }
    res.json(result)
  })

  router.post('/workspaces', async (req, res) => {
    const input = parse(workspaceInput, req.body)
    const userId = req.auth.user._id
    const workspaceId = randomUUID()
    const result = await models.Workspace.db.transaction(async session => {
      const [workspace] = await models.Workspace.create([{
        _id: workspaceId,
        name: input.name,
        description: input.description ?? '',
        color: input.color ?? '#2563eb',
        createdBy: userId,
        status: 'active',
        ownerCount: 1,
        authorizationVersion: 1,
        mutationSequence: 0,
        storageUsed: 0,
        storageReserved: 0,
        storageLimit: config.workspaceStorageLimit ?? 1024 * 1024 * 1024,
      }], { session })
      const [membership] = await models.Membership.create([{
        _id: randomUUID(), workspaceId, userId, role: 'owner', status: 'active', version: 1,
      }], { session })
      await audit({ models, workspaceId, actorId: userId, action: 'workspace.created', targetId: workspaceId, session })
      return workspaceDto({ models, context: { workspace, membership }, session })
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' })
    res.status(201).json(result)
  })

  router.get('/workspaces/:wid', async (req, res) => {
    const [workspaceId] = ids(req, 'wid')
    const context = await resolveWorkspace({ models, workspaceId, userId: req.auth.user._id, permission: 'workspace:read' })
    res.json(await workspaceDto({ models, context }))
  })

  router.patch('/workspaces/:wid', async (req, res) => {
    const [workspaceId] = ids(req, 'wid')
    const input = parse(workspaceUpdate, req.body)
    const userId = req.auth.user._id
    const result = await mutateWorkspace({ models, workspaceId, userId, permission: 'workspace:update' }, async (context, session) => {
      const workspace = await models.Workspace.findOneAndUpdate({ _id: workspaceId, status: 'active' }, { $set: input }, { returnDocument: 'after', session })
      if (!workspace) throw missing()
      await audit({ models, workspaceId, actorId: userId, action: 'workspace.updated', targetId: workspaceId, session })
      return workspaceDto({ models, context: { ...context, workspace }, session })
    })
    res.json(result)
  })

  router.delete('/workspaces/:wid', async (req, res) => {
    const [workspaceId] = ids(req, 'wid')
    const userId = req.auth.user._id
    await mutateWorkspace({ models, workspaceId, userId, permission: 'workspace:delete' }, async (_context, session) => {
      await models.Workspace.updateOne({ _id: workspaceId, status: 'active' }, { $set: { status: 'deleting' }, $inc: { authorizationVersion: 1 } }, { session })
      await models.Job.create([{
        _id: randomUUID(), workspaceId, type: 'workspace-cleanup', targetId: workspaceId, status: 'pending', attempts: 0,
      }], { session })
      await audit({ models, workspaceId, actorId: userId, action: 'workspace.deleted', targetId: workspaceId, session })
    })
    res.sendStatus(204)
  })

  router.get('/workspaces/:wid/members', async (req, res) => {
    const [workspaceId] = ids(req, 'wid')
    const userId = req.auth.user._id
    await resolveWorkspace({ models, workspaceId, userId, permission: 'members:read' })
    const members = await bounded(models.Membership.find({ workspaceId, status: 'active' }).sort({ createdAt: 1, _id: 1 }))
    const result = []
    for (const membership of members) {
      const user = await models.User.findById(membership.userId)
      if (user) result.push(memberDto(membership, user, userId))
    }
    res.json(result)
  })

  router.patch('/workspaces/:wid/members/:mid/role', async (req, res) => {
    const [workspaceId, memberId] = ids(req, 'wid', 'mid')
    const input = parse(z.object({ role }).strict(), req.body)
    const userId = req.auth.user._id
    const result = await mutateWorkspace({ models, workspaceId, userId, permission: 'members:update-role' }, async (_context, session) => {
      const membership = await activeMember(models, workspaceId, memberId, session)
      await guardLastOwner(models, membership, input.role, session)
      if (membership.role !== input.role) {
        const ownerDelta = Number(input.role === 'owner') - Number(membership.role === 'owner')
        await models.Membership.updateOne({ _id: memberId, workspaceId, status: 'active', version: membership.version }, { $set: { role: input.role }, $inc: { version: 1 } }, { session })
        membership.role = input.role
        membership.version += 1
        await updateAuthorization(models, workspaceId, ownerDelta, session)
        await audit({ models, workspaceId, actorId: userId, action: 'member.role-changed', targetId: memberId, session })
      }
      const user = await models.User.findById(membership.userId).session(session)
      return memberDto(membership, user, userId)
    })
    res.json(result)
  })

  router.delete('/workspaces/:wid/members/:mid', async (req, res) => {
    const [workspaceId, memberId] = ids(req, 'wid', 'mid')
    const userId = req.auth.user._id
    await mutateWorkspace({ models, workspaceId, userId, permission: 'members:remove' }, async (_context, session) => {
      const membership = await activeMember(models, workspaceId, memberId, session)
      await guardLastOwner(models, membership, null, session)
      await models.Membership.updateOne({ _id: memberId, workspaceId, status: 'active', version: membership.version }, { $set: { status: 'removed' }, $inc: { version: 1 } }, { session })
      await updateAuthorization(models, workspaceId, membership.role === 'owner' ? -1 : 0, session)
      await audit({ models, workspaceId, actorId: userId, action: 'member.removed', targetId: memberId, session })
    })
    res.sendStatus(204)
  })

  router.post('/workspaces/:wid/ownership-transfer', async (req, res) => {
    const [workspaceId] = ids(req, 'wid')
    const input = parse(z.object({ memberId: identifier }).strict(), req.body)
    const userId = req.auth.user._id
    const result = await mutateWorkspace({ models, workspaceId, userId, permission: 'members:update-role' }, async (context, session) => {
      const target = await activeMember(models, workspaceId, input.memberId, session)
      if (target.userId === userId) return workspaceDto({ models, context, session })
      const targetWasOwner = target.role === 'owner'
      await models.Membership.updateOne({ _id: target._id, workspaceId, status: 'active', version: target.version }, { $set: { role: 'owner' }, $inc: { version: 1 } }, { session })
      await models.Membership.updateOne({ _id: context.membership._id, workspaceId, userId, status: 'active', role: 'owner' }, { $set: { role: 'editor' }, $inc: { version: 1 } }, { session })
      await updateAuthorization(models, workspaceId, targetWasOwner ? -1 : 0, session)
      await audit({ models, workspaceId, actorId: userId, action: 'workspace.ownership-transferred', targetId: target._id, session })
      const refreshed = await resolveWorkspace({ models, workspaceId, userId, permission: 'workspace:read', session })
      return workspaceDto({ models, context: refreshed, session })
    })
    res.json(result)
  })

  router.get('/workspaces/:wid/invitations', async (req, res) => {
    const [workspaceId] = ids(req, 'wid')
    await resolveWorkspace({ models, workspaceId, userId: req.auth.user._id, permission: 'invitations:read' })
    const invitations = await bounded(models.Invitation.find({ workspaceId }).sort({ createdAt: -1, _id: 1 }))
    const result = []
    for (const invitation of invitations) result.push(await invitationDto(models, invitation))
    res.json(result)
  })

  router.post('/workspaces/:wid/invitations', async (req, res) => {
    const [workspaceId] = ids(req, 'wid')
    const input = parse(z.object({ email, role: inviteRole }).strict(), req.body)
    const userId = req.auth.user._id
    const result = await mutateWorkspace({ models, workspaceId, userId, permission: 'members:invite' }, async (context, session) => {
      const user = await models.User.findOne({ emailNormalized: input.email }).session(session)
      if (user && await models.Membership.exists({ workspaceId, userId: user._id, status: 'active' }).session(session)) {
        throw new HttpError(409, 'ALREADY_A_MEMBER', 'Bu kullanıcı zaten çalışma alanının üyesi.')
      }
      const previous = await models.Invitation.findOne({ workspaceId, emailNormalized: input.email }).session(session)
      const token = randomBytes(32).toString('base64url')
      const values = {
        role: input.role,
        status: 'pending',
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + config.invitationTtlMs),
        invitedBy: userId,
        version: (previous?.version ?? 0) + 1,
      }
      let invitation
      if (previous) {
        invitation = await models.Invitation.findOneAndUpdate({ _id: previous._id, workspaceId, version: previous.version }, { $set: values, $unset: { acceptedBy: 1 } }, { returnDocument: 'after', session })
      } else {
        ;[invitation] = await models.Invitation.create([{
          _id: randomUUID(), workspaceId, emailNormalized: input.email, ...values,
        }], { session })
      }
      await mailer.enqueueInvitation({ invitation, workspace: context.workspace, inviter: req.auth.user, token }, session)
      await audit({ models, workspaceId, actorId: userId, action: 'invitation.created', targetId: invitation._id, session })
      return invitationDto(models, invitation, session)
    })
    res.status(201).json(result)
  })

  router.delete('/workspaces/:wid/invitations/:iid', async (req, res) => {
    const [workspaceId, invitationId] = ids(req, 'wid', 'iid')
    const userId = req.auth.user._id
    await mutateWorkspace({ models, workspaceId, userId, permission: 'invitations:revoke' }, async (_context, session) => {
      const invitation = await models.Invitation.findOne({ _id: invitationId, workspaceId }).session(session)
      if (!invitation) throw missing()
      if (invitation.status === 'accepted') throw new HttpError(409, 'INVITATION_ACCEPTED', 'Kabul edilmiş davet iptal edilemez. Üye yönetimini kullanın.')
      if (invitation.status !== 'revoked') {
        await models.Invitation.updateOne({ _id: invitationId, workspaceId, version: invitation.version }, { $set: { status: 'revoked' }, $inc: { version: 1 } }, { session })
        await audit({ models, workspaceId, actorId: userId, action: 'invitation.revoked', targetId: invitationId, session })
      }
    })
    res.sendStatus(204)
  })

  // The token first identifies its tenant; every subsequent lookup is scoped to
  // that server-derived workspace. A client never chooses the acceptance scope.
  async function tokenReference(token) {
    const tokenHash = hashToken(token)
    const reference = await models.Invitation.findOne({ tokenHash }).select('_id workspaceId')
    if (!reference) throw inviteUnavailable()
    return { tokenHash, workspaceId: reference.workspaceId, invitationId: reference._id }
  }

  router.post('/invitations/inspect', async (req, res) => {
    const { token } = parse(tokenInput, req.body)
    const { tokenHash, workspaceId, invitationId } = await tokenReference(token)
    const workspace = await models.Workspace.findOne({ _id: workspaceId, status: 'active' })
    const invitation = await models.Invitation.findOne({ _id: invitationId, workspaceId, tokenHash, status: 'pending', expiresAt: { $gt: new Date() }, emailNormalized: req.auth.user.emailNormalized })
    if (!workspace || !invitation) throw inviteUnavailable()
    res.json({
      id: invitation._id, workspaceId, workspaceName: workspace.name,
      email: invitation.emailNormalized, role: invitation.role, expiresAt: asDate(invitation.expiresAt),
    })
  })

  router.post('/invitations/accept', async (req, res) => {
    const { token } = parse(tokenInput, req.body)
    const { tokenHash, workspaceId, invitationId } = await tokenReference(token)
    const userId = req.auth.user._id
    const result = await models.Workspace.db.transaction(async session => {
      // Same lock as content writes/member changes; revoke/reinvite/accept and
      // workspace deletion have a single transaction ordering.
      const workspace = await models.Workspace.findOneAndUpdate({ _id: workspaceId, status: 'active' }, { $inc: { mutationSequence: 1 } }, { returnDocument: 'after', session })
      if (!workspace) throw inviteUnavailable()
      const invitation = await models.Invitation.findOne({ _id: invitationId, workspaceId, tokenHash }).session(session)
      if (!invitation || invitation.emailNormalized !== req.auth.user.emailNormalized) throw inviteUnavailable()
      let membership = await models.Membership.findOne({ workspaceId, userId }).session(session)
      if (invitation.status === 'accepted') {
        if (invitation.acceptedBy !== userId || membership?.status !== 'active') throw inviteUnavailable()
        return workspaceDto({ models, context: { workspace, membership }, session })
      }
      if (invitation.status !== 'pending' || invitation.expiresAt <= new Date()) throw inviteUnavailable()
      const consumed = await models.Invitation.updateOne({
        _id: invitationId, workspaceId, tokenHash, version: invitation.version,
        status: 'pending', expiresAt: { $gt: new Date() }, emailNormalized: req.auth.user.emailNormalized,
      }, { $set: { status: 'accepted', acceptedBy: userId }, $inc: { version: 1 } }, { session })
      if (consumed.modifiedCount !== 1) throw inviteUnavailable()
      if (!membership) {
        ;[membership] = await models.Membership.create([{
          _id: randomUUID(), workspaceId, userId, role: invitation.role, status: 'active', version: 1,
        }], { session })
        await updateAuthorization(models, workspaceId, 0, session)
      } else if (membership.status !== 'active') {
        membership = await models.Membership.findOneAndUpdate({ _id: membership._id, workspaceId, userId, status: 'removed', version: membership.version }, { $set: { role: invitation.role, status: 'active' }, $inc: { version: 1 } }, { returnDocument: 'after', session })
        if (!membership) throw inviteUnavailable()
        await updateAuthorization(models, workspaceId, 0, session)
      }
      // An existing active member keeps their current role, including Owner.
      await audit({ models, workspaceId, actorId: userId, action: 'invitation.accepted', targetId: invitationId, session })
      return workspaceDto({ models, context: { workspace, membership }, session })
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' })
    res.json(result)
  })

  return router
}
