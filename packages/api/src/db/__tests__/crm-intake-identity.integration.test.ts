/** Resolution correctness only; verification admission is a separate intake contract. */
import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { CrmOperationsCommandSchema, type CrmOperationsContext } from '@use-brian/core'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const contender = new pg.Pool({ connectionString: process.env.DATABASE_URL, application_name: 'assurance_identity_contender' })
const store = createDbCrmOperationsStore(pool)
const competing = createDbCrmOperationsStore(contender)
const service = createCrmOperationsService(store)
async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID()
  await pool.query('INSERT INTO users (id,auth_provider_id) VALUES ($1::uuid,$1::text)', [userId])
  await pool.query(`INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'Identity fixture',$2)`, [workspaceId, userId])
  await pool.query(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner')`, [workspaceId, userId])
  const context: CrmOperationsContext = { workspaceId, actor: { kind: 'user', userId },
    authority: { role: 'owner', canWrite: true, canConfigure: true, trustedIdentitySources: [] } }
  return { workspaceId, userId, context }
}
async function observedIdentityWait() {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
      AND application_name='assurance_identity_contender' AND wait_event_type='Lock'
      AND position('pg_advisory_xact_lock' IN query)>0`)
    if (result.rowCount) return
    await setTimeout(10)
  }
  throw new Error('The identity contender never reached its database lock wait.')
}

describe('[COMP:crm/operations-store] Actual intake identity resolution', () => {
  afterAll(async () => { await Promise.all([pool.end(), contender.end()]) })
  it('requires review for ambiguous live email matches without a third contact or committed intake receipt', async () => {
    const f = await fixture()
    await pool.query(`INSERT INTO entities (workspace_id,kind,display_name,attributes,created_by_user_id,source)
      SELECT $1,'person','Fixture person',jsonb_build_object('email',email),$2,'manual'
      FROM unnest(ARRAY['Shared+alias@Example.com',' shared+alias@example.com ']) email`, [f.workspaceId, f.userId])
    await service.execute(f.context, CrmOperationsCommandSchema.parse({ kind: 'save_intake_definition', definitionKey: 'fixture', label: 'Fixture', definition: {
      identityPolicy: 'trusted_verified_email', fields: [
        { key: 'name', label: 'Name', type: 'text', mapping: { kind: 'base_field', field: 'name' } },
        { key: 'email', label: 'Email', type: 'email', mapping: { kind: 'base_field', field: 'email' } },
      ],
    } }))
    const before = await pool.query('SELECT count(*)::int AS count FROM association_audit_log WHERE workspace_id=$1', [f.workspaceId])
    await expect(service.execute(f.context, CrmOperationsCommandSchema.parse({ kind: 'record_submission', definitionKey: 'fixture', idempotencyKey: 'ambiguous', fields: { name: 'Fixture person', email: 'shared+alias@example.com' } })))
      .rejects.toMatchObject({ code: 'conflict', details: { reason: 'identity_review_required' } })
    expect((await pool.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1', [f.workspaceId])).rows[0].count).toBe(2)
    expect((await pool.query('SELECT count(*)::int AS count FROM crm_intake_idempotency WHERE workspace_id=$1', [f.workspaceId])).rows[0].count).toBe(0)
    expect((await pool.query('SELECT count(*)::int AS count FROM association_enquiries WHERE workspace_id=$1', [f.workspaceId])).rows[0].count).toBe(0)
    expect((await pool.query('SELECT count(*)::int AS count FROM association_audit_log WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual(before.rows)
    // Neither plus nor dot transformations are identity rules.
    expect(await store.transaction(f.context, (tx) => tx.findContactByEmail('shared@example.com'))).toBeNull()
    await pool.query(`UPDATE entities SET attributes=attributes||jsonb_build_object('crm_archived_at','2026-01-01') WHERE id=(SELECT id FROM entities WHERE workspace_id=$1 LIMIT 1)`, [f.workspaceId])
    const remaining = await store.transaction(f.context, (tx) => tx.findContactByEmail('SHARED+ALIAS@example.com'))
    expect(remaining).toBeTypeOf('string')
    await pool.query(`UPDATE entities SET attributes=attributes||jsonb_build_object('crm_archived_at','2026-01-01') WHERE workspace_id=$1`, [f.workspaceId])
    expect(await store.transaction(f.context, (tx) => tx.findContactByEmail('shared+alias@example.com'))).toBeNull()
  })

  it.each(['email', 'external_subject'] as const)('serializes %s lookup/create/bind while leaving other workspaces independent', async (kind) => {
    const f = await fixture(), other = await fixture()
    let release!: () => void, entered!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const created = new Promise<void>((resolve) => { entered = resolve })
    const resolve = (tx: Parameters<Parameters<typeof store.transaction>[1]>[0]) => kind === 'email'
      ? tx.findContactByEmail('concurrent@example.com') : tx.resolveExternalIdentity('fixture', 'concurrent_subject')
    const first = store.transaction(f.context, async (tx) => {
      expect(await resolve(tx)).toBeNull()
      const record = await tx.createContact({ name: 'Concurrent fixture', email: 'concurrent@example.com', phone: null, tags: [], customFields: {} }, { createdByUserId: f.userId, createdByAssistantId: null })
      if (kind === 'external_subject') await tx.bindExternalIdentity(String(record.id), 'fixture', 'concurrent_subject')
      entered()
      await held
      return String(record.id)
    })
    let second: Promise<string | null> | undefined
    try {
      await Promise.race([created, first.then(() => { throw new Error('Identity transaction ended before the test released it.') })])
      second = competing.transaction(f.context, resolve)
      await observedIdentityWait()
      expect(await store.transaction(other.context, resolve)).toBeNull()
    } finally {
      release()
      await Promise.allSettled([first, ...(second ? [second] : [])])
    }
    expect(await second).toBe(await first)
    expect((await pool.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1', [f.workspaceId])).rows[0].count).toBe(1)
    if (kind === 'external_subject') {
      await pool.query(`UPDATE entities SET attributes=attributes||jsonb_build_object('crm_archived_at','2026-01-01') WHERE workspace_id=$1`, [f.workspaceId])
      await expect(store.transaction(f.context, resolve)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'identity_review_required' } })
    }
  })
})
