import {randomUUID} from 'node:crypto'
import express from 'express'
import request from 'supertest'
import {afterAll,describe,expect,it} from 'vitest'
import {type CrmOperationsContext,type CrmRetentionPolicy,type CrmRetentionReview} from '@use-brian/core'
import {getPool,getAppPool} from '../client.js'
import {pruneCrmOperationsRetention} from '../../crm-operations/privacy.js'
import {createCrmPrivacyService} from '../../crm-operations/privacy-previews.js'
import {createCrmOperationsService} from '../../crm-operations/service.js'
import {createDbCrmOperationsStore} from '../crm-operations-store.js'
import {createCrmRetentionService,runScheduledCrmRetention,listCrmRetentionRuns} from '../../crm-operations/retention-service.js'
import {createWorkspaceStore} from '../workspace-store.js'
import {createDbCrmIntakeReadStore} from '../crm-intake-store.js'
import {crmOperationsRoutes} from '../../routes/crm-operations.js'
import {flushWorkspaceData} from '../workspace-flush.js'
import {streamCrmPrivacyExport} from '../../crm-operations/privacy-export.js'
import {_resetCoalescerForTests} from '../../brain-stream/notify.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),appPool=getAppPool(),service=createCrmOperationsService(createDbCrmOperationsStore()),retention=createCrmRetentionService()
const BASE:CrmRetentionPolicy={scheduled:false,intervalSeconds:60,resolvedSubmissionsSeconds:60,openSubmissions:null,
  importReceiptsSeconds:null,deliveryReceiptsSeconds:null,auditSeconds:null,financialRecordsSeconds:null,holds:[]}
