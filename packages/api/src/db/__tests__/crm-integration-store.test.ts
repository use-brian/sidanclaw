import { describe, expect, it } from 'vitest'
import { parseCrmIntegrationToken } from '../crm-integration-store.js'
import { parseBrainAuthToken } from '../brain-keys-store.js'
import { parseCrmIntakeToken } from '../crm-intake-store.js'
import { parseAuthToken } from '../api-key-store.js'

describe('[COMP:api/crm-integration-auth] Credential family boundary', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const secret = 'A'.repeat(43)
  const token = `sk_crm_${id}_${secret}`
  it('uses a distinct, bounded secret format', () => {
    expect(parseCrmIntegrationToken(token)).toEqual({ credentialId: id, secret })
    for (const candidate of [token + 'A', token.slice(0, -1), token.replace('sk_crm_', 'sk_brain_'),
      token.replace('sk_crm_', 'sk_intake_'), token.replace('sk_crm_', 'sk_live_'), 'invalid']) {
      expect(parseCrmIntegrationToken(candidate)).toBeNull()
    }
  })
  it('does not authenticate as Brain or intake', () => {
    expect(parseBrainAuthToken(token)).toBeNull()
    expect(parseCrmIntakeToken(token)).toBeNull()
    expect(parseAuthToken(token)).toBeNull()
  })
})
