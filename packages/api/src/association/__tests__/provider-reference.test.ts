import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, statSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
const { ProviderCheckpoint, createFakeProvider, createProviderReconciler, createBrianProviderClient } = await import(new URL('../../../../../scripts/crm/provider-reference.mjs', import.meta.url).href)
const { startReferenceProviderBackend } = await import(new URL('../../../../../scripts/crm/reference-provider-backend.mjs', import.meta.url).href)
const roots: string[] = [], checkpoints = new Set<InstanceType<typeof ProviderCheckpoint>>()
const secret = 'fictional_webhook_secret_for_local_tests_only', backendToken = 'fictional_backend_secret_for_local_tests_only'
const checkedFixture = JSON.parse(readFileSync(new URL('../../../../../scripts/crm/fixtures/provider-events.json', import.meta.url), 'utf8'))
function order(eventId = randomUUID()) { return { ...structuredClone(checkedFixture.events[0]), event: { ...checkedFixture.events[0].event, eventId } } }
function membership(eventId = randomUUID()) { return { ...structuredClone(checkedFixture.events[1]), event: { ...checkedFixture.events[1].event, eventId } } }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'provider-reference-')); roots.push(root)
  const time = { value: 1_800_000_000_000 }, options = { databasePath: join(root, 'checkpoint.sqlite'), sourceId: 'fictional-provider', provider: 'fixture', apiUrl: 'http://127.0.0.1:4444', workspaceId: randomUUID(), now: () => time.value }
  const open = () => { const c = new ProviderCheckpoint(options); checkpoints.add(c); return c }
  const close = (c: InstanceType<typeof ProviderCheckpoint>) => { c.close(); checkpoints.delete(c) }
  return { root, time, options, open, close, provider: (events: unknown[] = []) => createFakeProvider({ provider: 'fixture', events, webhookSecret: secret, now: () => time.value }) }
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers })
afterEach(() => { for (const checkpoint of checkpoints) checkpoint.close(); checkpoints.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('[COMP:crm/provider-reference] Durable provider adapter contract', () => {
  it('authenticates exact bytes before forwarding and refuses old signatures or another provider', async () => {
    const f = fixture(), provider = f.provider(), forward = vi.fn().mockResolvedValue({ id: randomUUID(), state: 'applied' })
    const reconciler = createProviderReconciler({ provider, client: { forward }, checkpoint: f.open() })
    const signed = provider.signWebhook(order())
    await expect(reconciler.receiveWebhook(Buffer.from(signed.body.toString().replace('paid', 'failed')), signed.signature)).rejects.toMatchObject({ code: 'invalid_signature' })
    await expect(reconciler.receiveWebhook(signed.body, 'invalid')).rejects.toMatchObject({ code: 'invalid_signature' })
    f.time.value += 301_000
    await expect(reconciler.receiveWebhook(signed.body, signed.signature)).rejects.toMatchObject({ code: 'invalid_signature' })
    expect(forward).not.toHaveBeenCalled()
    expect(() => provider.signWebhook({ ...order(), event: { ...order().event, provider: 'another' } })).toThrow('invalid_provider_envelope')
    const valid = provider.signWebhook(membership())
    expect((await reconciler.receiveWebhook(valid.body, valid.signature)).state).toBe('applied')
    expect(forward).toHaveBeenCalledWith(expect.objectContaining({ target: 'entitlement' }))
  })
  it('drains more than a first page across bounded ticks and persists restart progress for both targets', async () => {
    const f = fixture(), events = Array.from({ length: 1005 }, (_, i) => i % 2 ? membership() : order()), provider = f.provider(events)
    const checkpoint = f.open(), forward = vi.fn().mockImplementation(async () => ({ id: randomUUID(), state: 'applied' }))
    const worker = createProviderReconciler({ provider, client: { forward }, checkpoint })
    expect(await worker.reconcile()).toEqual({ state: 'more_due', processed: 1000, cursor: '1000' })
    f.close(checkpoint)
    const next = f.open()
    expect(await createProviderReconciler({ provider, client: { forward }, checkpoint: next }).reconcile()).toEqual({ state: 'caught_up', processed: 5, cursor: '1005' })
    expect(forward).toHaveBeenCalledTimes(1005)
    expect(next.issues()).toEqual({ items: [], nextCursor: null })
    expect(statSync(f.options.databasePath).mode & 0o077).toBe(0)
  })
  it('replays after uncertain Brian acceptance and after a cursor commit failure without changing event identity', async () => {
    const f = fixture(), provider = f.provider([order(), membership()]), checkpoint = f.open(), effects = new Map<string, string>()
    let disconnect = true
    const forward = vi.fn().mockImplementation(async (envelope: { event: { eventId: string } }) => {
      const key = envelope.event.eventId
      if (!effects.has(key)) effects.set(key, randomUUID())
      if (disconnect) { disconnect = false; throw new Error('private upstream exception') }
      return { id: effects.get(key), state: 'applied' }
    })
    const worker = createProviderReconciler({ provider, client: { forward }, checkpoint })
    expect(await worker.reconcile()).toMatchObject({ state: 'blocked', cursor: '0' })
    expect(checkpoint.state().cursor).toBe('0')
    expect((await worker.reconcile()).state).toBe('waiting')
    f.time.value += 60_001
    const advance = vi.spyOn(checkpoint, 'advance').mockImplementationOnce(() => { throw new Error('private checkpoint failure') })
    expect(await worker.reconcile()).toMatchObject({ state: 'blocked', cursor: '0' })
    advance.mockRestore(); f.close(checkpoint); f.time.value += 60_001
    expect(await createProviderReconciler({ provider, client: { forward }, checkpoint: f.open() }).reconcile()).toMatchObject({ state: 'caught_up', cursor: '2' })
    expect(effects.size).toBe(2)
    expect(forward.mock.calls.slice(0, 3).map(call => call[0].event.eventId)).toEqual(Array(3).fill(forward.mock.calls[0][0].event.eventId))
  })
  it('coordinates separate checkpoint handles and refuses a stale owner after abandoned lease recovery', () => {
    const f = fixture(), one = f.open(), two = f.open(), a = one.claim()
    expect(two.claim()).toBeNull()
    f.time.value += 120_001
    const b = two.claim()
    expect(b.cursor).toBe('0')
    const receipt = { id: randomUUID(), state: 'applied' }
    expect(() => one.advance(a.lease, '0', '1', receipt)).toThrow('checkpoint_lease_lost')
    two.advance(b.lease, '0', '1', receipt)
    one.release(a.lease)
    expect(two.state().cursor).toBe('1')
    expect(one.claim()).toBeNull()
  })
  it('retains paginated reconciliation pointers while distinguishing durable acceptance from payment success', async () => {
    const f = fixture(), checkpoint = f.open(), provider = f.provider(Array.from({ length: 105 }, () => order()))
    const worker = createProviderReconciler({ provider, checkpoint, client: { forward: async () => ({ id: randomUUID(), state: 'needs_reconciliation' }) } })
    expect(await worker.reconcile()).toMatchObject({ state: 'caught_up', processed: 105 })
    const first = checkpoint.issues(), next = checkpoint.issues({ cursor: first.nextCursor })
    expect(first.items).toHaveLength(100); expect(next.items).toHaveLength(5); expect(next.nextCursor).toBeNull()
    expect(first.items[0]).toEqual({ cursor: 1, receiptId: expect.any(String), state: 'needs_reconciliation', recordedAt: f.time.value })
    expect(JSON.stringify(checkpoint.state())).not.toContain(secret)
  })
  it('checks the credential workspace and rotates validation with tokens; honors 429 even with a non-JSON response', async () => {
    const f = fixture(), checkpoint = f.open(), provider = f.provider([order()])
    let token = `sk_crm_${randomUUID()}_${'A'.repeat(43)}`, limited = true, wrongWorkspace = false
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/catalog')) return json({ workspaceId: wrongWorkspace ? randomUUID() : f.options.workspaceId })
      if (limited) return new Response('back off', { status: 429, headers: { 'Retry-After': '120' } })
      return json({ receipt: { id: randomUUID(), state: 'applied' } }, 201)
    })
    const client = createBrianProviderClient({ apiUrl: f.options.apiUrl, workspaceId: f.options.workspaceId, getToken: () => token, fetchImpl, now: () => f.time.value })
    const worker = createProviderReconciler({ provider, client, checkpoint })
    expect(await worker.reconcile()).toMatchObject({ state: 'blocked', cursor: '0', error: 'brian_rate_limited' })
    expect(checkpoint.state().retryAt).toBe(f.time.value + 120_000)
    expect((await worker.reconcile()).state).toBe('waiting')
    f.time.value += 120_001; limited = false
    expect((await worker.reconcile()).state).toBe('caught_up')
    expect(fetchImpl.mock.calls.filter(call => call[0].endsWith('/catalog'))).toHaveLength(1)
    token = `sk_crm_${randomUUID()}_${'B'.repeat(43)}`; wrongWorkspace = true
    await expect(client.forward(order())).rejects.toMatchObject({ code: 'credential_workspace_mismatch' })
    expect(fetchImpl.mock.calls.filter(call => !call[0].endsWith('/catalog'))).toHaveLength(2)
  })
  it('requires explicit durable receipt evidence for non-success HTTP responses and never follows redirects', async () => {
    const f = fixture(), id = randomUUID(), token = `sk_crm_${randomUUID()}_${'A'.repeat(43)}`
    let response = json({ error: 'conflict', details: { receiptId: id, receiptState: 'needs_reconciliation' } }, 409)
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => url.endsWith('/catalog') ? json({ workspaceId: f.options.workspaceId }) : response)
    const client = createBrianProviderClient({ apiUrl: f.options.apiUrl, workspaceId: f.options.workspaceId, getToken: () => token, fetchImpl })
    expect(await client.forward(order())).toEqual({ id, state: 'needs_reconciliation' })
    response = json({ error: 'idempotency_conflict' }, 409)
    await expect(client.forward(order())).rejects.toMatchObject({ code: 'brian_receipt_unconfirmed' })
    response = json({ receipt: { id, state: 'paid' } }, 201)
    await expect(client.forward(order())).rejects.toMatchObject({ code: 'brian_receipt_unconfirmed' })
    expect(fetchImpl.mock.calls.every(call => call[1].redirect === 'error')).toBe(true)
  })
  it('runs signed webhook ingress and periodic polling over real loopback HTTP with private operator reads', async () => {
    const f = fixture(), event = order(), provider = f.provider([event]), checkpoint = f.open(), id = randomUUID()
    const forward = vi.fn().mockResolvedValue({ id, state: 'applied' }), reconciler = createProviderReconciler({ provider, checkpoint, client: { forward } })
    const backend = await startReferenceProviderBackend({ reconciler, checkpoint, backendToken, intervalMs: 1000 })
    try {
      await vi.waitFor(() => expect(checkpoint.state().cursor).toBe('1'))
      const signed = provider.signWebhook(event)
      const accepted = await fetch(`${backend.url}/webhook`, { method: 'POST', headers: { 'x-fixture-signature': signed.signature }, body: signed.body })
      expect(accepted.status).toBe(200); expect(await accepted.json()).toEqual({ receipt: { id, state: 'applied' } })
      expect((await fetch(`${backend.url}/webhook`, { method: 'POST', body: signed.body })).status).toBe(401)
      expect((await fetch(`${backend.url}/reconciliation`)).status).toBe(401)
      expect((await fetch(`${backend.url}/reconciliation`, { headers: { Authorization: `Bearer ${backendToken}` } })).status).toBe(200)
      expect(forward).toHaveBeenCalledTimes(2)
    } finally { await backend.close() }
  })
  it('refuses a changed checkpoint identity, nonprivate files and nonadvancing provider pages', async () => {
    const f = fixture(), checkpoint = f.open()
    expect(() => new ProviderCheckpoint({ ...f.options, workspaceId: randomUUID() })).toThrow('checkpoint_identity_mismatch')
    const worker = createProviderReconciler({ checkpoint, provider: { provider: 'fixture', listEvents: async () => ({ entries: [{ cursor: '0', envelope: order() }], hasMore: true }) }, client: { forward: vi.fn() } })
    expect(await worker.reconcile()).toMatchObject({ state: 'blocked', cursor: '0', error: 'provider_cursor_did_not_advance' })
    f.close(checkpoint); chmodSync(f.options.databasePath, 0o644)
    expect(() => f.open()).toThrow('private_owner_checkpoint_required')
  })
})
