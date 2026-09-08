/** Canonical Association command authority. [COMP:crm/association-service] */
import {
  ASSOCIATION_READ_COMMANDS, AssociationCommandSchema, AssociationContextSchema,
  AssociationError, CrmOperationsError, CrmIntegrationScopeError,
  actorAuditIdentity, crmIntegrationResourceSelection, decodeAssociationCursor,
  requireCrmIntegrationOperation, requireCrmIntegrationResources,
  type AssociationActor, type AssociationContext, type AssociationServicePort,
  type CrmIntegrationOperation, type CrmOperationsServicePort,
} from '@use-brian/core'
import { createAssociationStore, type AssociationStore } from '../db/association-store.js'
import { createWorkspaceModulesStore, type WorkspaceModulesStore } from '../db/workspace-modules-store.js'

function actor(context: AssociationContext): AssociationActor {
  const identity = actorAuditIdentity(context.actor)
  return { credentialKind: context.actor.kind, credentialId: identity.actorCredentialId,
    ...(identity.actingUserId ? { actingUserId: identity.actingUserId } : {}),
    ...(context.authority.integration ? { integration: context.authority.integration } : {}) }
}

export function createAssociationService(options: {
  crmService: CrmOperationsServicePort
  store?: AssociationStore
  modules?: WorkspaceModulesStore
}): AssociationServicePort {
  const store = options.store ?? createAssociationStore()
  // Resolve the default lazily so pure command tests never open a database.
  const modules = () => options.modules ?? createWorkspaceModulesStore()
  return {
    async execute(rawContext, rawCommand) {
      const context = AssociationContextSchema.parse(rawContext)
      const command = AssociationCommandSchema.parse(rawCommand)
      const { workspaceId, authority } = context
      const integration = authority.integration
      const read = (ASSOCIATION_READ_COMMANDS as readonly string[]).includes(command.kind)
      if (!(read ? authority.canRead : authority.canWrite)) throw new CrmOperationsError('not_authorized', 'Association authority is required.')
      if (context.actor.kind === 'intake_key') throw new CrmOperationsError('not_authorized', 'An intake credential cannot operate Association commerce.')
      if (context.actor.kind === 'integration_key' && integration?.credentialId !== context.actor.credentialId) throw new CrmIntegrationScopeError('association.read')
      const operation: CrmIntegrationOperation = read ? 'association.read'
        : command.kind === 'save_ticket' ? 'crm.catalog.configure'
        : command.kind === 'reconcile_provider_event' ? 'association.provider_events.write' : 'association.orders.write'
      if (integration) {
        if (command.kind === 'module_action') throw new CrmOperationsError('not_authorized', 'A member owner or admin is required for module actions.')
        requireCrmIntegrationOperation(integration, operation)
        if ('eventId' in command && command.eventId) requireCrmIntegrationResources(integration, operation, { eventIds: command.eventId })
      }
      if (context.actor.kind === 'system_job' && !(
        context.actor.job === 'association_reconciliation' && command.kind === 'reconcile_provider_event'
      )) throw new CrmOperationsError('not_authorized', 'This system job cannot perform the requested Association command.')
      const dbActor = actor(context)
      const output = { command: command.kind }
      const pagination = () => {
        if (!('limit' in command)) throw new Error('Command has no pagination')
        const cursor = decodeAssociationCursor(command.cursor)
        if (command.cursor && !cursor) throw new CrmOperationsError('invalid_input', 'Invalid Association cursor.')
        return { limit: command.limit, cursor }
      }
      switch (command.kind) {
        case 'module_status': return { ...output, record: { ...(await modules().getAssociation(workspaceId)) } }
        case 'module_action': {
          if (context.actor.kind !== 'user' || !authority.canConfigure || !['owner', 'admin'].includes(authority.role)) {
            throw new CrmOperationsError('not_authorized', 'A member owner or admin is required for module actions.')
          }
          const changed = await modules().act(workspaceId, context.actor.userId, command)
          return { ...output, record: { ...changed.module }, created: changed.changed, pendingOrders: changed.pendingOrders }
        }
        case 'list_tickets': return { ...output, items: await store.listTickets(workspaceId, command.eventId) }
        case 'save_ticket': return { ...output, ...(await store.upsertTicket(workspaceId, command.eventId, command.ticket, dbActor)) }
        case 'create_order': return { ...output, ...(await store.createOrder(workspaceId, command.order, dbActor)) }
        case 'get_order': {
          const record = await store.getOrder(workspaceId, command.orderId, dbActor)
          if (!record) throw new AssociationError('not_found', 'order not found')
          return { ...output, record }
        }
        case 'list_orders':
        case 'module_blockers': {
          const selected = integration ? crmIntegrationResourceSelection(integration, 'association.read', 'eventIds') : 'all'
          const page = await store.listOrders(workspaceId, { ...pagination(),
            ...(command.kind === 'module_blockers' ? { status: 'pending' as const }
              : { eventId: command.eventId, status: command.status, contactId: command.contactId }),
            ...(selected === 'all' ? {} : { allowedEventIds: selected }),
          })
          return { ...output, items: page.items, nextCursor: page.nextCursor,
            ...(command.kind === 'module_blockers' ? { pendingOrders: page.total } : {}) }
        }
        case 'cancel_order': return { ...output, ...(await store.cancelOrder(workspaceId, command.orderId, dbActor)) }
        case 'confirm_free_order': return { ...output, ...(await store.confirmFreeOrder(workspaceId, command.orderId, dbActor)) }
        case 'reconcile_provider_event': {
          if (!authority.canReconcileProvider || !['brain_key', 'oauth_token', 'integration_key', 'provider', 'system_job'].includes(context.actor.kind)) {
            throw new CrmOperationsError('not_authorized', 'Verified backend payment evidence is required; member and assistant commands cannot mark a checkout paid.')
          }
          if (context.actor.kind === 'provider' && (context.actor.provider !== command.event.provider || context.actor.eventId !== command.event.eventId)) {
            throw new CrmOperationsError('not_authorized', 'Provider evidence does not match the authenticated provider event.')
          }
          return { ...output, ...(await store.reconcileProviderEvent(workspaceId, command.orderId, command.event, dbActor)) }
        }
        case 'list_registrations': return { ...output, ...(await store.listEventRegistrations(workspaceId, command.eventId, { ...pagination(), status: command.status })) }
        case 'update_registration': {
          const management = await store.getRegistrationManagement(workspaceId, command.registrationId)
          if (!management) throw new AssociationError('not_found', 'registration not found')
          if (integration) requireCrmIntegrationResources(integration, operation, { eventIds: management.eventId ?? null })
          if (management.sourceKind === 'commerce') return { ...output, record: await store.updateRegistration(workspaceId, command.registrationId, command.update, dbActor) }
          const result = await options.crmService.execute(context, { kind: 'update_participation', participationId: command.registrationId,
            status: command.update.status === 'checked_in' ? 'attended' : 'cancelled' })
          const { contactId, metadata, ...rest } = result.record
          return { ...output, record: { workspaceId, ...rest, attendeeContactId: contactId ?? null,
            attendeeMetadata: metadata ?? {}, orderId: null, orderLineId: null, ticketId: null,
            reservationExpiresAt: null, status: command.update.status } }
        }
      }
    },
  }
}
