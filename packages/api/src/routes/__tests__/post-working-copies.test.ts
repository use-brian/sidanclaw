import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { postWorkingCopiesRoutes } from '../post-working-copies.js'
import { WorkingCopyError, type PostWorkingContent } from '../../db/post-working-copies.js'

const id = '00000000-0000-4000-8000-000000000001'
const content: PostWorkingContent = { title: '', privateBrief: 'Work in progress', text: '', postFormat: 'thread', threadSegments: ['Partial', ''], article: { sourceUrl: '', title: '', description: '' }, media: [] }
const input = { revision: 0, mutationId: id, create: { platform: 'twitter' }, content }
const path = `/api/distribution/assistant-1/post-working-copies/${id}`
function app({ canDraft = true, member = true, authenticated = true, failure = 0 } = {}) {
  const store = { get: vi.fn(async () => null), put: vi.fn(async () => {
    if (failure) throw new WorkingCopyError(failure)
    return { revision: 1, mutationId: id, content }
  }) }
  const server = express().use(express.json()).use((req, _res, next) => { if (authenticated) req.userId = 'user-1'; next() })
  server.use('/api/distribution', postWorkingCopiesRoutes({ store, resolveAccess: async () => member ? { userId: 'user-1', workspaceId: 'workspace-1', role: 'member', canDraft } : null }))
  return { server, store }
}
describe('[COMP:feed/post-working-copies] shared working-copy API', () => {
  it('accepts incomplete threads as working state and creates no review version', async () => {
    const { server, store } = app()
    const response = await request(server).put(path).send(input)
    expect(response.status).toBe(200)
    expect(response.body.copy.content.threadSegments).toEqual(['Partial', ''])
    expect(store.put).toHaveBeenCalledWith('assistant-1', id, 'user-1', input)
  })
  it('allows member reads but rechecks draft permission for writes', async () => {
    const { server, store } = app({ canDraft: false })
    expect((await request(server).get(path)).status).toBe(200)
    expect((await request(server).put(path).send(input)).status).toBe(403)
    expect(store.put).not.toHaveBeenCalled()
  })
  it.each([{ member: false, status: 403 }, { authenticated: false, status: 401 }])('denies access before storage: %j', async ({ status, ...options }) => {
    const { server, store } = app(options)
    expect((await request(server).put(path).send(input)).status).toBe(status)
    expect(store.put).not.toHaveBeenCalled()
  })
  it.each([409, 404])('reports %i without pretending the copy synced', async failure => {
    const { server } = app({ failure })
    expect((await request(server).put(path).send(input)).status).toBe(failure)
  })
  it.each([
    { ...input, revision: -1 }, { ...input, mutationId: 'bad' },
    { ...input, content: { ...content, text: 'x'.repeat(100_001) } },
    { ...input, content: { ...content, media: [{ fileId: 'bad' }] } },
  ])('rejects malformed or oversized state', async body => {
    const { server, store } = app()
    expect((await request(server).put(path).send(body)).status).toBe(400)
    expect(store.put).not.toHaveBeenCalled()
  })
})
