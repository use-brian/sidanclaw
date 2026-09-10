/** Bounded generic entitlement lifecycle, independent of Association. [COMP:crm/entitlement-lifecycle] */
import {randomUUID} from 'node:crypto'
import {query} from '../db/client.js'
import {createDbCrmOperationsStore} from '../db/crm-operations-store.js'
import {createCrmOperationsService} from './service.js'

export function createCrmEntitlementWorker(options:{
  enabled?:()=>boolean
  list?:(after:string|null,limit:number)=>Promise<{id:string;workspaceId:string}[]>
  expire?:(workspaceId:string,id:string,runId:string)=>Promise<void>
  intervalMs?:number
  onError?:()=>void
}={}) {
  const enabled=options.enabled ?? (()=>!['false','0'].includes((process.env.CRM_ENTITLEMENT_EXPIRY_ENABLED ?? '').trim().toLowerCase()))
  const list=options.list ?? (async(after,limit)=>(await query<{id:string;workspaceId:string}>(`SELECT id,workspace_id AS "workspaceId"
    FROM association_memberships WHERE status='active' AND provider IS NULL AND ends_at<=clock_timestamp()
      AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2`,[after,limit])).rows)
  const service=createCrmOperationsService(createDbCrmOperationsStore())
  const expire=options.expire ?? (async(workspaceId,id,runId)=>{
    await service.execute({workspaceId,actor:{kind:'system_job',job:'entitlement_expiry',runId},
      authority:{role:'owner',canConfigure:false,canWrite:true,trustedIdentitySources:[]}},
      {kind:'expire_due_entitlement',entitlementId:id})
  })
  let cursor:string|null=null,timer:ReturnType<typeof setInterval>|null=null,running:Promise<number>|null=null
  async function perform() {
    if(!enabled())return 0
    const runId=randomUUID();let attempted=0
    for(let page=0;page<10 && enabled();page++) {
      const rows=await list(cursor,100)
      for(const row of rows) {
        if(!enabled())return attempted
        try {await expire(row.workspaceId,row.id,runId)}catch{options.onError?.()}
        cursor=row.id;attempted++
      }
      if(rows.length<100){cursor=null;break}
    }
    return attempted
  }
  const tick=()=>{if(running)return running;running=perform().catch(()=>{options.onError?.();return 0}).finally(()=>{running=null});return running}
  return {tick,start(){if(timer)return;timer=setInterval(()=>void tick(),Math.max(1000,options.intervalMs ?? 60_000));timer.unref?.();void tick()},
    stop(){if(timer)clearInterval(timer);timer=null}}
}
