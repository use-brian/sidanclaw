import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { createCrmIntegrationStore } from '../crm-integration-store.js'
import { createCrmImportSources } from '../crm-import-sources.js'
import { crmIntegrationContext } from '../../routes/crm-integration.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const app = new pg.Pool({ connectionString: process.env.DATABASE_URL_APP })
const keys = createCrmIntegrationStore(pool, app), sources = createCrmImportSources(pool)
async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID()
  await pool.query('INSERT INTO users (id,auth_provider_id) VALUES ($1::uuid,$1::text)', [userId])
  await pool.query(`INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'Source fixture',$2)`, [workspaceId, userId])
  await pool.query(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner')`, [workspaceId, userId])
  const key = await keys.create(workspaceId, userId, { label: 'Importer', expiresAt: '2099-01-01T00:00:00Z', grants: [
    { operation: 'crm.imports.write', selectors: {} }, { operation: 'crm.records.write', selectors: {} },
  ] })
  const context = crmIntegrationContext((await keys.authenticate(key.oneTimeSecret))!)
  return { workspaceId, userId, context }
}
describe('[COMP:crm/production-import] Real immutable source staging', () => {
  afterAll(async () => { await Promise.all([pool.end(), app.end()]) })
  it('replays exact uploads once and refuses changed bytes and mutation of the source', async () => {
    const f = await fixture(), sourceKey = randomUUID(), bytes = Buffer.from('Name,Email\nFixture,person@example.com\n')
    const first = await sources.stage(f.context, sourceKey, bytes)
    expect(first.created).toBe(true)
    expect(await sources.stage(f.context, sourceKey, bytes)).toEqual({ ...first, created: false })
    await expect(sources.stage(f.context, sourceKey, Buffer.from('Name\nDifferent\n'))).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect((await sources.read(f.context, first.sourceId)).bytes.equals(bytes)).toBe(true)
    await expect(pool.query(`UPDATE crm_import_sources SET source_hash=$2 WHERE id=$1`, [first.sourceId, '0'.repeat(64)])).rejects.toThrow('immutable')
    expect(await sources.attributionUser(f.context)).toBe(f.userId)
    expect(f.context.actor.kind).toBe('integration_key')
    expect(f.context.authority.role).toBe('system')
  })
  it('refuses foreign or arbitrary file ids and applies actual app-role workspace RLS', async () => {
    const f = await fixture(), other = await fixture()
    const first = await sources.stage(f.context, randomUUID(), Buffer.from('Name\nFixture\n'))
    await expect(sources.read(other.context, first.sourceId)).rejects.toMatchObject({ code: 'not_found' })
    await expect(sources.read(f.context, randomUUID())).rejects.toMatchObject({ code: 'not_found' })
    const client = await app.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.current_user_id',$1,true)`, [other.userId])
      expect((await client.query('SELECT id FROM crm_import_sources WHERE id=$1', [first.sourceId])).rowCount).toBe(0)
    } finally { await client.query('ROLLBACK'); client.release() }
  })
})
