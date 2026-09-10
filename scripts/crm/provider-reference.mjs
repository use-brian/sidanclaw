/** Signature-verified provider reference and durable missed-event cursor.
 * [COMP:crm/provider-reference] No live provider SDK or ambient configuration.
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { ProviderInboxEnvelopeSchema } from '../../packages/core/dist/association/provider-inbox.js'
import { intakeOrigin } from './durable-intake-queue.mjs'

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
const states = new Set(['pending', 'processing', 'applied', 'retry', 'needs_reconciliation'])
const APP_ID = 1112688978
export class ProviderReferenceError extends Error {
  constructor(code, status = 400, retryAfterMs = 60_000) { super(code); this.code = code; this.status = status; this.retryAfterMs = retryAfterMs }
}
const fail = (code, status) => { throw new ProviderReferenceError(code, status) }
const integer = (value, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('invalid_bound')
  return value
}
function normalize(value, provider) {
  if (Buffer.byteLength(JSON.stringify(value)) > 32_768) fail('payload_too_large', 413)
  const result = ProviderInboxEnvelopeSchema.safeParse(value)
  if (!result.success || result.data.event.provider !== provider) fail('invalid_provider_envelope', 422)
  return result.data
}
function cursorNumber(value) {
  if (!/^(0|[1-9][0-9]{0,14})$/.test(String(value))) fail('invalid_provider_cursor')
  return integer(Number(value), 0, Number.MAX_SAFE_INTEGER)
}
/** The fake ledger is append-only for the lifetime of an adapter. A production
 * implementation must supply equivalent stable pagination across retention. */
export function createFakeProvider({ provider, events = [], webhookSecret, now = Date.now }) {
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(provider ?? '') || typeof webhookSecret !== 'string' || webhookSecret.length < 32) fail('provider_configuration_required')
  const ledger = []
  const append = value => { ledger.push(normalize(value, provider)); return String(ledger.length) }
  events.forEach(append)
  const digest = (body, seconds) => createHmac('sha256', webhookSecret).update(`${seconds}.`).update(body).digest('hex')
  return {
    provider, append,
    signWebhook(envelope, seconds = Math.floor(now() / 1000)) {
      const body = Buffer.from(JSON.stringify(normalize(envelope, provider)))
      return { body, signature: `t=${seconds},v1=${digest(body, seconds)}` }
    },
    verifyWebhook(body, signature) {
      if (!Buffer.isBuffer(body) || body.length > 32_768) fail('payload_too_large', 413)
      const match = /^t=([0-9]{1,12}),v1=([a-f0-9]{64})$/.exec(signature ?? '')
      if (!match || Math.abs(now() / 1000 - Number(match[1])) > 300 || !timingSafeEqual(Buffer.from(match[2], 'hex'), Buffer.from(digest(body, match[1]), 'hex'))) fail('invalid_signature', 401)
      let parsed
      try { parsed = JSON.parse(body.toString('utf8')) } catch { fail('invalid_provider_envelope', 422) }
      return normalize(parsed, provider)
    },
    async listEvents({ cursor = '0', limit = 100 }) {
      const offset = cursorNumber(cursor); integer(limit, 1, 100)
      if (offset > ledger.length) fail('provider_cursor_outside_ledger', 409)
      return { entries: ledger.slice(offset, offset + limit).map((envelope, index) => ({ cursor: String(offset + index + 1), envelope: structuredClone(envelope) })), hasMore: offset + limit < ledger.length }
    },
  }
}

