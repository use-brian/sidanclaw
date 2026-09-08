import { describe, expect, it } from 'vitest'
import {
  CrmOperationsCommandSchema,
  CrmIntakeDefinitionVersionInputSchema,
  CrmOperationsError,
  CrmOperationsContextSchema,
  actorAuditIdentity,
  assertCrmOperationsAuthority,
  canonicalCrmRequest,
  crmOperationsSha256,
  mayTransitionCrmEntitlement,
  mayTransitionCrmParticipation,
  parseCrmOperationsCommand,
} from '../operations-types.js'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222'
const ASSISTANT_ID = '33333333-3333-4333-8333-333333333333'
const SESSION_ID = '44444444-4444-4444-8444-444444444444'

describe('[COMP:crm/operations-contract] CRM operations contracts', () => {
  it('bounds verification configuration and refuses authority fields nested in identity claims', () => {
    const definition = { identityPolicy: 'trusted_verified_email', fields: [
      { key: 'email', label: 'Email', type: 'email', required: true, mapping: { kind: 'base_field', field: 'email' } },
    ], identityVerification: { keyId: 'backend', publicKey: 'A'.repeat(43), maxAgeSeconds: 600, acknowledged: true } }
    expect(CrmIntakeDefinitionVersionInputSchema.safeParse(definition).success).toBe(true)
    for (const change of [{ maxAgeSeconds: 0 }, { maxAgeSeconds: 86401 }, { maxAgeSeconds: undefined }, { acknowledged: false }, { privateKey: 'never_accept' }]) {
      expect(CrmIntakeDefinitionVersionInputSchema.safeParse({ ...definition, identityVerification: { ...definition.identityVerification, ...change } }).success).toBe(false)
    }
    expect(CrmOperationsCommandSchema.safeParse({ kind: 'record_submission', definitionKey: 'fixture', idempotencyKey: 'fixture', fields: {}, externalIdentity: { provider: 'fixture', subject: 'subject', verified: true } }).success).toBe(false)
  })
  it('bounds locale maps and rejects client-owned wording evidence', () => {
    const save = { kind: 'save_consent_purpose', purposeKey: 'updates', label: 'Updates', wordingVersion: '1', wording: 'Default' }
    expect(CrmOperationsCommandSchema.safeParse({ ...save, localeWordings: { ja: '同意します' } }).success).toBe(true)
    for (const localeWordings of [{ xx: 'Unknown' }, { en: '' }, { ja: 'x'.repeat(20_001) }]) {
      expect(CrmOperationsCommandSchema.safeParse({ ...save, localeWordings }).success).toBe(false)
    }
    for (const extra of [{ wording: 'Untrusted' }, { wordingHash: 'a'.repeat(64) }, { wordingVersionId: USER_ID }, { locale: 'xx' }]) {
      expect(CrmOperationsCommandSchema.safeParse({ kind: 'record_consent', contactId: USER_ID, purposeKey: 'updates', action: 'granted', source: 'manual', ...extra }).success).toBe(false)
    }
  })

  it('allows exactly one enumerated locale binding on a consent mapping', () => {
    const mapping = { fieldKey: 'agree', grantedValue: true, purposeKey: 'updates' }
    const fields = [
      { key: 'agree', label: 'Agree', type: 'boolean', mapping: { kind: 'submission_only' } },
      { key: 'language', label: 'Language', type: 'text', required: true, options: ['en', 'ja'], mapping: { kind: 'submission_only' } },
    ]
    const parse = (consentMapping: object, localeField: object = fields[1]!) => CrmIntakeDefinitionVersionInputSchema.safeParse({ identityPolicy: 'new_or_review', fields: [fields[0], localeField], consentMappings: [{ ...mapping, ...consentMapping }] }).success
    expect(parse({ locale: 'ja' })).toBe(true)
    expect(parse({ localeFieldKey: 'language' })).toBe(true)
    expect(parse({ locale: 'ja', localeFieldKey: 'language' })).toBe(false)
    expect(parse({ localeFieldKey: 'missing' })).toBe(false)
    for (const change of [{ required: false }, { options: [] }, { options: ['xx'] }, { type: 'string_array' }]) {
      expect(parse({ localeFieldKey: 'language' }, { ...fields[1], ...change })).toBe(false)
    }
  })

  it('parses a server-built actor and authority context', () => {
    expect(CrmOperationsContextSchema.parse({
      workspaceId: WORKSPACE_ID,
      actor: {
        kind: 'assistant',
        assistantId: ASSISTANT_ID,
        userId: USER_ID,
        sessionId: SESSION_ID,
      },
      authority: { role: 'member', canWrite: true, canConfigure: false },
    })).toMatchObject({ workspaceId: WORKSPACE_ID, actor: { kind: 'assistant' } })
  })

  it('rejects duplicate definition field keys and provider-policy drift', () => {
    const parsed = CrmOperationsCommandSchema.safeParse({
      kind: 'save_intake_definition',
      definitionKey: 'contact_form',
      label: 'Contact form',
      definition: {
        identityPolicy: 'trusted_verified_email',
        allowedIdentityProvider: 'website',
        fields: [
          { key: 'email', label: 'Email', type: 'email', required: true, mapping: { kind: 'base_field', field: 'email' } },
          { key: 'email', label: 'Email again', type: 'email', required: false, mapping: { kind: 'submission_only' } },
        ],
      },
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
        'field keys must be unique',
        'identity provider is only valid for external_subject',
      ]))
    }
  })

  it('rejects public attempts to add authority fields to a strict command', () => {
    expect(() => parseCrmOperationsCommand({
      kind: 'record_submission',
      definitionKey: 'contact_form',
      idempotencyKey: 'attempt-1',
      workspaceId: WORKSPACE_ID,
      actor: { kind: 'user', userId: USER_ID },
      verified: true,
      fields: { name: 'Ari Example' },
    })).toThrowError(CrmOperationsError)
  })

  it('canonicalizes object key order for stable idempotency hashes', () => {
    const left = { fields: { z: 2, a: [{ y: true, x: 'ok' }] } }
    const right = { fields: { a: [{ x: 'ok', y: true }], z: 2 } }
    expect(canonicalCrmRequest(left)).toBe(canonicalCrmRequest(right))
    expect(crmOperationsSha256(left)).toBe(crmOperationsSha256(right))
  })

  it('allows intake credentials to record submissions and nothing else', () => {
    const context = CrmOperationsContextSchema.parse({
      workspaceId: WORKSPACE_ID,
      actor: {
        kind: 'intake_key',
        credentialId: '55555555-5555-4555-8555-555555555555',
        definitionId: '66666666-6666-4666-8666-666666666666',
      },
      authority: { role: 'system', canWrite: true, canConfigure: false },
    })
    const submission = CrmOperationsCommandSchema.parse({
      kind: 'record_submission',
      definitionKey: 'contact_form',
      idempotencyKey: 'attempt-1',
      fields: { name: 'Ari Example' },
    })
    expect(() => assertCrmOperationsAuthority(context, submission)).not.toThrow()

    const suppression = CrmOperationsCommandSchema.parse({
      kind: 'record_suppression',
      contactId: '77777777-7777-4777-8777-777777777777',
      channel: 'all',
      action: 'suppressed',
      reasonCode: 'manual_do_not_contact',
      source: 'intake',
    })
    expect(() => assertCrmOperationsAuthority(context, suppression)).toThrowError(
      /only record a submission/,
    )
  })

  it('requires configuration authority for definitions and credential lifecycle', () => {
    const context = CrmOperationsContextSchema.parse({
      workspaceId: WORKSPACE_ID,
      actor: { kind: 'user', userId: USER_ID },
      authority: { role: 'member', canWrite: true, canConfigure: false },
    })
    const command = CrmOperationsCommandSchema.parse({
      kind: 'create_intake_credential',
      label: 'Website',
      definitionIds: ['66666666-6666-4666-8666-666666666666'],
    })
    expect(() => assertCrmOperationsAuthority(context, command)).toThrowError(
      /owner or admin/,
    )
  })

  it('maps every actor to bounded audit attribution', () => {
    expect(actorAuditIdentity({
      kind: 'assistant', assistantId: ASSISTANT_ID, userId: USER_ID, sessionId: SESSION_ID,
    })).toEqual({
      actorKind: 'assistant', actorCredentialId: ASSISTANT_ID, actingUserId: USER_ID,
    })
    expect(actorAuditIdentity({ kind: 'provider', provider: 'mail', eventId: 'evt_123' }))
      .toEqual({ actorKind: 'provider', actorCredentialId: 'evt_123', actingUserId: null })
  })

  it('keeps entitlement and participation lifecycle transitions closed-world', () => {
    expect(mayTransitionCrmEntitlement('pending', 'active')).toBe(true)
    expect(mayTransitionCrmEntitlement('cancelled', 'active')).toBe(false)
    expect(mayTransitionCrmParticipation('registered', 'no_show')).toBe(true)
    expect(mayTransitionCrmParticipation('attended', 'registered')).toBe(false)
    expect(mayTransitionCrmParticipation('made_up', 'attended')).toBe(false)
  })
})
