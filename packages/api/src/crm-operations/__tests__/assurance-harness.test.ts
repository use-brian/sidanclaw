import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
const harness = await import(new URL('../../../../../scripts/crm/brian-contract-check.mjs', import.meta.url).href)
const catalog = JSON.parse(await readFile(new URL('../../../../../scripts/crm/fixtures/association-assurance.json', import.meta.url), 'utf8'))
const root = new URL('../../../../../', import.meta.url).pathname
const suite = catalog.suites[0]
const result = () => ({ success: true, testResults: [{ name: root + suite.file, status: 'passed', assertionResults: [{ fullName: 'actual assertion', status: 'passed' }] }] })

describe('[COMP:crm/assurance-harness] Honest engineering evidence and remote boundaries', () => {
  it('requires the complete versioned matrix, unique owned paths and explicit database classification', () => {
    expect(harness.validateCatalog(catalog)).toBe(catalog)
    for (const mutate of [
      (c: any) => { delete c.caseDescriptions.K },
      (c: any) => { c.suites.push(c.suites[0]) },
      (c: any) => { c.suites[0].file = '../production.test.ts' },
      (c: any) => { c.suites[0].group = 'api' },
      (c: any) => { c.suites = c.suites.filter((s: any) => !s.cases.includes('K')) },
    ]) { const copy = structuredClone(catalog); mutate(copy); expect(() => harness.validateCatalog(copy)).toThrow() }
  })
  it('does not pass missing, empty, skipped, duplicate, failed or interrupted execution', () => {
    expect(harness.assessSuite(suite, result(), 0, root).status).toBe('passed')
    expect(harness.assessSuite(suite, result(), 124, root).status).toBe('failed')
    for (const mutate of [
      (r: any) => { r.testResults = [] },
      (r: any) => { r.testResults[0].assertionResults = [] },
      (r: any) => { r.testResults[0].assertionResults[0].status = 'pending' },
      (r: any) => { r.testResults.push(r.testResults[0]) },
      (r: any) => { r.testResults[0].status = 'failed' },
      (r: any) => { r.success = false },
    ]) { const r = result(); mutate(r); expect(harness.assessSuite(suite, r, 0, root).status).toBe('failed') }
  })
  it('keeps an absent case unexecuted and a database prerequisite blocked, never green', () => {
    expect(harness.summarize(catalog, {}).status).toBe('not_run')
    const evidence = Object.fromEntries(catalog.suites.map((s: any) => [s.file, { status: 'passed', assertions: ['verified'] }]))
    expect(harness.summarize(catalog, evidence).status).toBe('passed')
    evidence[suite.file] = { status: 'blocked', assertions: [] }
    expect(harness.summarize(catalog, evidence).status).toBe('blocked')
    delete evidence[suite.file]
    expect(harness.summarize(catalog, evidence).status).toBe('not_run')
  })
  it('refuses ambient target arguments in local mode and incomplete QA authorization', () => {
    const base = { reportDir: '/tmp/new-report' }
    expect(harness.validateOptions(base).mode).toBe('local')
    expect(() => harness.validateOptions({ ...base, apiUrl: 'https://api.example.com' })).toThrow()
    const remote = { ...base, mode: 'remote-qa', apiUrl: 'https://api.example.com', workspaceId: '00000001-0000-4000-8000-000000000001', tokenEnv: 'FIXTURE_TOKEN', identityPrefix: 'assurance-fixture', dedicatedWorkspace: true, confirm: true }
    expect(harness.validateOptions(remote).mode).toBe('remote-qa')
    for (const key of ['workspaceId', 'identityPrefix', 'dedicatedWorkspace', 'confirm']) { const copy: any = { ...remote }; delete copy[key]; expect(() => harness.validateOptions(copy)).toThrow() }
    expect(() => harness.validateOptions({ ...remote, migrationDirs: ['/production'] })).toThrow()
    expect(() => harness.validateOptions({ ...remote, mode: 'production' })).toThrow()
  })
  it.each(['remote-qa', 'production'])('limits %s to one catalog qualification and leaves acceptance unexecuted', async mode => {
    const verifyDestination = vi.fn().mockResolvedValue({}), request = vi.fn(() => { throw new Error('No mutation allowed') })
    const clientFactory = vi.fn(() => ({ verifyDestination, request }))
    const options = { mode, reportDir: '/tmp/new-report', apiUrl: 'https://api.example.com', workspaceId: '00000001-0000-4000-8000-000000000001', tokenEnv: 'FIXTURE_TOKEN',
      ...(mode === 'remote-qa' ? { identityPrefix: 'assurance-fixture', dedicatedWorkspace: true, confirm: true } : {}) }
    const value = await harness.remoteQualification(options, { tokenReader: async () => 'sk_crm_fixture', clientFactory })
    expect(value).toMatchObject({ status: 'passed', acceptanceStatus: 'not_run', action: 'catalog_read' })
    expect(verifyDestination).toHaveBeenCalledTimes(1); expect(request).not.toHaveBeenCalled()
    await expect(harness.remoteQualification(options, { tokenReader: async () => 'sk_intake_fixture', clientFactory })).rejects.toThrow('CRM-scoped')
    expect(clientFactory).toHaveBeenCalledTimes(1)
  })
})
