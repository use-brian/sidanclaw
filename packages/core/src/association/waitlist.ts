/** Versioned intake template and reference validation. [COMP:crm/association-waitlist] */
import { z } from 'zod'
import { CrmIntakeDefinitionVersionInputSchema, type CrmIntakeDefinitionVersionInput } from '../crm/operations-types.js'

export const AssociationWaitlistOfferInputSchema = z.object({
  submissionId: z.string().uuid(), promotionId: z.string().uuid(),
  reservationMinutes: z.number().int().min(1).max(120).default(20),
  useMemberPrice: z.boolean().default(false),
}).strict()
export type AssociationWaitlistOfferInput = z.infer<typeof AssociationWaitlistOfferInputSchema>

export function associationWaitlistDefinition(input: { eventId: string; ticketId: string; purposeKey: string }): CrmIntakeDefinitionVersionInput {
  z.string().uuid().parse(input.eventId); z.string().uuid().parse(input.ticketId)
  return CrmIntakeDefinitionVersionInputSchema.parse({
    identityPolicy: 'new_or_review', queueKey: 'association_waitlist',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, mapping: { kind: 'base_field', field: 'name' } },
      { key: 'email', label: 'Email', type: 'email', required: true, mapping: { kind: 'base_field', field: 'email' } },
      { key: 'association_event_id', label: 'Event', type: 'text', required: true, options: [input.eventId], mapping: { kind: 'submission_only' } },
      { key: 'association_ticket_id', label: 'Ticket', type: 'text', required: true, options: [input.ticketId], mapping: { kind: 'submission_only' } },
      { key: 'updates_consent', label: 'Updates consent', type: 'boolean', required: false, mapping: { kind: 'submission_only' } },
    ],
    consentMappings: [{ fieldKey: 'updates_consent', grantedValue: true, purposeKey: input.purposeKey }],
  })
}

export function associationWaitlistReferences(snapshot: unknown, submitted: unknown): { eventId: string; ticketId: string } | null {
  const definition = CrmIntakeDefinitionVersionInputSchema.safeParse(snapshot)
  const values = z.record(z.unknown()).safeParse(submitted)
  if (!definition.success || !values.success || definition.data.queueKey !== 'association_waitlist' || !definition.data.consentMappings.length) return null
  const reference = (key: string): string | null => {
    const field = definition.data.fields.find(candidate => candidate.key === key)
    const value = values.data[key]
    return field?.type === 'text' && field.required && field.mapping.kind === 'submission_only'
      && field.options?.length === 1 && field.options[0] === value && z.string().uuid().safeParse(value).success
      ? String(value) : null
  }
  const eventId = reference('association_event_id'), ticketId = reference('association_ticket_id')
  return eventId && ticketId ? { eventId, ticketId } : null
}
