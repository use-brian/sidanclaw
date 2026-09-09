import { describe, expect, it } from 'vitest'
import { associationWaitlistDefinition, associationWaitlistReferences, AssociationWaitlistOfferInputSchema } from '../waitlist.js'
const eventId = '11111111-1111-4111-8111-111111111111', ticketId = '22222222-2222-4222-8222-222222222222'
const values = { association_event_id: eventId, association_ticket_id: ticketId }
describe('[COMP:crm/association-waitlist] Versioned intake reference contract', () => {
  it('uses ordinary consent and new-or-review identity with fixed configured references', () => {
    const definition = associationWaitlistDefinition({ eventId, ticketId, purposeKey: 'updates' })
    expect(definition).toMatchObject({ identityPolicy: 'new_or_review', queueKey: 'association_waitlist', consentMappings: [{ purposeKey: 'updates' }] })
    expect(associationWaitlistReferences(definition, values)).toEqual({ eventId, ticketId })
    expect(associationWaitlistReferences(definition, { ...values, association_ticket_id: eventId })).toBeNull()
    expect(associationWaitlistReferences({ ...definition, consentMappings: [] }, values)).toBeNull()
    expect(associationWaitlistReferences({ ...definition, queueKey: 'other' }, values)).toBeNull()
    expect(associationWaitlistReferences({ ...definition, fields: definition.fields.map(f => f.key === 'association_event_id' ? { ...f, required: false } : f) }, values)).toBeNull()
  })
  it('bounds explicit offers without accepting payment or identity overrides', () => {
    const input = { submissionId: eventId, promotionId: ticketId }
    expect(AssociationWaitlistOfferInputSchema.parse(input)).toMatchObject({ reservationMinutes: 20, useMemberPrice: false })
    for (const patch of [{ reservationMinutes: 121 }, { contactId: ticketId }, { paid: true }]) expect(AssociationWaitlistOfferInputSchema.safeParse({ ...input, ...patch }).success).toBe(false)
  })
})
