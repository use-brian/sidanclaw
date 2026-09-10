/**
 * Bounded contracts for the association-operations vertical.
 *
 * These schemas sit at the API/store boundary so a public-site adapter, a
 * migration job, and a future operator UI all submit the same records. Money
 * is always an integer in minor units; provider state is reconciled through a
 * named order transition; flexible source payloads are preserved only inside
 * bounded JSON objects.
 *
 * [COMP:crm/association-domain]
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { APP_LOCALES } from '@use-brian/shared'
import { CrmPageQuerySchema } from '../crm/pagination.js'
import { CrmIntegrationAuthoritySchema } from '../crm/integration-authority.js'

const UUID = z.string().uuid()
const StableKey = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{0,62}$/)
const ProviderKey = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{0,62}$/)
const Currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/)
const Instant = z.string().datetime({ offset: true })
const NonNegativeMinor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

function boundedObject(maxBytes: number) {
  return z.record(z.string().min(1).max(100), z.unknown()).refine(
    (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes,
    `object must serialize to no more than ${maxBytes} bytes`,
  )
}

export const AssociationActorSchema = z.object({
  credentialKind: z.enum(['api_key', 'oauth_token', 'home_app', 'provider', 'user', 'assistant',
    'workflow', 'brain_key', 'intake_key', 'import', 'integration_key', 'system_job']),
  credentialId: z.string().trim().min(1).max(200),
  actingUserId: UUID.optional(),
  integration: CrmIntegrationAuthoritySchema.optional(),
})
export type AssociationActor = z.infer<typeof AssociationActorSchema>

export const AssociationExternalIdentityInputSchema = z.object({
  contactId: UUID,
  provider: ProviderKey,
  providerSubject: z.string().trim().min(1).max(500),
})
export type AssociationExternalIdentityInput = z.infer<typeof AssociationExternalIdentityInputSchema>

export const AssociationEnquiryCreateSchema = z.object({
  contactId: UUID,
  source: StableKey,
  sourceSubmissionId: z.string().trim().min(1).max(500),
  subject: z.string().trim().min(1).max(300),
  message: z.string().trim().min(1).max(20_000),
  queueKey: StableKey.default('general'),
  submittedAt: Instant.optional(),
  submittedData: boundedObject(32_000).default({}),
})
export type AssociationEnquiryCreateInput = z.infer<typeof AssociationEnquiryCreateSchema>

export const AssociationEnquiryStatusSchema = z.enum(['new', 'in_progress', 'resolved', 'spam'])
export type AssociationEnquiryStatus = z.infer<typeof AssociationEnquiryStatusSchema>

export const AssociationEnquiryUpdateSchema = z.object({
  status: AssociationEnquiryStatusSchema.optional(),
  queueKey: StableKey.optional(),
  ownerUserId: UUID.nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, 'at least one change is required')
export type AssociationEnquiryUpdateInput = z.infer<typeof AssociationEnquiryUpdateSchema>

export const AssociationEnquiryNoteInputSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
})
export type AssociationEnquiryNoteInput = z.infer<typeof AssociationEnquiryNoteInputSchema>

export const AssociationConsentInputSchema = z.object({
  contactId: UUID,
  purpose: StableKey,
  action: z.enum(['granted', 'withdrawn']),
  wordingVersion: z.string().trim().min(1).max(100),
  locale: z.enum(APP_LOCALES).optional(),
  source: StableKey,
  occurredAt: Instant.optional(),
  provider: ProviderKey.optional(),
  providerEventId: z.string().trim().min(1).max(500).optional(),
  metadata: boundedObject(8_000).default({}),
}).refine(
  (value) => (value.provider === undefined) === (value.providerEventId === undefined),
  'provider and providerEventId must be supplied together',
)
export type AssociationConsentInput = z.infer<typeof AssociationConsentInputSchema>

export const AssociationPlanInputSchema = z.object({
  key: StableKey,
  name: z.string().trim().min(1).max(200),
  currency: Currency,
  feeMinor: NonNegativeMinor,
  billingPeriod: z.enum(['one_time', 'monthly', 'annual', 'lifetime', 'manual']),
  benefits: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  eligibilityNote: z.string().trim().max(5_000).nullable().optional(),
  activeFrom: Instant.nullable().optional(),
  activeTo: Instant.nullable().optional(),
  published: z.boolean().default(false),
  provider: ProviderKey.optional(),
  providerPlanId: z.string().trim().min(1).max(500).optional(),
}).refine(
  (value) => !value.activeFrom || !value.activeTo || value.activeFrom < value.activeTo,
  'activeTo must be after activeFrom',
).refine(
  (value) => (value.provider === undefined) === (value.providerPlanId === undefined),
  'provider and providerPlanId must be supplied together',
)
export type AssociationPlanInput = z.infer<typeof AssociationPlanInputSchema>

export const AssociationMembershipInputSchema = z.object({
  contactId: UUID,
  planId: UUID,
  idempotencyKey: z.string().trim().min(1).max(200),
  status: z.enum(['pending', 'active', 'expired', 'cancelled']).default('pending'),
  startsAt: Instant,
  endsAt: Instant.nullable().optional(),
  renewalMode: z.enum(['none', 'manual', 'auto']).default('none'),
  provider: ProviderKey.optional(),
  providerMembershipId: z.string().trim().min(1).max(500).optional(),
  providerPeriodId: z.string().trim().min(1).max(500).optional(),
  predecessorId: UUID.optional(),
}).refine(
  (value) => !value.endsAt || value.startsAt < value.endsAt,
  'endsAt must be after startsAt',
).refine(
  (value) => (value.provider === undefined) === (value.providerMembershipId === undefined),
  'provider and providerMembershipId must be supplied together',
).refine(value => !value.providerPeriodId || (!!value.provider && !!value.endsAt), 'A provider period requires provider identity and a finite end').refine(value => !value.predecessorId || !!value.providerPeriodId, 'A predecessor requires a provider period')
export type AssociationMembershipInput = z.infer<typeof AssociationMembershipInputSchema>

export const AssociationMembershipUpdateSchema = z.object({
  status: z.enum(['pending', 'active', 'expired', 'cancelled']).optional(),
  endsAt: Instant.nullable().optional(),
  renewalMode: z.enum(['none', 'manual', 'auto']).optional(),
}).refine((value) => Object.keys(value).length > 0, 'at least one change is required')
export type AssociationMembershipUpdateInput = z.infer<typeof AssociationMembershipUpdateSchema>

function validIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

export const AssociationEventInputSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
  programmeKey: StableKey.nullable().optional(),
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(50_000).default(''),
  startsAt: Instant,
  endsAt: Instant,
  timezone: z.string().trim().min(1).max(100).refine(validIanaTimezone, 'timezone must be a valid IANA timezone'),
  mode: z.enum(['venue', 'online', 'hybrid']),
  venue: z.string().trim().max(2_000).nullable().optional(),
  onlineUrl: z.string().url().max(2_000).nullable().optional(),
  registrationOpensAt: Instant.nullable().optional(),
  registrationClosesAt: Instant.nullable().optional(),
  capacity: z.number().int().positive().max(1_000_000).nullable().optional(),
  status: z.enum(['draft', 'published', 'cancelled', 'completed']).default('draft'),
  canonicalUrl: z.string().url().max(2_000).nullable().optional(),
  metadata: boundedObject(16_000).default({}),
}).refine((value) => value.startsAt < value.endsAt, 'endsAt must be after startsAt')
  .refine(
    (value) => !value.registrationOpensAt || !value.registrationClosesAt
      || value.registrationOpensAt < value.registrationClosesAt,
    'registrationClosesAt must be after registrationOpensAt',
  )
export type AssociationEventInput = z.infer<typeof AssociationEventInputSchema>

export const AssociationTicketInputSchema = z.object({
  key: StableKey,
  name: z.string().trim().min(1).max(200),
  currency: Currency,
  priceMinor: NonNegativeMinor,
  memberPriceMinor: NonNegativeMinor.nullable().optional(),
  eligiblePlanKeys: z.array(StableKey).max(100).default([]),
  capacity: z.number().int().positive().max(1_000_000).nullable().optional(),
  perOrderLimit: z.number().int().positive().max(1_000).default(10),
  saleStartsAt: Instant.nullable().optional(),
  saleEndsAt: Instant.nullable().optional(),
  status: z.enum(['draft', 'on_sale', 'sold_out', 'closed']).default('draft'),
}).refine(
  (value) => !value.saleStartsAt || !value.saleEndsAt || value.saleStartsAt < value.saleEndsAt,
  'saleEndsAt must be after saleStartsAt',
)
export type AssociationTicketInput = z.infer<typeof AssociationTicketInputSchema>

export const AssociationOrderAttendeeSchema = z.object({
  contactId: UUID.optional(),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320).optional(),
  metadata: boundedObject(4_000).default({}),
})

export const AssociationOrderLineInputSchema = z.object({
  ticketId: UUID,
  quantity: z.number().int().positive().max(1_000),
  useMemberPrice: z.boolean().default(false),
  attendees: z.array(AssociationOrderAttendeeSchema).min(1).max(1_000),
}).refine((value) => value.quantity === value.attendees.length, {
  message: 'quantity must equal attendees length',
  path: ['attendees'],
})

export const AssociationOrderCreateSchema = z.object({
  contactId: UUID,
  idempotencyKey: z.string().trim().min(1).max(200),
  reservationMinutes: z.number().int().min(1).max(120).default(20),
  lines: z.array(AssociationOrderLineInputSchema).min(1).max(50),
  metadata: boundedObject(16_000).default({}),
}).refine(
  (value) => new Set(value.lines.map((line) => line.ticketId)).size === value.lines.length,
  'each ticket may appear only once per order',
)
export type AssociationOrderCreateInput = z.infer<typeof AssociationOrderCreateSchema>

export const AssociationOrderStatusSchema = z.enum(['pending', 'paid', 'failed', 'cancelled', 'refunded'])
export type AssociationOrderStatus = z.infer<typeof AssociationOrderStatusSchema>

export const AssociationProviderBindingInputSchema = z.object({
  provider: ProviderKey,
  providerReference: z.string().trim().min(1).max(500),
  amountMinor: z.number().int().nonnegative().safe(),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict()
export type AssociationProviderBindingInput = z.infer<typeof AssociationProviderBindingInputSchema>

export const AssociationProviderEventInputSchema = AssociationProviderBindingInputSchema.extend({
  eventId: z.string().trim().min(1).max(500),
  targetStatus: z.enum(['paid', 'failed', 'cancelled', 'refunded']),
  occurredAt: Instant,
  metadata: boundedObject(8_000).default({}),
})
export type AssociationProviderEventInput = z.infer<typeof AssociationProviderEventInputSchema>

export const AssociationRegistrationStatusSchema = z.enum([
  'reserved', 'confirmed', 'cancelled', 'refunded', 'checked_in',
])
export type AssociationRegistrationStatus = z.infer<typeof AssociationRegistrationStatusSchema>

export const AssociationRegistrationUpdateSchema = z.object({
  status: z.enum(['cancelled', 'checked_in']),
})
export type AssociationRegistrationUpdateInput = z.infer<typeof AssociationRegistrationUpdateSchema>

export const AssociationListPageSchema = CrmPageQuerySchema.strip()

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    )
  }
  return value
}

export function associationFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

const ORDER_TRANSITIONS: Record<AssociationOrderStatus, ReadonlySet<AssociationOrderStatus>> = {
  pending: new Set(['pending', 'paid', 'failed', 'cancelled']),
  paid: new Set(['paid', 'refunded']),
  failed: new Set(['failed']),
  cancelled: new Set(['cancelled']),
  refunded: new Set(['refunded']),
}

export function mayTransitionAssociationOrder(from: AssociationOrderStatus, to: AssociationOrderStatus): boolean {
  return ORDER_TRANSITIONS[from].has(to)
}

const REGISTRATION_TRANSITIONS: Record<AssociationRegistrationStatus, ReadonlySet<AssociationRegistrationStatus>> = {
  reserved: new Set(['reserved', 'confirmed', 'cancelled']),
  confirmed: new Set(['confirmed', 'cancelled', 'refunded', 'checked_in']),
  checked_in: new Set(['checked_in', 'refunded']),
  cancelled: new Set(['cancelled']),
  refunded: new Set(['refunded']),
}

export function mayTransitionAssociationRegistration(
  from: AssociationRegistrationStatus,
  to: AssociationRegistrationStatus,
): boolean {
  return REGISTRATION_TRANSITIONS[from].has(to)
}

export type AssociationErrorCode =
  | 'not_found'
  | 'conflict'
  | 'invalid_transition'
  | 'contact_required'
  | 'not_available'
  | 'member_price_ineligible'

export class AssociationError extends Error {
  constructor(
    readonly code: AssociationErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AssociationError'
  }
}
