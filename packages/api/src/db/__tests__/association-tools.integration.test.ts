import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createAssociationTools, createCrmOperationsTools, type CrmOperationsReadPort, type ToolContext, type Tool } from '@use-brian/core'
import { getPool, getAppPool } from '../client.js'
import { seedBuiltinPrimitiveCapabilities } from '../capability-seed.js'
import { createWorkspaceModulesStore } from '../workspace-modules-store.js'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createAssociationService } from '../../association/service.js'
import { _resetCoalescerForTests } from '../../brain-stream/notify.js'
import * as notifications from '../../brain-stream/notify.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), appPool = getAppPool(), modules = createWorkspaceModulesStore()
const crmService = createCrmOperationsService(createDbCrmOperationsStore())
const tools = createAssociationTools(createAssociationService({ crmService }))
const crmTools = createCrmOperationsTools({ service: crmService, reads: {} as CrmOperationsReadPort })
const grants = ['association', 'home_app:association:read', 'home_app:association:write', 'crm', 'home_app:crm:read', 'home_app:crm:write', 'configure']
async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), assistantId = randomUUID(), contactId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Native commerce fixture',$2)", [workspaceId, userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId])
  await pool.query("INSERT INTO assistants(id,name,workspace_id,kind,owner_user_id) VALUES($1,'Fixture assistant',$2,'primary',$3)", [assistantId, workspaceId, userId])
  await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source) VALUES($1,$2,'person','Example Attendee',$3,'manual')", [contactId, workspaceId, userId])
  await seedBuiltinPrimitiveCapabilities((sql, params) => pool.query(sql, params), assistantId, userId)
  async function context(): Promise<ToolContext> {
    const rows = await pool.query('SELECT capability FROM assistant_capabilities WHERE assistant_id=$1 AND revoked_at IS NULL', [assistantId])
    return { workspaceId, userId, assistantId, sessionId: randomUUID(), appId: assistantId, channelType: 'workflow', channelId: 'fixture',
      abortSignal: new AbortController().signal, activeCapabilities: new Set(rows.rows.map(row => row.capability)) }
  }
  async function grant() {
    for (const capability of grants) await pool.query(`INSERT INTO assistant_capabilities(assistant_id,capability,granted_by_user_id)
      VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [assistantId, capability, userId])
  }
  const call = async (tool: Tool, input: unknown = {}) => tool.execute(input, await context())
  return { workspaceId, userId, assistantId, contactId, call, grant, context }
}
function record(output: Awaited<ReturnType<Tool['execute']>>) {
  expect(output.isError, JSON.stringify(output.data)).not.toBe(true)
  return (output.data as { record: Record<string, unknown> }).record
}

describe('[COMP:crm/association-tools] Native tools through real canonical transactions', () => {
  afterAll(async () => { _resetCoalescerForTests(); await pool.end(); await appPool.end() })
  it('does not seed Association and does not grant it through workspace enablement', async () => {
    const f = await fixture()
    expect([...(await f.context()).activeCapabilities!].some(cap => cap.includes('association'))).toBe(false)
    const before = (await pool.query('SELECT home_apps FROM workspaces WHERE id=$1', [f.workspaceId])).rows
    const notified = vi.spyOn(notifications, 'notifyWorkspaceChange')
    try {
      await modules.act(f.workspaceId, f.userId, { action: 'enable', expectedVersion: 1 })
      expect(notified).toHaveBeenCalledExactlyOnceWith(f.workspaceId, 'workspace_config', 'update')
      expect((await pool.query('SELECT state FROM workspace_modules WHERE workspace_id=$1', [f.workspaceId])).rows[0].state).toBe('enabled')
      await modules.act(f.workspaceId, f.userId, { action: 'enable', expectedVersion: 2 })
      await expect(modules.act(f.workspaceId, f.userId, { action: 'request_disable', expectedVersion: 1 })).rejects.toMatchObject({ code: 'stale_module_version' })
      expect(notified).toHaveBeenCalledTimes(1)
    } finally { notified.mockRestore() }
    expect(await f.call(tools.getAssociationModuleStatus)).toMatchObject({ isError: true, data: { error: 'not_authorized' } })
    expect((await pool.query('SELECT home_apps FROM workspaces WHERE id=$1', [f.workspaceId])).rows).toEqual(before)
  })
  it('configures generic catalogs while disabled, reserves once, and preserves shutdown recovery and actor attribution', async () => {
    const f = await fixture(); await f.grant()
    const plan = record(await f.call(crmTools.saveCrmEntitlementPlan, { plan: { key: 'example-member', name: 'Example Membership', currency: 'USD', feeMinor: 0, billingPeriod: 'manual' } }))
    expect(plan.id).toBeTruthy()
    const event = record(await f.call(crmTools.saveCrmEvent, { event: { slug: 'example-meeting', title: 'Example Meeting', startsAt: '2099-01-01T10:00:00Z',
      endsAt: '2099-01-01T11:00:00Z', timezone: 'UTC', mode: 'venue', status: 'published', capacity: 1 } }))
    const ticketInput = { eventId: event.id, ticket: { key: 'standard', name: 'Standard', currency: 'USD', priceMinor: 0, capacity: 1, status: 'on_sale' } }
    expect(await f.call(tools.saveAssociationTicket, ticketInput)).toMatchObject({ isError: true, data: { error: 'module_disabled' } })
    await modules.act(f.workspaceId, f.userId, { action: 'enable', expectedVersion: 1 })
    const ticket = record(await f.call(tools.saveAssociationTicket, ticketInput))
    const input = { order: { contactId: f.contactId, idempotencyKey: randomUUID(), lines: [
      { ticketId: ticket.id, quantity: 1, attendees: [{ contactId: f.contactId, name: 'Example Attendee' }] },
    ] } }
    const order = record(await f.call(tools.createAssociationOrder, input))
    expect(record(await f.call(tools.createAssociationOrder, input)).id).toBe(order.id)
    await modules.act(f.workspaceId, f.userId, { action: 'request_disable', expectedVersion: 2 })
    expect(record(await f.call(tools.getAssociationOrder, { orderId: order.id })).status).toBe('pending')
    expect(await f.call(tools.createAssociationOrder, { order: { ...input.order, idempotencyKey: randomUUID() } }))
      .toMatchObject({ isError: true, data: { error: 'module_draining' } })
    expect(record(await f.call(tools.cancelAssociationOrder, { orderId: order.id })).status).toBe('cancelled')
    await modules.act(f.workspaceId, f.userId, { action: 'finish_disable', expectedVersion: 3 })
    expect(record(await f.call(tools.getAssociationOrder, { orderId: order.id })).status).toBe('cancelled')
    const audit = await pool.query("SELECT actor_kind,actor_credential_id FROM association_audit_log WHERE workspace_id=$1 AND subject_kind IN('event','entitlement_plan','order')", [f.workspaceId])
    expect(audit.rows.length).toBeGreaterThanOrEqual(4)
    expect(audit.rows.every(row => row.actor_kind === 'assistant' && row.actor_credential_id === f.assistantId)).toBe(true)
    await pool.query("UPDATE assistant_capabilities SET revoked_at=now() WHERE assistant_id=$1 AND capability='home_app:association:read'", [f.assistantId])
    expect(await f.call(tools.getAssociationOrder, { orderId: order.id })).toMatchObject({ isError: true, data: { error: 'not_authorized' } })
  })
})
