import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { AssociationCommandSchema, CrmOperationsCommandSchema, type CrmIntegrationGrant, type AssociationContext } from '@use-brian/core'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createDbCrmIntakeReadStore } from '../crm-intake-store.js'
import { createCrmIntegrationRecordReadStore } from '../crm-integration-records.js'
import { createAssociationService } from '../../association/service.js'
import { createAssociationStore } from '../association-store.js'
import { createWorkspaceModulesStore } from '../workspace-modules-store.js'
import { crmIntegrationContext } from '../../routes/crm-integration.js'
import { getPool } from '../client.js'
import { EventInputSchema, OrderCreateSchema, TicketInputSchema } from '../../association/domain.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const app = new pg.Pool({ connectionString: process.env.DATABASE_URL_APP })
const crm = createCrmOperationsService(createDbCrmOperationsStore(pool))
const commerce = createAssociationStore(pool)
const modules = createWorkspaceModulesStore(pool, app)
const association = createAssociationService({ crmService: crm, store: commerce, modules })
const legacy = { credentialKind: 'api_key' as const, credentialId: 'fixture' }
const event = (slug: string) => EventInputSchema.parse({ slug, title: slug, startsAt: '2099-01-01T12:00:00Z', endsAt: '2099-01-01T14:00:00Z', timezone: 'UTC', mode: 'venue', status: 'published', capacity: 100 })
const ticket = TicketInputSchema.parse({ key: 'general', name: 'General', currency: 'USD', priceMinor: 0, status: 'on_sale', capacity: 100 })
async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), credentialId = randomUUID(), contactId = randomUUID()
  await pool.query('INSERT INTO users (id,auth_provider_id) VALUES ($1::uuid,$1::text)', [userId])
  await pool.query(`INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'Command fixture',$2)`, [workspaceId, userId])
  await pool.query(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner')`, [workspaceId, userId])
  await pool.query(`INSERT INTO entities (id,workspace_id,kind,display_name,created_by_user_id,source) VALUES ($1,$2,'person','Fixture person',$3,'manual')`, [contactId, workspaceId, userId])
  const context = (grants: CrmIntegrationGrant[]) => crmIntegrationContext({ workspaceId, credentialId, grants })
  const vertical = (grants: CrmIntegrationGrant[]): AssociationContext => {
    const ctx = context(grants)
    return { ...ctx, authority: { ...ctx.authority, canRead: true, canReconcileProvider: true } }
  }
  const reads = (grants: CrmIntegrationGrant[]) => createDbCrmIntakeReadStore({ workspaceId, credentialId, grants })
  return { workspaceId, userId, credentialId, contactId, context, vertical, reads }
}

