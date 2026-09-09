/** Workspace lifecycle and transaction admission. [COMP:api/workspace-modules] */
import type { Pool, PoolClient } from 'pg'
import {
  WORKSPACE_MODULE_ACTIONS, workspaceModuleAdmits,
  type WorkspaceModule, type WorkspaceModuleActionInput, type WorkspaceModuleActionResult,
  type WorkspaceModuleConflict,
} from '@use-brian/shared'
import { applyRLSGucs, getAppPool, getPool } from './client.js'

export class WorkspaceModuleError extends Error {
  constructor(
    readonly code: WorkspaceModuleConflict | 'not_authorized' | 'invalid_input' | 'not_found',
    message: string,
    readonly details?: Record<string, unknown>,
  ) { super(message); this.name = 'WorkspaceModuleError' }
}

const SELECT = `workspace_id AS "workspaceId", module_key AS "moduleKey", state, version,
  enabled_at AS "enabledAt", disable_requested_at AS "disableRequestedAt",
  disabled_at AS "disabledAt", updated_at AS "updatedAt", updated_by_user_id AS "updatedByUserId"`

function record(workspaceId: string, row?: WorkspaceModule): WorkspaceModule {
  if (!row) return { workspaceId, moduleKey: 'association', state: 'disabled', version: 0,
    enabledAt: null, disableRequestedAt: null, disabledAt: null, updatedAt: null, updatedByUserId: null }
  return { ...row, enabledAt: instant(row.enabledAt), disableRequestedAt: instant(row.disableRequestedAt),
    disabledAt: instant(row.disabledAt), updatedAt: instant(row.updatedAt) }
}
function instant(value: string | null): string | null { return value === null ? null : new Date(value).toISOString() }

/** Must be the first domain lock in a vertical transaction, held through commit. */
export async function lockAssociationModule(client: PoolClient, workspaceId: string): Promise<WorkspaceModule> {
  const result = await client.query<WorkspaceModule>(
    `SELECT ${SELECT} FROM workspace_modules WHERE workspace_id=$1 AND module_key='association' FOR SHARE`, [workspaceId])
  if (!result.rows[0]) {
    // Serialize recovery with lifecycle's missing-row provisioning, then re-read
    // after the parent lock. Absence still never admits new commerce.
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [workspaceId])
    const retried = await client.query<WorkspaceModule>(
      `SELECT ${SELECT} FROM workspace_modules WHERE workspace_id=$1 AND module_key='association' FOR SHARE`, [workspaceId])
    return record(workspaceId, retried.rows[0])
  }
  return record(workspaceId, result.rows[0])
}

export function requireAssociationAdmission(module: WorkspaceModule): void {
  if (workspaceModuleAdmits(module.state, 'new_commerce')) return
  throw new WorkspaceModuleError(module.state === 'draining' ? 'module_draining' : 'module_disabled',
    'New Association commerce is unavailable. An owner or admin can review the module state.',
    { state: module.state, version: module.version })
}