export class ProviderCheckpoint {
  constructor({ databasePath, sourceId, provider, apiUrl, workspaceId, now = Date.now, leaseMs = 120_000 }) {
    if (!isAbsolute(databasePath ?? '') || !/^[a-z][a-z0-9_-]{0,62}$/.test(sourceId ?? '') || !uuid.test(workspaceId ?? '')) fail('explicit_checkpoint_identity_required')
    integer(leaseMs, 1000, 300_000)
    this.now = now; this.leaseMs = leaseMs
    this.identity = JSON.stringify({ sourceId, provider, apiUrl: intakeOrigin(apiUrl), workspaceId })
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
    if (!existsSync(databasePath)) {
      try { closeSync(openSync(databasePath, 'wx', 0o600)) } catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    const stat = lstatSync(databasePath)
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) fail('private_owner_checkpoint_required')
    this.db = new DatabaseSync(databasePath)
    try {
      const appId = this.db.prepare('PRAGMA application_id').get().application_id
      if (appId !== APP_ID && (appId !== 0 || this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get())) fail('not_a_provider_checkpoint')
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      this.transaction(() => {
        this.db.exec(`PRAGMA application_id=${APP_ID};
          CREATE TABLE IF NOT EXISTS checkpoint(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,identity TEXT NOT NULL,cursor TEXT NOT NULL DEFAULT '0',lease TEXT,lease_until INTEGER,retry_at INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS issues(cursor INTEGER PRIMARY KEY,receipt_id TEXT NOT NULL,state TEXT NOT NULL,recorded_at INTEGER NOT NULL);`)
        const row = this.db.prepare('SELECT * FROM checkpoint WHERE id=1').get()
        if (row && (row.version !== 1 || row.identity !== this.identity)) fail('checkpoint_identity_mismatch')
        if (!row) this.db.prepare('INSERT INTO checkpoint(id,version,identity) VALUES(1,1,?)').run(this.identity)
      })
    } catch (error) { this.db.close(); throw error }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  state() { return this.db.prepare('SELECT cursor,retry_at AS retryAt,lease_until AS leaseUntil FROM checkpoint WHERE id=1').get() }
  claim() {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM checkpoint WHERE id=1').get()
      if (row.retry_at > this.now() || row.lease_until > this.now()) return null
      const lease = randomUUID()
      this.db.prepare('UPDATE checkpoint SET lease=?,lease_until=? WHERE id=1').run(lease, this.now() + this.leaseMs)
      return { lease, cursor: row.cursor }
    })
  }
  renew(lease) {
    if (!this.db.prepare('UPDATE checkpoint SET lease_until=? WHERE id=1 AND lease=? AND lease_until>?').run(this.now() + this.leaseMs, lease, this.now()).changes) fail('checkpoint_lease_lost', 409)
  }
  advance(lease, previous, next, receipt) {
    cursorNumber(previous); cursorNumber(next)
    if (Number(next) <= Number(previous)) fail('provider_cursor_did_not_advance', 409)
    return this.transaction(() => {
      if (!this.db.prepare('UPDATE checkpoint SET cursor=? WHERE id=1 AND cursor=? AND lease=? AND lease_until>?').run(next, previous, lease, this.now()).changes) fail('checkpoint_lease_lost', 409)
      if (receipt.state !== 'applied') this.db.prepare('INSERT INTO issues(cursor,receipt_id,state,recorded_at) VALUES(?,?,?,?)').run(Number(next), receipt.id, receipt.state, this.now())
    })
  }
  release(lease, retryAfterMs = 0) {
    integer(retryAfterMs, 0, 86_400_000)
    this.db.prepare('UPDATE checkpoint SET lease=NULL,lease_until=NULL,retry_at=? WHERE id=1 AND lease=?').run(this.now() + retryAfterMs, lease)
  }
  issues({ cursor = '0', limit = 100 } = {}) {
    const rows = this.db.prepare('SELECT cursor,receipt_id AS receiptId,state,recorded_at AS recordedAt FROM issues WHERE cursor>? ORDER BY cursor LIMIT ?').all(cursorNumber(cursor), integer(limit, 1, 100) + 1)
    return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? String(rows[limit - 1].cursor) : null }
  }
  close() { this.db.close() }
}

