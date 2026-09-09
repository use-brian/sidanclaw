#!/usr/bin/env node
/** Loopback fake-provider backend. [COMP:crm/provider-reference] */
import { createServer } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { setTimeout } from 'node:timers/promises'
import { ProviderReferenceError, ProviderCheckpoint, createBrianProviderClient, createFakeProvider, createProviderReconciler } from './provider-reference.mjs'

async function rawBody(req) {
  const chunks = []; let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 32_768) throw new ProviderReferenceError('payload_too_large', 413)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
export async function startReferenceProviderBackend({ reconciler, checkpoint, backendToken, port = 0, intervalMs = 60_000 }) {
  if (typeof backendToken !== 'string' || backendToken.length < 32 || /\s/.test(backendToken)) throw new ProviderReferenceError('private_backend_token_required')
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3_600_000) throw new ProviderReferenceError('invalid_server_options')
  const hash = value => createHash('sha256').update(value).digest(), tokenHash = hash(`Bearer ${backendToken}`)
  const controller = new AbortController()
  let last = { state: 'not_run', processed: 0 }
  const server = createServer(async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (req.method === 'POST' && url.pathname === '/webhook') {
        const receipt = await reconciler.receiveWebhook(await rawBody(req), req.headers['x-fixture-signature'])
        reply(receipt.state === 'applied' ? 200 : 202, { receipt }); return
      }
      if (!timingSafeEqual(hash(req.headers.authorization ?? ''), tokenHash)) { reply(401, { error: 'unauthorized' }); return }
      if (req.method === 'GET' && url.pathname === '/reconciliation') {
        reply(200, { last, checkpoint: checkpoint.state(), issues: checkpoint.issues({ cursor: url.searchParams.get('cursor') ?? '0', limit: Number(url.searchParams.get('limit') ?? 100) }) }); return
      }
      reply(404, { error: 'not_found' })
    } catch (error) { reply(error instanceof ProviderReferenceError ? error.status : 500, { error: error instanceof ProviderReferenceError ? error.code : 'provider_reference_failed' }) }
  })
  server.requestTimeout = 30_000; server.headersTimeout = 10_000
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done) })
  let workerError = null, rejectFailure
  const failure = new Promise((_resolve, reject) => { rejectFailure = reject }); failure.catch(() => {})
  const worker = (async () => {
    while (!controller.signal.aborted) {
      last = await reconciler.reconcile()
      await setTimeout(intervalMs, undefined, { signal: controller.signal }).catch(() => {})
    }
  })()
  worker.catch(error => { workerError = error; controller.abort(); server.close(); rejectFailure(error) })
  return { url: `http://127.0.0.1:${server.address().port}`, failure, async close() {
    controller.abort(); await new Promise(done => server.close(done)); await worker.catch(() => {})
    if (workerError) throw workerError
  } }
}
const help = `Fake-provider webhook and missed-event reference (Node 22.13+; build core first).
Usage: node scripts/crm/reference-provider-backend.mjs --fixture <json>
  --checkpoint <absolute-private-sqlite-path> --api-url <loopback-origin>
  [--once | --serve] [--port 0] [--interval-seconds 60]
  [--token-env BRIAN_CRM_TOKEN] [--webhook-secret-env BRIAN_FIXTURE_WEBHOOK_SECRET]
  [--backend-token-env BRIAN_PROVIDER_BACKEND_TOKEN]

Default is preflight only. --once enumerates the fictional ledger once (bounded
1000 events); --serve exposes loopback POST /webhook and repeats reconciliation.
POST /webhook requires x-fixture-signature over the exact body. GET
/reconciliation requires the private backend bearer token and paginates receipt
pointers using cursor/limit. Sign fixture requests using createFakeProvider's
signWebhook function. Secrets come from named environment variables, never argv.
The fixture includes provider, sourceId, workspaceId and normalized events.
Its IDs must refer to records seeded in the disposable local Brian workspace.
Bind paid orders through /orders/:id/provider-binding before delivering events.
The fixture does not create contacts/orders/plans or assert real provider truth.
No .env, live provider SDK, cloud account or nonlocal API is used.
`
export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    help: { type: 'boolean' }, fixture: { type: 'string' }, checkpoint: { type: 'string' }, 'api-url': { type: 'string' },
    once: { type: 'boolean' }, serve: { type: 'boolean' }, port: { type: 'string' }, 'interval-seconds': { type: 'string' },
    'token-env': { type: 'string', default: 'BRIAN_CRM_TOKEN' }, 'webhook-secret-env': { type: 'string', default: 'BRIAN_FIXTURE_WEBHOOK_SECRET' },
    'backend-token-env': { type: 'string', default: 'BRIAN_PROVIDER_BACKEND_TOKEN' },
  } })
  if (values.help || !argv.length) { process.stdout.write(help); return }
  if (values.once && values.serve) throw new ProviderReferenceError('choose_once_or_serve')
  const url = new URL(values['api-url'])
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new ProviderReferenceError('loopback_api_required')
  for (const name of ['token-env', 'webhook-secret-env', 'backend-token-env']) if (!/^[A-Z][A-Z0-9_]{0,100}$/.test(values[name])) throw new ProviderReferenceError('invalid_secret_environment_name')
  const source = await readFile(values.fixture, 'utf8')
  if (Buffer.byteLength(source) > 8_388_608) throw new ProviderReferenceError('fixture_too_large')
  const fixture = JSON.parse(source)
  const provider = createFakeProvider({ ...fixture, webhookSecret: process.env[values['webhook-secret-env']] })
  if (!values.once && !values.serve) { process.stdout.write(`${JSON.stringify({ state: 'preflight', events: fixture.events.length, execution: 'not_run' })}\n`); return }
  const client = createBrianProviderClient({ apiUrl: url.origin, workspaceId: fixture.workspaceId, getToken: () => process.env[values['token-env']] })
  const checkpoint = new ProviderCheckpoint({ databasePath: values.checkpoint, apiUrl: url.origin, provider: fixture.provider, sourceId: fixture.sourceId, workspaceId: fixture.workspaceId })
  try {
    const reconciler = createProviderReconciler({ provider, client, checkpoint })
    if (values.once) {
      const result = await reconciler.reconcile(); process.stdout.write(`${JSON.stringify(result)}\n`)
      if (result.state !== 'caught_up') process.exitCode = 1
      return
    }
    const backend = await startReferenceProviderBackend({ reconciler, checkpoint, backendToken: process.env[values['backend-token-env']], port: Number(values.port ?? 0), intervalMs: Number(values['interval-seconds'] ?? 60) * 1000 })
    process.stdout.write(`${JSON.stringify({ url: backend.url })}\n`)
    let stop
    try { await Promise.race([backend.failure, new Promise(done => { stop = done; process.on('SIGINT', stop); process.on('SIGTERM', stop) })]) }
    finally { if (stop) { process.off('SIGINT', stop); process.off('SIGTERM', stop) }; await backend.close() }
  } finally { checkpoint.close() }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${JSON.stringify({ error: error instanceof ProviderReferenceError ? error.code : 'provider_reference_failed' })}\n`); process.exitCode = 1 })
}
