import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import type {CrmOperationsContext} from '@use-brian/core'
import {getPool,getAppPool} from '../client.js'
import {createDbWorkflowRunStore} from '../workflow-store.js'
import {_resetCoalescerForTests} from '../../brain-stream/notify.js'
import {createCrmPrivacyService} from '../../crm-operations/privacy-previews.js'
import {streamCrmPrivacyExport} from '../../crm-operations/privacy-export.js'
import {acquireCrmPrivacyAdmission} from '../../crm-operations/privacy-admission.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),appPool=getAppPool(),runs=createDbWorkflowRunStore(),privacy=createCrmPrivacyService()
const workspaces:string[]=[],users:string[]=[]
async function fixture() {
  const workspaceId=randomUUID(),userId=randomUUID(),contactId=randomUUID(),workflowId=randomUUID()
  users.push(userId);workspaces.push(workspaceId)
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Workflow copy fixture',$2)",[workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,userId])
  await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,created_by_user_id,source)
    VALUES($1,$2,'person','Subject fixture','subject@example.com',$3,'manual')`,[contactId,workspaceId,userId])
  await pool.query("INSERT INTO workflows(id,workspace_id,created_by,name,definition,enabled) VALUES($1,$2,$3,'Workflow fixture','{}',false)",[workflowId,workspaceId,userId])
  const context:CrmOperationsContext={workspaceId,actor:{kind:'user',userId},authority:{role:'owner',canWrite:true,canConfigure:true,trustedIdentitySources:[]}}
  const preview=()=>privacy.preview(context,{kind:'preview_contact_erasure',contactId})
  const erase=async()=>{const p=await preview();expect(p.blockers).toEqual([]);return privacy.erase(context,{kind:'erase_contact_with_preview',contactId,previewId:p.id,previewHash:p.previewHash,confirmed:true})}
  const event=async(subject=contactId)=>{
    const id=randomUUID();await pool.query(`INSERT INTO crm_domain_event_outbox(id,workspace_id,event_type,event_key,subject_kind,subject_id,actor_kind,payload,status,delivered_at)
      VALUES($1,$2,'crm.consent.changed',$1::uuid::text,'contact',$3,'user',$4,'delivered',clock_timestamp())`,[id,workspaceId,subject,JSON.stringify({contactId:subject})]);return id
  }
  const create=async(eventId?:string,input:Record<string,unknown>={})=>{
    const body=eventId?{trigger:{sourceType:'crm'},event:{domainEventId:eventId,subjectKind:'contact',subjectId:contactId,contactId}}:input
    return (await runs.createRun({workflowId,workspaceId,triggeredBy:userId,triggerKind:eventId?'event':'manual',input:body})).id
  }
  const finish=async(id:string,value='subject@example.com')=>{
    const step=await runs.createStepRun({runId:id,stepId:'local',stepType:'branch',input:{value}})
    await runs.updateStepRun(step.id,{status:'completed',output:{value},finishedAt:new Date()})
    await runs.updateRun(id,{status:'completed',vars:{value},outcome:{status:'completed',summary:value,logs:[],todo:[],blockers:[],state:{value},finishedAt:new Date().toISOString()},finishedAt:new Date()})
  }
  const blueprint=async(id:string)=>pool.query(`INSERT INTO blueprint_records(workspace_id,spec_snapshot,subject,anchor_key,fields,source_kind,source_id,created_by)
    VALUES($1,'{}','Fixture',$2,$3,'workflow',$2,$4)`,[workspaceId,id,JSON.stringify({private:'subject@example.com'}),userId])
  return {workspaceId,userId,contactId,workflowId,context,preview,erase,event,create,finish,blueprint}
}
async function rowsFor(context:CrmOperationsContext,contactId:string,domain:string) {
  const rows:Record<string,unknown>[]=[]
  for await(const line of streamCrmPrivacyExport(context,{contactId})) {const row=JSON.parse(line);if(row.type==='record'&&row.domain===domain)rows.push(row.record)}
  return rows
}
describe('[COMP:crm/privacy-copies] Workflow outcome copies and retirement',()=>{
  afterEach(async()=>{_resetCoalescerForTests();await pool.query('DELETE FROM workspaces WHERE id=ANY($1::uuid[])',[workspaces.splice(0)]);await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users.splice(0)])})
  afterAll(async()=>{_resetCoalescerForTests();await pool.end();await appPool.end()})
  it('retires a never-started run and refuses stale run and step writers',async()=>{
    const f=await fixture(),event=await f.event(),run=await f.create(event)
    await f.erase()
    expect((await pool.query('SELECT status,privacy_erased,input,vars,outcome,error,triggered_by FROM workflow_runs WHERE id=$1',[run])).rows[0]).toEqual({status:'failed',privacy_erased:true,input:{},vars:{},outcome:null,error:null,triggered_by:null})
    await expect(runs.updateRun(run,{status:'running'})).rejects.toMatchObject({code:'55000'})
    await expect(runs.createStepRun({runId:run,stepId:'late',stepType:'branch',input:{private:'subject@example.com'}})).rejects.toMatchObject({code:'55000'})
    expect((await pool.query('SELECT status FROM crm_domain_event_outbox WHERE id=$1',[event])).rows[0].status).toBe('retired')
  })
  it('follows more than one page of outcome consumers while preserving unrelated runs',async()=>{
    const f=await fixture(),root=await f.create(await f.event());await f.finish(root)
    for(let i=0;i<105;i++) {
      const child=await f.create();await runs.updateRun(child,{status:'running'})
      expect(await runs.getLatestOutcomeForWorkflowSystem(f.workflowId,child)).toMatchObject({summary:'subject@example.com'})
      await f.finish(child)
    }
    const untouched=await f.create(undefined,{unrelated:'keep'})
    expect(await rowsFor(f.context,f.contactId,'workflow_runs')).toHaveLength(106)
    expect(await rowsFor(f.context,f.contactId,'workflow_run_copy_sources')).toHaveLength(105)
    await f.erase()
    expect((await pool.query('SELECT id FROM workflow_runs WHERE workspace_id=$1 AND privacy_erased',[f.workspaceId])).rowCount).toBe(106)
    expect((await pool.query('SELECT id FROM workflow_step_runs WHERE run_id IN(SELECT id FROM workflow_runs WHERE workspace_id=$1)',[f.workspaceId])).rowCount).toBe(0)
    expect((await pool.query('SELECT input,privacy_erased FROM workflow_runs WHERE id=$1',[untouched])).rows[0]).toEqual({input:{unrelated:'keep'},privacy_erased:false})
    expect(await runs.getLatestOutcomeForWorkflowSystem(f.workflowId,untouched)).toBeNull()
  })
  it('records enrichment before returning it and keeps duplicate reads idempotent',async()=>{
    const f=await fixture(),source=await f.create(await f.event());await f.finish(source);await f.blueprint(source)
    const child=await f.create();await runs.updateRun(child,{status:'running'})
    for(let i=0;i<2;i++)expect(await runs.getLatestOutcomeForWorkflowSystem(f.workflowId,child)).toMatchObject({output:{private:'subject@example.com'},outputStatus:'incomplete'})
    expect((await pool.query('SELECT source_run_id FROM workflow_run_copy_sources WHERE run_id=$1',[child])).rows).toEqual([{source_run_id:source}])
    expect((await f.preview()).blockers).toContainEqual({domain:'workflow_runs',reason:'workflow_artifact_dependency',count:1})
  })
  it('returns no copied content when privacy admission cannot be acquired',async()=>{
    const f=await fixture(),source=await f.create(await f.event());await f.finish(source);const child=await f.create(),client=await pool.connect()
    try {await client.query('BEGIN');await acquireCrmPrivacyAdmission(client,f.workspaceId)
      await expect(runs.getLatestOutcomeForWorkflowSystem(f.workflowId,child)).rejects.toThrow('Workflow outcome copy could not be recorded')
      expect((await pool.query('SELECT run_id FROM workflow_run_copy_sources WHERE run_id=$1',[child])).rowCount).toBe(0)
    }finally{await client.query('ROLLBACK');client.release()}
  })
  it('blocks active, external-effect and independent-input copies',async()=>{
    const f=await fixture(),root=await f.create(await f.event());await f.finish(root)
    const active=await f.create();await runs.updateRun(active,{status:'running'});await runs.getLatestOutcomeForWorkflowSystem(f.workflowId,active)
    const shared=await f.create(undefined,{otherPerson:'other@example.com'});await runs.getLatestOutcomeForWorkflowSystem(f.workflowId,shared);await f.finish(shared)
    const external=await f.create();await runs.getLatestOutcomeForWorkflowSystem(f.workflowId,external)
    const step=await runs.createStepRun({runId:external,stepId:'external',stepType:'assistant_call'});await runs.updateStepRun(step.id,{status:'completed'});await runs.updateRun(external,{status:'completed'})
    const blockers=(await f.preview()).blockers
    expect(blockers).toContainEqual({domain:'workflow_runs',reason:'workflow_execution_dependency',count:1})
    expect(blockers).toContainEqual({domain:'workflow_runs',reason:'workflow_artifact_dependency',count:1})
    expect(blockers).toContainEqual({domain:'workflow_runs',reason:'shared_workflow_copy_dependency',count:1})
  })
  it('keeps pre-migration sibling reads as explicit unknown-lineage dependencies',async()=>{
    const f=await fixture();await f.create(await f.event());const legacy=randomUUID()
    await pool.query(`INSERT INTO workflow_runs(id,workspace_id,workflow_id,trigger_kind,input,privacy_lineage_version)
      VALUES($1,$2,$3,'manual','{}',0)`,[legacy,f.workspaceId,f.workflowId])
    expect((await f.preview()).blockers).toContainEqual({domain:'workflow_runs',reason:'workflow_legacy_lineage_dependency',count:1})
    expect((await rowsFor(f.context,f.contactId,'workflow_runs')).some(r=>r.id===legacy)).toBe(true)
    await expect(pool.query('UPDATE workflow_runs SET privacy_lineage_version=1 WHERE id=$1',[legacy])).rejects.toMatchObject({code:'55000'})
  })
  it('refuses stale-snapshot source admission after retirement',async()=>{
    const f=await fixture(),root=await f.create(await f.event());await f.finish(root);const child=await f.create(),client=await pool.connect()
    try {await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await client.query('SELECT id FROM workflow_runs WHERE id=$1',[root]);await f.erase()
      await expect(client.query('INSERT INTO workflow_run_copy_sources(workspace_id,run_id,source_run_id) VALUES($1,$2,$3)',[f.workspaceId,child,root])).rejects.toMatchObject({code:'40001'})
    }finally{await client.query('ROLLBACK');client.release()}
  })
  it('refuses cross-workspace and cross-workflow copy sources',async()=>{
    const f=await fixture(),g=await fixture(),root=await f.create(await f.event()),foreign=await g.create()
    await expect(pool.query('INSERT INTO workflow_run_copy_sources(workspace_id,run_id,source_run_id) VALUES($1,$2,$3)',[f.workspaceId,root,foreign])).rejects.toMatchObject({code:'55P03'})
    const otherWorkflow=randomUUID();await pool.query("INSERT INTO workflows(id,workspace_id,created_by,name,definition) VALUES($1,$2,$3,'Other','{}')",[otherWorkflow,f.workspaceId,f.userId])
    const other=(await runs.createRun({workflowId:otherWorkflow,workspaceId:f.workspaceId,triggeredBy:f.userId,triggerKind:'manual'})).id
    expect(await runs.getLatestOutcomeForWorkflowSystem(otherWorkflow,root)).toBeNull()
    await expect(pool.query('INSERT INTO workflow_run_copy_sources(workspace_id,run_id,source_run_id) VALUES($1,$2,$3)',[f.workspaceId,other,root])).rejects.toMatchObject({code:'55P03'})
  })
  it('minimizes delayed audit writes and refuses new typed artifacts after erasure',async()=>{
    const f=await fixture(),root=await f.create(await f.event());await f.finish(root);await f.erase()
    await pool.query(`INSERT INTO workspace_audit_log(workspace_id,actor_user_id,event_type,subject_id,details)
      VALUES($1,$2,'workflow.run_completed',$3,$4)`,[f.workspaceId,f.userId,root,JSON.stringify({name:'subject@example.com'})])
    expect((await pool.query("SELECT actor_user_id,details FROM workspace_audit_log WHERE subject_id=$1 AND event_type='workflow.run_completed'",[root])).rows).toEqual([{actor_user_id:null,details:{erased:true}}])
    await expect(f.blueprint(root)).rejects.toMatchObject({code:'55000'})
    await expect(pool.query('INSERT INTO pending_approvals(workspace_id,workflow_run_id,approver_user_id) VALUES($1,$2,$3)',[f.workspaceId,root,f.userId])).rejects.toMatchObject({code:'55000'})
  })
  it('rolls back workflow retirement when the final canonical delete fails',async()=>{
    const f=await fixture(),root=await f.create(await f.event());await f.finish(root)
    const p=await f.preview();expect(p.blockers).toEqual([])
    await pool.query('CREATE TABLE fixture_workflow_purge_guard(contact_id uuid REFERENCES entities(id) ON DELETE RESTRICT)')
    try {await pool.query('INSERT INTO fixture_workflow_purge_guard VALUES($1)',[f.contactId])
      await expect(privacy.erase(f.context,{kind:'erase_contact_with_preview',contactId:f.contactId,previewId:p.id,previewHash:p.previewHash,confirmed:true})).rejects.toMatchObject({details:{reason:'privacy_review_failed'}})
      expect((await pool.query('SELECT privacy_erased,outcome FROM workflow_runs WHERE id=$1',[root])).rows[0]).toMatchObject({privacy_erased:false,outcome:{summary:'subject@example.com'}})
      expect((await pool.query('SELECT id FROM workflow_step_runs WHERE run_id=$1',[root])).rowCount).toBe(1)
    }finally{await pool.query('DROP TABLE fixture_workflow_purge_guard')}
  })
  it('terminates cyclic lineage closure and erases both local copies once',async()=>{
    const f=await fixture(),root=await f.create(await f.event());await f.finish(root);const child=await f.create();await f.finish(child)
    await pool.query(`INSERT INTO workflow_run_copy_sources(workspace_id,run_id,source_run_id) VALUES($1,$2,$3),($1,$3,$2)`,[f.workspaceId,root,child])
    expect(await rowsFor(f.context,f.contactId,'workflow_runs')).toHaveLength(2)
    await f.erase();expect((await pool.query('SELECT id FROM workflow_runs WHERE workspace_id=$1 AND privacy_erased',[f.workspaceId])).rowCount).toBe(2)
  })
  it('applies actual app-role isolation to the copy edge table',async()=>{
    const f=await fixture(),g=await fixture(),source=await f.create(await f.event()),child=await f.create()
    await f.finish(source);await runs.getLatestOutcomeForWorkflowSystem(f.workflowId,child)
    const foreignSource=await g.create(),foreignChild=await g.create(),client=await appPool.connect()
    try {await client.query('BEGIN');await client.query("SELECT set_config('app.current_user_id',$1,true)",[f.userId])
      expect((await client.query('SELECT run_id FROM workflow_run_copy_sources WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([{run_id:child}])
      expect((await client.query('SELECT run_id FROM workflow_run_copy_sources WHERE workspace_id=$1',[g.workspaceId])).rowCount).toBe(0)
      await expect(client.query('INSERT INTO workflow_run_copy_sources(workspace_id,run_id,source_run_id) VALUES($1,$2,$3)',[g.workspaceId,foreignChild,foreignSource])).rejects.toMatchObject({code:expect.stringMatching(/^(42501|55P03)$/)})
    }finally{await client.query('ROLLBACK');client.release()}
    expect((await pool.query('SELECT run_id FROM workflow_run_copy_sources WHERE workspace_id=$1',[g.workspaceId])).rowCount).toBe(0)
  })
  it('keeps old rows at lineage version zero while new inserts default to tracked reads',async()=>{
    const client=await pool.connect(),old=randomUUID(),fresh=randomUUID(),workspace=randomUUID(),workflow=randomUUID()
    try {await client.query('BEGIN')
      await client.query('CREATE TEMP TABLE workflow_runs(LIKE public.workflow_runs INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP')
      await client.query('ALTER TABLE workflow_runs DROP COLUMN privacy_lineage_version,DROP COLUMN privacy_erased CASCADE,DROP COLUMN privacy_erased_at CASCADE')
      await client.query("INSERT INTO workflow_runs(id,workspace_id,workflow_id,trigger_kind) VALUES($1,$2,$3,'manual')",[old,workspace,workflow])
      const migration=await readFile(new URL('../../../migrations/513_workflow_copy_lineage.sql',import.meta.url),'utf8')
      await client.query(migration.slice(migration.indexOf('BEGIN;')+6,migration.indexOf('CREATE TABLE workflow_run_copy_sources')))
      await client.query("INSERT INTO workflow_runs(id,workspace_id,workflow_id,trigger_kind) VALUES($1,$2,$3,'manual')",[fresh,workspace,workflow])
      expect((await client.query('SELECT privacy_lineage_version FROM workflow_runs WHERE id=$1',[old])).rows[0].privacy_lineage_version).toBe(0)
      expect((await client.query('SELECT privacy_lineage_version FROM workflow_runs WHERE id=$1',[fresh])).rows[0].privacy_lineage_version).toBe(1)
    }finally{await client.query('ROLLBACK');client.release()}
  })

  it('invalidates a ready preview when a new outcome consumer appears',async()=>{
    const f=await fixture(),root=await f.create(await f.event());await f.finish(root);const child=await f.create(),p=await f.preview()
    expect(p.blockers).toEqual([])
    await runs.getLatestOutcomeForWorkflowSystem(f.workflowId,child)
    await expect(privacy.erase(f.context,{kind:'erase_contact_with_preview',contactId:f.contactId,previewId:p.id,previewHash:p.previewHash,confirmed:true})).rejects.toMatchObject({details:{reason:'privacy_preview_stale'}})
    expect((await pool.query('SELECT privacy_erased FROM workflow_runs WHERE id=$1',[root])).rows[0].privacy_erased).toBe(false)
  })
  it('keeps every resumed outcome source and blocks a consumer with another subject',async()=>{
    const f=await fixture(),root=await f.create(await f.event());await f.finish(root);const child=await f.create()
    await runs.getLatestOutcomeForWorkflowSystem(f.workflowId,child)
    const otherContact=randomUUID(),otherEvent=await f.event(otherContact)
    const other=(await runs.createRun({workflowId:f.workflowId,workspaceId:f.workspaceId,triggeredBy:f.userId,triggerKind:'event',input:{trigger:{sourceType:'crm'},event:{domainEventId:otherEvent,subjectKind:'contact',subjectId:otherContact,contactId:otherContact}}})).id
    await f.finish(other,'other@example.com')
    expect(await runs.getLatestOutcomeForWorkflowSystem(f.workflowId,child)).toMatchObject({summary:'other@example.com'})
    expect((await pool.query('SELECT source_run_id FROM workflow_run_copy_sources WHERE run_id=$1',[child])).rows.map(r=>r.source_run_id).sort()).toEqual([root,other].sort())
    expect((await f.preview()).blockers).toContainEqual({domain:'workflow_runs',reason:'shared_workflow_copy_dependency',count:1})
    expect((await rowsFor(f.context,f.contactId,'workflow_run_copy_sources')).some(r=>r.source_run_id===null)).toBe(true)
    expect((await rowsFor(f.context,f.contactId,'workflow_runs')).some(r=>r.id===other)).toBe(false)
  })

  it('refuses typed artifact references into another workspace',async()=>{
    const f=await fixture(),g=await fixture(),foreign=await g.create(),client=await appPool.connect()
    await expect(pool.query('INSERT INTO pending_approvals(workspace_id,workflow_run_id,approver_user_id) VALUES($1,$2,$3)',[f.workspaceId,foreign,f.userId])).rejects.toMatchObject({code:'23514'})
    try {await client.query('BEGIN');await client.query("SELECT set_config('app.current_user_id',$1,true)",[f.userId])
      await expect(client.query('INSERT INTO pending_approvals(workspace_id,workflow_run_id,approver_user_id) VALUES($1,$2,$3)',[f.workspaceId,foreign,f.userId])).rejects.toMatchObject({code:expect.stringMatching(/^(42501|55P03)$/)})
    }finally{await client.query('ROLLBACK');client.release()}
    expect((await pool.query('SELECT id FROM pending_approvals WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
  })

  it('keeps client-authored replay keys as review dependencies',async()=>{
    const f=await fixture(),event=await f.event()
    const created=await runs.createWebhookRun!({workflowId:f.workflowId,workspaceId:f.workspaceId,triggeredBy:f.userId,triggerKind:'event',input:{trigger:{sourceType:'crm'},event:{domainEventId:event}},idempotencyKey:'private-subject-fixture',bodySha256:'a'.repeat(64)})
    expect(created.kind).toBe('created')
    expect((await f.preview()).blockers).toContainEqual({domain:'workflow_runs',reason:'workflow_replay_dependency',count:1})
  })

})
