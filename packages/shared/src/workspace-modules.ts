/** Static product modules, independent of Home navigation and assistant grants.
 * Spec: docs/architecture/features/association-operations.md
 * [COMP:shared/workspace-modules]
 */
export const WORKSPACE_MODULES = {
  association: { key: 'association', defaultState: 'disabled' },
} as const

export type WorkspaceModuleKey = keyof typeof WORKSPACE_MODULES
export const WORKSPACE_MODULE_STATES = ['enabled', 'draining', 'disabled'] as const
export type WorkspaceModuleState = typeof WORKSPACE_MODULE_STATES[number]
export const WORKSPACE_MODULE_ACTIONS = ['enable', 'request_disable', 'finish_disable'] as const
export type WorkspaceModuleAction = typeof WORKSPACE_MODULE_ACTIONS[number]
export const WORKSPACE_MODULE_OPERATION_CLASSES = ['read', 'new_commerce', 'existing_recovery'] as const
export type WorkspaceModuleOperationClass = typeof WORKSPACE_MODULE_OPERATION_CLASSES[number]
export const WORKSPACE_MODULE_CONFLICTS = ['module_disabled', 'module_draining', 'module_drain_pending', 'stale_module_version'] as const
export type WorkspaceModuleConflict = typeof WORKSPACE_MODULE_CONFLICTS[number]

export interface WorkspaceModule {
  workspaceId: string
  moduleKey: WorkspaceModuleKey
  state: WorkspaceModuleState
  /** Zero means missing/unprovisioned, never enabled. */
  version: number
  enabledAt: string | null
  disableRequestedAt: string | null
  disabledAt: string | null
  updatedAt: string | null
  updatedByUserId: string | null
}

export interface WorkspaceModuleActionInput {
  action: WorkspaceModuleAction
  expectedVersion: number
}

export interface WorkspaceModuleActionResult {
  module: WorkspaceModule
  changed: boolean
  pendingOrders: number
}

/** Admission only. Callers still need resource and principal authority. */
export function workspaceModuleAdmits(state: WorkspaceModuleState, operation: WorkspaceModuleOperationClass): boolean {
  return operation === 'read' || operation === 'existing_recovery' || (operation === 'new_commerce' && state === 'enabled')
}
