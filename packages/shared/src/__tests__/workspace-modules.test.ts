import { describe, expect, it } from 'vitest'
import { WORKSPACE_MODULES, WORKSPACE_MODULE_STATES, workspaceModuleAdmits } from '../workspace-modules.js'

describe('[COMP:shared/workspace-modules] Module admission contract', () => {
  it('starts new workspaces disabled and admits new commerce only while enabled', () => {
    expect(WORKSPACE_MODULES.association.defaultState).toBe('disabled')
    for (const state of WORKSPACE_MODULE_STATES) {
      expect(workspaceModuleAdmits(state, 'new_commerce')).toBe(state === 'enabled')
      expect(workspaceModuleAdmits(state, 'read')).toBe(true)
      expect(workspaceModuleAdmits(state, 'existing_recovery')).toBe(true)
    }
  })
})
