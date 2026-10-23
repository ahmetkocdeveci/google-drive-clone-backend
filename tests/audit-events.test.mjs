import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createHarness} from './helpers.mjs'

const route=workspace=>`/workspaces/${workspace.id}/audit-events`
async function setup(h){
  const owner=await h.user({name:'Owner Name'}),otherOwner=await h.user({name:'Other Owner'}),editor=await h.user(),viewer=await h.user(),outsider=await h.user()
  const workspace=(await owner.request('post','/workspaces',{name:'Audit workspace'}).expect(201)).body
  for(const[user,role]of [[otherOwner,'owner'],[editor,'editor'],[viewer,'viewer']])await h.models.Membership.create({workspaceId:workspace.id,userId:user.user.id,role})
  const unrelated=(await outsider.request('post','/workspaces',{name:'Other tenant'}).expect(201)).body
  return {owner,otherOwner,editor,viewer,outsider,workspace,unrelated}
}

test('only current workspace Owners can read bounded audit pages with safe actor DTOs',async()=>{
  const h=await createHarness('auditaccess')
  try{
    const {owner,otherOwner,editor,viewer,outsider,workspace,unrelated}=await setup(h)
    const secretTarget=randomUUID(),missingActor=randomUUID()
    await h.models.AuditEvent.create({workspaceId:workspace.id,actorId:missingActor,action:'node.deleted',targetId:secretTarget,requestId:'internal-request-not-for-dto'})
    const response=await owner.request('get',route(workspace)).expect(200)
    assert.equal(response.body.nextCursor,null)
    assert.equal(response.body.items.length,2)
    const deleted=response.body.items.find(item=>item.action==='node.deleted')
    assert.equal(deleted.actor.name,'Silinmiş kullanıcı')
    assert.equal(deleted.targetId,secretTarget)
    const created=response.body.items.find(item=>item.action==='workspace.created')
    assert.equal(created.actor.name,'Owner Name')
    for(const item of response.body.items){
      assert.deepEqual(Object.keys(item).sort(),['action','actor','createdAt','id','targetId','workspaceId'].sort())
      assert.deepEqual(Object.keys(item.actor).sort(),['id','name'])
      assert.equal(item.workspaceId,workspace.id)
    }
    const json=JSON.stringify(response.body)
    assert.ok(!json.includes(owner.user.email))
    assert.ok(!json.includes('internal-request-not-for-dto'))
    assert.ok(!json.includes('passwordHash'))
    await otherOwner.request('get',route(workspace)).expect(200)
    await editor.request('get',route(workspace)).expect(403)
    await viewer.request('get',route(workspace)).expect(403)
    await outsider.request('get',route(workspace)).expect(404)
    await owner.request('get',route(unrelated)).expect(404)
    await h.client().get(`/api/v1${route(workspace)}`).expect(401)
    const unverified=await h.user({verified:false})
    await unverified.request('get',route(workspace)).expect(403)
  }finally{await h.close()}
})

test('audit cursor walks equal timestamps exactly once and binds user, tenant, page size and live revision',async()=>{
  const h=await createHarness('auditpages')
  try{
    const {owner,otherOwner,workspace,unrelated}=await setup(h)
    const timestamp=new Date('2026-02-01T00:00:00Z')
    const rows=Array.from({length:107},(_,index)=>({_id:randomUUID(),workspaceId:workspace.id,actorId:owner.user.id,action:`test.event-${index}`,createdAt:timestamp}))
    await h.models.AuditEvent.insertMany(rows)
    const expected=[...(await h.models.AuditEvent.find({workspaceId:workspace.id}).sort({createdAt:-1,_id:1}).lean())].map(row=>row._id)
    const seen=[]
    let cursor
    do{
      const page=(await owner.request('get',`${route(workspace)}?limit=25${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`).expect(200)).body
      assert.ok(page.items.length<=25)
      seen.push(...page.items.map(item=>item.id));cursor=page.nextCursor
    }while(cursor)
    assert.deepEqual(seen,expected)
    assert.equal(new Set(seen).size,108)
    const first=(await owner.request('get',`${route(workspace)}?limit=2`).expect(200)).body
    const next=`cursor=${encodeURIComponent(first.nextCursor)}`
    await otherOwner.request('get',`${route(workspace)}?limit=2&${next}`).expect(409)
    await owner.request('get',`${route(workspace)}?limit=3&${next}`).expect(409)
    await owner.request('get',`${route(unrelated)}?limit=2&${next}`).expect(404)
    const corrupted=`${first.nextCursor.startsWith('A')?'B':'A'}${first.nextCursor.slice(1)}`
    await owner.request('get',`${route(workspace)}?limit=2&cursor=${encodeURIComponent(corrupted)}`).expect(400)
    await owner.request('patch',`/workspaces/${workspace.id}`,{name:'New tenant revision'}).expect(200)
    await owner.request('get',`${route(workspace)}?limit=2&${next}`).expect(409)
    const fresh=(await owner.request('get',`${route(workspace)}?limit=2`).expect(200)).body
    const ownMembership=await h.models.Membership.findOne({workspaceId:workspace.id,userId:owner.user.id})
    await otherOwner.request('patch',`/workspaces/${workspace.id}/members/${ownMembership._id}/role`,{role:'viewer'}).expect(200)
    await owner.request('get',`${route(workspace)}?limit=2&cursor=${encodeURIComponent(fresh.nextCursor)}`).expect(403)
    await h.models.Membership.updateOne({_id:ownMembership._id},{$set:{status:'removed'}})
    await owner.request('get',route(workspace)).expect(404)
  }finally{await h.close()}
})

test('Owner permission lost while actor names are loading prevents the audit response',async t=>{
  const h=await createHarness('auditrace')
  try{
    const {owner,otherOwner,workspace}=await setup(h)
    const membership=await h.models.Membership.findOne({workspaceId:workspace.id,userId:owner.user.id})
    const originalFind=h.models.User.find.bind(h.models.User)
    let changed=false
    t.mock.method(h.models.User,'find',(...args)=>{
      const query=originalFind(...args),originalExec=query.exec.bind(query)
      query.exec=async(...execArgs)=>{
        const rows=await originalExec(...execArgs)
        if(!changed){changed=true;await otherOwner.request('patch',`/workspaces/${workspace.id}/members/${membership._id}/role`,{role:'viewer'}).expect(200)}
        return rows
      }
      return query
    })
    await owner.request('get',route(workspace)).expect(403)
    assert.equal(changed,true)
  }finally{t.mock.restoreAll();await h.close()}
})

test('audit queries reject unbounded limits and client-selected scopes or filters',async()=>{
  const h=await createHarness('auditquery')
  try{
    const owner=await h.user(),workspace=(await owner.request('post','/workspaces',{name:'Audit query'}).expect(201)).body
    for(const query of ['limit=0','limit=101','limit=-1','limit=2.5','limit=2&limit=3','cursor=bad','workspaceId=other','actorId=other','action=workspace.created','sort=oldest'])await owner.request('get',`${route(workspace)}?${query}`).expect(400)
    await owner.request('get',`${route(workspace)}/page?limit=100`).expect(200)
    await owner.request('get','/workspaces/not-an-id/audit-events').expect(400)
    await h.models.Workspace.updateOne({_id:workspace.id},{$set:{status:'deleting'}})
    await owner.request('get',route(workspace)).expect(404)
  }finally{await h.close()}
})
