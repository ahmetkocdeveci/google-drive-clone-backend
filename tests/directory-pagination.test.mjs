import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createHarness} from './helpers.mjs'

test('directory paging preserves ties, rejects cross-user and changed-tenant cursors, reports total owners',async()=>{
  const h=await createHarness('directorypage')
  try{
    const owner=await h.user(),stranger=await h.user()
    const workspaces=[]
    for(let i=0;i<3;i++)workspaces.push((await owner.request('post','/workspaces',{name:`Workspace ${i}`}).expect(201)).body)
    const first=(await owner.request('get','/workspaces/page?limit=2').expect(200)).body
    assert.equal(first.items.length,2);assert.ok(first.nextCursor)
    const second=(await owner.request('get',`/workspaces/page?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`).expect(200)).body
    assert.equal(second.items.length,1);assert.equal(second.nextCursor,null)
    assert.equal(new Set([...first.items,...second.items].map(row=>row.id)).size,3)
    await stranger.request('get',`/workspaces/page?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`).expect(409)
    const workspace=workspaces[0],date=new Date('2026-01-01T00:00:00Z')
    for(let i=0;i<3;i++){
      const userId=randomUUID();await h.models.User.create({_id:userId,name:`User ${i}`,emailNormalized:`${userId}@example.com`})
      await h.models.Membership.create({workspaceId:workspace.id,userId,role:i===0?'owner':'viewer',createdAt:date})
      await h.models.Invitation.create({workspaceId:workspace.id,emailNormalized:`invite${i}@example.com`,role:'viewer',tokenHash:randomUUID(),expiresAt:new Date(Date.now()+100000),invitedBy:owner.user.id,createdAt:date})
    }
    const dto=(await owner.request('get',`/workspaces/${workspace.id}`).expect(200)).body;assert.equal(dto.ownerCount,2)
    for(const kind of ['members','invitations']){
      const result=[],base=`/workspaces/${workspace.id}/${kind}/page?limit=2`
      let page=(await owner.request('get',base).expect(200)).body,firstCursor=page.nextCursor;result.push(...page.items)
      while(page.nextCursor){page=(await owner.request('get',`${base}&cursor=${encodeURIComponent(page.nextCursor)}`).expect(200)).body;result.push(...page.items)}
      assert.equal(new Set(result.map(row=>row.id)).size,kind==='members'?4:3)
      await owner.request('patch',`/workspaces/${workspace.id}`,{name:'Changed'}).expect(200)
      await owner.request('get',`${base}&cursor=${encodeURIComponent(firstCursor)}`).expect(409)
      await stranger.request('get',base).expect(404)
    }
  }finally{await h.close()}
})
