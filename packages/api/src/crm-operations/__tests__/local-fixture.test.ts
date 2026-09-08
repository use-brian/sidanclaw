import { describe, expect, it } from 'vitest'

const script = new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href
const { validateAmbientDatabase, cleanRuntimeEnvironment, assertLocalFixture } = await import(script)

describe('[COMP:crm/assurance-fixture] Disposable database safety', () => {
  it('refuses remote databases, socket overrides and libpq services before starting', () => {
    for (const value of ['postgresql://db.example/brain', 'postgres:///brain',
      'postgresql://127.0.0.1/brain?host=db.example', 'postgresql://localhost/brain?service=live', 'bad']) {
      expect(() => validateAmbientDatabase({ DATABASE_URL: value })).toThrow(/Unset DATABASE_URL/)
    }
    expect(() => validateAmbientDatabase({ DATABASE_URL_APP: 'postgresql://db.example/brain' })).toThrow()
    expect(() => validateAmbientDatabase({ DATABASE_URL: 'postgresql://127.0.0.1/unused' })).not.toThrow()
    expect(() => validateAmbientDatabase({})).not.toThrow()
  })

  it('does not propagate provider secrets, libpq switches or migration targets', () => {
    expect(cleanRuntimeEnvironment({ PATH: '/bin', HOME: '/tmp/fictional', DATABASE_URL: 'secret',
      PGHOST: 'db.example', PGOPTIONS: '-c role=admin', GOOGLE_API_KEY: 'secret',
      MIGRATION_DIRS: '/somewhere' })).toEqual({ PATH: '/bin', HOME: '/tmp/fictional' })
  })

  it('refuses integration tests outside an owned fixture', async () => {
    await expect(assertLocalFixture({ DATABASE_URL: 'postgresql://localhost/brain' }))
      .rejects.toThrow('Run this suite through')
  })
})
