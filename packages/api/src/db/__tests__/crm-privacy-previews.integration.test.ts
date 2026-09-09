import {randomUUID} from 'node:crypto'
import express from 'express'
import request from 'supertest'
import {afterAll,describe,expect,it} from 'vitest'
import {CrmOperationsCommandSchema,type CrmOperationsContext,type CrmErasurePreview} from '@use-brian/core'
import {getPool,getAppPool} from '../client.js'
import {createCrmOperationsService} from '../../crm-operations/service.js'
import {createDbCrmOperationsStore} from '../crm-operations-store.js'
import {createCrmPrivacyService} from '../../crm-operations/privacy-previews.js'
import {createWorkspaceStore} from '../workspace-store.js'
import {createDbCrmIntakeReadStore} from '../crm-intake-store.js'
import {crmOperationsRoutes} from '../../routes/crm-operations.js'
import {streamCrmPrivacyExport} from '../../crm-operations/privacy-export.js'
import {exportCrmOperationsPrivacy} from '../../crm-operations/privacy.js'
import {flushWorkspaceData} from '../workspace-flush.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),appPool=getAppPool(),service=createCrmOperationsService(createDbCrmOperationsStore()),privacy=createCrmPrivacyService()
async function fixture() {
  const workspaceId=randomUUID(),userId=randomUUID(),contactId=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Erasure preview fixture',$2)",[workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,userId])
  await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,created_by_user_id,source) VALUES($1,$2,'person','Private fixture name','private@example.com',$3,'manual')",[contactId,workspaceId,userId])
  const context:CrmOperationsContext={workspaceId,actor:{kind:'user',userId},authority:{role:'owner',canConfigure:true,canWrite:true,trustedIdentitySources:[]}}
  const preview=()=>privacy.preview(context,{kind:'preview_contact_erasure',contactId})
  const erase=(p:CrmErasurePreview)=>privacy.erase(context,{kind:'erase_contact_with_preview',contactId,previewId:p.id,previewHash:p.previewHash,confirmed:true})
  return {workspaceId,userId,contactId,context,preview,erase}
}
describe('[COMP:crm/privacy-previews] Review-bound canonical erasure',()=>{
  afterAll(async()=>{await pool.end();await appPool.end()})
  it('previews stable counts without retaining personal payload, then atomically consumes one purge and replays its receipt',async()=>{
    const f=await fixture()
    await pool.query("INSERT INTO crm_activities(workspace_id,entity_id,activity_type,summary) SELECT $1,$2,'note','Private note '||n FROM generate_series(1,110) n",[f.workspaceId,f.contactId])
    const first=await f.preview(),second=await f.preview()
    expect(first.status).toBe('ready')
    expect(first.domains.find(d=>d.domain==='crm_activities')).toMatchObject({action:'delete',count:110})
    expect((await pool.query('SELECT id FROM entities WHERE id=$1',[f.contactId])).rowCount).toBe(1)
    const stored=JSON.stringify((await pool.query('SELECT * FROM crm_privacy_previews WHERE id=$1',[first.id])).rows[0])
    expect(stored).not.toContain('Private fixture name');expect(stored).not.toContain('private@example.com');expect(stored).not.toContain('Private note')
    const result=await f.erase(first)
    expect(result).toMatchObject({duplicate:false,receipt:{previewId:first.id,status:'crm_contact_purged'}})
    expect((await f.erase(first))).toEqual({...result,duplicate:true})
    expect((await pool.query('SELECT id FROM entities WHERE id=$1',[f.contactId])).rowCount).toBe(0)
    expect((await pool.query('SELECT id FROM crm_activities WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
    const row=(await pool.query('SELECT subject_id,status,receipt FROM crm_privacy_previews WHERE id=$1',[first.id])).rows[0]
    expect(row).toMatchObject({subject_id:null,status:'consumed',receipt:result.receipt})
    expect((await pool.query('SELECT id FROM crm_privacy_previews WHERE id=$1',[second.id])).rowCount).toBe(0)
    expect((await pool.query("SELECT id FROM correction_audit WHERE workspace_id=$1 AND action='purge'",[f.workspaceId])).rowCount).toBe(1)
  })
  it.each(['update','insert','policy'] as const)('rejects a %s after review with no purge or consumption',async change=>{
    const f=await fixture(),preview=await f.preview()
    if(change==='update')await pool.query("UPDATE entities SET display_name='Changed after review' WHERE id=$1",[f.contactId])
    if(change==='insert')await pool.query("INSERT INTO crm_activities(workspace_id,entity_id,activity_type) VALUES($1,$2,'note')",[f.workspaceId,f.contactId])
    if(change==='policy')await service.execute(f.context,CrmOperationsCommandSchema.parse({kind:'save_privacy_policy',expectedVersion:0,confirmed:true,intakeReplay:{retentionSeconds:3600}}))
    await expect(f.erase(preview)).rejects.toMatchObject({code:'conflict',details:{reason:'privacy_preview_stale'}})
    expect((await pool.query('SELECT status FROM crm_privacy_previews WHERE id=$1',[preview.id])).rows[0].status).toBe('ready')
    expect((await pool.query('SELECT id FROM entities WHERE id=$1',[f.contactId])).rowCount).toBe(1)
  })
  it('reports unresolved drafts as blockers, refuses execution, and requires a fresh review after resolution',async()=>{
    const f=await fixture()
    const draft=(await pool.query("INSERT INTO crm_email_drafts(workspace_id,to_addresses,body) VALUES($1,ARRAY['private@example.com'],'Copied private content') RETURNING id",[f.workspaceId])).rows[0].id
    const preview=await f.preview()
    expect(preview).toMatchObject({status:'blocked',blockers:expect.arrayContaining([{domain:'crm_email_drafts',reason:'crm_copy_resolution_required',count:1}])})
    await expect(f.erase(preview)).rejects.toMatchObject({details:{reason:'privacy_preview_blocked'}})
    await pool.query('DELETE FROM crm_email_drafts WHERE id=$1',[draft])
    await expect(f.erase(preview)).rejects.toMatchObject({details:{reason:'privacy_preview_blocked'}})
    await f.erase(await f.preview())
  })
  it('binds a preview to its creating current owner, workspace, subject and hash',async()=>{
    const f=await fixture(),other=await fixture(),preview=await f.preview()
    await expect(other.erase(preview)).rejects.toMatchObject({code:'not_found'})
    await expect(f.erase({...preview,previewHash:'f'.repeat(64)})).rejects.toMatchObject({details:{reason:'privacy_preview_mismatch'}})
    await expect(privacy.erase(f.context,{kind:'erase_contact_with_preview',contactId:other.contactId,previewId:preview.id,previewHash:preview.previewHash,confirmed:true})).rejects.toMatchObject({details:{reason:'privacy_preview_mismatch'}})
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'admin')",[f.workspaceId,other.userId])
    const admin={...f.context,actor:{kind:'user' as const,userId:other.userId}}
    await expect(privacy.erase(admin,{kind:'erase_contact_with_preview',contactId:f.contactId,previewId:preview.id,previewHash:preview.previewHash,confirmed:true})).rejects.toMatchObject({code:'not_found'})
    await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId])
    await expect(f.erase(preview)).rejects.toMatchObject({code:'not_authorized'})
    await expect(f.preview()).rejects.toMatchObject({code:'not_authorized'})
  })
  it('rejects expired receipts before mutation and preserves the live record',async()=>{
    const f=await fixture(),preview=await f.preview(),expired=randomUUID()
    await pool.query(`INSERT INTO crm_privacy_previews(id,workspace_id,owner_user_id,subject_id,request_hash,snapshot_hash,preview_hash,policy_version,domain_summary,blockers,status,created_at,expires_at)
      SELECT $1,workspace_id,owner_user_id,subject_id,request_hash,snapshot_hash,preview_hash,policy_version,domain_summary,blockers,status,clock_timestamp()-interval '20 minutes',clock_timestamp()-interval '5 minutes'
      FROM crm_privacy_previews WHERE id=$2`,[expired,preview.id])
    await expect(f.erase({...preview,id:expired})).rejects.toMatchObject({details:{reason:'privacy_preview_expired'}})
    expect((await pool.query('SELECT id FROM entities WHERE id=$1',[f.contactId])).rowCount).toBe(1)
  })
  it('serializes concurrent exact execution and never creates duplicate purge evidence',async()=>{
    const f=await fixture(),preview=await f.preview()
    const results=await Promise.all([f.erase(preview),f.erase(preview)])
    expect(results.map(r=>r.duplicate).sort()).toEqual([false,true])
    expect(results[0].receipt).toEqual(results[1].receipt)
    expect((await pool.query("SELECT id FROM correction_audit WHERE workspace_id=$1 AND action='purge'",[f.workspaceId])).rowCount).toBe(1)
  })
  it('rolls back receipt consumption if the canonical purge is refused by a downstream dependency',async()=>{
    const f=await fixture(),preview=await f.preview()
    // A real FK outside the CRM slice proves that the receipt cannot commit
    // early. This fixture table is local to this isolated database.
    await pool.query('CREATE TABLE privacy_fixture_dependency(subject_id uuid REFERENCES entities(id) ON DELETE RESTRICT)')
    try {
      await pool.query('INSERT INTO privacy_fixture_dependency VALUES($1)',[f.contactId])
      await expect(f.erase(preview)).rejects.toMatchObject({code:'conflict',details:{reason:'privacy_review_failed'}})
      expect((await pool.query('SELECT status,subject_id FROM crm_privacy_previews WHERE id=$1',[preview.id])).rows[0]).toMatchObject({status:'ready',subject_id:f.contactId})
      expect((await pool.query("SELECT id FROM correction_audit WHERE workspace_id=$1 AND action='purge'",[f.workspaceId])).rowCount).toBe(0)
    }finally{await pool.query('DROP TABLE privacy_fixture_dependency')}
  })
  it('rejects non-member principals and client-selected authority through the actual routes',async()=>{
    const f=await fixture(),app=express()
    app.use(express.json());app.use((req,_res,next)=>{req.userId=f.userId;next()})
    app.use('/api/crm',crmOperationsRoutes({service,workspaceStore:createWorkspaceStore(),readStore:createDbCrmIntakeReadStore()}))
    const base='/api/crm/'+f.workspaceId+'/operations/privacy'
    expect((await request(app).post(base+'/erasure-preview').send({contactId:f.contactId,actor:{kind:'user',userId:f.userId}})).status).toBe(400)
    const preview=await request(app).post(base+'/erasure-preview').send({contactId:f.contactId})
    expect(preview.status).toBe(200);expect(preview.headers['cache-control']).toBe('no-store')
    const body={contactId:f.contactId,previewId:preview.body.id,previewHash:preview.body.previewHash}
    expect((await request(app).post(base+'/erase').send(body)).status).toBe(400)
    expect((await request(app).post(base+'/erase').send({...body,confirmed:true})).status).toBe(200)
    const integration:CrmOperationsContext={...f.context,actor:{kind:'integration_key',credentialId:randomUUID()}}
    await expect(privacy.preview(integration,{kind:'preview_contact_erasure',contactId:f.contactId})).rejects.toMatchObject({code:'not_authorized'})
  })
  it('exports only safe preview metadata and deletes reviews on workspace data reset',async()=>{
    const f=await fixture(),preview=await f.preview(),legacy=await exportCrmOperationsPrivacy(f.workspaceId)
    expect(legacy.tables.crm_privacy_previews).toMatchObject([{id:preview.id}])
    expect(legacy.tables.crm_privacy_previews[0]).not.toHaveProperty('preview_hash')
    const lines:string[]=[];for await(const line of streamCrmPrivacyExport(f.context))lines.push(line)
    const row=lines.map(l=>JSON.parse(l)).find(r=>r.type==='record'&&r.domain==='crm_privacy_previews')!.record
    expect(row).not.toHaveProperty('preview_hash');expect(row).not.toHaveProperty('snapshot_hash');expect(row).not.toHaveProperty('request_hash')
    expect(lines.join('')).not.toContain(preview.previewHash)
    const app=await appPool.connect()
    try {
      await app.query('BEGIN');await app.query("SELECT set_config('app.current_user_id',$1,true)",[f.userId])
      expect((await app.query('SELECT id FROM crm_privacy_previews')).rows.map(r=>r.id)).toEqual([preview.id])
      await app.query('ROLLBACK')
    }finally{await app.query('ROLLBACK');app.release()}
    await flushWorkspaceData(f.userId,f.workspaceId)
    expect((await pool.query('SELECT id FROM crm_privacy_previews WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
  })
  it('blocks a legacy Brain history copy and exports it only through the explicit current-parent workspace join',async()=>{
    const f=await fixture()
    await pool.query("INSERT INTO brain_row_versions(primitive,row_id,version_no,before_image,valid_from,valid_to,mutation_actor) VALUES('entity',$1,1,$2,now()-interval '1 minute',now(),'human_edit')",[f.contactId,JSON.stringify({kind:'person',display_name:'Historical private person'})])
    const preview=await f.preview()
    expect(preview.blockers).toContainEqual({domain:'brain_row_versions',reason:'crm_copy_resolution_required',count:1})
    await expect(f.erase(preview)).rejects.toMatchObject({details:{reason:'privacy_preview_blocked'}})
    const lines:string[]=[]
    for await(const line of streamCrmPrivacyExport(f.context,{contactId:f.contactId}))lines.push(line)
    expect(lines.join('')).toContain('Historical private person')
  })

})
