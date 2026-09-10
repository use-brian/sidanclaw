/** Pure REST discovery for operator manifests. [COMP:crm/manifest] */
import { open, constants } from 'node:fs/promises'
import { CrmManifestSchema } from '../../packages/core/dist/crm/manifest.js'
import { CrmOperationsUuidSchema } from '../../packages/core/dist/crm/operations-types.js'
import { CRM_CONFIG_ENTITY_KINDS } from '../../packages/core/dist/crm/config-commands.js'
import { CRM_CUSTOM_FIELD_TYPES } from '../../packages/core/dist/crm/types.js'

export class ManifestError extends Error {
  constructor(code, details = {}) {
    super(code)
    this.name = 'ManifestError'
    this.code = code
    this.details = details
  }
}
const fail = (code, details) => { throw new ManifestError(code, details) }
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function parseManifest(input) {
  const parsed = CrmManifestSchema.safeParse(input)
  if (!parsed.success) fail('invalid_manifest', { issues: parsed.error.issues.slice(0, 100).map((issue) => ({
    path: issue.path.join('.'), code: issue.code, message: issue.message,
  })) })
  return parsed.data
}

export async function readManifestToken({ tokenEnv, tokenFile, env = process.env }) {
  if (Boolean(tokenEnv) === Boolean(tokenFile)) fail('choose_one_token_source')
  let token
  if (tokenEnv) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) fail('invalid_token_environment_name')
    token = env[tokenEnv]
  } else {
    let file
    try {
      file = await open(tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const info = await file.stat()
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.() || info.size > 16_384) fail('private_token_file_required')
      const buffer = Buffer.alloc(16_385)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead > 16_384) fail('private_token_file_required')
      token = buffer.subarray(0, bytesRead).toString('utf8')
    } catch (error) {
      if (error instanceof ManifestError) throw error
      fail('token_file_unavailable')
    } finally { await file?.close() }
  }
  if (typeof token !== 'string') fail('token_unavailable')
  token = token.trim()
  if (!token || token.length > 16_384 || !/^[\x21-\x7e]+$/.test(token)) fail('invalid_token')
  return token
}

function origin(value) {
  let url
  try { url = new URL(value) } catch { fail('invalid_api_origin') }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('invalid_api_origin')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) fail('https_or_loopback_required')
  return url.origin
}

async function responseJson(response, maxBytes) {
  if (!response.body) fail('malformed_response')
  const reader = response.body.getReader(), chunks = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) fail('response_too_large')
      chunks.push(Buffer.from(value))
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { fail('malformed_response') }
  } finally { await reader.cancel().catch(() => {}) }
}

export function createManifestClient({ apiUrl, workspaceId, mode, token, fetchImpl = fetch, timeoutMs = 30_000, pageSize = 100, signal }) {
  const apiOrigin = origin(apiUrl)
  if (!CrmOperationsUuidSchema.safeParse(workspaceId).success) fail('invalid_workspace')
  if (!['member', 'integration'].includes(mode)) fail('invalid_auth_mode')
  if (typeof token !== 'string' || !token || !/^[\x21-\x7e]+$/.test(token) || token.length > 16_384) fail('invalid_token')
  if ((mode === 'integration') !== token.startsWith('sk_crm_')) fail('credential_family_mismatch')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) fail('invalid_request_deadline')
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) fail('invalid_page_size')
  const prefix = mode === 'integration' ? '/api/crm/integration' : `/api/crm/${workspaceId}`

  const request = async (path, { query = {}, method = 'GET', body } = {}) => {
    if (!/^\/(?:catalog|operations\/[a-z0-9/-]+)$/.test(path)) fail('invalid_resource_path')
    const url = new URL(prefix + path, apiOrigin)
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value))
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      signal?.throwIfAborted()
      const response = await fetchImpl(url, { method, redirect: 'manual', signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        fail(response.status >= 300 && response.status < 400 ? 'redirect_refused' : 'request_failed', { status: response.status, path, method })
      }
      return await responseJson(response, 8 * 1024 * 1024)
    } catch (error) {
      if (error instanceof ManifestError) throw error
      fail('request_uncertain', { path, method })
    } finally { clearTimeout(timer) }
  }

  const pages = async (path, key, query = {}) => {
    const rows = [], cursors = new Set(), ids = new Set()
    let cursor, catalog
    do {
      const body = await request(path, { query: { ...query, limit: pageSize, cursor } })
      if (!object(body) || !Array.isArray(body[key]) || !(body.nextCursor === null || (typeof body.nextCursor === 'string' && body.nextCursor.length > 0 && body.nextCursor.length <= 4096))) fail('malformed_catalog', { path })
      for (const row of body[key]) {
        if (!object(row) || !CrmOperationsUuidSchema.safeParse(row.id).success || ids.has(row.id)) fail('malformed_catalog', { path })
        ids.add(row.id); rows.push(row)
      }
      if (body.catalog !== undefined) {
        if (!Array.isArray(body.catalog) || body.catalog.some((entry) => !object(entry) || typeof entry.field !== 'string' || typeof entry.family !== 'string' || !Array.isArray(entry.operators))) fail('malformed_catalog', { path })
        // A catalog can change during traversal. Preserve the latest complete
        // catalog; membership pages themselves retain the API cursor contract.
        catalog = body.catalog
      }
      cursor = body.nextCursor
      if (cursor && cursors.has(cursor)) fail('repeated_cursor', { path })
      if (cursor) cursors.add(cursor)
      if (rows.length > 100_000 || cursors.size > 10_000) fail('catalog_limit_exceeded', { path })
    } while (cursor)
    return { rows, catalog }
  }

  const verifyDestination = async () => {
    if (mode === 'integration') {
      const discovery = await request('/catalog')
      if (!object(discovery) || !CrmOperationsUuidSchema.safeParse(discovery.workspaceId).success
        || !CrmOperationsUuidSchema.safeParse(discovery.credentialId).success || !Array.isArray(discovery.grants)) fail('malformed_discovery')
      if (discovery.workspaceId !== workspaceId) fail('workspace_mismatch')
      return discovery
    }
    // The member adapter reads real workspace membership before returning this
    // pure catalog. Do not use the settings getter, which seeds a default.
    await pages('/operations/record-fields', 'fields', {})
    return { workspaceId }
  }
  return { mode, workspaceId, request, pages, verifyDestination }
}

