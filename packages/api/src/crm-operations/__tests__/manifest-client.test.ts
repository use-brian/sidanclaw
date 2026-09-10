import { randomUUID } from 'node:crypto'
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { createManifestClient, discoverManifestCatalogs, readManifestToken, parseManifest } = await import(
  new URL('../../../../../scripts/crm/manifest-client.mjs', import.meta.url).href)
const fixture = JSON.parse(readFileSync(new URL('../../../../../scripts/crm/fixtures/community-manifest.v1.json', import.meta.url), 'utf8'))
const workspaceId = randomUUID(), credentialId = randomUUID(), token = 'sk_crm_synthetic_private_fixture'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
const discovery = () => json({ workspaceId, credentialId, grants: [] })
const client = (fetchImpl: unknown, extra = {}) => createManifestClient({ apiUrl: 'https://crm.example', workspaceId, mode: 'integration', token, fetchImpl, ...extra })

describe('[COMP:crm/manifest] Private credential handling and complete pure discovery', () => {
  it('validates the fictional complete manifest and discovers every catalog using GET only', async () => {
    const calls: string[] = []
    const properties: Record<string, string> = { 'record-fields': 'fields', pipelines: 'pipelines', 'consent-purposes': 'purposes',
      'entitlement-plans': 'plans', events: 'events', 'intake-definitions': 'definitions', segments: 'segments' }
    const fetchImpl = vi.fn(async (url: URL, init: RequestInit) => {
      expect(init.method).toBe('GET'); expect(init.redirect).toBe('manual'); expect(init.body).toBeUndefined()
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${token}` })
      expect(url.origin).toBe('https://crm.example')
      calls.push(url.pathname)
      if (url.pathname.endsWith('/catalog')) return discovery()
      const resource = url.pathname.split('/').at(-1)!
      expect(url.pathname).not.toContain('/config')
      return json({ [properties[resource]]: [], nextCursor: null, ...(resource === 'segments' ? { catalog: [] } : {}) })
    })
    const manifest = parseManifest(fixture)
    expect(manifest.intakeDefinitions[0].value.definition.fields.find((field: { key: string }) => field.key === 'private_note').mapping.kind).toBe('submission_only')
    const catalogs = await discoverManifestCatalogs(client(fetchImpl), fixture)
    expect(catalogs.loaded).toHaveLength(7)
    expect(calls.filter((path) => path.endsWith('/segments'))).toHaveLength(3)
    expect(calls).toHaveLength(10)
    expect(JSON.stringify(catalogs)).not.toContain(token)
  })

  it('traverses more than one page and rejects loops, duplicate rows, malformed pages and denied catalogs', async () => {
    const firstId = randomUUID(), secondId = randomUUID()
    const fetchImpl = vi.fn(async (url: URL) => json(url.searchParams.has('cursor')
      ? { fields: [{ id: secondId }], nextCursor: null } : { fields: [{ id: firstId }], nextCursor: 'next' }))
    expect((await client(fetchImpl).pages('/operations/record-fields', 'fields')).rows).toHaveLength(2)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    await expect(client(async () => json({ fields: [], nextCursor: 'repeated' })).pages('/operations/record-fields', 'fields'))
      .rejects.toMatchObject({ code: 'repeated_cursor' })
    await expect(client(async () => json({ fields: [{ id: firstId }, { id: firstId }], nextCursor: null })).pages('/operations/record-fields', 'fields'))
      .rejects.toMatchObject({ code: 'malformed_catalog' })
    await expect(client(async () => json({ fields: [] })).pages('/operations/record-fields', 'fields'))
      .rejects.toMatchObject({ code: 'malformed_catalog' })
    await expect(client(async () => new Response('private server detail', { status: 403 })).pages('/operations/record-fields', 'fields'))
      .rejects.toMatchObject({ code: 'request_failed', details: { status: 403 } })
  })

  it('stops before catalog work on a workspace mismatch and refuses redirected or uncertain responses without exposing secrets', async () => {
    const mismatch = vi.fn(async () => json({ workspaceId: randomUUID(), credentialId, grants: [] }))
    await expect(discoverManifestCatalogs(client(mismatch), fixture)).rejects.toMatchObject({ code: 'workspace_mismatch' })
    expect(mismatch).toHaveBeenCalledTimes(1)
    await expect(client(async () => new Response(token, { status: 302, headers: { Location: 'https://foreign.example' } })).verifyDestination())
      .rejects.toMatchObject({ code: 'redirect_refused' })
    try { await client(async () => { throw new Error(token) }).verifyDestination() }
    catch (error) { expect(JSON.stringify(error)).not.toContain(token); expect((error as { code: string }).code).toBe('request_uncertain') }
    expect(() => client(vi.fn(), { apiUrl: 'https://user:secret@crm.example' })).toThrow('invalid_api_origin')
    expect(() => client(vi.fn(), { apiUrl: 'http://remote.example' })).toThrow('https_or_loopback_required')
  })

  it('authenticates member discovery through the pure workspace catalog, preserving the selected path', async () => {
    const fetchImpl = vi.fn(async (url: URL) => {
      expect(url.pathname).toBe(`/api/crm/${workspaceId}/operations/record-fields`)
      return json({ fields: [], nextCursor: null })
    })
    await createManifestClient({ apiUrl: 'http://127.0.0.1:1234', workspaceId, mode: 'member', token: 'synthetic_member_token', fetchImpl }).verifyDestination()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(() => client(fetchImpl, { mode: 'member' })).toThrow('credential_family_mismatch')
  })

  it('bounds response bodies and stalled requests, and refuses malformed resource identities during discovery', async () => {
    await expect(client(async () => new Response(' '.repeat(8 * 1024 * 1024 + 1))).request('/catalog'))
      .rejects.toMatchObject({ code: 'response_too_large' })
    const stalled = (_url: URL, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')))
    })
    await expect(client(stalled, { timeoutMs: 5 }).request('/catalog')).rejects.toMatchObject({ code: 'request_uncertain' })
    const fetchImpl = async (url: URL) => url.pathname.endsWith('/catalog') ? discovery()
      : json({ fields: [{ id: randomUUID() }], nextCursor: null })
    await expect(discoverManifestCatalogs(client(fetchImpl), { schemaVersion: 1, sourceLabel: 'Fixture', recordFields: fixture.recordFields }))
      .rejects.toMatchObject({ code: 'malformed_catalog', details: { resource: 'recordFields' } })
  })

  it('reads only explicitly named environment or owner-private regular files and rejects symlinks', async () => {
    expect(await readManifestToken({ tokenEnv: 'CRM_FIXTURE_TOKEN', env: { CRM_FIXTURE_TOKEN: token } })).toBe(token)
    await expect(readManifestToken({ tokenEnv: 'MISSING', env: {} })).rejects.toMatchObject({ code: 'token_unavailable' })
    await expect(readManifestToken({ tokenEnv: 'NAME', tokenFile: '/unused' })).rejects.toMatchObject({ code: 'choose_one_token_source' })
    const root = mkdtempSync(join(tmpdir(), 'crm-manifest-')); roots.push(root)
    const path = join(root, 'token'); writeFileSync(path, token + '\n', { mode: 0o600 })
    expect(await readManifestToken({ tokenFile: path })).toBe(token)
    chmodSync(path, 0o644)
    await expect(readManifestToken({ tokenFile: path })).rejects.toMatchObject({ code: 'private_token_file_required' })
    chmodSync(path, 0o600); symlinkSync(path, join(root, 'link'))
    await expect(readManifestToken({ tokenFile: join(root, 'link') })).rejects.toMatchObject({ code: 'token_file_unavailable' })
  })
})