async function fixture() {
  const workspaceId=randomUUID(),userId=randomUUID(),contactId=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Retention fixture',$2)",[workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,userId])
  await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,created_by_user_id,source) VALUES($1,$2,'person','Fictional contact','retention@example.com',$3,'manual')",[contactId,workspaceId,userId])
  const context:CrmOperationsContext={workspaceId,actor:{kind:'user',userId},authority:{role:'owner',canConfigure:true,canWrite:true,trustedIdentitySources:[]}}
  async function policy(config:CrmRetentionPolicy=BASE,expectedVersion=0) {
    return service.execute(context,{kind:'save_privacy_policy',expectedVersion,confirmed:true,intakeReplay:{retentionSeconds:3600},retention:config})
  }
  const preview=()=>retention.preview(context,{kind:'preview_retention',before:new Date().toISOString()})
  const execute=(p:CrmRetentionReview)=>retention.execute(context,{kind:'execute_retention',previewId:p.id,previewHash:p.previewHash,confirmed:true})
  async function submission(status='resolved',id=randomUUID(),contact=contactId) {
    await pool.query(`INSERT INTO association_enquiries(id,workspace_id,contact_id,source,source_submission_id,request_fingerprint,subject,message,submitted_data,status,updated_at)
      VALUES($1::uuid,$2,$3,'manual',$1::text,repeat('a',64),'Private subject','Private message','{"sensitive":"Private form value"}',$4,now()-interval '2 days')`,[id,workspaceId,contact,status])
    return id
  }
  const note=(id:string)=>pool.query(`INSERT INTO association_enquiry_notes(workspace_id,enquiry_id,body,actor_kind,actor_credential_id)
    VALUES($1,$2,'Private note','api_key','fixture')`,[workspaceId,id])
  return {workspaceId,userId,contactId,context,policy,preview,execute,submission,note}
}
async function count(table:string,workspaceId:string) {return Number((await pool.query(`SELECT count(*) count FROM ${table} WHERE workspace_id=$1`,[workspaceId])).rows[0].count)}
describe('[COMP:crm/retention] Actual review and policy execution',()=>{
  afterAll(async()=>{_resetCoalescerForTests();await pool.end();await appPool.end()})
  it('rejects malformed retention policy through the database constraint as well as the command schema',async()=>{
    for(const value of [
      {...BASE,holds:[{domain:null,id:randomUUID()}]},
      {...BASE,openSubmissions:{afterSeconds:60,fields:[null]}},
      {...BASE,resolvedSubmissionsSeconds:0},
      {...BASE,holds:[{domain:'contact',id:'invalid'}]},
    ])expect((await pool.query('SELECT crm_retention_policy_valid($1::jsonb) valid',[JSON.stringify(value)])).rows[0].valid).toBe(false)
  })
  it('leaves an unconfigured workspace untouched and refuses machine approval or foreign holds',async()=>{
    const f=await fixture(),other=await fixture();await f.submission()
    const review=await f.preview();expect(review.status).toBe('blocked')
    await expect(f.execute(review)).rejects.toMatchObject({details:{reason:'retention_preview_blocked'}})
    expect(await runScheduledCrmRetention(f.workspaceId)).toBe('skipped')
    expect(await count('association_enquiries',f.workspaceId)).toBe(1)
    await expect(service.execute({...f.context,actor:{kind:'brain_key',credentialId:randomUUID()}},{kind:'save_privacy_policy',expectedVersion:0,confirmed:true,intakeReplay:null,retention:BASE})).rejects.toMatchObject({code:'not_authorized'})
    await expect(f.policy({...BASE,holds:[{domain:'contact',id:other.contactId}]})).rejects.toMatchObject({code:'invalid_input'})
    expect(await count('crm_privacy_policies',f.workspaceId)).toBe(0)
  })
  it('captures over 100 submissions, rejects changed notes, then consumes one transaction and replays its receipt',async()=>{
    const f=await fixture();await f.policy()
    for(let i=0;i<105;i++)await f.submission()
    const id=(await pool.query('SELECT id FROM association_enquiries WHERE workspace_id=$1 LIMIT 1',[f.workspaceId])).rows[0].id
    const audit=(await pool.query("INSERT INTO association_audit_log(workspace_id,action,subject_kind,subject_id,actor_kind,actor_credential_id,metadata) VALUES($1,'fixture','submission',$2,'user','fixture','{\"private\":\"Private audit\"}') RETURNING id",[f.workspaceId,id])).rows[0].id
    const first=await f.preview();expect(first.domains).toContainEqual({domain:'association_enquiries',action:'delete',count:105})
    expect(await count('association_enquiries',f.workspaceId)).toBe(105)
    await f.note(id)
    await expect(f.execute(first)).rejects.toMatchObject({details:{reason:'retention_preview_stale'}})
    const auditReview=await f.preview()
    await pool.query("UPDATE association_audit_log SET metadata='{\"private\":\"Changed private audit\"}' WHERE id=$1",[audit])
    await expect(f.execute(auditReview)).rejects.toMatchObject({details:{reason:'retention_preview_stale'}})
    const review=await f.preview(),executed=await f.execute(review)
    expect(executed.receipt.changed).toMatchObject({submissions:105});expect(executed.duplicate).toBe(false)
    expect(await count('association_enquiries',f.workspaceId)).toBe(0)
    expect(await count('association_enquiry_notes',f.workspaceId)).toBe(0)
    expect((await pool.query('SELECT metadata FROM association_audit_log WHERE id=$1',[audit])).rows[0].metadata).toEqual({retentionRedacted:true})
    expect(await f.execute(review)).toEqual({receipt:executed.receipt,duplicate:true})
    const runs=(await pool.query('SELECT * FROM crm_retention_runs WHERE workspace_id=$1',[f.workspaceId])).rows
    expect(JSON.stringify(runs)).not.toContain('Private')
  })
  it('binds review to the owner and current policy and refuses membership revocation',async()=>{
    const f=await fixture(),other=await fixture();await f.policy();await f.submission()
    const review=await f.preview()
    await expect(other.execute(review)).rejects.toMatchObject({code:'not_found'})
    await expect(f.execute({...review,previewHash:'f'.repeat(64)})).rejects.toMatchObject({details:{reason:'retention_preview_mismatch'}})
    await f.policy({...BASE,resolvedSubmissionsSeconds:120},1)
    await expect(f.execute(review)).rejects.toMatchObject({details:{reason:'retention_preview_stale'}})
    const fresh=await f.preview()
    await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId])
    await expect(f.execute(fresh)).rejects.toMatchObject({code:'not_authorized'})
    expect(await count('association_enquiries',f.workspaceId)).toBe(1)
  })
  it('redacts selected open fields and notes while retaining state and independent copies',async()=>{
    const f=await fixture();await f.policy({...BASE,openSubmissions:{afterSeconds:60,fields:['message','metadata','notes']}})
    const id=await f.submission('in_progress');await f.note(id)
    const review=await f.preview();expect(review.retainedCopies).toContain('independent_task_import_delivery_copies')
    await f.execute(review)
    const row=(await pool.query('SELECT subject,message,submitted_data,status,contact_id FROM association_enquiries WHERE id=$1',[id])).rows[0]
    expect(row).toEqual({subject:'Private subject',message:'Removed by retention policy',submitted_data:{},status:'in_progress',contact_id:f.contactId})
    expect(await count('association_enquiry_notes',f.workspaceId)).toBe(0)
    expect(await count('entities',f.workspaceId)).toBe(1)
  })
  it('supports metadata-only and notes-only policies without changing other submission content',async()=>{
    for(const field of ['metadata','notes'] as const) {
      const f=await fixture();await f.policy({...BASE,openSubmissions:{afterSeconds:60,fields:[field]}})
      const id=await f.submission('new');await f.note(id);await f.execute(await f.preview())
      const row=(await pool.query('SELECT subject,message,submitted_data,status FROM association_enquiries WHERE id=$1',[id])).rows[0]
      expect(row.message).toBe('Private message');expect(row.status).toBe('new')
      expect(row.submitted_data).toEqual(field==='metadata'?{}:{sensitive:'Private form value'})
      expect(await count('association_enquiry_notes',f.workspaceId)).toBe(field==='notes'?0:1)
    }
  })
  it('retains holds and live event attribution without starving eligible submissions beyond a full held page',async()=>{
    const f=await fixture(),held=await f.submission('resolved','00000000-0000-4000-8000-000000000001')
    // Many dependent rows precede the eligible row in id order.
    for(let i=0;i<505;i++) {
      const id=await f.submission()
      await pool.query(`INSERT INTO crm_domain_event_outbox(workspace_id,event_type,event_key,subject_kind,subject_id,actor_kind)
        VALUES($1,'crm.submission.received',$2::text,'submission',$2::uuid,'user')`,[f.workspaceId,id])
    }
    const eligible=await f.submission();await f.policy({...BASE,holds:[{domain:'submission',id:held}]})
    const review=await f.preview()
    expect(review.domains).toContainEqual({domain:'association_enquiries',action:'delete',count:1})
    expect(review.domains).toContainEqual({domain:'association_enquiries',action:'retain',count:506})
    expect(review.hasMore).toBe(false);await f.execute(review)
    expect((await pool.query('SELECT id FROM association_enquiries WHERE id=$1',[eligible])).rowCount).toBe(0)
    expect(await count('association_enquiries',f.workspaceId)).toBe(506)
  })
  it('bounds mutations to 500 and exposes remaining eligible work',async()=>{
    const f=await fixture();await f.policy()
    for(let i=0;i<503;i++)await f.submission()
    const review=await f.preview();expect(review.hasMore).toBe(true)
    expect((await f.execute(review)).receipt.changed).toMatchObject({submissions:500})
    const rest=await f.preview();expect(rest.hasMore).toBe(false)
    expect((await f.execute(rest)).receipt.changed).toMatchObject({submissions:3})
  })
  it('rechecks admission, and a later failure rolls back all earlier selected deletions',async()=>{
    const f=await fixture();await f.policy();await f.submission();const review=await f.preview()
    const writer=await pool.connect()
    try {
      await writer.query('BEGIN');await writer.query("UPDATE entities SET display_name='Pending private edit' WHERE id=$1",[f.contactId])
      await expect(f.execute(review)).rejects.toMatchObject({details:{reason:'privacy_operation_busy'}})
    }finally{await writer.query('ROLLBACK');writer.release()}
    // A test-owned FK forces failure after the selected deletion is attempted.
    const conn=await pool.connect()
    try {
      await conn.query('CREATE TABLE retention_test_block(id uuid PRIMARY KEY, enquiry_id uuid REFERENCES association_enquiries(id))')
      const id=(await pool.query('SELECT id FROM association_enquiries WHERE workspace_id=$1',[f.workspaceId])).rows[0].id
      await conn.query('INSERT INTO retention_test_block VALUES($1,$2)',[randomUUID(),id])
      await expect(f.execute(review)).rejects.toMatchObject({details:{reason:'retention_failed'}})
      expect(await count('association_enquiries',f.workspaceId)).toBe(1)
      expect((await pool.query('SELECT status FROM crm_retention_runs WHERE id=$1',[review.id])).rows[0].status).toBe('ready')
    }finally{await conn.query('DROP TABLE IF EXISTS retention_test_block');conn.release()}
    await f.execute(review)
  })
  it('runs an opted-in policy once across simultaneous workers and a restart, and reacts to a later disable',async()=>{
    const f=await fixture();await f.policy({...BASE,scheduled:true});await f.submission()
    const outcomes=await Promise.all([runScheduledCrmRetention(f.workspaceId),runScheduledCrmRetention(f.workspaceId)])
    expect(outcomes.filter(v=>v==='completed')).toHaveLength(1)
    expect(await runScheduledCrmRetention(f.workspaceId)).toBe('skipped')
    expect(await count('association_enquiries',f.workspaceId)).toBe(0)
    expect(await count('crm_retention_runs',f.workspaceId)).toBe(1)
    await f.policy(BASE,1);await f.submission()
    expect(await runScheduledCrmRetention(f.workspaceId)).toBe('skipped')
    expect(await count('association_enquiries',f.workspaceId)).toBe(1)
  })
  it('makes a saved contact hold block canonical contact erasure as well as retention',async()=>{
    const f=await fixture();await f.policy({...BASE,holds:[{domain:'contact',id:f.contactId}]});await f.submission()
    expect((await f.policy({...BASE,holds:[{domain:'contact',id:f.contactId.toUpperCase()}]},1)).created).toBe(false)
    await pruneCrmOperationsRetention(f.workspaceId,new Date())
    expect(await count('association_enquiries',f.workspaceId)).toBe(1)
    const review=await f.preview();expect(review.domains).toContainEqual({domain:'association_enquiries',action:'retain',count:1})
    const erasure=await createCrmPrivacyService().preview(f.context,{kind:'preview_contact_erasure',contactId:f.contactId.toUpperCase()})
    expect(erasure.status).toBe('blocked');expect(erasure.blockers).toContainEqual({domain:'entities',reason:'retention_hold',count:1})
    await expect(createCrmPrivacyService().erase(f.context,{kind:'erase_contact_with_preview',contactId:f.contactId.toUpperCase(),previewId:erasure.id,previewHash:erasure.previewHash,confirmed:true})).rejects.toMatchObject({details:{reason:'privacy_preview_blocked'}})
  })
  it('minimizes eligible delivery envelopes and retains ambiguous sends and failed events',async()=>{
    const f=await fixture();await f.policy({...BASE,deliveryReceiptsSeconds:60})
    const ids:Record<string,string>={}
    for(const status of ['sent','failed','needs_reconciliation']) {
      const id=randomUUID();ids[status]=id
      await pool.query(`INSERT INTO crm_delivery_receipts(workspace_id,delivery_id,request_hash,connector_instance_id,provider_key,purpose_key,
        actor_kind,actor_credential_id,envelope,status,claim_token,claim_deadline,provider_receipt,accepted_at,updated_at)
        VALUES($1,$2,repeat('a',64),$3,'fake','updates','user','fixture','{"body":"Private message"}',$4,$5,now(),
          '{"private":"Private provider reply"}',CASE WHEN $4='sent' THEN now()-interval '2 days' ELSE NULL END,now()-interval '2 days')`,[f.workspaceId,id,randomUUID(),status,randomUUID()])
    }
    for(const status of ['delivered','failed'])await pool.query(`INSERT INTO crm_domain_event_outbox(workspace_id,event_type,event_key,subject_kind,subject_id,actor_kind,status,created_at)
      VALUES($1,'crm.submission.received',$2,'submission',$3,'user',$4,now()-interval '2 days')`,[f.workspaceId,randomUUID(),randomUUID(),status])
    const review=await f.preview()
    expect(review.domains).toContainEqual({domain:'crm_delivery_receipts',action:'redact',count:2})
    expect(review.domains).toContainEqual({domain:'crm_delivery_receipts',action:'retain',count:1})
    await f.execute(review)
    const rows=(await pool.query('SELECT delivery_id,status,envelope,provider_receipt,redacted_at FROM crm_delivery_receipts WHERE workspace_id=$1',[f.workspaceId])).rows
    expect(rows.filter(r=>r.status!=='needs_reconciliation').every(r=>r.envelope===null && r.provider_receipt===null && r.redacted_at instanceof Date)).toBe(true)
    expect(rows.find(r=>r.delivery_id===ids.needs_reconciliation).envelope).toEqual({body:'Private message'})
    expect((await pool.query('SELECT status FROM crm_domain_event_outbox WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([{status:'failed'}])
  })
  it('binds receipt expiry to the preview time, and prunes expired replay only on a later review',async()=>{
    const f=await fixture();await f.policy();const submission=await f.submission()
    const def=await service.execute(f.context,{kind:'save_intake_definition',definitionKey:'retention',label:'Retention fixture',active:true,definition:{
      identityPolicy:'new_or_review',fields:[{key:'name',label:'Name',type:'text',required:true,mapping:{kind:'base_field',field:'name'}}],
      consentMappings:[],queueKey:'general',ownerUserId:null,followUpTaskTemplate:null,followUpDueMinutes:null,maxPayloadBytes:32768}})
    const receipt=randomUUID()
    await pool.query(`INSERT INTO crm_intake_idempotency(id,workspace_id,actor_scope,definition_id,idempotency_key,request_hash,status,submission_id,contact_id,
      created_at,committed_at,replay_policy_version,replay_expires_at)
      VALUES($1,$2,'fixture',$3,'fixture',repeat('a',64),'committed',$4,$5,now()-interval '2 days',now()-interval '2 days',1,now()+interval '1 second')`,
      [receipt,f.workspaceId,def.record.id,submission,f.contactId])
    const review=await f.preview();await pool.query('SELECT pg_sleep(1.05)');await f.execute(review)
    expect((await pool.query('SELECT status,replay_expires_at<clock_timestamp() expired FROM crm_intake_idempotency WHERE id=$1',[receipt])).rows).toEqual([{status:'retired',expired:true}])
    await f.execute(await f.preview())
    expect((await pool.query('SELECT id FROM crm_intake_idempotency WHERE id=$1',[receipt])).rowCount).toBe(0)
  })
  it('records scheduled rollback as a fixed failed run without committing partial deletion',async()=>{
    const f=await fixture();await f.policy({...BASE,scheduled:true});const id=await f.submission()
    await pool.query('CREATE TABLE retention_worker_test_block(id uuid PRIMARY KEY, enquiry_id uuid REFERENCES association_enquiries(id))')
    try {
      await pool.query('INSERT INTO retention_worker_test_block VALUES($1,$2)',[randomUUID(),id])
      expect(await runScheduledCrmRetention(f.workspaceId)).toBe('failed')
      expect(await count('association_enquiries',f.workspaceId)).toBe(1)
      const runs=(await pool.query('SELECT status,error_code,summary,receipt FROM crm_retention_runs WHERE workspace_id=$1',[f.workspaceId])).rows
      expect(runs).toEqual([{status:'failed',error_code:'retention_failed',summary:{},receipt:null}])
      expect(await runScheduledCrmRetention(f.workspaceId)).toBe('skipped')
    }finally{await pool.query('DROP TABLE retention_worker_test_block')}
  })
  it('exposes member REST review/execute and paginated run history with no approval hashes in exports',async()=>{
    const f=await fixture();await f.policy();await f.submission()
    const app=express();app.use(express.json());app.use((req,_res,next)=>{req.userId=f.userId;next()})
    app.use('/crm',crmOperationsRoutes({workspaceStore:createWorkspaceStore(),readStore:createDbCrmIntakeReadStore(),service}))
    const preview=await request(app).post(`/crm/${f.workspaceId}/operations/retention/dry-run`).send({before:new Date().toISOString()})
    expect(preview.status).toBe(200)
    const execution=await request(app).post(`/crm/${f.workspaceId}/operations/retention/execute`).send({previewId:preview.body.id,previewHash:preview.body.previewHash,confirmed:true})
    expect(execution.status).toBe(200)
    for(let i=0;i<5;i++)await f.preview()
    const first=await listCrmRetentionRuns(f.context,{limit:2});expect(first.runs).toHaveLength(2);expect(first.nextCursor).toEqual(expect.any(String))
    const second=await listCrmRetentionRuns(f.context,{limit:2,cursor:first.nextCursor!});expect(second.runs).toHaveLength(2)
    expect(new Set([...first.runs,...second.runs].map(r=>r.id)).size).toBe(4)
    const exported=[];for await(const line of streamCrmPrivacyExport(f.context))exported.push(line)
    const records=exported.join('').trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.type==='record' && row.domain==='crm_retention_runs')
    expect(records).toHaveLength(6)
    expect(records.every(row=>!Object.hasOwn(row.record,'preview_hash') && !Object.hasOwn(row.record,'snapshot_hash'))).toBe(true)
    expect(exported.join('')).not.toContain(preview.body.previewHash)
  })
  it('enforces actual app-role read/write isolation and workspace reset preserves policy',async()=>{
    const f=await fixture(),other=await fixture();await f.policy();const preview=await f.preview()
    const app=await appPool.connect()
    try {
      await app.query('BEGIN');await app.query("SELECT set_config('app.current_user_id',$1,true)",[other.userId])
      expect((await app.query('SELECT id FROM crm_retention_runs WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
      expect((await app.query("UPDATE crm_retention_runs SET status='completed' WHERE id=$1",[preview.id])).rowCount).toBe(0)
      await app.query('ROLLBACK');await app.query('BEGIN');await app.query("SELECT set_config('app.current_user_id',$1,true)",[f.userId])
      expect((await app.query('SELECT id FROM crm_retention_runs WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(1)
      expect((await app.query('DELETE FROM crm_retention_runs WHERE id=$1',[preview.id])).rowCount).toBe(0)
    }finally{await app.query('ROLLBACK');app.release()}
    await flushWorkspaceData(f.userId,f.workspaceId)
    expect(await count('crm_retention_runs',f.workspaceId)).toBe(0)
    expect(await count('crm_privacy_policies',f.workspaceId)).toBe(1)
  })
})
