#!/usr/bin/env node
/** Loopback-only executable reference. [COMP:crm/intake-reference] */
import { createServer } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { setTimeout } from 'node:timers/promises'
import { DurableIntakeQueue, IntakeQueueError } from './durable-intake-queue.mjs'

function readJson(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = []; let bytes = 0, failed = false
    req.on('data', (chunk) => {
      if (failed) return
      bytes += chunk.length
      if (bytes > 1_060_000) { failed = true; reject(new IntakeQueueError('payload_too_large', 413)); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (failed) return
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new IntakeQueueError('invalid_json')) }
    })
    req.on('error', () => reject(new IntakeQueueError('request_interrupted')))
  })
}
export async function startReferenceIntakeBackend({ queue, bearerToken, getIntakeToken, port = 0, runWorker = true }) {
  if (typeof bearerToken !== 'string' || bearerToken.length < 32 || /\s/.test(bearerToken)) throw new IntakeQueueError('private_backend_token_required')
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new IntakeQueueError('invalid_port')
  const digest = (value) => createHash('sha256').update(value).digest()
  const bearerHash = digest(`Bearer ${bearerToken}`), controller = new AbortController()
  const server = createServer(async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    if (!timingSafeEqual(digest(req.headers.authorization ?? ''), bearerHash)) { reply(401, { error: 'unauthorized' }); return }
    try {
      const url = new URL(req.url, 'http://localhost'), parts = url.pathname.split('/').filter(Boolean)
      if (req.method === 'POST' && parts[0] === 'submissions' && parts.length === 2) {
        const input = await readJson(req)
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['idempotencyKey', 'body'].includes(key))) throw new IntakeQueueError('invalid_submission_body')
        const receipt = queue.enqueue({ definitionKey: parts[1], idempotencyKey: input.idempotencyKey, body: input.body,
          // No forwarded headers: production ingress must supply its own trusted resolver.
          visitorId: req.socket.remoteAddress ?? 'local_unknown' })
        reply(['queued', 'leased'].includes(receipt.state) ? 202 : 200, { receipt })
        return
      }
      if (req.method === 'GET' && parts[0] === 'receipts' && parts.length === 2) {
        const receipt = queue.getReceipt(parts[1], { includePayload: url.searchParams.get('includePayload') === 'true' })
        reply(receipt ? 200 : 404, receipt ? { receipt } : { error: 'receipt_not_found' }); return
      }
      if (req.method === 'POST' && parts[0] === 'receipts' && parts.length === 3 && ['retry', 'cancel'].includes(parts[2])) {
        const input = await readJson(req)
        if (!input || input.confirmed !== true || Object.keys(input).length !== 1) throw new IntakeQueueError('owner_confirmation_required')
        reply(200, { receipt: queue[parts[2]](parts[1]) }); return
      }
      reply(404, { error: 'not_found' })
    } catch (error) {
      reply(error instanceof IntakeQueueError ? error.status : 500, { error: error instanceof IntakeQueueError ? error.code : 'reference_backend_failed' })
    }
  })
  server.requestTimeout = 30_000; server.headersTimeout = 10_000
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done) })
  const worker = runWorker ? (async () => {
    while (!controller.signal.aborted) {
      await queue.tick({ getToken: getIntakeToken, signal: controller.signal })
      await setTimeout(250, undefined, { signal: controller.signal }).catch(() => {})
    }
  })() : Promise.resolve()
  // Keep rejected workers observable and stop new ingress; never keep returning
  // queued acknowledgements after the only fixture worker has failed.
  let workerError = null, reportFailure
  const failure = new Promise((_resolve, reject) => { reportFailure = reject })
  failure.catch(() => {})
  worker.catch((error) => { workerError = error; controller.abort(); server.close(); reportFailure(error) })
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    failure,
    async close() {
      controller.abort()
      await new Promise((done) => server.close(done))
      await worker.catch(() => {})
      if (workerError) throw workerError
    },
  }
}

const help = `Durable CRM intake backend reference (loopback only; Node 22.13+).
Usage: node scripts/crm/reference-intake-backend.mjs --db <absolute-path>
  --api-url <https-origin-or-loopback> --workspace <uuid> --source <stable-key>
  --replay-horizon-seconds <approved-seconds> [--port 0]
  [--intake-token-env BRIAN_INTAKE_TOKEN] [--backend-token-env BRIAN_QUEUE_TOKEN]

Supply secrets only through the named environment variables. The backend token
must contain at least 32 non-whitespace characters. No .env file is loaded.
POST /submissions/<definition> with {idempotencyKey,body:{fields,...}} commits
the queue before 202. GET /receipts/<id> shows state; ?includePayload=true is
explicit owner inspection. POST /receipts/<id>/retry or /cancel requires
{confirmed:true}. All routes require the private backend bearer credential.
The fixture ignores forwarded-IP headers and is not a production website.
The approved retry horizon must fit Brian's receipt policy. Cancellation of an
in-flight request is uncertain: inspect Brian before assuming nothing arrived.
`
export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    help: { type: 'boolean' }, db: { type: 'string' }, 'api-url': { type: 'string' }, workspace: { type: 'string' },
    source: { type: 'string' }, 'replay-horizon-seconds': { type: 'string' }, port: { type: 'string' },
    'intake-token-env': { type: 'string', default: 'BRIAN_INTAKE_TOKEN' }, 'backend-token-env': { type: 'string', default: 'BRIAN_QUEUE_TOKEN' },
  } })
  if (values.help) { process.stdout.write(help); return }
  for (const key of ['intake-token-env', 'backend-token-env']) if (!/^[A-Z][A-Z0-9_]{0,100}$/.test(values[key])) throw new IntakeQueueError('invalid_token_environment_name')
  const getIntakeToken = () => process.env[values['intake-token-env']]
  if (!/^sk_intake_[a-f0-9-]{36}_[^\s]+$/i.test(getIntakeToken() ?? '')) throw new IntakeQueueError('intake_credential_required')
  const queue = new DurableIntakeQueue({ databasePath: values.db, apiUrl: values['api-url'], workspaceId: values.workspace,
    sourceId: values.source, replayHorizonMs: Number(values['replay-horizon-seconds']) * 1000 })
  try {
    const backend = await startReferenceIntakeBackend({ queue, getIntakeToken, bearerToken: process.env[values['backend-token-env']], port: Number(values.port ?? 0) })
    process.stdout.write(`${JSON.stringify({ url: backend.url, sourceId: values.source, workspaceId: values.workspace })}\n`)
    let stop
    try {
      await Promise.race([backend.failure, new Promise((done) => {
        stop = done; process.on('SIGINT', stop); process.on('SIGTERM', stop)
      })])
    } finally {
      if (stop) { process.off('SIGINT', stop); process.off('SIGTERM', stop) }
      await backend.close()
    }
  } finally { queue.close() }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${JSON.stringify({ error: error instanceof IntakeQueueError ? error.code : 'reference_backend_failed' })}\n`); process.exitCode = 1 })
}
