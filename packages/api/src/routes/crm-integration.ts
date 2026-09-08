/** CRM-only bearer router. Mount before bare JWT /api guards.
 * [COMP:api/crm-integration-auth]
 */
import { Router, raw, type Request, type Response } from 'express'
import { z } from 'zod'
import {
  CRM_INTEGRATION_OPERATIONS, CRM_INTEGRATION_RESOURCE_CATALOG,
  CrmOperationsCommandSchema, CrmOperationsError, assertCrmOperationsAuthority,
  type CrmOperationsContext, type CrmOperationsServicePort, type AssociationServicePort,
} from '@use-brian/core'
import type { CrmIntegrationPrincipal, CrmIntegrationStore } from '../db/crm-integration-store.js'
import { CreateCrmIntegrationCredentialSchema } from '../db/crm-integration-store.js'
import { createDbCrmIntakeReadStore, type DbCrmOperationsReadStore } from '../db/crm-intake-store.js'
import { createCrmIntegrationRecordReadStore } from '../db/crm-integration-records.js'
import { MAX_CRM_IMPORT_SOURCE_BYTES, type CrmImportSources } from '../db/crm-import-sources.js'
import type { CrmProductionImportService } from '../crm-operations/import-service.js'
import { requireImportOperation } from '../crm-operations/import-authority.js'
import type { WorkspaceStore } from '../db/workspace-store.js'
import { associationErrorResponse } from './association.js'
import { associationMemberContext, crmAssociationRoutes } from './crm-association.js'
import { SubmissionQuery, SendabilityQuery, EntitlementPlansQuery, EntitlementsQuery, EventsQuery, ParticipationQuery } from './crm-operations.js'

const UUID = z.string().uuid()
export function crmIntegrationContext(principal: CrmIntegrationPrincipal): CrmOperationsContext {
  return { workspaceId: principal.workspaceId, actor: { kind: 'integration_key', credentialId: principal.credentialId },
    authority: { role: 'system', canWrite: true,
      canConfigure: principal.grants.some((grant) => grant.operation === 'crm.catalog.configure'),
      trustedIdentitySources: [], integration: { credentialId: principal.credentialId, grants: principal.grants } } }
}

