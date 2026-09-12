import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('[COMP:doc-sync/persistence] native launcher import graph', () => {
  it.each(['', 'cjs'])('loads the real entrypoint outside Vitest aliases and preserves populated pages (mix=%s)', mix => {
    const result = spawnSync(process.execPath, ['--import', 'tsx',
      'src/__tests__/native-runtime.fixture.mjs'], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, NATIVE_BASELINE: '', NATIVE_COMPILED: '', NATIVE_MIX: mix }, encoding: 'utf8', timeout: 30_000,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).not.toContain('Yjs was already imported')
    expect(result.stdout).toContain('native-runtime: populated canonical save/reload and invalid projection passed')
  }, 35_000)
  it('reproduces the original store branch without the bootstrap under a dual-export loader', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/__tests__/native-runtime.fixture.mjs'], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, NATIVE_BASELINE: '1', NATIVE_COMPILED: '', NATIVE_MIX: 'cjs' }, encoding: 'utf8', timeout: 30_000,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('[onStoreDocument] Unexpected case')
    expect(result.stdout).toContain('native-runtime: original store error reproduced with integrated XML')
  }, 35_000)
})
