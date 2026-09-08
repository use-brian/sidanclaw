import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { CrmIntegrationScopeError, CrmOperationsError, type CrmOperationsServicePort, type AssociationServicePort } from '@use-brian/core'
import { crmIntegrationRoutes, crmIntegrationCredentialRoutes } from '../crm-integration.js'
import { crmAssociationRoutes, associationMemberContext, workspaceModuleRoutes } from '../crm-association.js'
import { createAssociationService } from '../../association/service.js'
import type { CrmIntegrationStore, CrmIntegrationPrincipal } from '../../db/crm-integration-store.js'
import type { WorkspaceStore } from '../../db/workspace-store.js'
import type { WorkspaceModulesStore } from '../../db/workspace-modules-store.js'
import type { AssociationStore } from '../../db/association-store.js'
import { authenticateBrainRequest } from '../../brain-mcp/auth.js'
import type { BrainKeyStore } from '../../db/brain-keys-store.js'
import { parseCrmIntakeToken } from '../../db/crm-intake-store.js'

const workspaceId = randomUUID(), credentialId = randomUUID(), userId = randomUUID(), eventId = randomUUID()
const token = `sk_crm_${credentialId}_${'A'.repeat(43)}`
const principal: CrmIntegrationPrincipal = { workspaceId, credentialId, grants: [{ operation: 'crm.catalog.configure', selectors: { eventIds: 'all' } }] }
function fixture(auth: CrmIntegrationPrincipal | null = principal) {
  const service = { execute: vi.fn().mockResolvedValue({ command: 'save_event', record: { id: eventId }, created: true }) }
  const association = { execute: vi.fn().mockRejectedValue(new CrmIntegrationScopeError('association.read')) }
  const authenticate = vi.fn().mockResolvedValue(auth)
  const app = express()
  app.use(express.json())
  app.use('/api/crm/integration', crmIntegrationRoutes({ credentials: { authenticate }, service: service as CrmOperationsServicePort, association: association as AssociationServicePort }))
  const jwtGuard = vi.fn((_req, res) => res.status(401).json({ error: 'jwt_only' }))
  app.use('/api', jwtGuard)
  return { app, service, association, authenticate, jwtGuard }
}

