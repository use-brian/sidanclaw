import { describe, expect, it } from 'vitest'
import { evaluateCrmSendability } from '../sendability.js'

describe('[COMP:crm/sendability] evaluateCrmSendability', () => {
  const base = {
    channel: 'email' as const,
    hasContactMethod: true,
    purpose: { archived: false, requiresConsent: true },
    consentEvents: [{ id: 'consent-1', action: 'granted' as const, occurredAt: '2026-01-01T00:00:00Z' }],
    suppressionEvents: [],
  }

  it('allows only a present address, effective grant, and no suppression', () => {
    expect(evaluateCrmSendability(base)).toEqual({
      verdict: 'allowed',
      reasons: [],
      effectiveConsentEventId: 'consent-1',
      effectiveSuppressionEventIds: [],
    })
  })

  it('returns unknown rather than permission for missing evidence', () => {
    expect(evaluateCrmSendability({
      ...base,
      hasContactMethod: false,
      consentEvents: [],
    })).toEqual({
      verdict: 'unknown',
      reasons: ['contact_method_missing', 'consent_not_recorded'],
      effectiveSuppressionEventIds: [],
    })
  })

  it('blocks an effective global or channel suppression', () => {
    const verdict = evaluateCrmSendability({
      ...base,
      suppressionEvents: [
        { id: 'old-all', channel: 'all', action: 'released', occurredAt: '2026-01-01T00:00:00Z' },
        { id: 'new-all', channel: 'all', action: 'suppressed', occurredAt: '2026-02-01T00:00:00Z' },
        { id: 'email', channel: 'email', action: 'suppressed', occurredAt: '2026-03-01T00:00:00Z' },
      ],
    })
    expect(verdict.verdict).toBe('blocked')
    expect(verdict.reasons).toEqual(['global_suppression', 'channel_suppression'])
    expect(verdict.effectiveSuppressionEventIds).toEqual(['new-all', 'email'])
  })

  it('blocks withdrawal even if an older grant exists', () => {
    expect(evaluateCrmSendability({
      ...base,
      consentEvents: [
        ...base.consentEvents,
        { id: 'consent-2', action: 'withdrawn', occurredAt: '2026-02-01T00:00:00Z' },
      ],
    })).toMatchObject({ verdict: 'blocked', reasons: ['consent_withdrawn'], effectiveConsentEventId: 'consent-2' })
  })

  it('does not require consent for a purpose configured without it', () => {
    expect(evaluateCrmSendability({
      ...base,
      purpose: { archived: false, requiresConsent: false },
      consentEvents: [],
    }).verdict).toBe('allowed')
  })

  it('blocks archived purposes', () => {
    expect(evaluateCrmSendability({
      ...base,
      purpose: { archived: true, requiresConsent: true },
    })).toMatchObject({ verdict: 'blocked', reasons: ['purpose_archived'] })
  })

  it('keeps withdrawal effective when an older grant arrives later', () => {
    expect(evaluateCrmSendability({ ...base, consentEvents: [
      { id: 'withdrawal', action: 'withdrawn', occurredAt: '2026-02-01T00:00:00Z', createdAt: '2026-02-01T00:00:00Z' },
      { id: 'late-grant', action: 'granted', occurredAt: '2026-01-01T00:00:00Z', createdAt: '2026-03-01T00:00:00Z' },
    ] })).toMatchObject({ verdict: 'blocked', effectiveConsentEventId: 'withdrawal' })
  })

  it('orders occurrence, recording, then id without discarding microseconds or timezone offsets', () => {
    const withdrawal = { id: 'a', action: 'withdrawn' as const, occurredAt: '2026-01-01T00:00:00.123457Z', createdAt: '2026-01-01T00:00:00.123458Z' }
    const earlier = { id: 'z', action: 'granted' as const, occurredAt: '2026-01-01T00:00:00.123456Z', createdAt: '2026-02-01T00:00:00Z' }
    expect(evaluateCrmSendability({ ...base, consentEvents: [earlier, withdrawal] })).toMatchObject({ verdict: 'blocked', effectiveConsentEventId: 'a' })
    const tie = { ...earlier, occurredAt: '2025-12-31T19:00:00.123457-05:00', createdAt: '2026-01-01T00:00:00.123457Z' }
    expect(evaluateCrmSendability({ ...base, consentEvents: [tie, withdrawal] })).toMatchObject({ verdict: 'blocked', effectiveConsentEventId: 'a' })
    expect(evaluateCrmSendability({ ...base, consentEvents: [withdrawal, { ...tie, createdAt: withdrawal.createdAt }] })).toMatchObject({ verdict: 'allowed', effectiveConsentEventId: 'z' })
  })

  it('allows suppression release only with a valid grant and no other active suppression', () => {
    const suppressions = [
      { id: 'release', channel: 'email' as const, action: 'released' as const, occurredAt: '2026-02-01T00:00:00Z' },
      { id: 'delayed', channel: 'email' as const, action: 'suppressed' as const, occurredAt: '2026-01-01T00:00:00Z', createdAt: '2026-03-01T00:00:00Z' },
    ]
    expect(evaluateCrmSendability({ ...base, suppressionEvents: suppressions }).verdict).toBe('allowed')
    expect(evaluateCrmSendability({ ...base, suppressionEvents: suppressions, consentEvents: [{ ...base.consentEvents[0], action: 'withdrawn' }] })).toMatchObject({ verdict: 'blocked', reasons: ['consent_withdrawn'] })
    expect(evaluateCrmSendability({ ...base, suppressionEvents: [...suppressions, { ...suppressions[1], channel: 'all' }] })).toMatchObject({ verdict: 'blocked', reasons: ['global_suppression'] })
  })

  it('blocks channel-inapplicable purposes even when consent is not required', () => {
    expect(evaluateCrmSendability({ ...base, purpose: { ...base.purpose, requiresConsent: false, applicableChannels: ['sms'] } })).toMatchObject({ verdict: 'blocked', reasons: ['purpose_channel_inapplicable'] })
    expect(evaluateCrmSendability({ ...base, purpose: { ...base.purpose, applicableChannels: [] } }).verdict).toBe('allowed')
    expect(evaluateCrmSendability({ ...base, purpose: { ...base.purpose, applicableChannels: ['email'] } }).verdict).toBe('allowed')
  })

  it('accepts legacy Date evidence and refuses malformed timestamps', () => {
    expect(evaluateCrmSendability({ ...base, consentEvents: [{ ...base.consentEvents[0], occurredAt: new Date('2026-01-01T00:00:00Z') }] }).verdict).toBe('allowed')
    expect(() => evaluateCrmSendability({ ...base, consentEvents: [{ ...base.consentEvents[0], occurredAt: 'invalid' }] })).toThrow('Invalid CRM evidence timestamp')
  })
})
