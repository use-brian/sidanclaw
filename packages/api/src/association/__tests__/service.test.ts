import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { AssociationCommandSchema, type AssociationContext, type CrmOperationsServicePort } from '@use-brian/core'
import { createAssociationService } from '../service.js'
import type { AssociationStore } from '../../db/association-store.js'
import type { WorkspaceModulesStore } from '../../db/workspace-modules-store.js'

const workspaceId = randomUUID(), userId = randomUUID(), credentialId = randomUUID(), eventId = randomUUID(), orderId = randomUUID()
const member: AssociationContext = { workspaceId, actor: { kind: 'user', userId },
  authority: { role: 'member', canRead: true, canWrite: true, canConfigure: false, canReconcileProvider: false, trustedIdentitySources: [] } }
const command = (raw: unknown) => AssociationCommandSchema.parse(raw)
function fixture() {
  const store = {
    listOrders: vi.fn().mockResolvedValue({ items: [], nextCursor: null, total: 7 }),
    listTickets: vi.fn().mockResolvedValue([]), getOrder: vi.fn().mockResolvedValue({ id: orderId }),
    getRegistrationManagement: vi.fn().mockResolvedValue({ sourceKind: 'manual', eventId }),
    updateRegistration: vi.fn(), reconcileProviderEvent: vi.fn().mockResolvedValue({ record: { id: orderId }, created: true }),
    expireDueOrder: vi.fn(),
    cancelOrder: vi.fn().mockResolvedValue({ record: { id: orderId }, created: true }), confirmFreeOrder: vi.fn(),
  }
  const crm = { execute: vi.fn().mockResolvedValue({ record: { id: orderId, contactId: userId, metadata: {} } }) }
  const modules = { act: vi.fn().mockResolvedValue({ module: { state: 'disabled' }, changed: true, pendingOrders: 0 }),
    getAssociation: vi.fn().mockResolvedValue({ state: 'disabled', version: 3 }) }
  return { store, crm, modules, service: createAssociationService({ store: store as unknown as AssociationStore,
    crmService: crm as CrmOperationsServicePort, modules: modules as unknown as WorkspaceModulesStore }) }
}
function integration(): AssociationContext {
  return { ...member, actor: { kind: 'integration_key', credentialId }, authority: { ...member.authority, role: 'system',
    integration: { credentialId, grants: [{ operation: 'association.read', selectors: { eventIds: [eventId] } }] } } }
}

