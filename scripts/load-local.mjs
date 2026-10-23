import assert from 'node:assert/strict'
import {performance} from 'node:perf_hooks'
import {createServer} from 'node:http'
import {createHarness} from '../tests/helpers.mjs'

const count=Number(process.env.LOAD_REQUESTS || 200),concurrency=Number(process.env.LOAD_CONCURRENCY || 8)
if(!Number.isInteger(count) || count<10 || count>1000 || !Number.isInteger(concurrency) || concurrency<1 || concurrency>32)throw new Error('Use LOAD_REQUESTS 10..1000 and LOAD_CONCURRENCY 1..32.')
// A fresh test database is used; this script never loads a production endpoint.
const h=await createHarness('boundedload'),times=[]
const server=createServer(h.app)
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const api=`http://127.0.0.1:${server.address().port}/api/v1`
try{
  const owner=await h.user(),outsider=await h.user()
  const workspace=(await owner.request('post','/workspaces',{name:'Isolated load test'}).expect(201)).body
  for(let index=0;index<16;index++)await owner.request('post',`/workspaces/${workspace.id}/folders`,{name:`Folder ${index}`,parentId:null}).expect(201)
  async function authenticate(user){
    let cookie=''
    async function request(route,method='GET',body,csrf){
      const response=await fetch(`${api}${route}`,{method,headers:{Origin:h.config.frontendOrigin,...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)})
      if(response.headers.getSetCookie().length)cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')
      return response
    }
    const csrf=(await(await request('/auth/csrf-token')).json()).csrfToken
    assert.equal((await request('/auth/login','POST',{email:user.user.email,password:user.password},csrf)).status,200)
    return request
  }
  const ownerRead=await authenticate(owner),outsiderRead=await authenticate(outsider)
  let next=0
  const started=performance.now()
  const results=await Promise.allSettled(Array.from({length:concurrency},async()=>{
    for(;;){
      const index=next++;if(index>=count)return
      const start=performance.now(),forbidden=index%4===0
      const response=await (forbidden?outsiderRead:ownerRead)(`/workspaces/${workspace.id}/nodes/page?limit=10`)
      assert.equal(response.status,forbidden?404:200)
      const body=await response.json()
      if(!forbidden){assert.equal(body.items.length,10);assert.ok(body.items.every(node=>node.workspaceId===workspace.id));assert.ok(body.nextCursor)}
      times.push(performance.now()-start)
    }
  }))
  for(const result of results)if(result.status==='rejected')throw result.reason
  const elapsed=performance.now()-started;times.sort((a,b)=>a-b)
  const percentile=p=>Math.round(times[Math.min(times.length-1,Math.ceil(times.length*p)-1)])
  console.log(JSON.stringify({status:'passed',requests:count,concurrency,elapsedMs:Math.round(elapsed),p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),tenantIsolation:'checked',scope:'local synthetic API; not a production capacity guarantee'}))
}finally{await new Promise(resolve=>server.close(resolve));await h.close()}
