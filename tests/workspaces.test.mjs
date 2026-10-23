import assert from 'node:assert/strict'
import test from 'node:test'
import { createHarness } from './helpers.mjs'

async function workspace(actor, name) {
  const response = await actor.request('post', '/workspaces', { name })
  assert.equal(response.status, 201, JSON.stringify(response.body))
  return response.body
}

async function invitation(h, owner, workspaceId, email, role = 'editor') {
  const response = await owner.request('post', `/workspaces/${workspaceId}/invitations`, { email, role })
  assert.equal(response.status, 201, JSON.stringify(response.body))
  assert.equal('token' in response.body, false)
  assert.equal('tokenHash' in response.body, false)
  assert.equal('demoToken' in response.body, false)
  await h.flushMail()
  const message = h.mail.findLast(item => String(item.to).includes(email) && item.text.includes('/invitations/accept#token='))
  assert.ok(message, 'Invitation must reach the captured development mailbox.')
  const token = message.text.match(/\/invitations\/accept#token=([A-Za-z0-9_-]+)/)?.[1]
  assert.ok(token, 'Email must contain a fragment token, not a query token.')
  assert.equal(JSON.stringify(response.body).includes(token), false)
  return { ...response.body, token }
}

test('workspace creation assigns Owner; tenant IDs and member administration are enforced by the API', async t => {
  const h = await createHarness('workspace-boundaries')
  t.after(() => h.close())
  const owner = await h.user({ name: 'Ahmet', email: 'owner@example.com' })
  const outsider = await h.user({ name: 'Other owner', email: 'outsider@example.com' })
  const editor = await h.user({ name: 'Editor', email: 'editor@example.com' })
  const unverified = await h.user({ name: 'Unverified', email: 'unverified@example.com', verified: false })
  const first = await workspace(owner, 'First workspace')
  const second = await workspace(owner, 'Second workspace')
  const external = await workspace(outsider, 'External workspace')
  assert.equal(first.role, 'owner')
  assert.equal(first.memberCount, 1)
  assert.ok(first.capabilities.includes('members:update-role'))
  const directory = await owner.request('get', '/workspaces')
  assert.deepEqual(directory.body.map(item => item.id).sort(), [first.id, second.id].sort())
  assert.equal((await outsider.request('get', `/workspaces/${first.id}`)).status, 404)
  assert.equal((await unverified.request('post', '/workspaces', { name: 'Blocked' })).status, 403)
  assert.equal((await owner.request('post', '/workspaces', { name: 'Injected', role: 'viewer' })).status, 400)
  assert.equal((await owner.request('patch', `/workspaces/${first.id}`, { ownerCount: 0 })).status, 400)

  const invite = await invitation(h, owner, first.id, editor.user.email)
  const accepted = await editor.request('post', '/invitations/accept', { token: invite.token })
  assert.equal(accepted.status, 200)
  assert.equal(accepted.body.role, 'editor')
  assert.equal((await editor.request('get', `/workspaces/${first.id}/members`)).status, 403)
  assert.equal((await editor.request('patch', `/workspaces/${first.id}`, { name: 'Forbidden rename' })).status, 403)
  assert.equal((await editor.request('post', `/workspaces/${first.id}/invitations`, { email: 'new@example.com', role: 'viewer' })).status, 403)

  const externalMembers = await outsider.request('get', `/workspaces/${external.id}/members`)
  const externalMemberId = externalMembers.body[0].id
  assert.equal((await owner.request('patch', `/workspaces/${first.id}/members/${externalMemberId}/role`, { role: 'viewer' })).status, 404)
  assert.equal((await owner.request('delete', `/workspaces/${first.id}/members/${externalMemberId}`)).status, 404)
  const otherInvitation = await invitation(h, outsider, external.id, 'external-invite@example.com')
  assert.equal((await owner.request('delete', `/workspaces/${first.id}/invitations/${otherInvitation.id}`)).status, 404)
  assert.equal((await owner.request('post', `/workspaces/${first.id}/invitations`, { email: editor.user.email, role: 'viewer' })).status, 409)
  assert.equal((await owner.request('post', `/workspaces/${first.id}/invitations`, { email: 'new@example.com', role: 'owner' })).status, 400)

  assert.equal((await owner.request('delete', `/workspaces/${first.id}`)).status, 204)
  assert.equal((await owner.request('get', `/workspaces/${first.id}`)).status, 404)
  assert.equal((await editor.request('get', `/workspaces/${first.id}`)).status, 404)
  assert.ok(await h.models.Job.findOne({ workspaceId: first.id, targetId: first.id, type: 'workspace-cleanup' }))
  assert.equal((await owner.request('get', `/workspaces/${second.id}`)).status, 200)
})

test('invitation acceptance checks verified identity, expiry, revocation and single use without overwriting roles', async t => {
  const h = await createHarness('workspace-invitations')
  t.after(() => h.close())
  const owner = await h.user({ name: 'Owner', email: 'owner@example.com' })
  const stranger = await h.user({ name: 'Stranger', email: 'stranger@example.com' })
  const current = await workspace(owner, 'Invitation workspace')
  const futureEmail = 'future@example.com'
  assert.equal(await h.models.User.countDocuments({ emailNormalized: futureEmail }), 0)
  const pending = await invitation(h, owner, current.id, futureEmail, 'viewer')
  assert.equal(await h.models.User.countDocuments({ emailNormalized: futureEmail }), 0, 'Inviting an email must not create a ghost account.')
  assert.equal((await stranger.request('post', '/invitations/inspect', { token: pending.token })).status, 404)
  assert.equal((await stranger.request('post', '/invitations/accept', { token: pending.token })).status, 404)
  const future = await h.user({ name: 'Future teammate', email: futureEmail })
  assert.equal((await future.request('post', '/invitations/inspect', { token: pending.token })).body.role, 'viewer')
  const acceptAttempts = await Promise.all([
    future.request('post', '/invitations/accept', { token: pending.token }),
    future.request('post', '/invitations/accept', { token: pending.token }),
  ])
  assert.deepEqual(acceptAttempts.map(item => item.status), [200, 200])
  const accepted = acceptAttempts[0]
  assert.equal(accepted.body.role, 'viewer')
  assert.equal((await future.request('post', '/invitations/accept', { token: pending.token })).status, 200)
  assert.equal(await h.models.Membership.countDocuments({ workspaceId: current.id, userId: future.user.id }), 1)

  const members = await owner.request('get', `/workspaces/${current.id}/members`)
  const membership = members.body.find(item => item.userId === future.user.id)
  assert.equal((await owner.request('patch', `/workspaces/${current.id}/members/${membership.id}/role`, { role: 'owner' })).status, 200)
  const retry = await future.request('post', '/invitations/accept', { token: pending.token })
  assert.equal(retry.body.role, 'owner', 'Retrying an accepted Viewer invitation must preserve the current Owner role.')
  assert.equal((await owner.request('delete', `/workspaces/${current.id}/members/${membership.id}`)).status, 204)
  assert.equal((await future.request('post', '/invitations/accept', { token: pending.token })).status, 404, 'An old accepted token must not restore a removed membership.')

  const renewed = await invitation(h, owner, current.id, futureEmail, 'editor')
  assert.notEqual(renewed.token, pending.token)
  assert.equal((await future.request('post', '/invitations/accept', { token: pending.token })).status, 404)
  assert.equal((await future.request('post', '/invitations/accept', { token: renewed.token })).body.role, 'editor')
  assert.equal((await owner.request('delete', `/workspaces/${current.id}/invitations/${renewed.id}`)).status, 409)

  const revoked = await invitation(h, owner, current.id, stranger.user.email, 'viewer')
  assert.equal((await owner.request('delete', `/workspaces/${current.id}/invitations/${revoked.id}`)).status, 204)
  assert.equal((await stranger.request('post', '/invitations/accept', { token: revoked.token })).status, 404)
  const expiring = await invitation(h, owner, current.id, stranger.user.email, 'viewer')
  await h.models.Invitation.updateOne({ _id: expiring.id, workspaceId: current.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } })
  assert.equal((await stranger.request('post', '/invitations/inspect', { token: expiring.token })).status, 404)
  assert.equal((await stranger.request('post', '/invitations/accept', { token: expiring.token })).status, 404)
  const listed = await owner.request('get', `/workspaces/${current.id}/invitations`)
  assert.equal(listed.body.find(item => item.id === expiring.id).status, 'expired')
  for (const item of listed.body) {
    assert.equal('tokenHash' in item, false)
    assert.equal('token' in item, false)
  }
})

