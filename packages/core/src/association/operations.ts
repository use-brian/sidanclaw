/** Canonical vertical command port, shared by member/legacy/integration/tool adapters.
 * [COMP:crm/association-service]
 */
import { z } from 'zod'
import { AssociationWaitlistOfferInputSchema } from './waitlist.js'
import { WORKSPACE_MODULE_ACTIONS } from '@use-brian/shared'
import { CrmOperationsActorSchema, CrmOperationsAuthoritySchema } from '../crm/operations-types.js'
import {
  AssociationTicketInputSchema, AssociationOrderCreateSchema, AssociationProviderEventInputSchema, AssociationProviderBindingInputSchema,
  AssociationRegistrationUpdateSchema, AssociationOrderStatusSchema, AssociationRegistrationStatusSchema,
  AssociationListPageSchema,
} from './domain.js'

const Id = z.string().uuid()
export const AssociationContextSchema = z.object({
  workspaceId: Id,
  actor: CrmOperationsActorSchema,
  authority: CrmOperationsAuthoritySchema.extend({
    canRead: z.boolean(), canReconcileProvider: z.boolean().default(false),
  }),
}).strict()
export type AssociationContext = z.infer<typeof AssociationContextSchema>

export const AssociationCommandSchema = z.union([
  z.object({ kind: z.literal('module_status') }).strict(),
  z.object({ kind: z.literal('module_action'), action: z.enum(WORKSPACE_MODULE_ACTIONS), expectedVersion: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('list_tickets'), eventId: Id }).strict(),
  z.object({ kind: z.literal('save_ticket'), eventId: Id, ticket: AssociationTicketInputSchema }).strict(),
  AssociationListPageSchema.extend({ kind: z.literal('list_waitlist'), eventId: Id.optional(), includeClosed: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal('offer_waitlist_place'), offer: AssociationWaitlistOfferInputSchema }).strict(),
  z.object({ kind: z.literal('create_order'), order: AssociationOrderCreateSchema }).strict(),
  z.object({ kind: z.literal('get_order'), orderId: Id }).strict(),
  AssociationListPageSchema.extend({ kind: z.literal('list_orders'), eventId: Id.optional(),
    contactId: Id.optional(), status: AssociationOrderStatusSchema.optional() }).strict(),
  AssociationListPageSchema.extend({ kind: z.literal('module_blockers') }).strict(),
  z.object({ kind: z.literal('expire_due_order'), orderId: Id }).strict(),
  z.object({ kind: z.literal('cancel_order'), orderId: Id }).strict(),
  z.object({ kind: z.literal('confirm_free_order'), orderId: Id }).strict(),
  z.object({ kind: z.literal('bind_order_provider'), orderId: Id, binding: AssociationProviderBindingInputSchema }).strict(),
  z.object({ kind: z.literal('reconcile_provider_event'), orderId: Id, event: AssociationProviderEventInputSchema }).strict(),
  AssociationListPageSchema.extend({ kind: z.literal('list_registrations'), eventId: Id, status: AssociationRegistrationStatusSchema.optional() }).strict(),
  z.object({ kind: z.literal('update_registration'), registrationId: Id, update: AssociationRegistrationUpdateSchema }).strict(),
])
export type AssociationCommand = z.infer<typeof AssociationCommandSchema>
export type AssociationCommandResult = {
  command: AssociationCommand['kind']
  record?: Record<string, unknown>
  items?: Array<Record<string, unknown>>
  nextCursor?: string | null
  created?: boolean
  pendingOrders?: number
}
export interface AssociationServicePort {
  execute(context: AssociationContext, command: AssociationCommand): Promise<AssociationCommandResult>
}
export const ASSOCIATION_READ_COMMANDS = ['module_status', 'list_tickets', 'get_order', 'list_orders', 'module_blockers', 'list_registrations', 'list_waitlist'] as const