describe('[COMP:api/crm-integration-auth] Actual command and joined resource isolation', () => {
  afterAll(async () => { await Promise.all([pool.end(), app.end(), getPool().end()]) })
  it('keeps generic catalogs available while disabled and enforces configuration resource selectors inside the transaction', async () => {
    const f = await fixture()
    const ctx = f.context([{ operation: 'crm.catalog.configure', selectors: { eventIds: 'all', planIds: 'all' } }])
    const created = await crm.execute(ctx, CrmOperationsCommandSchema.parse({ kind: 'save_event', ...event('allowed') }))
    const id = String(created.record.id)
    const limited = f.context([{ operation: 'crm.catalog.configure', selectors: { eventIds: [id] } }])
    await crm.execute(limited, CrmOperationsCommandSchema.parse({ kind: 'save_event', ...event('allowed'), title: 'Updated fixture' }))
    const before = await pool.query('SELECT count(*) FROM association_audit_log WHERE workspace_id=$1', [f.workspaceId])
    await expect(crm.execute(limited, CrmOperationsCommandSchema.parse({ kind: 'save_event', ...event('not-selected') }))).rejects.toMatchObject({ code: 'integration_scope_denied' })
    const after = await pool.query('SELECT count(*) FROM association_audit_log WHERE workspace_id=$1', [f.workspaceId])
    expect(after.rows).toEqual(before.rows)
    expect((await modules.getAssociation(f.workspaceId)).state).toBe('disabled')
    const audit = await pool.query('SELECT actor_kind,actor_credential_id FROM association_audit_log WHERE workspace_id=$1', [f.workspaceId])
    expect(audit.rows).toHaveLength(2)
    expect(audit.rows.every((row) => row.actor_kind === 'integration_key' && row.actor_credential_id === f.credentialId)).toBe(true)
  })
  it('filters catalog and entitlement lists before LIMIT and checks workspace even for an empty selector', async () => {
    const f = await fixture()
    const created = []
    for (const slug of ['first', 'second', 'third']) created.push(await commerce.upsertEvent(f.workspaceId, event(slug), legacy))
    const allowed = String(created[0].record.id)
    const read = f.reads([{ operation: 'crm.catalog.read', selectors: { eventIds: [allowed] } }])
    expect((await read.listEvents(f.workspaceId, { limit: 1 })).events.map((row) => row.id)).toEqual([allowed])
    expect(await read.listEntitlementPlans(f.workspaceId)).toEqual({ plans: [], nextCursor: null })
    await expect(read.listEvents(randomUUID())).rejects.toMatchObject({ code: 'integration_scope_denied' })
    await expect(read.listEntitlements(f.workspaceId)).rejects.toMatchObject({ code: 'integration_scope_denied' })
  })
  it('rejects consent and trusted-identity escalation through intake configuration before any evidence is written', async () => {
    const f = await fixture()
    const limited = f.context([{ operation: 'crm.catalog.configure', selectors: { definitionIds: 'all' } }])
    const definition = { fields: [{ key: 'choice', label: 'Choice', type: 'boolean', mapping: { kind: 'submission_only' } }],
      identityPolicy: 'new_or_review', consentMappings: [{ fieldKey: 'choice', grantedValue: true, purposeKey: 'updates' }] }
    await expect(crm.execute(limited, CrmOperationsCommandSchema.parse({ kind: 'save_intake_definition', definitionKey: 'fixture', label: 'Fixture', definition })))
      .rejects.toMatchObject({ code: 'integration_scope_denied' })
    await expect(crm.execute(limited, CrmOperationsCommandSchema.parse({ kind: 'save_intake_definition', definitionKey: 'fixture', label: 'Fixture',
      definition: { ...definition, consentMappings: [], identityPolicy: 'trusted_verified_email' } })))
      .rejects.toMatchObject({ code: 'not_authorized' })
    expect((await pool.query('SELECT count(*)::int AS count FROM crm_intake_definitions WHERE workspace_id=$1', [f.workspaceId])).rows[0].count).toBe(0)
    expect((await pool.query('SELECT count(*)::int AS count FROM association_audit_log WHERE workspace_id=$1', [f.workspaceId])).rows[0].count).toBe(0)
  })
  it('reads only CRM records in the credential workspace and traverses equal-microsecond timestamps without omission', async () => {
    const f = await fixture(), other = await fixture()
    const principal = { workspaceId: f.workspaceId, credentialId: f.credentialId,
      grants: [{ operation: 'crm.records.read' as const, selectors: {} }] }
    const records = createCrmIntegrationRecordReadStore(principal, pool)
    await pool.query(`INSERT INTO entities (workspace_id,kind,display_name,created_by_user_id,source,created_at)
      SELECT $1,'person','Fixture '||n,$2,'manual','2026-01-01T00:00:00.123456Z'::timestamptz FROM generate_series(1,102) n`, [f.workspaceId, f.userId])
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await records.list({ limit: 10, cursor })
      seen.push(...page.records.map((row) => String(row.id)))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(seen).toHaveLength(103)
    expect(new Set(seen).size).toBe(103)
    expect(await records.get(other.contactId)).toBeNull()
    expect(await records.get(f.contactId)).toMatchObject({ id: f.contactId, kind: 'person' })
    expect(await records.fields()).toEqual({ fields: [], nextCursor: null })
    await expect(records.list({ kind: 'knowledge' })).rejects.toThrow()
    await expect(createCrmIntegrationRecordReadStore({ ...principal, grants: [{ operation: 'association.read', selectors: { eventIds: 'all' } }] }, pool).get(f.contactId))
      .rejects.toMatchObject({ code: 'integration_scope_denied' })
  })
  it('bounds traversal across new inserts and label edits, rejects cross-query cursors and pages all field definitions', async () => {
    const f = await fixture()
    const principal = { workspaceId: f.workspaceId, credentialId: f.credentialId,
      grants: [{ operation: 'crm.records.read' as const, selectors: {} }] }
    const records = createCrmIntegrationRecordReadStore(principal, pool)
    await pool.query(`INSERT INTO entities (workspace_id,kind,display_name,created_by_user_id,source,created_at)
      SELECT $1,'person','Fixture '||n,$2,'manual','2026-01-01T00:00:00.123456Z'::timestamptz FROM generate_series(1,105) n`, [f.workspaceId, f.userId])
    const first = await records.list({ limit: 7 })
    expect(first.nextCursor).toBeTruthy()
    await pool.query(`UPDATE entities SET display_name='Renamed fixture' WHERE workspace_id=$1`, [f.workspaceId])
    const newer = await pool.query(`INSERT INTO entities (workspace_id,kind,display_name,created_by_user_id,source,created_at)
      VALUES ($1,'person','New fixture',$2,'manual','2099-01-01T00:00:00Z') RETURNING id`, [f.workspaceId, f.userId])
    const ids = first.records.map((row) => row.id)
    let cursor = first.nextCursor
    while (cursor) {
      const page = await records.list({ limit: 19, cursor })
      ids.push(...page.records.map((row) => row.id))
      cursor = page.nextCursor
    }
    expect(ids).toHaveLength(106)
    expect(new Set(ids).size).toBe(106)
    expect(ids).not.toContain(newer.rows[0].id)
    for (const input of [{ kind: 'company' }, { query: 'Renamed' }, { includeArchived: 'true' }, { createdAfter: '2025-01-01T00:00:00Z' }]) {
      await expect(records.list({ ...input, cursor: first.nextCursor })).rejects.toMatchObject({ code: 'invalid_input' })
    }
    await expect(records.fields({ cursor: first.nextCursor })).rejects.toMatchObject({ code: 'invalid_input' })
    const otherWorkspace = createCrmIntegrationRecordReadStore({ ...principal, workspaceId: randomUUID() }, pool)
    await expect(otherWorkspace.list({ cursor: first.nextCursor })).rejects.toMatchObject({ code: 'invalid_input' })
    await pool.query(`INSERT INTO crm_field_definitions (workspace_id,entity_kind,field_key,label,field_type)
      SELECT $1,'person','fixture_'||n,'Fixture '||n,'text' FROM generate_series(1,105) n`, [f.workspaceId])
    const fields: unknown[] = []
    cursor = null
    do {
      const page = await records.fields({ limit: 17, cursor: cursor ?? undefined })
      fields.push(...page.fields.map((row) => row.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(fields).toHaveLength(105)
    expect(new Set(fields).size).toBe(105)
    const window = await records.list({ limit: 100, createdAfter: '2026-01-01T00:00:00.123456Z', createdBefore: '2026-01-01T00:00:00.123457Z' })
    expect(window.records).toHaveLength(100)
    expect((await records.list({ limit: 100, createdAfter: '2026-01-01T00:00:00.123456Z', createdBefore: '2026-01-01T00:00:00.123457Z', cursor: window.nextCursor })).records).toHaveLength(5)
  })
  it('prevents ticket, mixed-order, by-id, provider and registration traversal across event grants', async () => {
    const f = await fixture()
    await modules.act(f.workspaceId, f.userId, { action: 'enable', expectedVersion: 1 })
    const a = await commerce.upsertEvent(f.workspaceId, event('event-a'), legacy)
    const b = await commerce.upsertEvent(f.workspaceId, event('event-b'), legacy)
    const aid = String(a.record.id), bid = String(b.record.id)
    const ta = await commerce.upsertTicket(f.workspaceId, aid, ticket, legacy)
    const tb = await commerce.upsertTicket(f.workspaceId, bid, ticket, legacy)
    const lines = [ta, tb].map((row) => ({ ticketId: row.record.id, quantity: 1, attendees: [{ name: 'Fixture attendee' }] }))
    const input = OrderCreateSchema.parse({ contactId: f.contactId, idempotencyKey: randomUUID(), lines })
    const grants: CrmIntegrationGrant[] = [
      { operation: 'association.read', selectors: { eventIds: [aid] } },
      { operation: 'association.orders.write', selectors: { eventIds: [aid] } },
      { operation: 'crm.catalog.configure', selectors: { eventIds: [aid] } },
      { operation: 'association.provider_events.write', selectors: { eventIds: [aid], providerKeys: ['fixture'] } },
    ]
    const ctx = f.vertical(grants)
    await expect(association.execute(ctx, { kind: 'create_order', order: input })).rejects.toMatchObject({ code: 'integration_scope_denied' })
    expect((await pool.query('SELECT count(*)::int AS count FROM association_orders WHERE workspace_id=$1', [f.workspaceId])).rows[0].count).toBe(0)
    await expect(association.execute(ctx, { kind: 'save_ticket', eventId: bid, ticket })).rejects.toMatchObject({ code: 'integration_scope_denied' })
    const mixed = await commerce.createOrder(f.workspaceId, input, legacy)
    const orderId = String(mixed.record.id)
    expect((await association.execute(ctx, AssociationCommandSchema.parse({ kind: 'list_orders', limit: 1 }))).items).toEqual([])
    await expect(association.execute(ctx, { kind: 'get_order', orderId })).rejects.toMatchObject({ code: 'integration_scope_denied' })
    await expect(association.execute(ctx, { kind: 'cancel_order', orderId })).rejects.toMatchObject({ code: 'integration_scope_denied' })
    const registrationId = String((mixed.record.registrations as Array<{ id: string; eventId: string }>).find((row) => row.eventId === bid)!.id)
    await expect(association.execute(ctx, { kind: 'update_registration', registrationId, update: { status: 'cancelled' } })).rejects.toMatchObject({ code: 'integration_scope_denied' })
    const single = await commerce.createOrder(f.workspaceId, OrderCreateSchema.parse({ ...input, idempotencyKey: randomUUID(), lines: [lines[0]] }), legacy)
    const singleId = String(single.record.id)
    await expect(association.execute(ctx, AssociationCommandSchema.parse({ kind: 'reconcile_provider_event', orderId: singleId,
      event: { provider: 'ungranted', eventId: 'evt-1', targetStatus: 'paid', occurredAt: '2026-09-08T00:00:00Z' } }))).rejects.toMatchObject({ code: 'integration_scope_denied' })
    const page = await association.execute(ctx, AssociationCommandSchema.parse({ kind: 'module_blockers', limit: 1 }))
    expect(page.pendingOrders).toBe(1)
    expect(page.items?.[0].id).toBe(singleId)
    await modules.act(f.workspaceId, f.userId, { action: 'request_disable', expectedVersion: 2 })
    await association.execute(ctx, { kind: 'confirm_free_order', orderId: singleId })
    expect((await commerce.getOrder(f.workspaceId, singleId))?.status).toBe('paid')
    expect((await pool.query('SELECT count(*)::int AS count FROM association_provider_events WHERE workspace_id=$1', [f.workspaceId])).rows[0].count).toBe(0)
  })
})