export function crmIntegrationRoutes(options: {
  credentials: Pick<CrmIntegrationStore, 'authenticate'>
  service: CrmOperationsServicePort
  association: AssociationServicePort
  imports?: CrmProductionImportService
  importSources?: CrmImportSources
  reads?: (principal: CrmIntegrationPrincipal) => DbCrmOperationsReadStore
}): Router {
  const router = Router()
  router.use(async (req, res, next) => {
    try {
      const header = req.get('authorization')
      const token = /^Bearer (sk_crm_\S+)$/i.exec(header ?? '')?.[1]
      const principal = token ? await options.credentials.authenticate(token) : null
      if (!principal) { res.status(401).json({ error: 'invalid_crm_integration_credential' }); return }
      res.locals.crmIntegration = principal
      next()
    } catch (error) { associationErrorResponse(error, res) }
  })
  const principal = (res: Response): CrmIntegrationPrincipal => res.locals.crmIntegration as CrmIntegrationPrincipal
  const reads = (res: Response) => (options.reads ?? createDbCrmIntakeReadStore)(principal(res))
  const endpoint = (fn: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
    try { await fn(req, res) } catch (error) { associationErrorResponse(error, res) }
  }
  router.get('/catalog', (_req, res) => res.json({ operations: CRM_INTEGRATION_OPERATIONS,
    selectors: CRM_INTEGRATION_RESOURCE_CATALOG, grants: principal(res).grants }))
  router.post('/operations/import-sources', (req, res, next) => {
    try {
      requireImportOperation(crmIntegrationContext(principal(res)), 'crm.imports.write')
      if (!req.is('text/csv')) { res.status(415).json({ error: 'csv_required' }); return }
      UUID.parse(req.get('Idempotency-Key'))
      next()
    } catch (error) { associationErrorResponse(error, res) }
  }, raw({ type: 'text/csv', limit: MAX_CRM_IMPORT_SOURCE_BYTES, inflate: false }), endpoint(async (req, res) => {
    if (!options.importSources) { res.status(503).json({ error: 'import_unavailable' }); return }
    if (!Buffer.isBuffer(req.body)) throw new CrmOperationsError('invalid_input', 'CSV bytes are required.')
    const result = await options.importSources.stage(crmIntegrationContext(principal(res)), UUID.parse(req.get('Idempotency-Key')), req.body)
    res.status(result.created ? 201 : 200).json(result)
  }))
  const imports = () => {
    if (!options.imports) throw new CrmOperationsError('not_found', 'CRM import service is unavailable.')
    return options.imports
  }
  router.post('/operations/imports/dry-run', endpoint(async (req, res) => {
    res.json(await imports().dryRun(crmIntegrationContext(principal(res)), req.body))
  }))
  router.post('/operations/imports', endpoint(async (req, res) => {
    res.status(201).json(await imports().confirm(crmIntegrationContext(principal(res)), req.body))
  }))
  router.get('/operations/imports', endpoint(async (_req, res) => {
    res.json({ jobs: await imports().list(crmIntegrationContext(principal(res))) })
  }))
  router.get('/operations/imports/:id', endpoint(async (req, res) => {
    const job = await imports().get(crmIntegrationContext(principal(res)), UUID.parse(req.params.id))
    if (!job) { res.status(404).json({ error: 'not_found' }); return }
    res.json(job)
  }))
  for (const action of ['resume', 'cancel'] as const) router.post(`/operations/imports/:id/${action}`, endpoint(async (req, res) => {
    z.object({}).strict().parse(req.body ?? {})
    res.json(await imports()[action](crmIntegrationContext(principal(res)), UUID.parse(req.params.id)))
  }))
  router.get('/operations/imports/:id/errors.csv', endpoint(async (req, res) => {
    const csv = await imports().errorsCsv(crmIntegrationContext(principal(res)), UUID.parse(req.params.id))
    if (csv === null) { res.status(404).json({ error: 'not_found' }); return }
    res.type('text/csv').attachment('crm-import-errors.csv').send(csv)
  }))
  router.get('/operations/records', endpoint(async (req, res) => {
    res.json(await createCrmIntegrationRecordReadStore(principal(res)).list(req.query))
  }))
  router.get('/operations/records/:id', endpoint(async (req, res) => {
    const record = await createCrmIntegrationRecordReadStore(principal(res)).get(req.params.id, req.query)
    if (!record) { res.status(404).json({ error: 'not_found' }); return }
    res.json({ record })
  }))
  router.get('/operations/record-fields', endpoint(async (_req, res) => {
    res.json({ fields: await createCrmIntegrationRecordReadStore(principal(res)).fields() })
  }))
  router.post('/operations/commands', endpoint(async (req, res) => {
    const context = crmIntegrationContext(principal(res))
    if (req.body && ['workspaceId', 'actor', 'authority'].some((key) => Object.hasOwn(req.body, key))) {
      throw new CrmOperationsError('invalid_input', 'Workspace and authority are credential-derived.')
    }
    const command = CrmOperationsCommandSchema.parse(req.body)
    assertCrmOperationsAuthority(context, command)
    const result = await options.service.execute(context, command)
    res.status(result.created ? 201 : 200).json(result)
  }))
  const commands = [
    ['/intake-definitions', 'save_intake_definition'], ['/consent-purposes', 'save_consent_purpose'],
    ['/entitlement-plans', 'save_entitlement_plan'], ['/events', 'save_event'], ['/submissions', 'record_submission'],
    ['/entitlements', 'grant_entitlement'], ['/participation', 'record_participation'],
  ] as const
  for (const [path, kind] of commands) router.post(`/operations${path}`, endpoint(async (req, res) => {
    const context = crmIntegrationContext(principal(res))
    const raw = z.record(z.unknown()).parse(req.body)
    if (['kind', 'workspaceId', 'actor', 'authority'].some((key) => Object.hasOwn(raw, key))) throw new CrmOperationsError('invalid_input', 'Use only command business fields.')
    const command = CrmOperationsCommandSchema.parse({ ...raw, kind })
    assertCrmOperationsAuthority(context, command)
    const result = await options.service.execute(context, command)
    res.status(result.created ? 201 : 200).json(result)
  }))
  router.get('/operations/intake-definitions', endpoint(async (_req, res) => {
    res.json({ definitions: await reads(res).listDefinitions(principal(res).workspaceId) })
  }))
  router.get('/operations/consent-purposes', endpoint(async (req, res) => {
    const query = z.object({ includeArchived: z.enum(['true', 'false']).optional() }).strict().parse(req.query)
    res.json({ purposes: await reads(res).listConsentPurposes(principal(res).workspaceId, query.includeArchived === 'true') })
  }))
  router.get('/operations/submissions', endpoint(async (req, res) => {
    res.json({ submissions: await reads(res).listSubmissions(principal(res).workspaceId, SubmissionQuery.parse(req.query)) })
  }))
  router.get('/operations/submissions/:id', endpoint(async (req, res) => {
    const submission = await reads(res).getSubmission(principal(res).workspaceId, UUID.parse(req.params.id))
    if (!submission) { res.status(404).json({ error: 'not_found' }); return }
    res.json({ submission })
  }))
  router.get('/operations/entitlement-plans', endpoint(async (req, res) => {
    res.json({ plans: await reads(res).listEntitlementPlans(principal(res).workspaceId, EntitlementPlansQuery.parse(req.query)) })
  }))
  router.get('/operations/entitlements', endpoint(async (req, res) => {
    res.json({ entitlements: await reads(res).listEntitlements(principal(res).workspaceId, EntitlementsQuery.parse(req.query)) })
  }))
  router.get('/operations/events', endpoint(async (req, res) => {
    res.json({ events: await reads(res).listEvents(principal(res).workspaceId, EventsQuery.parse(req.query)) })
  }))
  router.get('/operations/participation', endpoint(async (req, res) => {
    res.json({ participation: await reads(res).listParticipation(principal(res).workspaceId, ParticipationQuery.parse(req.query)) })
  }))
  router.get('/operations/contacts/:id/consent', endpoint(async (req, res) => {
    res.json(await reads(res).getConsent(principal(res).workspaceId, UUID.parse(req.params.id)))
  }))
  router.get('/operations/contacts/:id/sendability', endpoint(async (req, res) => {
    const query = SendabilityQuery.parse(req.query)
    res.json(await reads(res).checkSendability(principal(res).workspaceId, UUID.parse(req.params.id), query.channel, query.purposeKey))
  }))
  router.use('/association', crmAssociationRoutes({ service: options.association, context: async (_req, res) => {
    const ctx = crmIntegrationContext(principal(res))
    return { ...ctx, authority: { ...ctx.authority, canRead: true, canReconcileProvider: true } }
  } }))
  // Terminate here. CRM keys must never fall through into member/admin routers.
  router.use((_req, res) => res.status(403).json({ error: 'integration_scope_denied' }))
  return router
}

