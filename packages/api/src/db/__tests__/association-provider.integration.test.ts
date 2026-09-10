import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { type AssociationActor, type AssociationProviderEventInput } from '@use-brian/core'
import { getPool, getAppPool } from '../client.js'
import { createWorkspaceModulesStore } from '../workspace-modules-store.js'
import { createAssociationStore } from '../association-store.js'
import { createCrmIntegrationStore } from '../crm-integration-store.js'
import { EventInputSchema, TicketInputSchema, OrderCreateSchema } from '../../association/domain.js'
import { _resetCoalescerForTests } from '../../brain-stream/notify.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), appPool = getAppPool(), modules = createWorkspaceModulesStore(), store = createAssociationStore(), keys = createCrmIntegrationStore()
async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), contactId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Provider fixture',$2)", [workspaceId, userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId])
  await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source) VALUES($1,$2,'person','Fictional buyer',$3,'manual')", [contactId, workspaceId, userId])
  await modules.act(workspaceId, userId, { action: 'enable', expectedVersion: 1 })
  const human: AssociationActor = { credentialKind: 'user', credentialId: userId, actingUserId: userId }, actor: AssociationActor = { credentialKind: 'api_key', credentialId: 'fixture-backend' }
  const eventId = String((await store.upsertEvent(workspaceId, EventInputSchema.parse({ slug: 'fixture', title: 'Provider fixture', startsAt: '2099-01-01T12:00:00Z', endsAt: '2099-01-01T14:00:00Z', timezone: 'UTC', mode: 'venue', status: 'published', capacity: 10 }), human)).record.id)
  const ticketId = String((await store.upsertTicket(workspaceId, eventId, TicketInputSchema.parse({ key: 'standard', name: 'Standard', currency: 'USD', priceMinor: 1000, status: 'on_sale', capacity: 10 }), human)).record.id)
  const order = async () => String((await store.createOrder(workspaceId, OrderCreateSchema.parse({ contactId, idempotencyKey: randomUUID(), lines: [{ ticketId, quantity: 1, attendees: [{ contactId, name: 'Fictional buyer' }] }] }), human)).record.id)
  const orderId = await order(), binding = { provider: 'fixture', providerReference: randomUUID(), amountMinor: 1000, currency: 'USD' }
  const bind = (id = orderId, patch = {}, a = actor) => store.bindOrderProvider(workspaceId, id, { ...binding, ...patch }, a)
  const evidence: AssociationProviderEventInput = { ...binding, eventId: randomUUID(), targetStatus: 'paid', occurredAt: '2026-09-01T12:00:00.000001Z', metadata: {} }
  const apply = (patch: Partial<AssociationProviderEventInput> = {}, id = orderId, a = actor) => store.reconcileProviderEvent(workspaceId, id, { ...evidence, ...patch }, a)
  return { workspaceId, userId, human, actor, eventId, orderId, binding, evidence, order, bind, apply }
}
async function counts(ws: string) {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM association_provider_events WHERE workspace_id=$1) evidence,
    (SELECT count(*)::int FROM association_audit_log WHERE workspace_id=$1 AND action IN('order.paid','order.refunded')) transitions,
    (SELECT count(*)::int FROM association_notification_outbox WHERE workspace_id=$1 AND source_kind='order') notifications`, [ws])).rows[0]
}
describe('[COMP:crm/association-provider] Actual provider object and money admission', () => {
  afterAll(async () => { _resetCoalescerForTests(); await pool.end(); await appPool.end() })
  it('requires a prior bound object and exact canonical money before any payment effect', async () => {
    const f = await fixture()
    await expect(f.apply()).rejects.toMatchObject({ code: 'conflict' })
    for (const patch of [{ amountMinor: 999 }, { currency: 'EUR' }]) await expect(f.bind(undefined, patch)).rejects.toMatchObject({ code: 'conflict' })
    expect((await f.bind()).created).toBe(true)
    expect((await f.bind()).created).toBe(false)
    for (const patch of [{ amountMinor: 999 }, { currency: 'EUR' }, { providerReference: 'different' }, { provider: 'other' }]) await expect(f.apply({ ...patch, eventId: randomUUID() })).rejects.toMatchObject({ code: 'conflict' })
    expect(await counts(f.workspaceId)).toEqual({ evidence: 0, transitions: 0, notifications: 0 })
    expect((await f.apply()).record.status).toBe('paid')
  })
  it('deduplicates concurrent event ids and semantic duplicates without repeating transitions or notifications', async () => {
    const f = await fixture(); await f.bind()
    const results = await Promise.allSettled([f.apply(), f.apply()])
    expect(results.filter(r => r.status === 'fulfilled' && r.value.created)).toHaveLength(1)
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'conflict', details: { reason: 'provider_event_processing' } })
    expect((await f.apply()).created).toBe(false)
    for (const patch of [{ occurredAt: '2026-09-01T12:00:00.000002Z' }, { metadata: { changed: true } }]) await expect(f.apply(patch)).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await f.apply({ eventId: randomUUID() })
    expect(await counts(f.workspaceId)).toEqual({ evidence: 2, transitions: 1, notifications: 2 })
    await expect(pool.query("UPDATE association_provider_events SET metadata='{}' WHERE workspace_id=$1", [f.workspaceId])).rejects.toMatchObject({ code: '23514' })
  })
  it('serializes competing bindings and prevents database rebinds or changing bound money', async () => {
    const f = await fixture(), second = await f.order(), results = await Promise.allSettled([f.bind(), f.bind(second)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toMatchObject([{ reason: { code: 'conflict' } }])
    const bound = (await pool.query('SELECT id FROM association_orders WHERE workspace_id=$1 AND provider_reference=$2', [f.workspaceId, f.binding.providerReference])).rows[0].id
    await expect(pool.query('UPDATE association_orders SET total_minor=999 WHERE id=$1', [bound])).rejects.toMatchObject({ code: '23514' })
    await expect(pool.query('UPDATE association_orders SET provider_reference=$2 WHERE id=$1', [bound, randomUUID()])).rejects.toMatchObject({ code: '23514' })
    await expect(f.bind(bound, { providerReference: 'other' })).rejects.toMatchObject({ code: 'conflict' })
  })
  it('retains bound recovery after disable and refunds checked-in registrations exactly once', async () => {
    const f = await fixture(); await f.bind(); await f.apply()
    await modules.act(f.workspaceId, f.userId, { action: 'request_disable', expectedVersion: 2 })
    expect((await f.bind()).created).toBe(false)
    const registration = (await pool.query('SELECT id FROM association_registrations WHERE order_id=$1', [f.orderId])).rows[0].id
    await store.updateRegistration(f.workspaceId, registration, { status: 'checked_in' }, f.human)
    const refund = { eventId: randomUUID(), targetStatus: 'refunded' as const }
    await f.apply(refund); await f.apply(refund)
    expect((await pool.query('SELECT status FROM association_registrations WHERE id=$1', [registration])).rows[0].status).toBe('refunded')
    expect(await counts(f.workspaceId)).toEqual({ evidence: 2, transitions: 2, notifications: 2 })
    await expect(f.apply({ eventId: randomUUID() })).rejects.toMatchObject({ code: 'invalid_transition' })
  })
  it('refuses late success, new expired bindings and human payment assertions', async () => {
    const f = await fixture(); await f.bind()
    await pool.query("UPDATE association_orders SET reservation_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.orderId])
    await expect(f.apply()).rejects.toMatchObject({ code: 'not_available' })
    const second = await f.order()
    await pool.query("UPDATE association_orders SET reservation_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [second])
    await expect(f.bind(second, { providerReference: randomUUID() })).rejects.toMatchObject({ code: 'not_available' })
    await expect(f.bind(undefined, {}, f.human)).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(f.apply({}, undefined, f.human)).rejects.toMatchObject({ code: 'not_authorized' })
    expect(await counts(f.workspaceId)).toEqual({ evidence: 0, transitions: 0, notifications: 0 })
  })
  it('rechecks provider/event credential ceilings and revocation on binding and event replay', async () => {
    const f = await fixture(), issued = await keys.create(f.workspaceId, f.userId, { label: 'Provider backend', expiresAt: '2099-01-01T00:00:00Z', grants: [{ operation: 'association.provider_events.write', selectors: { eventIds: [f.eventId], providerKeys: ['fixture'] } }] })
    const integration = (await keys.authenticate(issued.oneTimeSecret))!, actor: AssociationActor = { credentialKind: 'integration_key', credentialId: integration.credentialId, integration }
    await f.bind(undefined, {}, actor); await f.apply({}, undefined, actor)
    await expect(f.apply({ provider: 'other' }, undefined, actor)).rejects.toMatchObject({ code: 'integration_scope_denied' })
    await keys.revoke(f.workspaceId, f.userId, actor.credentialId)
    await expect(f.bind(undefined, {}, actor)).rejects.toMatchObject({ code: 'credential_revoked' })
    await expect(f.apply({}, undefined, actor)).rejects.toMatchObject({ code: 'credential_revoked' })
  })
  it('rolls back bound provider state or payment evidence when audit fails, then retries safely', async () => {
    const f = await fixture()
    await pool.query("ALTER TABLE association_audit_log ADD CONSTRAINT fixture_refuse_provider_audit CHECK(action NOT IN('order.provider_bound','order.paid')) NOT VALID")
    try { await expect(f.bind()).rejects.toThrow(); expect((await store.getOrder(f.workspaceId, f.orderId))?.providerReference).toBeNull() }
    finally { await pool.query('ALTER TABLE association_audit_log DROP CONSTRAINT fixture_refuse_provider_audit') }
    await f.bind()
    await pool.query("ALTER TABLE association_audit_log ADD CONSTRAINT fixture_refuse_provider_audit CHECK(action<>'order.paid') NOT VALID")
    try { await expect(f.apply()).rejects.toThrow(); expect(await counts(f.workspaceId)).toEqual({ evidence: 0, transitions: 0, notifications: 0 }) }
    finally { await pool.query('ALTER TABLE association_audit_log DROP CONSTRAINT fixture_refuse_provider_audit') }
    expect((await f.apply()).record.status).toBe('paid')
  })
  it('compares every retained legacy evidence field without inventing a historical fingerprint', async () => {
    const f = await fixture(); await f.bind(); await f.apply()
    const legacyId = randomUUID()
    await pool.query(`INSERT INTO association_provider_events(workspace_id,order_id,provider,provider_event_id,target_status,provider_reference,occurred_at,metadata)
      VALUES($1,$2,$3,$4,'paid',$5,$6,'{}')`, [f.workspaceId, f.orderId, f.binding.provider, legacyId, f.binding.providerReference, f.evidence.occurredAt])
    expect((await f.apply({ eventId: legacyId })).created).toBe(false)
    await expect(f.apply({ eventId: legacyId, occurredAt: '2026-09-01T12:00:00.000002Z' })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(f.apply({ eventId: legacyId, metadata: { changed: true } })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect((await pool.query('SELECT request_fingerprint FROM association_provider_events WHERE workspace_id=$1 AND provider_event_id=$2', [f.workspaceId, legacyId])).rows[0].request_fingerprint).toBeNull()
  })
  it('serializes one provider event identity presented concurrently for different bound orders', async () => {
    const f = await fixture(), second = await f.order(), secondReference = randomUUID()
    await f.bind(); await f.bind(second, { providerReference: secondReference })
    const results = await Promise.allSettled([f.apply(), f.apply({ providerReference: secondReference }, second)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toMatchObject([{ reason: { code: 'idempotency_conflict' } }])
    expect(await counts(f.workspaceId)).toEqual({ evidence: 1, transitions: 1, notifications: 2 })
  })
})