describe('[COMP:api/crm-integration-auth] Route isolation and shared adapters', () => {
  it('runs before JWT-only guards, derives context from the CRM credential and exposes no secret', async () => {
    const f = fixture()
    const result = await request(f.app).get('/api/crm/integration/catalog').set('Authorization', `Bearer ${token}`)
    expect(result.status).toBe(200)
    expect(result.body.grants).toEqual(principal.grants)
    expect(JSON.stringify(result.body)).not.toContain(token)
    expect(f.jwtGuard).not.toHaveBeenCalled()
    const response = await request(f.app).post('/api/crm/integration/operations/events').set('Authorization', `Bearer ${token}`).send({
      slug: 'fixture', title: 'Fixture', startsAt: '2099-01-01T10:00:00Z', endsAt: '2099-01-01T12:00:00Z', timezone: 'UTC', mode: 'venue',
    })
    expect(response.status).toBe(201)
    expect(f.service.execute).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, actor: { kind: 'integration_key', credentialId },
      authority: expect.objectContaining({ integration: { credentialId, grants: principal.grants }, trustedIdentitySources: [] }) }), expect.objectContaining({ kind: 'save_event' }))
  })
  it.each(['', 'Bearer sk_intake_fixture', 'Bearer sk_brian_fixture', 'Bearer first-party-jwt'])(
    'rejects other credential families before authentication: %s', async (authorization) => {
      const f = fixture()
      const response = await request(f.app).get('/api/crm/integration/catalog').set('Authorization', authorization)
      expect(response.status).toBe(401)
      expect(f.authenticate).not.toHaveBeenCalled()
    },
  )
  it('rejects invalid/revoked keys and does not fall through to another authority', async () => {
    const f = fixture(null)
    expect((await request(f.app).get('/api/crm/integration/catalog').set('Authorization', `Bearer ${token}`)).status).toBe(401)
    expect(f.jwtGuard).not.toHaveBeenCalled()
  })
  it('returns 401 when a previously authenticated key loses admission at transaction time', async () => {
    const f=fixture()
    f.service.execute.mockRejectedValueOnce(new CrmOperationsError('credential_revoked','The CRM integration credential is no longer active.'))
    const response=await request(f.app).post('/api/crm/integration/operations/events').set('Authorization',`Bearer ${token}`).send({
      slug: 'fixture',title: 'Fixture',startsAt: '2099-01-01T10:00:00Z',endsAt: '2099-01-01T12:00:00Z',timezone: 'UTC',mode: 'venue',
    })
    expect(response.status).toBe(401)
    expect(response.body.error).toBe('credential_revoked')
    expect(f.jwtGuard).not.toHaveBeenCalled()
  })
  it.each(['/modules/association/actions', '/operations/intake-credentials', '/operations/integration-credentials', '/operations/contacts/erase', '/operations/privacy/erase', '/chat', '/brain/mcp'])(
    'has no machine escalation route: %s', async (path) => {
      const f = fixture()
      const response = await request(f.app).post(`/api/crm/integration${path}`).set('Authorization', `Bearer ${token}`).send({ confirmed: true })
      expect(response.status).toBe(403)
      expect(response.body.error).toBe('integration_scope_denied')
      expect(f.service.execute).not.toHaveBeenCalled()
      expect(f.jwtGuard).not.toHaveBeenCalled()
    },
  )
  it('refuses body workspace/actor authority and command-level credential administration', async () => {
    const f = fixture()
    for (const field of ['workspaceId', 'actor', 'authority']) {
      const response = await request(f.app).post('/api/crm/integration/operations/commands').set('Authorization', `Bearer ${token}`).send({ kind: 'save_event', [field]: workspaceId })
      expect(response.status).toBe(422)
    }
    const response = await request(f.app).post('/api/crm/integration/operations/commands').set('Authorization', `Bearer ${token}`).send({ kind: 'revoke_intake_credential', credentialId })
    expect(response.status).toBe(403)
    expect(f.service.execute).not.toHaveBeenCalled()
  })
  it('denies an ungranted command before calling the canonical service', async () => {
    const f = fixture({ ...principal, grants: [{ operation: 'crm.records.read', selectors: {} }] })
    const response = await request(f.app).post('/api/crm/integration/operations/commands').set('Authorization', `Bearer ${token}`).send({ kind: 'archive_segment', segmentId: eventId })
    expect(response.status).toBe(403)
    expect(response.body.error).toBe('integration_scope_denied')
    expect(f.service.execute).not.toHaveBeenCalled()
  })
  it('cannot authenticate CRM keys at Brain MCP or the definition-scoped intake boundary', async () => {
    const brain = { authenticate: vi.fn(), getById: vi.fn() } as unknown as BrainKeyStore
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as express.Request
    expect(await authenticateBrainRequest(req, { brainKeyStore: brain })).toBeNull()
    expect(parseCrmIntakeToken(token)).toBeNull()
  })
  it('member adapters ignore machine headers and verify workspace membership before commands', async () => {
    const workspaceStore = { getRole: vi.fn().mockResolvedValue(null) } as unknown as WorkspaceStore
    const service = { execute: vi.fn() } as unknown as AssociationServicePort
    const app = express()
    app.use('/api/crm/:workspaceId/association', crmAssociationRoutes({ service, context: associationMemberContext(workspaceStore) }))
    expect((await request(app).get(`/api/crm/${workspaceId}/association/orders`).set('Authorization', `Bearer ${token}`)).status).toBe(401)
    expect(workspaceStore.getRole).not.toHaveBeenCalled()
    expect(service.execute).not.toHaveBeenCalled()
  })
  it('keeps member module reads separate from owner/admin actions and credential issuance', async () => {
    const workspaceStore = { getRole: vi.fn().mockResolvedValue('member') } as unknown as WorkspaceStore
    const credentials = { create: vi.fn(), listForMember: vi.fn() } as unknown as CrmIntegrationStore
    const modules = { listForMember: vi.fn().mockResolvedValue([{ state: 'disabled', version: 1 }]), act: vi.fn() } as unknown as WorkspaceModulesStore
    const service = createAssociationService({ modules, store: {} as AssociationStore, crmService: {} as CrmOperationsServicePort })
    const app = express()
    app.use(express.json(), (req, _res, next) => { req.userId = userId; next() })
    app.use('/api/workspaces', workspaceModuleRoutes({ workspaceStore, modules, service }))
    app.use('/api/crm', crmIntegrationCredentialRoutes({ workspaceStore, credentials }))
    expect((await request(app).get(`/api/workspaces/${workspaceId}/modules`)).status).toBe(200)
    expect((await request(app).post(`/api/workspaces/${workspaceId}/modules/association/actions`).send({ action: 'enable', expectedVersion: 1 })).status).toBe(403)
    expect((await request(app).post(`/api/crm/${workspaceId}/operations/integration-credentials`).send({})).status).toBe(403)
    expect(modules.act).not.toHaveBeenCalled()
    expect(credentials.create).not.toHaveBeenCalled()
  })
})