test('concurrent Owner demotions preserve the last Owner and ownership transfer is atomic', async t => {
  const h = await createHarness('workspace-last-owner')
  t.after(() => h.close())
  const firstOwner = await h.user({ name: 'First owner', email: 'first@example.com' })
  const secondOwner = await h.user({ name: 'Second owner', email: 'second@example.com' })
  const nextOwner = await h.user({ name: 'Next owner', email: 'next@example.com' })
  const current = await workspace(firstOwner, 'Concurrent owners')
  const pending = await invitation(h, firstOwner, current.id, secondOwner.user.email)
  assert.equal((await secondOwner.request('post', '/invitations/accept', { token: pending.token })).status, 200)
  let members = (await firstOwner.request('get', `/workspaces/${current.id}/members`)).body
  const firstMember = members.find(item => item.userId === firstOwner.user.id)
  const secondMember = members.find(item => item.userId === secondOwner.user.id)
  assert.equal((await firstOwner.request('patch', `/workspaces/${current.id}/members/${secondMember.id}/role`, { role: 'owner' })).status, 200)
  const concurrent = await Promise.all([
    firstOwner.request('patch', `/workspaces/${current.id}/members/${firstMember.id}/role`, { role: 'editor' }),
    secondOwner.request('patch', `/workspaces/${current.id}/members/${secondMember.id}/role`, { role: 'editor' }),
  ])
  assert.deepEqual(concurrent.map(item => item.status).sort(), [200, 409])
  const owners = await h.models.Membership.find({ workspaceId: current.id, status: 'active', role: 'owner' })
  assert.equal(owners.length, 1)
  assert.equal((await h.models.Workspace.findOne({ _id: current.id })).ownerCount, 1)
  const remaining = owners[0].userId === firstOwner.user.id ? firstOwner : secondOwner
  assert.equal((await remaining.request('patch', `/workspaces/${current.id}/members/${owners[0]._id}/role`, { role: 'viewer' })).status, 409)
  assert.equal((await remaining.request('delete', `/workspaces/${current.id}/members/${owners[0]._id}`)).status, 409)
  const nextInvitation = await invitation(h, remaining, current.id, nextOwner.user.email)
  assert.equal((await nextOwner.request('post', '/invitations/accept', { token: nextInvitation.token })).status, 200)
  members = (await remaining.request('get', `/workspaces/${current.id}/members`)).body
  const nextMember = members.find(item => item.userId === nextOwner.user.id)
  const transferred = await remaining.request('post', `/workspaces/${current.id}/ownership-transfer`, { memberId: nextMember.id })
  assert.equal(transferred.status, 200)
  assert.equal(transferred.body.role, 'editor')
  assert.equal((await remaining.request('patch', `/workspaces/${current.id}`, { name: 'No longer allowed' })).status, 403)
  assert.equal((await nextOwner.request('get', `/workspaces/${current.id}`)).body.role, 'owner')
  assert.equal(await h.models.Membership.countDocuments({ workspaceId: current.id, status: 'active', role: 'owner' }), 1)
  assert.equal((await h.models.Workspace.findOne({ _id: current.id })).ownerCount, 1)
})
