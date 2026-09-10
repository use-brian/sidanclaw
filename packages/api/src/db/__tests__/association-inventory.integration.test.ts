import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { type CrmOperationsContext, type CrmOperationsCommand } from '@use-brian/core'
import { getPool, getAppPool } from '../client.js'
import { createWorkspaceModulesStore } from '../workspace-modules-store.js'
import { createAssociationStore } from '../association-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { EventInputSchema, TicketInputSchema, OrderCreateSchema } from '../../association/domain.js'
import { _resetCoalescerForTests } from '../../brain-stream/notify.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), appPool = getAppPool(), modules = createWorkspaceModulesStore()
const commerce = createAssociationStore(), operations = createCrmOperationsService(createDbCrmOperationsStore())
const eventInput = { slug: 'fixture-event', title: 'Inventory fixture', startsAt: '2099-01-01T12:00:00Z', endsAt: '2099-01-01T14:00:00Z', timezone: 'UTC', mode: 'venue', status: 'published', capacity: 1 }
const ticketInput = { key: 'standard', name: 'Standard', currency: 'USD', priceMinor: 0, status: 'on_sale', capacity: 1 }
async function fixture(eventPatch: Record<string, unknown> = {}, withTicket = true, ticketPatch: Record<string, unknown> = {}) {
  const workspaceId = randomUUID(), userId = randomUUID(), contactId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Inventory fixture',$2)", [workspaceId, userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId])
  await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source) VALUES($1,$2,'person','Fictional attendee',$3,'manual')", [contactId, workspaceId, userId])
  await modules.act(workspaceId, userId, { action: 'enable', expectedVersion: 1 })
  const actor = { credentialKind: 'user' as const, credentialId: userId, actingUserId: userId }
  const event = await commerce.upsertEvent(workspaceId, EventInputSchema.parse({ ...eventInput, ...eventPatch }), actor)
  const eventId = String(event.record.id)
  const ticket = withTicket ? await commerce.upsertTicket(workspaceId, eventId, TicketInputSchema.parse({ ...ticketInput, ...ticketPatch }), actor) : null
  const ticketId = ticket ? String(ticket.record.id) : undefined
  const context: CrmOperationsContext = { workspaceId, actor: { kind: 'user', userId }, authority: { role: 'owner', canConfigure: true, canWrite: true, trustedIdentitySources: [] } }
  const order = (ids = [ticketId!], key = randomUUID(), useMemberPrice = false) => commerce.createOrder(workspaceId, OrderCreateSchema.parse({ contactId, idempotencyKey: key, lines: ids.map(id => ({ ticketId: id, quantity: 1, useMemberPrice, attendees: [{ contactId, name: 'Fictional attendee' }] })) }), actor)
  const participation = (patch: Partial<Extract<CrmOperationsCommand, { kind: 'record_participation' }>> = {}, ctx = context) => operations.execute(ctx, { kind: 'record_participation', eventId, contactId, sourceKind: 'manual', sourceId: randomUUID(), attendeeName: 'Fictional attendee', status: 'registered', metadata: {}, ...patch })
  return { workspaceId, userId, contactId, actor, context, eventId, ticketId, order, participation }
}
async function boundaries(workspaceId: string) {
  return (await pool.query("SELECT event_type,payload,event_key FROM crm_domain_event_outbox WHERE workspace_id=$1 AND event_type LIKE 'association.inventory.%' ORDER BY created_at,id", [workspaceId])).rows
}
async function blocked(fragment: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if ((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND position($1 in query)>0", [fragment])).rowCount) return
    await setTimeout(10)
  }
  throw Error('Expected a database row-lock wait')
}
describe('[COMP:crm/association-inventory] Actual admission and committed boundaries', () => {
  afterAll(async () => { _resetCoalescerForTests(); await pool.end(); await appPool.end() })
  it('serializes different ticket types competing for the last event place', async () => {
    const f = await fixture({}, true, { capacity: 10 })
    const second = await commerce.upsertTicket(f.workspaceId, f.eventId, TicketInputSchema.parse({ ...ticketInput, key: 'second', capacity: 10 }), f.actor)
    const results = await Promise.allSettled([f.order(), f.order([String(second.record.id)])])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toMatchObject([{ reason: { code: 'not_available' } }])
    expect(await boundaries(f.workspaceId)).toMatchObject([{ event_type: 'association.inventory.sold_out', payload: { eventId: f.eventId, ticketId: null, capacity: 1, used: 1, revision: 1 } }])
    expect((await pool.query('SELECT count(*)::int n FROM association_registrations WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(1)
  })
  it('takes a consistent lock order for overlapping multi-ticket orders and releases exactly one boundary per scope', async () => {
    const f = await fixture({ capacity: 2 })
    const second = String((await commerce.upsertTicket(f.workspaceId, f.eventId, TicketInputSchema.parse({ ...ticketInput, key: 'second' }), f.actor)).record.id)
    const key = randomUUID(), results = await Promise.all([f.order([f.ticketId!, second], key), f.order([f.ticketId!, second], key)])
    expect(results.filter(r => r.created)).toHaveLength(1)
    const id = String(results[0].record.id)
    expect((await boundaries(f.workspaceId)).map(r => r.event_type)).toEqual(Array(3).fill('association.inventory.sold_out'))
    await commerce.cancelOrder(f.workspaceId, id, f.actor)
    await commerce.cancelOrder(f.workspaceId, id, f.actor)
    const events = await boundaries(f.workspaceId)
    expect(events.filter(r => r.event_type === 'association.inventory.available')).toHaveLength(3)
    expect(new Set(events.map(r => r.event_key)).size).toBe(6)
  })
  it.each([
    [{ registrationOpensAt: '2098-01-01T00:00:00Z' }, {}],
    [{ registrationClosesAt: '2000-01-01T00:00:00Z' }, {}],
    [{}, { saleStartsAt: '2098-01-01T00:00:00Z' }],
    [{}, { saleEndsAt: '2000-01-01T00:00:00Z' }],
    [{ startsAt: '1999-01-01T12:00:00Z', endsAt: '1999-01-01T14:00:00Z' }, {}],
  ])('enforces every event/ticket window and refuses ended events (%j)', async (ep, tp) => {
    const f = await fixture(ep, true, tp)
    await expect(f.order()).rejects.toMatchObject({ code: 'not_available' })
    expect(await boundaries(f.workspaceId)).toEqual([])
  })
  it('free confirmation preserves occupied stock without inventing payment evidence; expiry emits availability once', async () => {
    const f = await fixture(), reserved = await f.order(), id = String(reserved.record.id)
    await commerce.confirmFreeOrder(f.workspaceId, id, f.actor)
    await commerce.confirmFreeOrder(f.workspaceId, id, f.actor)
    expect(await boundaries(f.workspaceId)).toHaveLength(2)
    expect((await pool.query('SELECT count(*)::int n FROM association_provider_events WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
    const g = await fixture(), expiring = String((await g.order()).record.id)
    await pool.query("UPDATE association_orders SET reservation_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expiring])
    await pool.query("UPDATE association_registrations SET reservation_expires_at=clock_timestamp()-interval '1 second' WHERE order_id=$1", [expiring])
    const actor = { credentialKind: 'system_job' as const, credentialId: `association_expiry:${randomUUID()}` }
    await commerce.expireDueOrder(g.workspaceId, expiring, actor)
    await commerce.expireDueOrder(g.workspaceId, expiring, actor)
    expect((await boundaries(g.workspaceId)).filter(r => r.event_type === 'association.inventory.available')).toHaveLength(2)
  })
  it('rolls back stock and boundary events when order audit fails, then permits a retry', async () => {
    const f = await fixture()
    await pool.query("ALTER TABLE association_audit_log ADD CONSTRAINT fixture_refuse_inventory_audit CHECK(action<>'order.reserved') NOT VALID")
    try { await expect(f.order()).rejects.toThrow(); expect(await boundaries(f.workspaceId)).toEqual([]) }
    finally { await pool.query('ALTER TABLE association_audit_log DROP CONSTRAINT fixture_refuse_inventory_audit') }
    expect((await f.order()).created).toBe(true)
  })
  it('blocks generic live participation for capacity-only and ticket-only events on every source vocabulary', async () => {
    for (const f of [await fixture({}, false), await fixture({ capacity: null })]) {
      for (const sourceKind of ['manual', 'form', 'import', 'workflow'] as const) {
        await expect(f.participation({ sourceKind })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'association_order_required' } })
      }
      await expect(f.participation({ sourceKind: 'import', historicalImport: true })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'historical_event_not_ended' } })
      await expect(pool.query("INSERT INTO association_registrations(workspace_id,event_id,attendee_name,status,source_kind,source_id,request_fingerprint) VALUES($1,$2,'Fictional attendee','registered','manual',$3,'fixture')", [f.workspaceId, f.eventId, randomUUID()])).rejects.toMatchObject({ code: '23514' })
    }
  })
  it('keeps unconstrained participation and counts pre-existing admissions when capacity is later introduced', async () => {
    const f = await fixture({ capacity: null }, false), saved = await f.participation()
    expect(saved.record).toMatchObject({ historicalImport: false, status: 'registered' })
    await commerce.upsertEvent(f.workspaceId, EventInputSchema.parse(eventInput), f.actor)
    expect(await boundaries(f.workspaceId)).toMatchObject([{ payload: { used: 1, capacity: 1, revision: 1 } }])
    await operations.execute(f.context, { kind: 'update_participation', participationId: String(saved.record.id), status: 'cancelled' })
    expect((await boundaries(f.workspaceId)).filter(r => r.event_type === 'association.inventory.available')).toHaveLength(1)
    await expect(commerce.updateRegistration(f.workspaceId, String(saved.record.id), { status: 'checked_in' }, f.actor)).rejects.toMatchObject({ code: 'invalid_transition' })
  })
  it('requires an explicit human admin historical import, records provenance and never consumes stock', async () => {
    const f = await fixture({ startsAt: '1999-01-01T12:00:00Z', endsAt: '1999-01-01T14:00:00Z' })
    const patch = { sourceKind: 'import' as const, historicalImport: true, sourceId: randomUUID(), status: 'attended' as const }
    const saved = await f.participation(patch)
    expect(saved.record).toMatchObject({ historicalImport: true })
    expect((await f.participation(patch)).duplicate).toBe(true)
    expect(await boundaries(f.workspaceId)).toEqual([])
    expect((await pool.query('SELECT used FROM association_inventory_boundaries WHERE workspace_id=$1', [f.workspaceId])).rows.every(r => r.used === 0)).toBe(true)
    const foreign = await fixture()
    await expect(f.participation({ ...patch, sourceId: randomUUID() }, { ...f.context, actor: { kind: 'user', userId: foreign.userId } })).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(f.participation({ ...patch, sourceId: randomUUID() }, { ...f.context, actor: { kind: 'workflow', workflowId: randomUUID(), runId: randomUUID(), userId: f.userId } })).rejects.toMatchObject({ code: 'not_authorized' })
    await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.userId])
    await expect(f.participation(patch)).rejects.toMatchObject({ code: 'not_authorized' })
  })
  it('rechecks membership after waiting and refuses an expired discount without holding stock', async () => {
    const f = await fixture({}, true, { priceMinor: 1000, memberPriceMinor: 500 })
    const planId = (await pool.query("INSERT INTO association_membership_plans(workspace_id,plan_key,name,currency,fee_minor,billing_period) VALUES($1,'fixture','Fixture','USD',0,'annual') RETURNING id", [f.workspaceId])).rows[0].id
    const id = (await pool.query("INSERT INTO association_memberships(workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,status,starts_at,ends_at) VALUES($1,$2,$3,$4,repeat('a',64),'active',clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day') RETURNING id", [f.workspaceId, f.contactId, planId, randomUUID()])).rows[0].id
    const writer = await pool.connect(); let pending: ReturnType<typeof f.order> | undefined
    try {
      await writer.query('BEGIN')
      await writer.query("UPDATE association_memberships SET ends_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id])
      pending = f.order(undefined, undefined, true)
      const rejected = expect(pending).rejects.toMatchObject({ code: 'member_price_ineligible' })
      await blocked("status='active' ORDER BY id FOR SHARE")
      await writer.query('COMMIT'); await rejected
      expect(await boundaries(f.workspaceId)).toEqual([])
    } finally { await writer.query('ROLLBACK').catch(() => {}); writer.release(); if (pending) await pending.catch(() => {}) }
  })
  it('revalidates free-order expiry after a row-lock wait', async () => {
    const f = await fixture(), id = String((await f.order()).record.id), writer = await pool.connect()
    let pending: ReturnType<typeof commerce.confirmFreeOrder> | undefined
    try {
      await writer.query('BEGIN')
      await writer.query("UPDATE association_orders SET reservation_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id])
      pending = commerce.confirmFreeOrder(f.workspaceId, id, f.actor)
      const rejected = expect(pending).rejects.toMatchObject({ code: 'not_available' })
      await blocked('SELECT status,total_minor::text')
      await writer.query('COMMIT'); await rejected
      expect((await commerce.getOrder(f.workspaceId, id))?.status).toBe('pending')
    } finally { await writer.query('ROLLBACK').catch(() => {}); writer.release(); if (pending) await pending.catch(() => {}) }
  })
  it('emits capacity changes once and refuses opposite-order overlapping checkout without deadlocking', async () => {
    const f = await fixture({ capacity: 2 })
    const second = String((await commerce.upsertTicket(f.workspaceId, f.eventId, TicketInputSchema.parse({ ...ticketInput, key: 'second' }), f.actor)).record.id)
    const raced = await Promise.allSettled([f.order([f.ticketId!, second]), f.order([second, f.ticketId!])])
    expect(raced.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(raced.filter(r => r.status === 'rejected')).toMatchObject([{ reason: { code: 'not_available' } }])
    await commerce.upsertEvent(f.workspaceId, EventInputSchema.parse({ ...eventInput, capacity: 3 }), f.actor)
    await commerce.upsertEvent(f.workspaceId, EventInputSchema.parse({ ...eventInput, capacity: 3 }), f.actor)
    expect((await boundaries(f.workspaceId)).filter(r => r.event_type === 'association.inventory.available')).toMatchObject([{ payload: { ticketId: null, revision: 2 } }])
  })
  it('isolates member reads by workspace and denies application-role boundary writes', async () => {
    const f = await fixture(), g = await fixture(), client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.current_user_id',$1,true)", [f.userId])
      expect((await client.query('SELECT id FROM association_inventory_boundaries WHERE workspace_id=$1', [f.workspaceId])).rowCount).toBe(2)
      expect((await client.query('SELECT id FROM association_inventory_boundaries WHERE workspace_id=$1', [g.workspaceId])).rowCount).toBe(0)
      expect((await client.query('UPDATE association_inventory_boundaries SET sold_out=true WHERE workspace_id=$1', [f.workspaceId])).rowCount).toBe(0)
    } finally { await client.query('ROLLBACK'); client.release() }
  })
})
