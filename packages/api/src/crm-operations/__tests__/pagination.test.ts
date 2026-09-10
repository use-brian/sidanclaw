import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { queryCrmPage } from '../pagination.js'

describe('[COMP:crm/operations-pagination] Query-bound CRM cursors', () => {
  const workspaceId = randomUUID()
  const first = { id: 'eeeeeeee-1111-4111-8111-111111111111', createdAt: new Date('2026-01-01'),
    __cursorAt: '2026-01-01T00:00:00.123456Z', __evaluatedAt: '2026-09-08T12:00:00.654321Z' }
  const last = { ...first, id: 'dddddddd-1111-4111-8111-111111111111' }
  const options = { workspaceId, resource: 'fixture', key: 'records',
    sql: 'SELECT id,created_at AS "createdAt" FROM fixture WHERE workspace_id=$1', params: [workspaceId] }
  it('retains microsecond tuples and evaluation time while allowing a new page size', async () => {
    const run = vi.fn().mockResolvedValue({ rows: [first, last] })
    const page = await queryCrmPage(run, { ...options, query: { limit: 1 } })
    expect(page.records).toEqual([{ id: first.id, createdAt: first.createdAt }])
    const decoded = JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString('utf8'))
    expect(decoded).toMatchObject({ upper: { at: first.__cursorAt, id: first.id }, after: { at: first.__cursorAt, id: first.id }, evaluatedAt: first.__evaluatedAt })
    run.mockResolvedValueOnce({ rows: [last] })
    expect((await queryCrmPage(run, { ...options, query: { limit: 5, cursor: page.nextCursor! } })).nextCursor).toBeNull()
    expect(run.mock.calls[1][1]).toContain(first.__cursorAt)
    expect(run.mock.calls[1][1]).toContain(first.__evaluatedAt)
  })
  it('rejects another workspace/resource/filter or corrupt token before querying', async () => {
    const run = vi.fn().mockResolvedValue({ rows: [first, last] })
    const page = await queryCrmPage(run, { ...options, query: { limit: 1 } })
    run.mockClear()
    for (const changed of [{ ...options, workspaceId: randomUUID() }, { ...options, resource: 'another' }, { ...options, params: [workspaceId, 'different'] }, { ...options, sql: options.sql + ' AND active' }]) {
      await expect(queryCrmPage(run, { ...changed, query: { cursor: page.nextCursor! } })).rejects.toMatchObject({ code: 'invalid_input' })
    }
    for (const cursor of ['not-json', '%%%invalid', Buffer.from('{}').toString('base64url')]) {
      await expect(queryCrmPage(run, { ...options, query: { cursor } })).rejects.toMatchObject({ code: 'invalid_input' })
    }
    expect(run).not.toHaveBeenCalled()
  })
  it('uses explicit C collation for catalog text keys and never accepts them in a UUID stream', async () => {
    const run = vi.fn().mockResolvedValue({ rows: [{ ...first, id: 'related_to' }, { ...last, id: 'owns' }] })
    const page = await queryCrmPage(run, { ...options, idType: 'text', query: { limit: 1 } })
    expect(run.mock.calls[0][0]).toContain('candidate.id COLLATE "C"')
    await queryCrmPage(run, { ...options, idType: 'text', query: { cursor: page.nextCursor! } })
    await expect(queryCrmPage(run, { ...options, query: { cursor: page.nextCursor! } })).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it('normalizes equivalent time offsets and rejects reversed or excessive-precision windows', async () => {
    const run = vi.fn().mockResolvedValue({ rows: [first, last] })
    const page = await queryCrmPage(run, { ...options, query: { limit: 1, createdAfter: '2025-12-31T19:00:00.123456-05:00' } })
    await expect(queryCrmPage(run, { ...options, query: { cursor: page.nextCursor!, createdAfter: first.__cursorAt } })).resolves.toBeDefined()
    await expect(queryCrmPage(run, { ...options, query: { createdAfter: '2026-01-01T00:00:00.1234567Z' } })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(queryCrmPage(run, { ...options, query: { createdAfter: '2026-01-02T00:00:00Z', createdBefore: '2026-01-01T00:00:00Z' } })).rejects.toMatchObject({ code: 'invalid_input' })
  })
})
