/**
 * Canonical consent/suppression evaluator. Unknown is intentionally distinct
 * from allowed so every outbound consumer fails closed.
 *
 * [COMP:crm/sendability]
 */

import { z } from 'zod'

export const CrmDeliveryChannelSchema = z.enum([
  'email', 'sms', 'phone', 'whatsapp', 'telegram', 'slack',
])
export type CrmDeliveryChannel = z.infer<typeof CrmDeliveryChannelSchema>

export const SendabilityReasonSchema = z.enum([
  'contact_method_missing',
  'global_suppression',
  'channel_suppression',
  'consent_withdrawn',
  'consent_not_recorded',
  'purpose_archived',
  'purpose_channel_inapplicable',
])
export type SendabilityReason = z.infer<typeof SendabilityReasonSchema>

export type SendabilityVerdict = {
  verdict: 'allowed' | 'blocked' | 'unknown'
  reasons: SendabilityReason[]
  effectiveConsentEventId?: string
  effectiveSuppressionEventIds: string[]
}

export type ConsentEvidence = {
  id: string
  action: 'granted' | 'withdrawn'
  occurredAt: string | Date
  createdAt?: string | Date
}

export type SuppressionEvidence = {
  id: string
  channel: 'all' | CrmDeliveryChannel
  action: 'suppressed' | 'released'
  occurredAt: string | Date
  createdAt?: string | Date
}

export type SendabilityInput = {
  channel: CrmDeliveryChannel
  hasContactMethod: boolean
  purpose: {
    archived: boolean
    requiresConsent: boolean
    applicableChannels?: readonly CrmDeliveryChannel[]
  }
  consentEvents: readonly ConsentEvidence[]
  suppressionEvents: readonly SuppressionEvidence[]
}

function instant(value: string | Date): bigint {
  const text = value instanceof Date ? value.toISOString() : value
  const millis = Date.parse(text)
  const fraction = /\.(\d+)/.exec(text)?.[1] ?? ''
  if (!z.string().datetime({ offset: true }).safeParse(text).success
    || !Number.isFinite(millis) || fraction.length > 6) {
    throw new RangeError('Invalid CRM evidence timestamp.')
  }
  return BigInt(millis) * 1000n + BigInt(fraction.padEnd(6, '0').slice(3))
}

function latest<T extends { id: string; occurredAt: string | Date; createdAt?: string | Date }>(
  events: readonly T[],
): T | undefined {
  let winner: T | undefined
  let occurred = 0n, recorded = 0n
  for (const event of events) {
    const at = instant(event.occurredAt)
    const received = instant(event.createdAt ?? event.occurredAt)
    if (!winner || at > occurred || (at === occurred && (received > recorded
      || (received === recorded && event.id > winner.id)))) {
      winner = event
      occurred = at
      recorded = received
    }
  }
  return winner
}

export function evaluateCrmSendability(input: SendabilityInput): SendabilityVerdict {
  const reasons: SendabilityReason[] = []
  const global = latest(input.suppressionEvents.filter((event) => event.channel === 'all'))
  const channel = latest(input.suppressionEvents.filter((event) => event.channel === input.channel))
  const effectiveSuppressions: string[] = []

  if (global?.action === 'suppressed') {
    reasons.push('global_suppression')
    effectiveSuppressions.push(global.id)
  }
  if (channel?.action === 'suppressed') {
    reasons.push('channel_suppression')
    effectiveSuppressions.push(channel.id)
  }
  if (input.purpose.archived) reasons.push('purpose_archived')
  if (input.purpose.applicableChannels?.length
    && !input.purpose.applicableChannels.includes(input.channel)) reasons.push('purpose_channel_inapplicable')
  if (!input.hasContactMethod) reasons.push('contact_method_missing')

  const consent = latest(input.consentEvents)
  if (input.purpose.requiresConsent) {
    if (!consent) reasons.push('consent_not_recorded')
    else if (consent.action === 'withdrawn') reasons.push('consent_withdrawn')
  }

  const blocked = reasons.some((reason) =>
    reason === 'global_suppression'
      || reason === 'channel_suppression'
      || reason === 'consent_withdrawn'
      || reason === 'purpose_archived'
      || reason === 'purpose_channel_inapplicable')
  const unknown = reasons.some((reason) =>
    reason === 'contact_method_missing' || reason === 'consent_not_recorded')

  return {
    verdict: blocked ? 'blocked' : unknown ? 'unknown' : 'allowed',
    reasons,
    ...(consent ? { effectiveConsentEventId: consent.id } : {}),
    effectiveSuppressionEventIds: effectiveSuppressions,
  }
}
