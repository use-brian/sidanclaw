import {randomUUID} from 'node:crypto'
import {setTimeout} from 'node:timers/promises'
import {afterAll,describe,expect,it} from 'vitest'
import {getPool,getAppPool} from '../client.js'
import {createWorkspaceModulesStore,finishAssociationDrain} from '../workspace-modules-store.js'
import {createAssociationStore} from '../association-store.js'
import {createAssociationService} from '../../association/service.js'
import {createCrmOperationsService} from '../../crm-operations/service.js'
import {createDbCrmOperationsStore} from '../crm-operations-store.js'
import {createAssociationLifecycleWorker} from '../../association/lifecycle-worker.js'
import {EventInputSchema,TicketInputSchema,OrderCreateSchema} from '../../association/domain.js'
import {_resetCoalescerForTests} from '../../brain-stream/notify.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),appPool=getAppPool(),modules=createWorkspaceModulesStore(),commerce=createAssociationStore(),service=createAssociationService({crmService:createCrmOperationsService(createDbCrmOperationsStore())})
async function fixture() {
  const workspaceId=randomUUID(),userId=randomUUID(),contactId=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Reservation fixture',$2)",[workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,userId])
  await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source) VALUES($1,$2,'person','Fictional attendee',$3,'manual')",[contactId,workspaceId,userId])
  await modules.act(workspaceId,userId,{action:'enable',expectedVersion:1})
  const actor={credentialKind:'user' as const,credentialId:userId,actingUserId:userId}
  const event=await commerce.upsertEvent(workspaceId,EventInputSchema.parse({slug:'fixture-event',title:'Fixture event',startsAt:'2099-01-01T12:00:00Z',endsAt:'2099-01-01T14:00:00Z',timezone:'UTC',mode:'venue',status:'published',capacity:1000}),actor)
  const ticket=await commerce.upsertTicket(workspaceId,String(event.record.id),TicketInputSchema.parse({key:'standard',name:'Standard',currency:'USD',priceMinor:0,status:'on_sale',capacity:1000}),actor)
  const context={workspaceId,actor:{kind:'system_job' as const,job:'association_expiry' as const,runId:randomUUID()},authority:{role:'owner' as const,canConfigure:false,canRead:true,canWrite:true,canReconcileProvider:false,trustedIdentitySources:[]}}
  async function order(due=true) {
    const result=await commerce.createOrder(workspaceId,OrderCreateSchema.parse({contactId,idempotencyKey:randomUUID(),lines:[{ticketId:ticket.record.id,quantity:1,attendees:[{name:'Fictional attendee'}]}]}),actor)
    const id=String(result.record.id)
    if(due)await pool.query("UPDATE association_orders SET reservation_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id])
    return id
  }
  const expire=(id:string)=>service.execute(context,{kind:'expire_due_order',orderId:id})
  const drain=async()=>modules.act(workspaceId,userId,{action:'request_disable',expectedVersion:(await modules.getAssociation(workspaceId)).version})
  return {workspaceId,userId,context,actor,order,expire,drain}
}
async function blocked(fragment:string) {
  const deadline=Date.now()+5000
  while(Date.now()<deadline) {
    if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND position($1 in query)>0",[fragment])).rowCount)return
    await setTimeout(10)
  }
  throw Error('Expected a database row-lock wait')
}
describe('[COMP:crm/association-lifecycle] Actual reservation expiry and durable drain',()=>{
  afterAll(async()=>{_resetCoalescerForTests();await pool.end();await appPool.end()})
  it('expires over 100 orders and finishes a requested drain after restart without deleting history',async()=>{
    const f=await fixture();for(let i=0;i<105;i++)await f.order()
    expect((await f.drain()).module.state).toBe('draining')
    await createAssociationLifecycleWorker().tick()
    expect((await modules.getAssociation(f.workspaceId)).state).toBe('disabled')
    expect((await pool.query("SELECT count(*)::int count FROM association_orders WHERE workspace_id=$1 AND status='cancelled'",[f.workspaceId])).rows[0].count).toBe(105)
    expect((await pool.query("SELECT count(*)::int count FROM association_registrations WHERE workspace_id=$1 AND status='cancelled'",[f.workspaceId])).rows[0].count).toBe(105)
    await createAssociationLifecycleWorker().tick()
    expect((await pool.query("SELECT count(*)::int count FROM association_audit_log WHERE workspace_id=$1 AND action='order.expired'",[f.workspaceId])).rows[0].count).toBe(105)
    expect((await pool.query('SELECT count(*)::int count FROM association_provider_events WHERE workspace_id=$1',[f.workspaceId])).rows[0].count).toBe(0)
  })
  it('keeps future and indefinite pending orders as drain blockers, and preserves paid orders',async()=>{
    const f=await fixture(),future=await f.order(false),indefinite=await f.order(false),paid=await f.order(false)
    await commerce.confirmFreeOrder(f.workspaceId,paid,f.actor)
    await pool.query('UPDATE association_orders SET reservation_expires_at=NULL WHERE id=$1',[indefinite])
    for(const id of [future,indefinite,paid,randomUUID()])expect((await f.expire(id)).created).toBe(false)
    await f.drain();expect(await finishAssociationDrain(f.workspaceId)).toBe(false)
    expect((await commerce.getOrder(f.workspaceId,paid))?.status).toBe('paid')
  })
  it('two workers commit one expiry and one drain completion; re-enable cannot be overridden',async()=>{
    const f=await fixture(),id=await f.order();await f.drain()
    expect((await Promise.all([f.expire(id),f.expire(id)])).filter(r=>r.created)).toHaveLength(1)
    expect((await Promise.all([finishAssociationDrain(f.workspaceId),finishAssociationDrain(f.workspaceId)])).filter(Boolean)).toHaveLength(1)
    const disabled=await modules.getAssociation(f.workspaceId)
    await modules.act(f.workspaceId,f.userId,{action:'enable',expectedVersion:disabled.version})
    expect(await finishAssociationDrain(f.workspaceId)).toBe(false)
    expect((await modules.getAssociation(f.workspaceId)).state).toBe('enabled')
  })
  it('rechecks stale expiry candidates and refuses expiry authority from a member or unrelated job',async()=>{
    const f=await fixture(),id=await f.order(),other=await fixture()
    await pool.query("UPDATE association_orders SET reservation_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[id])
    expect((await f.expire(id)).created).toBe(false)
    expect((await other.expire(id)).created).toBe(false)
    await expect(service.execute({...f.context,actor:{kind:'user',userId:f.userId}},{kind:'expire_due_order',orderId:id})).rejects.toMatchObject({code:'not_authorized'})
    await expect(commerce.expireDueOrder(f.workspaceId,id,f.actor)).rejects.toMatchObject({code:'not_authorized'})
    await expect(service.execute(f.context,{kind:'cancel_order',orderId:id})).rejects.toMatchObject({code:'not_authorized'})
  })
  it('expiry waits for a concurrent paid transition and preserves its registrations',async()=>{
    const f=await fixture(),id=await f.order(false),writer=await pool.connect()
    let pending:ReturnType<typeof f.expire>|undefined
    try {
      await writer.query('BEGIN')
      await writer.query("UPDATE association_orders SET status='paid',reservation_expires_at=NULL WHERE id=$1",[id])
      await writer.query("UPDATE association_registrations SET status='confirmed',reservation_expires_at=NULL WHERE order_id=$1",[id])
      pending=f.expire(id);await blocked('SELECT status,total_minor::text')
      await writer.query('COMMIT');expect((await pending).created).toBe(false)
      expect((await commerce.getOrder(f.workspaceId,id))?.status).toBe('paid')
      expect((await pool.query('SELECT status FROM association_registrations WHERE order_id=$1',[id])).rows[0].status).toBe('confirmed')
    }finally{await writer.query('ROLLBACK').catch(()=>{});writer.release();if(pending)await pending}
  })
  it('a concurrent re-enable wins against a stale drain candidate',async()=>{
    const f=await fixture(),id=await f.order();await f.drain();await f.expire(id)
    const writer=await pool.connect();let pending:Promise<boolean>|undefined
    try {
      await writer.query('BEGIN')
      await writer.query("UPDATE workspace_modules SET state='enabled',version=version+1 WHERE workspace_id=$1 AND module_key='association'",[f.workspaceId])
      pending=finishAssociationDrain(f.workspaceId);await blocked('SELECT version FROM workspace_modules')
      await writer.query('COMMIT');expect(await pending).toBe(false)
      expect((await modules.getAssociation(f.workspaceId)).state).toBe('enabled')
    }finally{await writer.query('ROLLBACK').catch(()=>{});writer.release();if(pending)await pending}
  })
  it('rolls back order and registration state if audit fails, and retries safely',async()=>{
    const f=await fixture(),id=await f.order()
    await pool.query("ALTER TABLE association_audit_log ADD CONSTRAINT fixture_refuse_order_expiry CHECK(action<>'order.expired') NOT VALID")
    try {
      await expect(f.expire(id)).rejects.toThrow()
      expect((await commerce.getOrder(f.workspaceId,id))?.status).toBe('pending')
      expect((await pool.query("SELECT status FROM association_registrations WHERE workspace_id=$1 AND order_id=$2",[f.workspaceId,id])).rows[0].status).toBe('reserved')
    }finally{await pool.query('ALTER TABLE association_audit_log DROP CONSTRAINT fixture_refuse_order_expiry')}
    expect((await f.expire(id)).created).toBe(true)
  })
})