async function boundedJson(response) {
  if (!response.body) fail('invalid_brian_receipt', 502)
  const reader = response.body.getReader(), chunks = []; let bytes = 0
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break
      bytes += part.value.byteLength
      if (bytes > 1_048_576) fail('invalid_brian_receipt', 502)
      chunks.push(Buffer.from(part.value))
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { fail('invalid_brian_receipt', 502) }
  } finally { await reader.cancel().catch(() => {}) }
}
export function createBrianProviderClient({ apiUrl, workspaceId, getToken, fetchImpl = fetch, now = Date.now }) {
  const origin = intakeOrigin(apiUrl)
  if (!uuid.test(workspaceId ?? '')) fail('explicit_workspace_required')
  let verifiedTokenHash
  return { async forward(envelope) {
    const input = ProviderInboxEnvelopeSchema.parse(envelope), token = getToken()
    if (!/^sk_crm_[a-f0-9-]{36}_[A-Za-z0-9_-]{43}$/i.test(token ?? '')) fail('integration_credential_required', 401)
    const tokenHash = createHash('sha256').update(token).digest('hex')
    if (verifiedTokenHash !== tokenHash) {
      let catalog
      try { catalog = await fetchImpl(`${origin}/api/crm/integration/catalog`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000), redirect: 'error' }) }
      catch { throw new ProviderReferenceError('brian_response_uncertain', 503) }
      if (!catalog.ok || (await boundedJson(catalog)).workspaceId !== workspaceId) fail('credential_workspace_mismatch', 403)
      verifiedTokenHash = tokenHash
    }
    const path = input.target === 'order' ? `/orders/${input.orderId}/provider-events` : '/provider-entitlement-events'
    let response
    try { response = await fetchImpl(`${origin}/api/crm/integration/association${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input.event), signal: AbortSignal.timeout(30_000), redirect: 'error' }) }
    catch { throw new ProviderReferenceError('brian_response_uncertain', 503) }
    const value = response.headers.get('retry-after'), seconds = value === null ? NaN : Number(value)
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value ?? '') - now()
    const retryAfterMs = Number.isFinite(delay) ? Math.max(1000, Math.min(86_400_000, delay)) : 60_000
    if (response.status === 429) { await response.body?.cancel(); throw new ProviderReferenceError('brian_rate_limited', 429, retryAfterMs) }
    const body = await boundedJson(response)
    const receipt = [200, 201].includes(response.status) ? body.receipt
      : [401, 403, 409, 422].includes(response.status) && body.details ? { id: body.details.receiptId, state: body.details.receiptState } : null
    if (receipt && uuid.test(receipt.id ?? '') && states.has(receipt.state)) return { id: receipt.id, state: receipt.state }
    throw new ProviderReferenceError('brian_receipt_unconfirmed', response.status, retryAfterMs)
  } }
}

export function createProviderReconciler({ provider, client, checkpoint, pageSize = 100, maxPages = 10 }) {
  integer(pageSize, 1, 100); integer(maxPages, 1, 10)
  return {
    async receiveWebhook(body, signature) { return client.forward(provider.verifyWebhook(body, signature)) },
    async reconcile() {
      const claim = checkpoint.claim()
      if (!claim) return { state: 'waiting', processed: 0, cursor: checkpoint.state().cursor }
      let cursor = claim.cursor, processed = 0, retryAfterMs = 0
      try {
        for (let page = 0; page < maxPages; page++) {
          checkpoint.renew(claim.lease)
          const result = await provider.listEvents({ cursor, limit: pageSize })
          if (!Array.isArray(result.entries) || result.entries.length > pageSize || (!result.entries.length && result.hasMore)) fail('invalid_provider_page', 502)
          for (const entry of result.entries) {
            checkpoint.renew(claim.lease)
            if (cursorNumber(entry.cursor) <= cursorNumber(cursor)) fail('provider_cursor_did_not_advance', 502)
            const receipt = await client.forward(normalize(entry.envelope, provider.provider))
            if (!uuid.test(receipt?.id ?? '') || !states.has(receipt.state)) fail('invalid_brian_receipt', 502)
            checkpoint.advance(claim.lease, cursor, entry.cursor, receipt)
            cursor = entry.cursor; processed++
          }
          if (!result.hasMore) return { state: 'caught_up', processed, cursor }
        }
        return { state: 'more_due', processed, cursor }
      } catch (error) {
        retryAfterMs = error instanceof ProviderReferenceError ? error.retryAfterMs : 60_000
        return { state: 'blocked', processed, cursor, error: error instanceof ProviderReferenceError ? error.code : 'provider_reconciliation_failed' }
      } finally { checkpoint.release(claim.lease, retryAfterMs) }
    },
  }
}
