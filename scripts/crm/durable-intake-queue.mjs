/** Durable, paced intake reference. [COMP:crm/intake-reference]
 * Spec: docs/architecture/features/crm-assurance.md. No ambient credentials.
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'

const APP_ID = 1112688977
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const stableKey = /^[a-z][a-z0-9_-]{0,62}$/
const retryable = new Set([408, 425, 429])
export class IntakeQueueError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status }
}
const fail = (code, status) => { throw new IntakeQueueError(code, status) }
function integer(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`invalid_${name}`)
  return value
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid_json')
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  fail('invalid_json')
}
const json = (value) => JSON.stringify(canonical(value))
export function intakeOrigin(value) {
  let target
  try { target = new URL(value) } catch { fail('invalid_api_origin') }
  if (target.username || target.password || target.search || target.hash || target.pathname !== '/') fail('invalid_api_origin')
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))) fail('https_or_loopback_required')
  return target.origin
}
async function smallJson(response) {
  if (!response.body) throw new Error('invalid_response')
  const reader = response.body.getReader(), chunks = []
  let bytes = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > 16_384) throw new Error('invalid_response')
      chunks.push(Buffer.from(part.value))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel().catch(() => {}) }
}
function intakeResult(status, body) {
  if (status === 200 && body?.duplicate === true && body.outcome === 'submission_retired'
    && body.contactId === undefined && body.submissionId === undefined && body.followUpTaskId === undefined) {
    return { state: 'retired', result: { duplicate: true, outcome: 'submission_retired' } }
  }
  if (![200, 201].includes(status) || body?.duplicate !== (status === 200)
    || !uuid.test(body.submissionId) || !uuid.test(body.contactId)
    || !(body.followUpTaskId === null || uuid.test(body.followUpTaskId))) throw new Error('invalid_response')
  return { state: 'delivered', result: { submissionId: body.submissionId, contactId: body.contactId,
    followUpTaskId: body.followUpTaskId, duplicate: body.duplicate } }
}

export class DurableIntakeQueue {
  constructor({ databasePath, apiUrl, workspaceId, sourceId, replayHorizonMs, minimumSpacingMs = 1100,
    visitorLimit = 10, visitorWindowMs = 60_000, requestTimeoutMs = 30_000, maxOutstanding = 10_000,
    now = Date.now, random = Math.random }) {
    if (!isAbsolute(databasePath ?? '') || databasePath === ':memory:') fail('absolute_database_path_required')
    if (!uuid.test(workspaceId) || !stableKey.test(sourceId)) fail('invalid_queue_identity')
    this.config = { apiUrl: intakeOrigin(apiUrl), workspaceId, sourceId,
      replayHorizonMs: integer(replayHorizonMs, 1, 2147483647000, 'replay_horizon'),
      minimumSpacingMs: integer(minimumSpacingMs, 1001, 60_000, 'spacing'),
      visitorLimit: integer(visitorLimit, 1, 10000, 'visitor_limit'),
      visitorWindowMs: integer(visitorWindowMs, 1000, 3_600_000, 'visitor_window'),
      requestTimeoutMs: integer(requestTimeoutMs, 100, 60_000, 'request_timeout'),
      maxOutstanding: integer(maxOutstanding, 1, 100_000, 'queue_capacity') }
    this.now = now; this.random = random
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
    if (!existsSync(databasePath)) {
      try { closeSync(openSync(databasePath, 'wx', 0o600)) } catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    const stat = lstatSync(databasePath)
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)
      || (process.getuid && stat.uid !== process.getuid())) fail('private_owner_database_required')
    this.db = new DatabaseSync(databasePath)
    try {
      const identity = this.db.prepare('PRAGMA application_id').get().application_id
      if (identity !== APP_ID && (identity !== 0 || this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get())) fail('not_an_intake_queue')
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;')
      this.transaction(() => {
        this.db.exec(`PRAGMA application_id=${APP_ID};
          CREATE TABLE IF NOT EXISTS queue_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,
            configuration TEXT NOT NULL,visitor_salt TEXT NOT NULL,next_start_at INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,definition_key TEXT NOT NULL,source_key TEXT NOT NULL,
            request_hash TEXT NOT NULL,payload_json TEXT,state TEXT NOT NULL CHECK(state IN ('queued','leased','delivered','retired','failed','paused','cancelled')),
            created_at INTEGER NOT NULL,retry_until INTEGER NOT NULL,next_attempt_at INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until INTEGER,
            response_json TEXT,error_category TEXT,http_status INTEGER,uncertain INTEGER NOT NULL DEFAULT 0,
            UNIQUE(definition_key,source_key));
          CREATE INDEX IF NOT EXISTS receipts_due ON receipts(state,next_attempt_at,created_at,id);
          CREATE TABLE IF NOT EXISTS visitor_windows(visitor_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,count INTEGER NOT NULL);`)
        const meta = this.db.prepare('SELECT * FROM queue_meta WHERE id=1').get()
        if (meta && (meta.version !== 1 || meta.configuration !== json(this.config))) fail('queue_configuration_mismatch')
        if (!meta) this.db.prepare('INSERT INTO queue_meta(id,version,configuration,visitor_salt) VALUES(1,1,?,?)').run(json(this.config), randomBytes(32).toString('hex'))
        this.salt = this.db.prepare('SELECT visitor_salt FROM queue_meta WHERE id=1').get().visitor_salt
      })
    } catch (error) { this.db.close(); throw error }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  getReceipt(id, { includePayload = false } = {}) {
    const row = this.db.prepare('SELECT * FROM receipts WHERE id=?').get(id)
    if (!row) return null
    return { id: row.id, definitionKey: row.definition_key, idempotencyKey: row.source_key,
      state: row.state, createdAt: row.created_at, retryUntil: row.retry_until, nextAttemptAt: row.next_attempt_at,
      attempts: row.attempts, uncertain: row.uncertain === 1,
      error: row.error_category ? { category: row.error_category, status: row.http_status } : null,
      result: row.response_json ? JSON.parse(row.response_json) : null,
      ...(includePayload ? { payload: row.payload_json ? JSON.parse(row.payload_json) : null } : {}) }
  }
  enqueue({ definitionKey, idempotencyKey, body, visitorId }) {
    if (!stableKey.test(definitionKey) || typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.trim().length > 200) fail('invalid_submission_identity')
    if (typeof visitorId !== 'string' || !visitorId || visitorId.length > 500) fail('trusted_visitor_identifier_required')
    if (!body || typeof body !== 'object' || Array.isArray(body) || !body.fields || typeof body.fields !== 'object' || Array.isArray(body.fields)
      || Object.keys(body).some((key) => !['fields', 'externalIdentity', 'submittedAt', 'identityProof'].includes(key))) fail('invalid_submission_body')
    const payload = json(body), sourceKey = idempotencyKey.trim()
    if (Buffer.byteLength(payload) > 1_048_576) fail('payload_too_large', 413)
    const hash = createHash('sha256').update(json({ definitionKey, body })).digest('hex')
    const id = this.transaction(() => {
      const prior = this.db.prepare('SELECT id,request_hash FROM receipts WHERE definition_key=? AND source_key=?').get(definitionKey, sourceKey)
      if (prior) {
        if (prior.request_hash !== hash) fail('idempotency_conflict', 409)
        return prior.id
      }
      const now = this.now()
      if (this.db.prepare('SELECT count(*) AS n FROM receipts WHERE payload_json IS NOT NULL').get().n >= this.config.maxOutstanding) fail('queue_full', 503)
      this.db.prepare('DELETE FROM visitor_windows WHERE expires_at<=?').run(now)
      const visitor = createHmac('sha256', this.salt).update(visitorId).digest('hex')
      const window = this.db.prepare('SELECT count FROM visitor_windows WHERE visitor_hash=?').get(visitor)
      if ((window?.count ?? 0) >= this.config.visitorLimit) fail('visitor_rate_limited', 429)
      this.db.prepare(`INSERT INTO visitor_windows(visitor_hash,expires_at,count) VALUES(?,?,1)
        ON CONFLICT(visitor_hash) DO UPDATE SET count=count+1`).run(visitor, now + this.config.visitorWindowMs)
      const receiptId = randomUUID()
      this.db.prepare(`INSERT INTO receipts(id,definition_key,source_key,request_hash,payload_json,state,created_at,retry_until,next_attempt_at)
        VALUES(?,?,?,?,?,'queued',?,?,?)`).run(receiptId, definitionKey, sourceKey, hash, payload, now, now + this.config.replayHorizonMs, now)
      return receiptId
    })
    return this.getReceipt(id)
  }
  claim() {
    return this.transaction(() => {
      const now = this.now()
      this.db.prepare(`UPDATE receipts SET state='queued',lease_token=NULL,lease_until=NULL,uncertain=1,error_category='lease_expired'
        WHERE state='leased' AND lease_until<=?`).run(now)
      this.db.prepare(`UPDATE receipts SET state='paused',error_category='replay_deadline_expired' WHERE state='queued' AND retry_until<=?`).run(now)
      if (this.db.prepare('SELECT next_start_at FROM queue_meta WHERE id=1').get().next_start_at > now) return null
      const row = this.db.prepare(`SELECT * FROM receipts WHERE state='queued' AND next_attempt_at<=? ORDER BY next_attempt_at,created_at,id LIMIT 1`).get(now)
      if (!row) return null
      const token = randomUUID()
      this.db.prepare(`UPDATE receipts SET state='leased',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=?`)
        .run(token, now + this.config.requestTimeoutMs + 5000, row.id)
      this.db.prepare('UPDATE queue_meta SET next_start_at=? WHERE id=1').run(now + this.config.minimumSpacingMs)
      return { ...row, lease_token: token, attempts: row.attempts + 1 }
    })
  }
  finish(row, { state, result = null, category = null, status = null, delay = 0, uncertain = false }) {
    const now = this.now(), next = now + delay
    if (state === 'queued' && next >= row.retry_until) { state = 'paused'; category = 'replay_deadline_expired' }
    const terminal = ['delivered', 'retired'].includes(state)
    this.db.prepare(`UPDATE receipts SET state=?,response_json=?,error_category=?,http_status=?,next_attempt_at=?,
      uncertain=CASE WHEN ? THEN 0 WHEN ? THEN 1 ELSE uncertain END,
      payload_json=CASE WHEN ? THEN NULL ELSE payload_json END,lease_token=NULL,lease_until=NULL
      WHERE id=? AND state='leased' AND lease_token=?`)
      .run(state, result ? json(result) : null, category, status, next, Number(terminal), Number(uncertain), Number(terminal), row.id, row.lease_token)
    return this.getReceipt(row.id)
  }
  async tick({ getToken, fetchImpl = fetch, signal } = {}) {
    if (signal?.aborted) return { processed: false }
    const row = this.claim()
    if (!row) return { processed: false }
    const delay = Math.min(60_000, Math.round(1000 * 2 ** Math.min(row.attempts - 1, 16) * (1 + Math.max(0, Math.min(1, this.random())) * .2)))
    let response
    try {
      const token = await getToken?.()
      if (typeof token !== 'string' || !/^sk_intake_[a-f0-9-]{36}_[^\s]+$/i.test(token)) {
        return { processed: true, receipt: this.finish(row, { state: 'failed', category: 'credentials_unavailable' }) }
      }
      const timeout = AbortSignal.timeout(this.config.requestTimeoutMs)
      response = await fetchImpl(`${this.config.apiUrl}/api/crm/intake/${encodeURIComponent(row.definition_key)}/submissions`, {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': row.source_key },
        body: row.payload_json, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if ([200, 201].includes(response.status)) {
        const accepted = intakeResult(response.status, await smallJson(response))
        return { processed: true, receipt: this.finish(row, { ...accepted, status: response.status }) }
      }
      await response.body?.cancel().catch(() => {})
      const transient = retryable.has(response.status) || (response.status >= 500 && response.status <= 599)
      const retryAfter = response.headers.get('retry-after')
      const requestedDelay = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000
        : retryAfter ? Math.max(0, Date.parse(retryAfter) - this.now()) : 0
      return { processed: true, receipt: this.finish(row, { state: transient ? 'queued' : 'failed',
        category: transient ? 'upstream_retryable' : 'upstream_rejected', status: response.status,
        delay: transient ? Math.max(delay, Number.isFinite(requestedDelay) ? Math.min(requestedDelay, 2147483647000) : 0) : 0,
        uncertain: response.status >= 500 || response.status === 408 }) }
    } catch {
      return { processed: true, receipt: this.finish(row, { state: 'queued', category: response ? 'invalid_upstream_response' : 'transport_uncertain', delay, uncertain: true }) }
    }
  }
  retry(id) {
    return this.transaction(() => {
      const row = this.getReceipt(id)
      if (!row) fail('receipt_not_found', 404)
      if (row.state !== 'failed' || this.now() >= row.retryUntil) fail('receipt_not_retryable', 409)
      this.db.prepare(`UPDATE receipts SET state='queued',next_attempt_at=?,error_category=NULL,http_status=NULL WHERE id=?`).run(this.now(), id)
      return this.getReceipt(id)
    })
  }
  cancel(id) {
    return this.transaction(() => {
      const row = this.getReceipt(id)
      if (!row) fail('receipt_not_found', 404)
      if (['delivered', 'retired'].includes(row.state)) fail('receipt_already_committed', 409)
      this.db.prepare(`UPDATE receipts SET state='cancelled',payload_json=NULL,lease_token=NULL,lease_until=NULL,
        uncertain=CASE WHEN state='leased' OR uncertain=1 THEN 1 ELSE 0 END,error_category='owner_cancelled' WHERE id=?`).run(id)
      return this.getReceipt(id)
    })
  }
  close() { this.db.close() }
}
