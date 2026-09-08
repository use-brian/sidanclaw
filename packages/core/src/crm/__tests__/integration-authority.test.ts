import { describe, expect, it } from 'vitest'
import {
  CrmIntegrationGrantsSchema, crmIntegrationResourceSelection,
  requireCrmIntegrationOperation, requireCrmIntegrationResources,
} from '../integration-authority.js'

const selected = '11111111-1111-4111-8111-111111111111'
const outside = '22222222-2222-4222-8222-222222222222'
describe('[COMP:crm/integration-authority] Closed integration ceiling', () => {
  it('refuses unknown operations, privilege grants and meaningless selectors', () => {
    for (const operation of ['crm.erase', 'workspace.modules.enable', 'crm.credentials.write', 'unknown']) {
      expect(CrmIntegrationGrantsSchema.safeParse([{ operation }]).success).toBe(false)
    }
    expect(CrmIntegrationGrantsSchema.safeParse([{ operation: 'crm.records.read', selectors: { eventIds: 'all' } }]).success).toBe(false)
    expect(CrmIntegrationGrantsSchema.safeParse([{ operation: 'association.read', selectors: { eventIds: ['slug-is-not-an-id'] } }]).success).toBe(false)
    expect(CrmIntegrationGrantsSchema.safeParse([{ operation: 'association.read', selectors: { eventIds: [] } }]).success).toBe(false)
    expect(CrmIntegrationGrantsSchema.safeParse([{ operation: 'crm.audit.read' }, { operation: 'crm.audit.read' }]).success).toBe(false)
  })

  it('treats omitted resource selectors as none, independently of operation permission', () => {
    const authority = { credentialId: selected, grants: CrmIntegrationGrantsSchema.parse([{ operation: 'association.read' }]) }
    expect(requireCrmIntegrationOperation(authority, 'association.read')).toBeDefined()
    expect(crmIntegrationResourceSelection(authority, 'association.read', 'eventIds')).toEqual([])
    expect(() => requireCrmIntegrationResources(authority, 'association.read', { eventIds: selected })).toThrow(/does not permit/)
    expect(() => requireCrmIntegrationOperation(authority, 'association.orders.write')).toThrow(/not granted/)
  })

  it('requires every event and provider, and explicit all for catalog creation', () => {
    const authority = { credentialId: selected, grants: CrmIntegrationGrantsSchema.parse([
      { operation: 'association.provider_events.write', selectors: { eventIds: [selected], providerKeys: ['fixture'] } },
      { operation: 'crm.catalog.configure', selectors: { eventIds: [selected], planIds: 'all' } },
    ]) }
    expect(() => requireCrmIntegrationResources(authority, 'association.provider_events.write', { eventIds: [selected], providerKeys: 'fixture' })).not.toThrow()
    for (const resources of [{ eventIds: [selected, outside], providerKeys: 'fixture' }, { eventIds: selected, providerKeys: 'other' }]) {
      expect(() => requireCrmIntegrationResources(authority, 'association.provider_events.write', resources)).toThrow(/does not permit/)
    }
    expect(() => requireCrmIntegrationResources(authority, 'crm.catalog.configure', { eventIds: null })).toThrow()
    expect(() => requireCrmIntegrationResources(authority, 'crm.catalog.configure', { planIds: null })).not.toThrow()
  })
})