describe('[COMP:crm/association-service] Canonical authority and adapters', () => {
  it('keeps history/recovery usable without an admission precheck that could hide disabled history', async () => {
    const f = fixture()
    expect((await f.service.execute(member, { kind: 'get_order', orderId })).record?.id).toBe(orderId)
    await f.service.execute(member, { kind: 'cancel_order', orderId })
    expect(f.modules.getAssociation).not.toHaveBeenCalled()
    expect(f.store.cancelOrder).toHaveBeenCalledWith(workspaceId, orderId, { credentialKind: 'user', credentialId: userId, actingUserId: userId })
  })
  it('denies read/write independently, including direct invocation', async () => {
    const f = fixture()
    await expect(f.service.execute({ ...member, authority: { ...member.authority, canRead: false } }, { kind: 'get_order', orderId })).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(f.service.execute({ ...member, authority: { ...member.authority, canWrite: false } }, { kind: 'cancel_order', orderId })).rejects.toMatchObject({ code: 'not_authorized' })
    expect(f.store.getOrder).not.toHaveBeenCalled()
    expect(f.store.cancelOrder).not.toHaveBeenCalled()
  })
  it('confines module changes to owner/admin users, even if a machine claims configuration authority', async () => {
    const f = fixture(), change = command({ kind: 'module_action', action: 'enable', expectedVersion: 1 })
    for (const context of [member, { ...integration(), authority: { ...integration().authority, canConfigure: true } }]) {
      await expect(f.service.execute(context, change)).rejects.toMatchObject({ code: 'not_authorized' })
    }
    await f.service.execute({ ...member, authority: { ...member.authority, role: 'admin', canConfigure: true } }, change)
    expect(f.modules.act).toHaveBeenCalledTimes(1)
    expect(f.modules.act).toHaveBeenCalledWith(workspaceId, userId, expect.objectContaining({ expectedVersion: 1 }))
  })
  it('passes the event ceiling into SQL list inputs before pagination and scopes blocker counts', async () => {
    const f = fixture()
    const result = await f.service.execute(integration(), command({ kind: 'module_blockers', limit: 2 }))
    expect(f.store.listOrders).toHaveBeenCalledWith(workspaceId, { limit: 2, cursor: null, status: 'pending', allowedEventIds: [eventId] })
    expect(result.pendingOrders).toBe(7)
    await expect(f.service.execute(integration(), command({ kind: 'list_orders', eventId: randomUUID() }))).rejects.toMatchObject({ code: 'integration_scope_denied' })
    expect(f.store.listOrders).toHaveBeenCalledTimes(1)
  })
  it('carries the original grant ceiling to by-id reads and refuses mismatched credentials', async () => {
    const f = fixture(), context = integration()
    await f.service.execute(context, { kind: 'get_order', orderId })
    expect(f.store.getOrder).toHaveBeenCalledWith(workspaceId, orderId, expect.objectContaining({ integration: context.authority.integration }))
    await expect(f.service.execute({ ...context, actor: { kind: 'integration_key', credentialId: randomUUID() } }, { kind: 'get_order', orderId })).rejects.toMatchObject({ code: 'integration_scope_denied' })
  })
  it('does not let read scope or intake credentials perform commerce writes', async () => {
    const f = fixture()
    await expect(f.service.execute(integration(), { kind: 'cancel_order', orderId })).rejects.toMatchObject({ code: 'integration_scope_denied' })
    await expect(f.service.execute({ ...member, actor: { kind: 'intake_key', credentialId, definitionId: eventId } }, { kind: 'get_order', orderId })).rejects.toMatchObject({ code: 'not_authorized' })
  })
  it('denies fabricated paid evidence from humans and assistants even with a forged backend boolean', async () => {
    const f = fixture(), input = command({ kind: 'reconcile_provider_event', orderId,
      event: { provider: 'fixture', eventId: 'event-1', targetStatus: 'paid', occurredAt: '2026-09-08T00:00:00Z', amountMinor: 100, currency: 'USD' } })
    for (const actor of [member.actor, { kind: 'assistant' as const, assistantId: userId, sessionId: randomUUID() },
      { kind: 'home_app' as const, credentialId }, { kind: 'provider' as const, provider: 'other', eventId: 'event-1' }]) {
      await expect(f.service.execute({ ...member, actor, authority: { ...member.authority, canReconcileProvider: true } }, input)).rejects.toMatchObject({ code: 'not_authorized' })
    }
    expect(f.store.reconcileProviderEvent).not.toHaveBeenCalled()
    await f.service.execute({ ...member, actor: { kind: 'brain_key', credentialId }, authority: { ...member.authority, canReconcileProvider: true } }, input)
    expect(f.store.reconcileProviderEvent).toHaveBeenCalledTimes(1)
  })
  it('routes generic participation through CRM and preserves the legacy registration envelope', async () => {
    const f = fixture()
    const result = await f.service.execute(member, { kind: 'update_registration', registrationId: orderId, update: { status: 'checked_in' } })
    expect(f.crm.execute).toHaveBeenCalledWith(expect.objectContaining({ workspaceId }), { kind: 'update_participation', participationId: orderId, status: 'attended' })
    expect(result.record).toMatchObject({ attendeeContactId: userId, status: 'checked_in', orderId: null })
    expect(f.store.updateRegistration).not.toHaveBeenCalled()
  })
})
