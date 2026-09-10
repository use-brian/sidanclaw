/** Closed operation and resource authority for CRM-only keys.
 * Spec: docs/architecture/features/crm-operations.md
 * [COMP:crm/integration-authority]
 */
import { z } from 'zod'

export const CRM_INTEGRATION_OPERATIONS = [
  'crm.records.read', 'crm.records.write', 'crm.catalog.read', 'crm.catalog.configure',
  'crm.submissions.read', 'crm.submissions.write', 'crm.consent.read', 'crm.consent.write',
  'crm.entitlements.read', 'crm.entitlements.write', 'crm.participation.read', 'crm.participation.write',
  'crm.imports.read', 'crm.imports.write', 'crm.audit.read', 'crm.privacy.export', 'crm.privacy.retention',
  'crm.delivery.read', 'crm.delivery.dispatch', 'association.read', 'association.orders.write',
  'association.provider_events.write',
] as const
export const CrmIntegrationOperationSchema = z.enum(CRM_INTEGRATION_OPERATIONS)
export type CrmIntegrationOperation = z.infer<typeof CrmIntegrationOperationSchema>

const Id = z.string().uuid()
const Key = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/)
function selector<T extends z.ZodTypeAny>(item: T) {
  return z.union([z.literal('all'), z.array(item).min(1).max(200).refine((values) => new Set(values).size === values.length, 'Selectors must be unique')])
}
export const CrmIntegrationSelectorsSchema = z.object({
  definitionIds: selector(Id).optional(), purposeKeys: selector(Key).optional(),
  planIds: selector(Id).optional(), eventIds: selector(Id).optional(), providerKeys: selector(Key).optional(),
}).strict()
export type CrmIntegrationSelectors = z.infer<typeof CrmIntegrationSelectorsSchema>
export type CrmIntegrationSelector = keyof CrmIntegrationSelectors

const catalogs = ['definitionIds', 'purposeKeys', 'planIds', 'eventIds'] as const
export const CRM_INTEGRATION_RESOURCE_CATALOG = {
  'crm.records.read': [], 'crm.records.write': [],
  'crm.catalog.read': catalogs, 'crm.catalog.configure': catalogs,
  'crm.submissions.read': ['definitionIds'], 'crm.submissions.write': ['definitionIds'],
  'crm.consent.read': ['purposeKeys'], 'crm.consent.write': ['purposeKeys'],
  'crm.entitlements.read': ['planIds'], 'crm.entitlements.write': ['planIds'],
  'crm.participation.read': ['eventIds'], 'crm.participation.write': ['eventIds'],
  'crm.imports.read': [...catalogs, 'providerKeys'], 'crm.imports.write': [...catalogs, 'providerKeys'],
  'crm.audit.read': [], 'crm.privacy.export': [], 'crm.privacy.retention': [],
  'crm.delivery.read': ['purposeKeys', 'providerKeys'], 'crm.delivery.dispatch': ['purposeKeys', 'providerKeys'],
  'association.read': ['eventIds'], 'association.orders.write': ['eventIds'],
  'association.provider_events.write': ['eventIds', 'providerKeys'],
} as const satisfies Record<CrmIntegrationOperation, readonly CrmIntegrationSelector[]>

export const CrmIntegrationGrantSchema = z.object({
  operation: CrmIntegrationOperationSchema,
  selectors: CrmIntegrationSelectorsSchema.default({}),
}).strict().superRefine((grant, context) => {
  const allowed: readonly string[] = CRM_INTEGRATION_RESOURCE_CATALOG[grant.operation]
  for (const dimension of Object.keys(grant.selectors)) {
    if (!allowed.includes(dimension)) context.addIssue({ code: z.ZodIssueCode.custom,
      path: ['selectors', dimension], message: `Selector does not constrain ${grant.operation}. Valid selectors: ${allowed.join(', ') || '(none; workspace-wide operation)'}` })
  }
})
export type CrmIntegrationGrant = z.infer<typeof CrmIntegrationGrantSchema>
export const CrmIntegrationGrantsSchema = z.array(CrmIntegrationGrantSchema).min(1).max(CRM_INTEGRATION_OPERATIONS.length)
  .refine((grants) => new Set(grants.map((grant) => grant.operation)).size === grants.length, 'One grant per operation is required')

export const CrmIntegrationAuthoritySchema = z.object({
  credentialId: Id, grants: CrmIntegrationGrantsSchema,
}).strict()
export type CrmIntegrationAuthority = z.infer<typeof CrmIntegrationAuthoritySchema>

export class CrmIntegrationScopeError extends Error {
  readonly code = 'integration_scope_denied'
  constructor(readonly operation: string, readonly dimension?: CrmIntegrationSelector) {
    super(dimension ? `Integration grant does not permit this ${dimension} resource for ${operation}`
      : `Integration operation is not granted: ${operation}`)
    this.name = 'CrmIntegrationScopeError'
  }
}

/** The existence of an operation grant never implies all its resources. */
export function requireCrmIntegrationOperation(authority: CrmIntegrationAuthority, operation: CrmIntegrationOperation): CrmIntegrationGrant {
  if (!CRM_INTEGRATION_OPERATIONS.includes(operation)) throw new CrmIntegrationScopeError(operation)
  const grant = authority.grants.find((item) => item.operation === operation)
  if (!grant) throw new CrmIntegrationScopeError(operation)
  return grant
}

/** Use the returned allowlist in SQL before limit/cursor, never filter a page after reading it. */
export function crmIntegrationResourceSelection(authority: CrmIntegrationAuthority, operation: CrmIntegrationOperation,
  dimension: CrmIntegrationSelector): 'all' | readonly string[] {
  const grant = requireCrmIntegrationOperation(authority, operation)
  const allowed: readonly string[] = CRM_INTEGRATION_RESOURCE_CATALOG[operation]
  if (!allowed.includes(dimension)) throw new CrmIntegrationScopeError(operation, dimension)
  return grant.selectors[dimension] ?? []
}

export function requireCrmIntegrationResources(authority: CrmIntegrationAuthority, operation: CrmIntegrationOperation,
  resources: Partial<Record<CrmIntegrationSelector, string | readonly string[] | null>>): void {
  requireCrmIntegrationOperation(authority, operation)
  for (const [key, value] of Object.entries(resources)) {
    const dimension = key as CrmIntegrationSelector
    const allowed = crmIntegrationResourceSelection(authority, operation, dimension)
    // null is an as-yet nonexistent catalog resource, which requires all.
    if (allowed === 'all') continue
    if (value === null) throw new CrmIntegrationScopeError(operation, dimension)
    const requested = typeof value === 'string' ? [value] : value
    if (!requested?.length || requested.some((item) => !allowed.includes(item))) throw new CrmIntegrationScopeError(operation, dimension)
  }
}
