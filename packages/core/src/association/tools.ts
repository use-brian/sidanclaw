/** Native adapters to the canonical commerce service. [COMP:crm/association-tools] */
import { z } from 'zod'
import { WorkspaceModuleError } from '@use-brian/shared'
import { buildTool, type Tool } from '../tools/types.js'
import { missingToolCapability } from '../tools/capability-gate.js'
import { crmOperationsToolContext } from '../crm/operations-tools.js'
import { CrmOperationsError } from '../crm/operations-types.js'
import {
  AssociationError, AssociationListPageSchema, AssociationOrderCreateSchema,
  AssociationOrderStatusSchema, AssociationRegistrationStatusSchema,
  AssociationRegistrationUpdateSchema, AssociationTicketInputSchema,
} from './domain.js'
import { AssociationWaitlistOfferInputSchema } from './waitlist.js'
import { ProviderReceiptStateSchema } from './provider-inbox.js'
import { AssociationCommandSchema, type AssociationCommand, type AssociationServicePort } from './operations.js'

const Id = z.string().uuid()
const OrderId = z.object({ orderId: Id }).strict()
const followPages = ' Follow nextCursor with identical filters until null.'

export function createAssociationTools(service: AssociationServicePort) {
  function command<Input extends z.ZodType>(
    name: string, description: string, inputSchema: Input,
    isReadOnly: boolean, contacts: boolean,
    toCommand: (input: z.infer<Input>) => unknown,
    requiresConfirmation = false,
  ): Tool<Input> {
    const tool: Tool<Input> = buildTool({
      name, description, inputSchema, isReadOnly, isConcurrencySafe: isReadOnly,
      requiresConfirmation,
      requiresCapability: contacts ? 'crm' : 'association',
      homeAppToolSet: { app: 'association', set: isReadOnly ? 'read' : 'write' },
      async execute(rawInput, context) {
        // Gate direct MCP/gateway calls as well as executor-mediated calls.
        const missing = missingToolCapability(tool, context.activeCapabilities)
        if (missing) return { isError: true, data: { error: 'not_authorized', requiredCapability: missing } }
        const crm = crmOperationsToolContext(context)
        if (!crm) return { isError: true, data: { error: 'not_authorized', message: 'Association requires a workspace-scoped assistant or credential.' } }
        try {
          const operation: AssociationCommand = AssociationCommandSchema.parse(toCommand(inputSchema.parse(rawInput)))
          return { data: await service.execute({ ...crm, authority: {
            ...crm.authority, canRead: isReadOnly, canWrite: !isReadOnly,
            canConfigure: false, canReconcileProvider: false,
          } }, operation) }
        } catch (error) {
          if (error instanceof AssociationError || error instanceof CrmOperationsError || error instanceof WorkspaceModuleError) {
            return { isError: true, data: { error: error.code, message: error.message, details: error.details } }
          }
          if (error instanceof z.ZodError) return { isError: true, data: { error: 'invalid_input', message: 'Use the declared fields, returned resource ids and valid quantities.' } }
          return { isError: true, data: { error: 'internal', message: 'Association could not complete this operation.' } }
        }
      },
    })
    return tool
  }
  return {
    getAssociationModuleStatus: command('getAssociationModuleStatus',
      'Read workspace Association module state and version. Module enablement is a human owner/admin action.',
      z.object({}).strict(), true, false, () => ({ kind: 'module_status' })),
    listAssociationTickets: command('listAssociationTickets',
      'List tickets, prices, sale windows and inventory configuration for a returned CRM event id.',
      z.object({ eventId: Id }).strict(), true, false, input => ({ kind: 'list_tickets', ...input })),
    saveAssociationTicket: command('saveAssociationTicket',
      'Create or update an event ticket by its stable key using canonical inventory validation. Enumerate CRM event ids and plan keys first.',
      z.object({ eventId: Id, ticket: AssociationTicketInputSchema }).strict(), false, false, input => ({ kind: 'save_ticket', ...input })),
    listAssociationOrders: command('listAssociationOrders',
      'Read order history, including while the module is disabled. Filters use returned event/contact ids.' + followPages,
      AssociationListPageSchema.extend({ eventId: Id.optional(), contactId: Id.optional(), status: AssociationOrderStatusSchema.optional() }).strict(),
      true, true, input => ({ kind: 'list_orders', ...input })),
    getAssociationOrder: command('getAssociationOrder',
      'Read one order with its lines and current state using a returned order id. A pending order is not proof of payment.',
      OrderId, true, true, input => ({ kind: 'get_order', ...input })),
    createAssociationOrder: command('createAssociationOrder',
      'Reserve ticket inventory for existing CRM contacts. Enumerate tickets first. Reuse the same idempotencyKey and identical envelope after an uncertain response. Member pricing is checked at reservation time. This never asserts payment.',
      z.object({ order: AssociationOrderCreateSchema }).strict(), false, true, input => ({ kind: 'create_order', ...input })),
    confirmFreeAssociationOrder: command('confirmFreeAssociationOrder',
      'Confirm an existing zero-total pending order after approval. The service refuses paid-price orders and expired reservations; provider evidence is required for payments.',
      OrderId, false, true, input => ({ kind: 'confirm_free_order', ...input }), true),
    cancelAssociationOrder: command('cancelAssociationOrder',
      'Cancel an unpaid pending order and release its reservation. Exact replay is safe. Paid orders need provider reconciliation.',
      OrderId, false, true, input => ({ kind: 'cancel_order', ...input })),
    listAssociationRegistrations: command('listAssociationRegistrations',
      'Read attendees and registration state for a returned event id.' + followPages,
      AssociationListPageSchema.extend({ eventId: Id, status: AssociationRegistrationStatusSchema.optional() }).strict(),
      true, true, input => ({ kind: 'list_registrations', ...input })),
    updateAssociationRegistration: command('updateAssociationRegistration',
      'Check in or cancel a returned registration through the canonical participation/inventory authority. This cannot create an attendee or assert payment.',
      z.object({ registrationId: Id, update: AssociationRegistrationUpdateSchema }).strict(),
      false, true, input => ({ kind: 'update_registration', ...input })),
    listAssociationWaitlist: command('listAssociationWaitlist',
      'Read validated waitlist submissions and existing offers. A listed submission does not reserve inventory.' + followPages,
      AssociationListPageSchema.extend({ eventId: Id.optional(), includeClosed: z.boolean().default(false) }).strict(),
      true, true, input => ({ kind: 'list_waitlist', ...input })),
    offerAssociationWaitlistPlace: command('offerAssociationWaitlistPlace',
      'Explicitly offer a listed waitlist submission a place by reserving available ticket inventory. Keep one promotionId for the same intended offer and retry it unchanged. An offer does not send a notification or confirm payment.',
      z.object({ offer: AssociationWaitlistOfferInputSchema }).strict(), false, true, input => ({ kind: 'offer_waitlist_place', ...input })),
    listAssociationModuleBlockers: command('listAssociationModuleBlockers',
      'Read pending orders blocking module drain completion. Resolve these through allowed cancellation or provider reconciliation.' + followPages,
      AssociationListPageSchema.strict(), true, true, input => ({ kind: 'module_blockers', ...input })),
    listAssociationProviderReceipts: command('listAssociationProviderReceipts',
      'Inspect safe provider receipt history and reconciliation states. A receipt needing reconciliation is not successful payment. Only an authenticated backend can apply provider evidence.' + followPages,
      AssociationListPageSchema.extend({ orderId: Id.optional(), entitlementId: Id.optional(), state: ProviderReceiptStateSchema.optional() }).strict(),
      true, true, input => ({ kind: 'list_provider_receipts', ...input })),
  }
}

export type AssociationTools = ReturnType<typeof createAssociationTools>
