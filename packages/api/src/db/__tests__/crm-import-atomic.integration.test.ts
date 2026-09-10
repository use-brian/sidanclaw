import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import pg from 'pg'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { CrmOperationsCommandSchema, type CrmOperationsCommand, type CrmOperationsContext, type FilesApi, type EntityLinksStore } from '@use-brian/core'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createCrmProductionImportService, type CrmImportEntityKind } from '../../crm-operations/import-service.js'
import { getPool } from '../client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, application_name: 'crm_atomic_import_fixture' })
const files = new Map<string, Buffer>()
const filesApi = { readBytes: async (_ctx: unknown, id: string) => ({ ok: true, value: { file: { id }, bytes: files.get(id)! } }) } as unknown as FilesApi
const operations = createCrmOperationsService(createDbCrmOperationsStore(pool))
type Hook = (client: pg.PoolClient, command: CrmOperationsCommand) => Promise<void>
function importer(hook?: Hook, entityLinks?: EntityLinksStore) {
  return createCrmProductionImportService({ pool, filesApi, entityLinks, operationsForTransaction: (client) => ({
    execute: async (context, command) => {
      const result = await createCrmOperationsService(createDbCrmOperationsStore(pool, client)).execute(context, command)
      await hook?.(client, command)
      return result
    },
  }) })
}
async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID()
  await pool.query('INSERT INTO users (id,auth_provider_id) VALUES ($1::uuid,$1::text)', [userId])
  await pool.query(`INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'Atomic import fixture',$2)`, [workspaceId, userId])
  await pool.query(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner')`, [workspaceId, userId])
  const context: CrmOperationsContext = { workspaceId, actor: { kind: 'user', userId }, authority: { role: 'owner', canWrite: true, canConfigure: true, trustedIdentitySources: [] } }
  await operations.execute(context, CrmOperationsCommandSchema.parse({ kind: 'save_consent_purpose', purposeKey: 'updates', label: 'Fixture updates', wording: 'Fixture wording', wordingVersion: '1' }))
  async function entity(kind: string, name: string, attributes = {}) {
    const id = randomUUID()
    await pool.query(`INSERT INTO entities (id,workspace_id,kind,display_name,attributes,created_by_user_id,source)
      VALUES ($1,$2,$3,$4,$5,$6,'manual')`, [id, workspaceId, kind, name, attributes, userId])
    return id
  }
  async function job(columns: string[], rows: string[][], kind: CrmImportEntityKind = 'contact', trustedIdentitySource?: string) {
    const id = randomUUID(), bytes = Buffer.from([columns.join(','), ...rows.map((row) => row.join(',')), ''].join('\n'))
    files.set(id, bytes)
    await pool.query(`INSERT INTO workspace_files (id,workspace_id,path,name,storage_uri,created_by_user_id)
      VALUES ($1,$2,$3,'fixture.csv','fixture://local',$4)`, [id, workspaceId, `/fixture/${id}.csv`, userId])
    const input = { stagedFileId: id, entityKind: kind,
      mapping: { columns: Object.fromEntries(columns.map((column, index) => [index, column])), ...(trustedIdentitySource ? { trustedIdentitySource } : {}) } }
    const service = importer(), checked = await service.dryRun(context, input)
    expect(checked.failedRows).toBe(0)
    return service.confirm(context, { ...input, confirmed: true, dryRunHash: checked.dryRunHash })
  }
  async function counts() {
    return (await pool.query(`SELECT
      (SELECT count(*) FROM entities WHERE workspace_id=$1)::int AS entities,
      (SELECT count(*) FROM crm_identity_bindings WHERE workspace_id=$1)::int AS bindings,
      (SELECT count(*) FROM association_consent_events WHERE workspace_id=$1)::int AS consent,
      (SELECT count(*) FROM crm_import_rows WHERE workspace_id=$1)::int AS receipts,
      (SELECT count(*) FROM crm_import_chunks WHERE workspace_id=$1)::int AS chunks,
      (SELECT count(*) FROM crm_import_errors WHERE workspace_id=$1)::int AS errors,
      (SELECT count(*) FROM association_audit_log WHERE workspace_id=$1)::int AS audit,
      (SELECT count(*) FROM crm_domain_event_outbox WHERE workspace_id=$1)::int AS outbox`, [workspaceId])).rows[0]
  }
  return { workspaceId, userId, context, entity, job, counts }
}
const consentColumns = ['name', 'email', 'consentPurposeKey', 'consentAction', 'consentSource']
const row = (index: number) => [`Fixture ${index}`, `fixture${index}@example.com`, 'updates', 'granted', 'fixture_import']

