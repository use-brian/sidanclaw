/** Opt-in, bounded policy retention. [COMP:crm/retention] */
import {query} from '../db/client.js'
import {runScheduledCrmRetention} from './retention-service.js'

export function createCrmRetentionWorker(options:{
  enabled?:()=>boolean
  list?:(after:string|null,limit:number)=>Promise<string[]>
  run?:(workspaceId:string)=>Promise<'completed'|'blocked'|'skipped'|'failed'>
  intervalMs?:number
  onError?:()=>void
}={}) {
  const enabled=options.enabled ?? (()=>!['false','0'].includes((process.env.CRM_RETENTION_ENABLED ?? '').trim().toLowerCase()))
  const list=options.list ?? (async(after:string|null,limit:number)=>{
    const rows=await query<{id:string}>(`SELECT w.id FROM workspaces w
      JOIN LATERAL(SELECT policy FROM crm_privacy_policies WHERE workspace_id=w.id ORDER BY version DESC LIMIT 1) p ON true
      WHERE p.policy#>>'{retention,scheduled}'='true' AND ($1::uuid IS NULL OR w.id>$1)
      ORDER BY w.id LIMIT $2`,[after,limit])
    return rows.rows.map(r=>r.id)
  })
  const run=options.run ?? runScheduledCrmRetention
  let cursor:string|null=null,timer:ReturnType<typeof setInterval>|null=null,running:Promise<number>|null=null
  async function perform() {
    if(!enabled())return 0
    const ids=await list(cursor,25)
    for(const id of ids) {
      if(!enabled())break
      try {if(await run(id)==='failed')options.onError?.()}
      catch {options.onError?.()}
      cursor=id
    }
    if(ids.length<25)cursor=null
    return ids.length
  }
  const tick=()=>{
    if(running)return running
    running=perform().catch(()=>{options.onError?.();return 0}).finally(()=>{running=null})
    return running
  }
  return {tick,
    start(){if(timer)return;timer=setInterval(()=>{void tick()},Math.max(1000,options.intervalMs ?? 60_000));timer.unref?.();void tick()},
    stop(){if(timer)clearInterval(timer);timer=null},
  }
}
