import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getPool } from '../client.js'
import { createMemory } from '../memories.js'
import { flushWorkspaceData, WorkspaceFlushNotOwnerError } from '../workspace-flush.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
process.env.CRM_SUPPRESSION_HMAC_KEYRING = JSON.stringify({ activeVersion: 'fixture',keys: { fixture: Buffer.alloc(32,7).toString('base64') } })
const pool = getPool()
const overlayNames = ['pending_classifications', 'brain_candidates', 'connector_actions', 'external_entities', 'distribution_events']
const installed = (await pool.query<{ name: string }>(
  `SELECT name FROM unnest($1::text[]) name WHERE to_regclass(format('public.%I',name)) IS NOT NULL`,
  [overlayNames],
)).rows.map((row) => row.name)

async function seed() {
  const userId = randomUUID(), workspaceId = randomUUID(), assistantId = randomUUID()
  const contactId = randomUUID(), episodeId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query(`INSERT INTO workspaces(id,name,owner_user_id,is_personal) VALUES($1,'Flush fixture',$2,true)`, [workspaceId,userId])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [workspaceId,userId])
  await pool.query(`INSERT INTO assistants(id,name,workspace_id,kind,owner_user_id) VALUES($1,'Fixture assistant',$2,'primary',$3)`, [assistantId,workspaceId,userId])
  await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,created_by_user_id,source) VALUES($1,$2,'person','Fixture person','flush@example.com',$3,'manual')`, [contactId,workspaceId,userId])
  await pool.query(`INSERT INTO episodes(id,workspace_id,source_kind,source_ref,occurred_at,created_by_user_id,user_id)
    VALUES($1,$2,'chat','{}',now(),$3,$3)`, [episodeId,workspaceId,userId])
  const { id: memoryId } = await createMemory({ workspaceId,userId,assistantId,summary: 'Fixture memory',
    createdByUserId: userId,createdByAssistantId: assistantId,sensitivity: 'internal',source: 'user' })
  await pool.query(`INSERT INTO tasks(workspace_id,title,status,created_by_user_id) VALUES($1,'Fixture task','todo',$2)`, [workspaceId,userId])
  await pool.query(`INSERT INTO sessions(user_id,assistant_id,channel_type,channel_id) VALUES($1,$2,'web','fixture')`, [userId,assistantId])
  await pool.query(`INSERT INTO scheduled_jobs(assistant_id,user_id,schedule,timezone,instructions,channel_type,channel_id,next_run_at)
    VALUES($1,$2,'{"type":"daily"}','UTC','Fixture job','cron','cron',now()+interval '1 day')`, [assistantId,userId])
  await pool.query(`INSERT INTO crm_privacy_policies(workspace_id,version,policy,approved_by_user_id)
    VALUES($1,1,'{"intakeReplay":null,"addressSuppression":{"retentionSeconds":3600}}',$2)`, [workspaceId,userId])
  await pool.query(`INSERT INTO crm_suppression_events(workspace_id,contact_id,channel,action,reason_code,source,actor_kind)
    VALUES($1,$2,'email','suppressed','manual_do_not_contact','fixture','user')`, [workspaceId,contactId])
  if (installed.includes('pending_classifications')) await pool.query(
    `INSERT INTO pending_classifications(workspace_id,primitive_kind,target_id,current_value,suggested_value,rule_id,confidence,detected_by_boundary)
     VALUES($1,'entity',$2,'internal','confidential','fixture',0.9,'tool')`, [workspaceId,contactId])
  if (installed.includes('brain_candidates')) await pool.query(
    `INSERT INTO brain_candidates(workspace_id,memory_id,suggested_action,created_by_user_id) VALUES($1,$2,'drop',$3)`, [workspaceId,memoryId,userId])
  if (installed.includes('connector_actions')) await pool.query(
    `INSERT INTO connector_actions(workspace_id,episode_id,connector_id,action_kind,payload,initiated_by_user_id,
      initiated_by_assistant_id,retrieval_sensitivity_max,audience_clearance,response_ceiling,status)
     VALUES($1,$2,'gmail','send','{}',$3,$4,'internal','internal','internal','executed')`, [workspaceId,episodeId,userId,assistantId])
  if (installed.includes('external_entities')) await pool.query(
    `INSERT INTO external_entities(assistant_id,platform,platform_user_id) VALUES($1,'fixture','synthetic')`, [assistantId])
  if (installed.includes('distribution_events')) await pool.query(
    `INSERT INTO distribution_events(assistant_id,platform,event_type) VALUES($1,'fixture','synthetic')`, [assistantId])
  return { userId,workspaceId,assistantId }
}
type Fixture = Awaited<ReturnType<typeof seed>>
async function state(f: Fixture) {
  const tables = ['entities','episodes','memories','tasks','crm_suppression_events','crm_privacy_policies','workspace_modules',
    ...installed.filter((name) => !['external_entities','distribution_events'].includes(name))]
  const result: Record<string, unknown[]> = {}
  for (const table of tables) result[table] = (await pool.query(`SELECT * FROM ${table} t WHERE workspace_id=$1 ORDER BY to_jsonb(t)::text`, [f.workspaceId])).rows
  for (const table of ['sessions','scheduled_jobs',...installed.filter((name) => ['external_entities','distribution_events'].includes(name))]) {
    result[table] = (await pool.query(`SELECT * FROM ${table} WHERE assistant_id=$1 ORDER BY id`, [f.assistantId])).rows
  }
  return result
}

describe('[COMP:api/workspace-flush] Actual OSS and hosted flush boundaries', () => {
  afterAll(async () => pool.end())
  it('flushes installed content, skips only absent overlay tables and preserves the shell and another workspace', async () => {
    const f = await seed(), other = await seed(), otherBefore = await state(other), before = await state(f)
    const result = await flushWorkspaceData(f.userId,f.workspaceId)
    const after = await state(f)
    for (const [table,rows] of Object.entries(after)) {
      expect(rows,table).toEqual(['crm_privacy_policies','workspace_modules'].includes(table) ? before[table] : [])
    }
    expect(await state(other)).toEqual(otherBefore)
    expect(result.deleted).toMatchObject({ tasks: 1,entities: 1,episodes: 1,memories: 1,sessions: 1,scheduled_jobs: 1 })
    for (const name of overlayNames) expect(result.deleted[name],name).toBe(installed.includes(name) ? 1 : 0)
    for (const [table,column,value] of [['workspaces','id',f.workspaceId],['assistants','id',f.assistantId],['workspace_members','workspace_id',f.workspaceId]]) {
      expect((await pool.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`,[value])).rowCount).toBe(1)
    }
    expect((await flushWorkspaceData(f.userId,f.workspaceId)).total).toBe(0)
  })
  it('rechecks current ownership and leaves every seeded content row intact on refusal', async () => {
    const f = await seed(), other = await seed(), before = await state(f)
    await expect(flushWorkspaceData(other.userId,f.workspaceId)).rejects.toBeInstanceOf(WorkspaceFlushNotOwnerError)
    await pool.query(`UPDATE workspaces SET owner_user_id=$2,is_personal=false WHERE id=$1`,[f.workspaceId,other.userId])
    await expect(flushWorkspaceData(f.userId,f.workspaceId)).rejects.toBeInstanceOf(WorkspaceFlushNotOwnerError)
    expect(await state(f)).toEqual(before)
  })
  it('rolls back prior deletions if a required OSS table is unavailable', async () => {
    const f = await seed(), before = await state(f)
    // This guarded test mutates only its disposable cluster's schema. Run
    // combined fixture files with --maxWorkers=1 to isolate the temporary rename.
    // A required missing relation must never become a skipped delete.
    await pool.query('ALTER TABLE tasks RENAME TO fixture_unavailable_tasks')
    try {
      await expect(flushWorkspaceData(f.userId,f.workspaceId)).rejects.toMatchObject({ code: '42P01' })
    } finally { await pool.query('ALTER TABLE fixture_unavailable_tasks RENAME TO tasks') }
    expect(await state(f)).toEqual(before)
  })
})