async function pendingOrders(client: PoolClient, workspaceId: string): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM association_orders WHERE workspace_id=$1 AND status='pending'`, [workspaceId])
  return result.rows[0].count
}

async function memberTransaction<T>(pool: Pool, workspaceId: string, userId: string, admin: boolean,
  fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, userId)
    const member = await client.query<{ role: string }>(
      'SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', [workspaceId, userId])
    if (!member.rows[0] || (admin && !['owner', 'admin'].includes(member.rows[0].role))) {
      throw new WorkspaceModuleError('not_authorized', admin ? 'An owner or admin member is required' : 'Workspace membership is required')
    }
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client.release() }
}

export function createWorkspaceModulesStore(pool: Pool = getPool(), memberPool: Pool = getAppPool()) {
  return {
    /** System/tool reads require the caller's already-resolved workspace authority. */
    async getAssociation(workspaceId: string): Promise<WorkspaceModule> {
      const result = await pool.query<WorkspaceModule>(
        `SELECT ${SELECT} FROM workspace_modules WHERE workspace_id=$1 AND module_key='association'`, [workspaceId])
      return record(workspaceId, result.rows[0])
    },
    async listForMember(workspaceId: string, userId: string): Promise<WorkspaceModule[]> {
      return memberTransaction(memberPool, workspaceId, userId, false, async (client) => {
        const result = await client.query<WorkspaceModule>(
          `SELECT ${SELECT} FROM workspace_modules WHERE workspace_id=$1 AND module_key='association'`, [workspaceId])
        return [record(workspaceId, result.rows[0])]
      })
    },
    async act(workspaceId: string, userId: string, input: WorkspaceModuleActionInput): Promise<WorkspaceModuleActionResult> {
      if (!WORKSPACE_MODULE_ACTIONS.includes(input.action) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
        throw new WorkspaceModuleError('invalid_input', 'A known action and a nonnegative expectedVersion are required')
      }
      return memberTransaction(memberPool, workspaceId, userId, true, async (client) => {
        let result = await client.query<WorkspaceModule>(
          `SELECT ${SELECT} FROM workspace_modules WHERE workspace_id=$1 AND module_key='association' FOR UPDATE`, [workspaceId])
        let wasMissing = false
        if (!result.rows[0]) {
          const parent = await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])
          if (!parent.rowCount) throw new WorkspaceModuleError('not_found', 'Workspace not found')
          // Another legacy creator/lifecycle transaction may have inserted it
          // while we waited on the parent lock. Preserve its state and version.
          result = await client.query<WorkspaceModule>(
            `SELECT ${SELECT} FROM workspace_modules WHERE workspace_id=$1 AND module_key='association' FOR UPDATE`, [workspaceId])
          if (!result.rows[0]) {
            wasMissing = true
            result = await client.query<WorkspaceModule>(
              `INSERT INTO workspace_modules (workspace_id,module_key,state,disabled_at)
               VALUES ($1,'association','disabled',now()) RETURNING ${SELECT}`, [workspaceId])
          }
        }
        const current = record(workspaceId, result.rows[0])
        const observedVersion = wasMissing ? 0 : current.version
        if (observedVersion !== input.expectedVersion) {
          throw new WorkspaceModuleError('stale_module_version', 'Module state changed; reload before trying again', { version: observedVersion })
        }
        const pending = await pendingOrders(client, workspaceId)
        if (input.action === 'finish_disable' && pending > 0) {
          throw new WorkspaceModuleError('module_drain_pending', 'Pending orders must settle or expire before shutdown finishes', { pendingOrders: pending })
        }
        const state = input.action === 'enable' ? 'enabled'
          : input.action === 'request_disable' && pending > 0 ? 'draining' : 'disabled'
        if (state === current.state) return { module: current, changed: false, pendingOrders: pending }
        const changed = await client.query<WorkspaceModule>(
          `UPDATE workspace_modules SET state=$2,version=version+1,updated_at=now(),updated_by_user_id=$3,
             enabled_at=CASE WHEN $2='enabled' THEN now() ELSE enabled_at END,
             disable_requested_at=CASE WHEN $2='enabled' THEN NULL ELSE coalesce(disable_requested_at,now()) END,
             disabled_at=CASE WHEN $2='disabled' THEN now() ELSE NULL END
           WHERE workspace_id=$1 AND module_key='association' RETURNING ${SELECT}`, [workspaceId, state, userId])
        const module = record(workspaceId, changed.rows[0])
        await client.query(`INSERT INTO workspace_audit_log (workspace_id,actor_user_id,event_type,subject_id,details)
          VALUES ($1,$2,'workspace.module_changed',$1,$3)`, [workspaceId, userId,
          { moduleKey: 'association', action: input.action, from: current.state, to: state, version: module.version }])
        return { module, changed: true, pendingOrders: pending }
      })
    },
  }
}
export type WorkspaceModulesStore = ReturnType<typeof createWorkspaceModulesStore>

/** Finish only a previously owner-requested drain. [COMP:crm/association-lifecycle] */
export async function finishAssociationDrain(workspaceId:string,pool:Pool=getPool()):Promise<boolean> {
  const client=await pool.connect()
  try {
    await client.query('BEGIN')
    const current=(await client.query<{version:number}>(`SELECT version FROM workspace_modules
      WHERE workspace_id=$1 AND module_key='association' AND state='draining' FOR UPDATE`,[workspaceId])).rows[0]
    if(!current || await pendingOrders(client,workspaceId)>0){await client.query('COMMIT');return false}
    await client.query(`UPDATE workspace_modules SET state='disabled',version=version+1,disabled_at=clock_timestamp(),updated_at=clock_timestamp(),updated_by_user_id=NULL
      WHERE workspace_id=$1 AND module_key='association'`,[workspaceId])
    await client.query(`INSERT INTO workspace_audit_log(workspace_id,event_type,subject_id,details)
      VALUES($1,'workspace.module_changed',$1,$2::jsonb)`,[workspaceId,JSON.stringify({moduleKey:'association',action:'finish_disable',from:'draining',to:'disabled',version:current.version+1,actorKind:'system_job'})])
    await client.query('COMMIT');return true
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}finally{client.release()}
}