describe('[COMP:crm/production-import] Atomic rows and serialized chunk recovery', () => {
  afterAll(async () => { await Promise.all([pool.end(), getPool().end()]) })
  it('rolls back a failed row including custom fields, stable bindings and evidence, and emits only committed graph projections', async () => {
    const f = await fixture(), companyId = await f.entity('company', 'Fixture company')
    await pool.query(`INSERT INTO crm_field_definitions (workspace_id,entity_kind,field_key,label,field_type)
      VALUES ($1,'person','score','Score','number')`, [f.workspaceId])
    const columns = [...consentColumns, 'custom:score', 'companyId', 'identityProvider', 'identityProviderInstance', 'identitySubject']
    const job = await f.job(columns, [0, 1].map((i) => [...row(i), '7', companyId, 'fixture', 'fixture_instance', `subject_${i}`]), 'contact', 'fixture')
    const create = vi.fn(async () => ({ id: randomUUID() }))
    const links = { create } as unknown as EntityLinksStore
    const service = importer(async (_client, command) => {
      expect(create).not.toHaveBeenCalled()
      if (command.kind === 'record_consent' && command.metadata.importRow === 2) throw new Error('Fixture rejection after evidence write')
    }, links)
    expect(await service.resume(f.context, job.id)).toMatchObject({ status: 'completed', processedRows: 2, succeededRows: 1, failedRows: 1 })
    expect(await f.counts()).toMatchObject({ entities: 2, bindings: 1, consent: 1, receipts: 2, errors: 1, audit: 2, outbox: 1 })
    const person = (await pool.query(`SELECT id,attributes FROM entities WHERE workspace_id=$1 AND kind='person'`, [f.workspaceId])).rows[0]
    expect(person.attributes).toMatchObject({ email: 'fixture1@example.com', custom_fields: { score: 7 }, company_id: companyId })
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ sourceId: person.id, targetId: companyId }))
    const before = await f.counts()
    await service.resume(f.context, job.id)
    expect(await f.counts()).toEqual(before)
    // Emulate the legacy committed chunk whose separate job checkpoint never ran.
    await pool.query(`UPDATE crm_import_jobs SET status='running',processed_rows=0,succeeded_rows=0,failed_rows=0,next_chunk_index=0,completed_at=NULL WHERE id=$1`, [job.id])
    expect(await importer().resume(f.context, job.id)).toMatchObject({ status: 'completed', processedRows: 2, succeededRows: 1, failedRows: 1, nextChunkIndex: 1 })
    expect(await f.counts()).toEqual(before)
    const boundAgain = await f.job(columns, [[...row(1), '8', companyId, 'fixture', 'fixture_instance', 'subject_1']], 'contact', 'fixture')
    expect(await importer().resume(f.context, boundAgain.id)).toMatchObject({ status: 'completed', succeededRows: 1, failedRows: 0 })
    expect(await f.counts()).toMatchObject({ entities: 2, bindings: 1, consent: 2 })
    expect((await pool.query('SELECT attributes FROM entities WHERE id=$1', [person.id])).rows[0].attributes.custom_fields).toEqual({ score: 8 })
  })

  it('survives connection termination after the canonical command and before the row receipt with immediate clean resume', async () => {
    const f = await fixture(), job = await f.job(consentColumns, [row(0)])
    const before = await f.counts()
    await expect(importer(async (client) => {
      client.once('error', () => undefined)
      await client.query('SELECT pg_terminate_backend(pg_backend_pid())')
    }).resume(f.context, job.id)).rejects.toBeDefined()
    expect(await f.counts()).toEqual(before)
    expect(await importer().resume(f.context, job.id)).toMatchObject({ status: 'completed', succeededRows: 1, failedRows: 0 })
    expect(await f.counts()).toMatchObject({ entities: 1, consent: 1, receipts: 1, chunks: 1, errors: 0, outbox: 1 })
  })

  it('finishes file I/O before borrowing the only transaction connection', async () => {
    const f = await fixture(), job = await f.job(consentColumns, [row(0)])
    const single = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 1000 })
    const boundedFiles = { readBytes: async (ctx: unknown, id: string) => {
      await single.query('SELECT 1')
      return filesApi.readBytes(ctx as Parameters<FilesApi['readBytes']>[0], id)
    } } as unknown as FilesApi
    try {
      const service = createCrmProductionImportService({ pool: single, filesApi: boundedFiles,
        operationsForTransaction: (client) => createCrmOperationsService(createDbCrmOperationsStore(single, client)) })
      expect(await service.resume(f.context, job.id)).toMatchObject({ status: 'completed', succeededRows: 1 })
    } finally { await single.end() }
  })

  it('serializes concurrent resume and cancellation across a 50-row boundary', async () => {
    const f = await fixture(), job = await f.job(consentColumns, Array.from({ length: 51 }, (_, i) => row(i)))
    let enter!: () => void, release!: () => void
    const ready = new Promise<void>((resolve) => { enter = resolve }), gate = new Promise<void>((resolve) => { release = resolve })
    let held = false
    const first = importer(async () => { if (!held) { held = true; enter(); await gate } }).resume(f.context, job.id)
    let cancellation: ReturnType<ReturnType<typeof importer>['cancel']> | undefined
    try {
      await Promise.race([ready, first.then(() => { throw new Error('Import ended before barrier') })])
      expect(await f.counts()).toMatchObject({ entities: 0, consent: 0, receipts: 0, chunks: 0 })
      await expect(importer().resume(f.context, job.id)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'import_processing' } })
      const other = await fixture(), otherJob = await other.job(consentColumns, [row(0)])
      expect(await importer().resume(other.context, otherJob.id)).toMatchObject({ status: 'completed', succeededRows: 1 })
      cancellation = importer().cancel(f.context, job.id)
      let locked = false
      const until = Date.now() + 5000
      while (Date.now() < until) {
        const r = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE application_name='crm_atomic_import_fixture'
          AND wait_event_type='Lock' AND query LIKE '%UPDATE crm_import_jobs SET status=%'`)
        if (r.rowCount) { locked = true; break }
        await setTimeout(10)
      }
      expect(locked).toBe(true)
    } finally { release(); await Promise.allSettled([first, ...(cancellation ? [cancellation] : [])]) }
    expect(await first).toMatchObject({ status: 'paused', processedRows: 50, succeededRows: 50 })
    expect(await cancellation).toMatchObject({ status: 'cancelled', processedRows: 50 })
    expect(await importer().resume(f.context, job.id)).toMatchObject({ status: 'cancelled', processedRows: 50 })
    expect(await f.counts()).toMatchObject({ entities: 50, consent: 50, receipts: 50, chunks: 1, outbox: 50 })
  })

  it('rolls back committed row savepoints if the chunk checkpoint fails, then retries without double counters', async () => {
    const f = await fixture(), job = await f.job(consentColumns, [row(0), row(1)])
    const trigger = `crm_import_fixture_${randomUUID().replaceAll('-', '')}`
    await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.workspace_id='${f.workspaceId}'::uuid AND NEW.status='completed' THEN
        RAISE EXCEPTION 'Fixture checkpoint serialization failure' USING ERRCODE='40001';
      END IF; RETURN NEW; END $$`)
    await pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON crm_import_chunks FOR EACH ROW EXECUTE FUNCTION ${trigger}()`)
    const before = await f.counts()
    try {
      await expect(importer().resume(f.context, job.id)).rejects.toMatchObject({ code: '40001' })
      expect(await f.counts()).toEqual(before)
    } finally {
      await pool.query(`DROP TRIGGER ${trigger} ON crm_import_chunks`)
      await pool.query(`DROP FUNCTION ${trigger}()`)
    }
    const service = importer()
    expect(await service.resume(f.context, job.id)).toMatchObject({ status: 'completed', processedRows: 2, succeededRows: 2, failedRows: 0 })
    const committed = await f.counts()
    expect(committed).toMatchObject({ entities: 2, consent: 2, receipts: 2, chunks: 1, outbox: 2 })
    await service.resume(f.context, job.id)
    expect(await f.counts()).toEqual(committed)
  })

  it.each(['company', 'deal'] as const)('rolls back %s record changes when a later command rejects the row', async (kind) => {
    const f = await fixture(), company = await f.entity('company', 'Fixture company', { domain: 'original.example', tags: ['original'] })
    const person = await f.entity('person', 'Fixture person', { email: 'fixture@example.com' })
    await pool.query(`INSERT INTO crm_field_definitions (workspace_id,entity_kind,field_key,label,field_type)
      VALUES ($1,$2,'score','Score','number')`, [f.workspaceId, kind])
    const job = await f.job(['name', 'domain', 'contactId', 'companyId', 'custom:score', 'consentPurposeKey', 'consentAction', 'consentSource'],
      [['Fixture company', 'changed.example', person, company, '7', 'updates', 'granted', 'fixture']], kind)
    const before = (await pool.query('SELECT id,display_name,attributes FROM entities WHERE workspace_id=$1 ORDER BY id', [f.workspaceId])).rows
    expect(await importer(async () => { throw new Error('Fixture later command rejected') }).resume(f.context, job.id)).toMatchObject({ status: 'completed', succeededRows: 0, failedRows: 1 })
    expect((await pool.query('SELECT id,display_name,attributes FROM entities WHERE workspace_id=$1 ORDER BY id', [f.workspaceId])).rows).toEqual(before)
    expect(await f.counts()).toMatchObject({ entities: 2, consent: 0, receipts: 1, errors: 1, audit: 1, outbox: 0 })
  })

  it('refuses stale trusted-source authority and ambiguous normalized email without minting another person', async () => {
    const f = await fixture()
    await f.entity('person', 'First fixture', { email: ' fixture@example.com ' })
    await f.entity('person', 'Second fixture', { email: 'FIXTURE@example.com' })
    const job = await f.job(consentColumns, [['Updated fixture', 'fixture@example.com', 'updates', 'granted', 'fixture']], 'contact', 'fixture')
    await pool.query(`UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2`, [f.workspaceId, f.userId])
    await expect(importer().resume(f.context, job.id)).rejects.toMatchObject({ code: 'not_authorized' })
    await pool.query(`UPDATE workspace_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2`, [f.workspaceId, f.userId])
    expect(await importer().resume(f.context, job.id)).toMatchObject({ status: 'completed', succeededRows: 0, failedRows: 1 })
    expect(await f.counts()).toMatchObject({ entities: 2, consent: 0, outbox: 0 })
    expect(await importer().errorsCsv(f.context, job.id)).toContain('Multiple live contacts match this email')
  })
})
