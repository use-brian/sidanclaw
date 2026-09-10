import { describe, expect, it, vi } from 'vitest'
import { createProviderInboxWorker } from '../provider-inbox-worker.js'
describe('[COMP:crm/provider-inbox] Bounded receipt recovery', () => {
  it('advances through every page, limits one tick and resumes on the next tick', async () => {
    const rows = Array.from({ length: 1105 }, (_, i) => ({ id: String(i).padStart(5, '0'), workspaceId: 'fixture' }))
    const due = vi.fn(async (after: string | null, limit: number) => rows.filter(r => !after || r.id > after).slice(0, limit))
    const process = vi.fn(async () => {})
    const worker = createProviderInboxWorker({ due, process })
    expect(await worker.tick()).toBe(1000)
    expect(await worker.tick()).toBe(105)
    expect(process).toHaveBeenCalledTimes(1105)
    expect(due).toHaveBeenLastCalledWith('01099', 100)
  })
  it('does not overlap ticks and continues other receipts after a failed operation', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const onError = vi.fn(), process = vi.fn(async (_workspace: string, id: string) => { await gate; if (id === 'first') throw Error('private error detail') })
    const worker = createProviderInboxWorker({ due: async () => [{ id: 'first', workspaceId: 'fixture' }, { id: 'second', workspaceId: 'fixture' }], process, onError })
    const first = worker.tick(), second = worker.tick()
    expect(first).toBe(second); release()
    expect(await first).toBe(2)
    expect(onError).toHaveBeenCalledWith()
    expect(process).toHaveBeenCalledTimes(2)
  })
})
