/** Durable reservation expiry and completion of requested drains. [COMP:crm/association-lifecycle] */
import {randomUUID} from 'node:crypto'
import {query} from '../db/client.js'
import {createAssociationService} from './service.js'
import {createCrmOperationsService} from '../crm-operations/service.js'
import {createDbCrmOperationsStore} from '../db/crm-operations-store.js'
import {finishAssociationDrain} from '../db/workspace-modules-store.js'
import {notifyWorkspaceChange} from '../brain-stream/notify.js'
export function createAssociationLifecycleWorker(options:{
  enabled?:()=>boolean
  orders?:(after:string|null,limit:number)=>Promise<{id:string;workspaceId:string}[]>
  drains?:(after:string|null,limit:number)=>Promise<string[]>
  expire?:(workspaceId:string,id:string,runId:string)=>Promise<void>
  finish?:(workspaceId:string)=>Promise<boolean>
  onError?:()=>void
  intervalMs?:number
}={}) {
  const enabled=options.enabled ?? (()=>!['false','0'].includes((process.env.ASSOCIATION_LIFECYCLE_ENABLED ?? '').trim().toLowerCase()))
  const orders=options.orders ?? (async(after,limit)=>(await query<{id:string;workspaceId:string}>(`SELECT id,workspace_id AS "workspaceId" FROM association_orders
    WHERE status='pending' AND reservation_expires_at<=clock_timestamp() AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2`,[after,limit])).rows)
  const drains=options.drains ?? (async(after,limit)=>(await query<{id:string}>(`SELECT workspace_id id FROM workspace_modules
    WHERE module_key='association' AND state='draining' AND ($1::uuid IS NULL OR workspace_id>$1) ORDER BY workspace_id LIMIT $2`,[after,limit])).rows.map(r=>r.id))
  const service=createAssociationService({crmService:createCrmOperationsService(createDbCrmOperationsStore())})
  const expire=options.expire ?? (async(workspaceId,id,runId)=>{
    await service.execute({workspaceId,actor:{kind:'system_job',job:'association_expiry',runId},
      authority:{role:'owner',canConfigure:false,canRead:true,canWrite:true,canReconcileProvider:false,trustedIdentitySources:[]}},
      {kind:'expire_due_order',orderId:id})
  })
  const finish=options.finish ?? finishAssociationDrain
  let orderCursor:string|null=null,drainCursor:string|null=null,timer:ReturnType<typeof setInterval>|null=null,running:Promise<number>|null=null
  async function perform() {
    if(!enabled())return 0
    const runId=randomUUID();let attempted=0
    for(let page=0;page<10 && enabled();page++) {
      const rows=await orders(orderCursor,100)
      for(const row of rows) {
        if(!enabled())return attempted
        try{await expire(row.workspaceId,row.id,runId)}catch{options.onError?.()}
        orderCursor=row.id;attempted++
      }
      if(rows.length<100){orderCursor=null;break}
    }
    if(!enabled())return attempted
    const workspaces=await drains(drainCursor,100)
    for(const workspaceId of workspaces) {
      if(!enabled())return attempted
      try{if(await finish(workspaceId))notifyWorkspaceChange(workspaceId,'workspace_config','update')}catch{options.onError?.()}
      drainCursor=workspaceId
    }
    if(workspaces.length<100)drainCursor=null
    return attempted
  }
  const tick=()=>{if(running)return running;running=perform().catch(()=>{options.onError?.();return 0}).finally(()=>{running=null});return running}
  return {tick,start(){if(timer)return;timer=setInterval(()=>void tick(),Math.max(1000,options.intervalMs ?? 60_000));timer.unref?.();void tick()},
    stop(){if(timer)clearInterval(timer);timer=null}}
}
