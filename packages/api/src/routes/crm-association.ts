/** Member and scoped integration adapters for the canonical vertical service.
 * [COMP:crm/association-service]
 */
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { AssociationCommandSchema, type AssociationContext, type AssociationServicePort } from '@use-brian/core'
import { WORKSPACE_MODULES, WORKSPACE_MODULE_ACTIONS } from '@use-brian/shared'
import type { WorkspaceStore } from '../db/workspace-store.js'
import { associationErrorResponse } from './association.js'
import type { WorkspaceModulesStore } from '../db/workspace-modules-store.js'

export type AssociationContextResolver = (req: Request, res: Response) => Promise<AssociationContext | null>
export function associationMemberContext(workspaces: WorkspaceStore): AssociationContextResolver {
  return async (req, res) => {
    if (!req.userId) { res.status(401).json({ error: 'Unauthorized' }); return null }
    const workspaceId = z.string().uuid().safeParse(req.params.workspaceId)
    if (!workspaceId.success) { res.status(400).json({ error: 'invalid_workspace' }); return null }
    const role = await workspaces.getRole(req.userId, workspaceId.data)
    if (!role) { res.status(404).json({ error: 'workspace_not_found' }); return null }
    return { workspaceId: workspaceId.data, actor: { kind: 'user', userId: req.userId },
      authority: { role, canRead: true, canWrite: true, canConfigure: role === 'owner' || role === 'admin',
        canReconcileProvider: false, trustedIdentitySources: [] } }
  }
}

export function crmAssociationRoutes(options: { service: AssociationServicePort; context: AssociationContextResolver }): Router {
  const router = Router({ mergeParams: true })
  const route = (method: 'get' | 'post' | 'patch', path: string,
    command: (req: Request) => unknown, key: string) => {
    router[method](path, async (req, res) => {
      try {
        const context = await options.context(req, res)
        if (!context) return
        const input = AssociationCommandSchema.parse(command(req))
        const result = await options.service.execute(context, input)
        const createsResource = ['save_ticket', 'create_order', 'reconcile_provider_event'].includes(input.kind)
        res.status(result.created && createsResource ? 201 : 200).json({
          [key]: result.items ?? result.record, ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
          ...(result.created !== undefined ? { created: result.created } : {}),
          ...(result.pendingOrders !== undefined ? { pendingOrders: result.pendingOrders } : {}),
        })
      } catch (error) { associationErrorResponse(error, res) }
    })
  }
  route('get', '/module', () => ({ kind: 'module_status' }), 'module')
  route('get', '/module-blockers', (req) => ({ ...req.query, kind: 'module_blockers' }), 'orders')
  route('get', '/events/:eventId/tickets', (req) => ({ kind: 'list_tickets', eventId: req.params.eventId }), 'tickets')
  route('post', '/events/:eventId/tickets', (req) => ({ kind: 'save_ticket', eventId: req.params.eventId, ticket: req.body }), 'ticket')
  route('get', '/events/:eventId/registrations', (req) => ({ ...req.query, kind: 'list_registrations', eventId: req.params.eventId }), 'registrations')
  route('patch', '/registrations/:id', (req) => ({ kind: 'update_registration', registrationId: req.params.id, update: req.body }), 'registration')
  route('get', '/orders', (req) => ({ ...req.query, kind: 'list_orders' }), 'orders')
  route('post', '/orders', (req) => ({ kind: 'create_order', order: req.body }), 'order')
  route('get', '/orders/:id', (req) => ({ kind: 'get_order', orderId: req.params.id }), 'order')
  for (const [path, kind] of [['cancel', 'cancel_order'], ['confirm-free', 'confirm_free_order']] as const) {
    route('post', `/orders/:id/${path}`, (req) => {
      z.object({}).strict().parse(req.body ?? {})
      return { kind, orderId: req.params.id }
    }, 'order')
  }
  route('post', '/orders/:id/provider-events', (req) => ({ kind: 'reconcile_provider_event', orderId: req.params.id, event: req.body }), 'order')
  return router
}

export function workspaceModuleRoutes(options: { workspaceStore: WorkspaceStore; modules: WorkspaceModulesStore; service: AssociationServicePort }): Router {
  const router = Router()
  const context = associationMemberContext(options.workspaceStore)
  router.get('/:workspaceId/modules', async (req, res) => {
    try {
      const ctx = await context(req, res)
      if (!ctx || ctx.actor.kind !== 'user') return
      res.json({ registry: WORKSPACE_MODULES, modules: await options.modules.listForMember(ctx.workspaceId, ctx.actor.userId) })
    } catch (error) { associationErrorResponse(error, res) }
  })
  router.post('/:workspaceId/modules/association/actions', async (req, res) => {
    try {
      const ctx = await context(req, res)
      if (!ctx) return
      const body = z.object({ action: z.enum(WORKSPACE_MODULE_ACTIONS), expectedVersion: z.number().int().nonnegative() }).strict().parse(req.body)
      const result = await options.service.execute(ctx, { kind: 'module_action', ...body })
      res.json({ module: result.record, changed: result.created, pendingOrders: result.pendingOrders })
    } catch (error) { associationErrorResponse(error, res) }
  })
  return router
}
