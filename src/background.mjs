/** SMTP latency must never hold the file cleanup queue hostage. */
export function startBackgroundWork({worker,mailer,logger=console,intervalMs=2000}) {
  let stopped=false
  const loops=[['jobs',()=>worker.drainJobs()],['mail',()=>mailer.drain()]].map(([queue,run])=>{
    let inFlight=null
    const tick=()=>{
      if(stopped || inFlight) return
      inFlight=Promise.resolve().then(run).catch(()=>logger.error(JSON.stringify({event:'background_failed',queue}))).finally(()=>{inFlight=null})
    }
    const timer=setInterval(tick,intervalMs)
    tick()
    return {timer,current:()=>inFlight}
  })
  return {
    async stop() {
      stopped=true
      for(const loop of loops) clearInterval(loop.timer)
      await Promise.allSettled(loops.map(loop=>loop.current()))
    },
  }
}

export async function settleWithin(promise,timeoutMs=10000) {
  let timer
  try { await Promise.race([promise,new Promise(resolve=>{timer=setTimeout(resolve,timeoutMs)})]) }
  finally { clearTimeout(timer) }
}