export function crmIntegrationCredentialRoutes(options: { workspaceStore: WorkspaceStore; credentials: CrmIntegrationStore }): Router {
  const router = Router()
  const member = associationMemberContext(options.workspaceStore)
  const endpoint = (fn: (req: Request, res: Response, workspaceId: string, userId: string) => Promise<void>) => async (req: Request, res: Response) => {
    try {
      const context = await member(req, res)
      if (!context) return
      if (context.actor.kind !== 'user' || !context.authority.canConfigure) throw new CrmOperationsError('not_authorized', 'An owner or admin is required for integration credentials.')
      res.setHeader('Cache-Control', 'no-store')
      await fn(req, res, context.workspaceId, context.actor.userId)
    } catch (error) { associationErrorResponse(error, res) }
  }
  const path = '/:workspaceId/operations/integration-credentials'
  router.get(`${path}/catalog`, endpoint(async (_req, res) => { res.json({ operations: CRM_INTEGRATION_OPERATIONS, selectors: CRM_INTEGRATION_RESOURCE_CATALOG }) }))
  router.get(path, endpoint(async (_req, res, workspaceId, userId) => { res.json({ credentials: await options.credentials.listForMember(workspaceId, userId) }) }))
  router.post(path, endpoint(async (req, res, workspaceId, userId) => {
    res.status(201).json(await options.credentials.create(workspaceId, userId, CreateCrmIntegrationCredentialSchema.parse(req.body)))
  }))
  router.post(`${path}/:id/revoke`, endpoint(async (req, res, workspaceId, userId) => {
    z.object({}).strict().parse(req.body ?? {})
    res.json({ revoked: await options.credentials.revoke(workspaceId, userId, UUID.parse(req.params.id)) })
  }))
  return router
}