export async function discoverManifestCatalogs(client, manifestInput) {
  const manifest = parseManifest(manifestInput)
  await client.verifyDestination()
  const has = (key) => manifest[key].length > 0
  const needed = {
    recordFields: has('recordFields') || has('intakeDefinitions') || has('segments'),
    pipelines: has('pipelines') || has('pipelineStages') || has('segments'),
    consentPurposes: has('consentPurposes') || has('intakeDefinitions') || has('segments'),
    entitlementPlans: has('entitlementPlans') || has('segments'),
    events: has('events') || has('segments'),
    intakeDefinitions: has('intakeDefinitions'), segments: has('segments'),
  }
  const resources = {
    recordFields: ['record-fields', 'fields', { includeArchived: true }],
    pipelines: ['pipelines', 'pipelines', { includeArchived: true }],
    consentPurposes: ['consent-purposes', 'purposes', { includeArchived: true }],
    entitlementPlans: ['entitlement-plans', 'plans', {}],
    events: ['events', 'events', {}], intakeDefinitions: ['intake-definitions', 'definitions', {}],
  }
  const result = { segments: [], segmentCatalogs: {}, loaded: [] }
  for (const [key, [path, property, query]] of Object.entries(resources)) {
    result[key] = []
    if (needed[key]) {
      result[key] = (await client.pages(`/operations/${path}`, property, query)).rows
      validateRows(key, result[key])
      result.loaded.push(key)
    }
  }
  if (needed.segments) {
    // Segment keys are workspace-wide even when a list is entity-kind scoped.
    for (const entityKind of CRM_CONFIG_ENTITY_KINDS) {
      const page = await client.pages('/operations/segments', 'segments', { entityKind, includeArchived: true })
      if (!page.catalog) fail('malformed_catalog', { path: '/operations/segments' })
      validateRows('segments', page.rows)
      if (page.rows.some((row) => row.entityKind !== entityKind)) fail('malformed_catalog', { path: '/operations/segments' })
      result.segments.push(...page.rows)
      result.segmentCatalogs[entityKind] = page.catalog
    }
    result.loaded.push('segments')
  }
  return result
}

function validateRows(resource, rows) {
  const text = (value) => typeof value === 'string' && value.length > 0
  const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string')
  const valid = {
    recordFields: (row) => CRM_CONFIG_ENTITY_KINDS.includes(row.entityKind) && text(row.fieldKey)
      && text(row.label) && CRM_CUSTOM_FIELD_TYPES.includes(row.fieldType) && strings(row.options) && typeof row.isRequired === 'boolean',
    pipelines: (row) => text(row.name) && typeof row.isDefault === 'boolean' && Array.isArray(row.stages)
      && row.stages.every((stage) => object(stage) && CrmOperationsUuidSchema.safeParse(stage.id).success
        && stage.pipelineId === row.id && text(stage.name) && text(stage.category) && Number.isInteger(stage.probability) && strings(stage.requiredFields)),
    consentPurposes: (row) => text(row.purposeKey) && text(row.label) && text(row.wordingVersion) && text(row.wording)
      && typeof row.requiresConsent === 'boolean' && strings(row.applicableChannels),
    entitlementPlans: (row) => text(row.planKey) && text(row.name) && text(row.currency)
      && (typeof row.feeMinor === 'number' || (typeof row.feeMinor === 'string' && /^[0-9]+$/.test(row.feeMinor)))
      && Number.isSafeInteger(Number(row.feeMinor)) && Number(row.feeMinor) >= 0 && text(row.billingPeriod) && typeof row.published === 'boolean',
    events: (row) => text(row.slug) && text(row.title) && text(row.startsAt) && text(row.endsAt) && text(row.timezone) && text(row.mode) && text(row.status),
    intakeDefinitions: (row) => text(row.definitionKey) && text(row.label) && Number.isInteger(row.currentVersion)
      && row.currentVersion > 0 && typeof row.active === 'boolean' && Array.isArray(row.fields) && Array.isArray(row.consentMappings) && text(row.identityPolicy),
    segments: (row) => text(row.segmentKey) && text(row.name) && CRM_CONFIG_ENTITY_KINDS.includes(row.entityKind)
      && object(row.predicate) && Number.isInteger(row.version) && row.version > 0,
  }
  if (rows.some((row) => !valid[resource](row))) fail('malformed_catalog', { resource })
}
