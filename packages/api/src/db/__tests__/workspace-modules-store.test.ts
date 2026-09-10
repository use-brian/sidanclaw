import type { Pool, PoolClient } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceModulesStore, lockAssociationModule, requireAssociationAdmission } from '../workspace-modules-store.js'

describe('[COMP:api/workspace-modules] Admission failures', () => {
  it('treats missing state as disabled and locks its parent before re-reading', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    const module = await lockAssociationModule({ query } as unknown as PoolClient, 'workspace')
    expect(module).toMatchObject({ state: 'disabled', version: 0 })
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining("module_key='association' FOR SHARE"),
      'SELECT id FROM workspaces WHERE id=$1 FOR SHARE',
      expect.stringContaining("module_key='association' FOR SHARE"),
    ])
    expect(() => requireAssociationAdmission(module)).toThrow(expect.objectContaining({ code: 'module_disabled' }))
  })

  it('does not turn database failure into permission or a fake disabled result', async () => {
    const query = vi.fn().mockRejectedValue(new Error('database unavailable'))
    const pool = { query } as unknown as Pool
    await expect(createWorkspaceModulesStore(pool, pool).getAssociation('workspace')).rejects.toThrow('database unavailable')
    await expect(lockAssociationModule({ query } as unknown as PoolClient, 'workspace')).rejects.toThrow('database unavailable')
  })

  it('rejects malformed lifecycle commands without opening a transaction', async () => {
    const pool = { connect: vi.fn() } as unknown as Pool
    const store = createWorkspaceModulesStore(pool, pool)
    await expect(store.act('workspace', 'user', { action: 'enable', expectedVersion: -1 }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    expect(pool.connect).not.toHaveBeenCalled()
  })
})
