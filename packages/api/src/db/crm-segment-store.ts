/**
 * Dynamic CRM segment catalog, compiler, and read store.
 *
 * The compiler accepts only catalog-validated AST nodes and parameterizes all
 * values. Dynamic membership is evaluated against the entity-backed CRM at
 * read time; no second membership table exists.
 *
 * [COMP:crm/segments]
 */

import {
  CrmOperationsError,
  CrmDomainEventTypeSchema,
  CrmSegmentPredicateSchema,
  CrmPageQuerySchema,
  validateCrmSegmentCatalog,
  type CrmOperationsReadPort,
  type CrmSegmentCatalog,
  type CrmSegmentCatalogEntry,
  type CrmSegmentOperator,
  type CrmSegmentPredicate,
  type CrmSegmentRule,
} from '@use-brian/core'
import type { QueryResultRow } from 'pg'
import { query } from './client.js'
import { crmPageInstant, queryCrmPage } from '../crm-operations/pagination.js'

type EntityKind = 'person' | 'company' | 'deal'
type QueryFn = <T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>

const TEXT_OPS: CrmSegmentOperator[] = ['eq', 'neq', 'contains', 'not_contains', 'in', 'not_in', 'is_empty', 'is_not_empty']
const NUMBER_OPS: CrmSegmentOperator[] = ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty']
const DATE_OPS: CrmSegmentOperator[] = ['eq', 'neq', 'before', 'after', 'is_empty', 'is_not_empty']
const BOOLEAN_OPS: CrmSegmentOperator[] = ['eq', 'neq', 'is_empty', 'is_not_empty']
const UUID_OPS: CrmSegmentOperator[] = ['eq', 'neq', 'in', 'not_in', 'is_empty', 'is_not_empty']
const ENUM_OPS: CrmSegmentOperator[] = ['eq', 'neq', 'in', 'not_in', 'is_empty', 'is_not_empty']

type FieldType = CrmSegmentCatalogEntry['valueType']
type CatalogEntry = CrmSegmentCatalogEntry & { sqlKind?: string; sourceKey?: string }

function entry(
  family: CatalogEntry['family'],
  field: string,
  label: string,
  valueType: FieldType,
  operators: CrmSegmentOperator[],
  options: Partial<Pick<CatalogEntry, 'validValues' | 'sqlKind' | 'sourceKey'>> = {},
): CatalogEntry {
  return { family, field, label, valueType, operators, ...options }
}

function baseCatalog(kind: EntityKind): CatalogEntry[] {
  const common = [
    entry('base', 'name', 'Name', 'text', TEXT_OPS),
    entry('base', 'created_at', 'Created at', 'date', DATE_OPS),
    entry('base', 'updated_at', 'Updated at', 'date', DATE_OPS),
    entry('tag', 'tags', 'Tags', 'text', TEXT_OPS),
  ]
  if (kind === 'person') return [
    ...common,
    entry('base', 'email', 'Email', 'text', TEXT_OPS),
    entry('base', 'phone', 'Phone', 'text', TEXT_OPS),
  ]
  if (kind === 'company') return [...common, entry('base', 'domain', 'Domain', 'text', TEXT_OPS)]
  return [
    ...common,
    entry('base', 'amount', 'Amount', 'number', NUMBER_OPS),
    entry('base', 'currency', 'Currency', 'text', TEXT_OPS),
    entry('base', 'status', 'Status', 'text', TEXT_OPS),
    entry('base', 'close_date', 'Close date', 'date', DATE_OPS),
    entry('pipeline', 'pipeline', 'Pipeline', 'uuid', UUID_OPS),
    entry('pipeline', 'stage', 'Pipeline stage', 'uuid', UUID_OPS),
  ]
}

function customFieldType(type: string): { valueType: FieldType; operators: CrmSegmentOperator[] } {
  if (type === 'number') return { valueType: 'number', operators: NUMBER_OPS }
  if (type === 'date') return { valueType: 'date', operators: DATE_OPS }
  if (type === 'boolean') return { valueType: 'boolean', operators: BOOLEAN_OPS }
  if (type === 'entity_reference') return { valueType: 'uuid', operators: UUID_OPS }
  return { valueType: type === 'single_select' || type === 'multi_select' ? 'enum' : 'text', operators: TEXT_OPS }
}

export async function loadCrmSegmentCatalog(
  run: QueryFn,
  workspaceId: string,
  entityKind: EntityKind,
): Promise<{ entries: CatalogEntry[]; catalog: CrmSegmentCatalog }> {
  // Catalog validation must see every key. A missing later-page key is not an
  // invalid user predicate, and dropping later enum choices changes its meaning.
  const all = async <T extends QueryResultRow>(resource: string, sql: string, params: unknown[], idType: 'uuid' | 'text' = 'uuid') => {
    const rows: T[] = []
    let cursor: string | undefined
    do {
      const page = await queryCrmPage<'rows', T>(run, { workspaceId, resource, key: 'rows', sql, params,
        idType, query: { limit: 100, cursor } })
      rows.push(...page.rows)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    return { rows }
  }
  const [custom, relationships, purposes, plans, events] = await Promise.all([
    all<{ fieldKey: string; label: string; fieldType: string; options: unknown }>('crm.segment-catalog.fields',
      `SELECT id,created_at AS "createdAt",field_key AS "fieldKey",label,field_type AS "fieldType",options
         FROM crm_field_definitions WHERE workspace_id=$1 AND entity_kind=$2 AND archived_at IS NULL`, [workspaceId, entityKind]),
    all<{ edgeType: string; description: string }>('crm.segment-catalog.relationships',
      `SELECT edge_type AS id,created_at AS "createdAt",edge_type AS "edgeType",description FROM entity_link_types`, [], 'text'),
    all<{ purposeKey: string; label: string }>('crm.segment-catalog.purposes',
      `SELECT id,created_at AS "createdAt",purpose_key AS "purposeKey",label FROM crm_consent_purposes
        WHERE workspace_id=$1 AND archived_at IS NULL`, [workspaceId]),
    all<{ planKey: string; name: string }>('crm.segment-catalog.plans',
      `SELECT id,created_at AS "createdAt",plan_key AS "planKey",name FROM association_membership_plans
        WHERE workspace_id=$1`, [workspaceId]),
    all<{ slug: string; title: string }>('crm.segment-catalog.events',
      `SELECT id,created_at AS "createdAt",slug,title FROM association_events WHERE workspace_id=$1`, [workspaceId]),
  ])

  const entries: CatalogEntry[] = [...baseCatalog(entityKind)]
  for (const row of custom.rows) {
    const typed = customFieldType(row.fieldType)
    const validValues = Array.isArray(row.options)
      ? row.options.filter((value): value is string => typeof value === 'string')
      : undefined
    entries.push(entry('custom', row.fieldKey, row.label, typed.valueType, typed.operators, {
      validValues,
      ...(row.fieldType === 'multi_select' ? { sqlKind: 'multi_select' } : {}),
    }))
  }
  for (const row of relationships.rows) {
    if (!/^[a-z][a-z0-9_-]{0,62}$/.test(row.edgeType)) continue
    entries.push(entry('relationship', row.edgeType, row.description, 'uuid', UUID_OPS))
  }
  if (entityKind === 'person') {
    for (const row of purposes.rows) {
      entries.push(entry('consent', row.purposeKey, row.label, 'enum', ENUM_OPS, {
        validValues: ['granted', 'withdrawn', 'none'], sourceKey: row.purposeKey,
      }))
    }
    for (const channel of ['all', 'email', 'sms', 'phone', 'whatsapp', 'telegram', 'slack']) {
      entries.push(entry('suppression', channel, `Suppression: ${channel}`, 'enum', ENUM_OPS, {
        validValues: ['suppressed', 'released', 'none'], sourceKey: channel,
      }))
    }
    for (const row of plans.rows) {
      entries.push(entry('entitlement', row.planKey, row.name, 'enum', ENUM_OPS, {
        validValues: ['pending', 'active', 'expired', 'cancelled', 'inactive', 'none'], sqlKind: 'status', sourceKey: row.planKey,
      }))
      if (`${row.planKey}_starts_at`.length <= 63) entries.push(entry('entitlement', `${row.planKey}_starts_at`, `${row.name} starts at`, 'date', DATE_OPS, { sqlKind: 'starts_at', sourceKey: row.planKey }))
      if (`${row.planKey}_ends_at`.length <= 63) entries.push(entry('entitlement', `${row.planKey}_ends_at`, `${row.name} ends at`, 'date', DATE_OPS, { sqlKind: 'ends_at', sourceKey: row.planKey }))
    }
    for (const row of events.rows) {
      if (!/^[a-z][a-z0-9_-]{0,62}$/.test(row.slug)) continue
      entries.push(entry('participation', row.slug, row.title, 'enum', ENUM_OPS, {
        validValues: ['registered', 'attended', 'cancelled', 'no_show', 'reserved', 'confirmed', 'checked_in', 'refunded', 'none'], sqlKind: 'status', sourceKey: row.slug,
      }))
      if (`${row.slug}_starts_at`.length <= 63) entries.push(entry('participation', `${row.slug}_starts_at`, `${row.title} starts at`, 'date', DATE_OPS, { sqlKind: 'starts_at', sourceKey: row.slug }))
    }
  }
  const fields = new Map(entries.map((item) => [`${item.family}:${item.field}`, item]))
  return { entries, catalog: { fields } }
}

type CompileState = { params: unknown[]; next: number; entries: Map<string, CatalogEntry>; pageTime: boolean }

function param(state: CompileState, value: unknown): string {
  state.params.push(value)
  return `$${state.next++}`
}

function scalarPredicate(expression: string, rule: CrmSegmentRule, field: CatalogEntry, state: CompileState): string {
  if (rule.operator === 'is_empty') return `(${expression}) IS NULL`
  if (rule.operator === 'is_not_empty') return `(${expression}) IS NOT NULL`
  const effectiveExpression = field.validValues?.includes('none')
    ? `COALESCE((${expression})::text,'none')`
    : expression
  if (rule.operator === 'contains' || rule.operator === 'not_contains') {
    const p = param(state, `%${String(rule.value)}%`)
    const sql = `COALESCE((${effectiveExpression})::text,'') ILIKE ${p}`
    return rule.operator === 'contains' ? sql : `NOT (${sql})`
  }
  if (rule.operator === 'in' || rule.operator === 'not_in') {
    const cast = field.valueType === 'number' ? 'numeric[]' : field.valueType === 'boolean' ? 'boolean[]' : field.valueType === 'date' ? 'timestamptz[]' : 'text[]'
    const p = param(state, rule.value)
    const sql = `(${effectiveExpression}) = ANY(${p}::${cast})`
    return rule.operator === 'in' ? sql : `NOT (${sql})`
  }
  const cast = field.valueType === 'number' ? 'numeric' : field.valueType === 'boolean' ? 'boolean' : field.valueType === 'date' ? 'timestamptz' : 'text'
  const p = param(state, rule.value)
  const op = rule.operator === 'eq' ? '=' : rule.operator === 'neq' ? '<>'
    : rule.operator === 'gt' || rule.operator === 'after' ? '>'
      : rule.operator === 'gte' ? '>=' : rule.operator === 'lt' || rule.operator === 'before' ? '<' : '<='
  return `((${effectiveExpression})::${cast} ${op} ${p}::${cast})`
}

function expressionFor(rule: CrmSegmentRule, field: CatalogEntry, state: CompileState): string {
  if (rule.family === 'base') {
    const expressions: Record<string, string> = {
      name: 'e.display_name', created_at: 'e.created_at', updated_at: 'e.updated_at',
      email: `COALESCE(NULLIF(e.attributes->>'email',''),e.canonical_id)`,
      phone: `NULLIF(e.attributes->>'phone','')`,
      domain: `COALESCE(NULLIF(e.attributes->>'domain',''),e.canonical_id)`,
      amount: `NULLIF(e.attributes->>'amount','')`,
      currency: `COALESCE(NULLIF(e.attributes->>'currency_code',''),NULLIF(e.attributes->>'currency',''))`,
      status: `NULLIF(e.attributes->>'status','')`, close_date: `NULLIF(e.attributes->>'close_date','')`,
    }
    return expressions[rule.field]!
  }
  if (rule.family === 'custom') {
    const key = param(state, rule.field)
    return `e.attributes->'custom_fields'->>${key}`
  }
  if (rule.family === 'pipeline') {
    return rule.field === 'pipeline' ? `NULLIF(e.attributes->>'pipeline_id','')` : `NULLIF(e.attributes->>'pipeline_stage_id','')`
  }
  if (rule.family === 'consent') {
    const purpose = param(state, field.sourceKey)
    return `(SELECT ce.action FROM association_consent_events ce
      WHERE ce.workspace_id=e.workspace_id AND ce.contact_id=e.id AND ce.purpose=${purpose}
      ORDER BY ce.occurred_at DESC,ce.created_at DESC,ce.id DESC LIMIT 1)`
  }
  if (rule.family === 'suppression') {
    const channel = param(state, field.sourceKey)
    return `(SELECT se.action FROM crm_suppression_events se
      WHERE se.workspace_id=e.workspace_id AND se.contact_id=e.id
        AND (se.channel=${channel} OR (${channel}<>'all' AND se.channel='all'))
      ORDER BY se.occurred_at DESC,se.created_at DESC,se.id DESC LIMIT 1)`
  }
  if (rule.family === 'entitlement') {
    const plan = param(state, field.sourceKey)
    const at = state.pageTime ? '(SELECT at FROM crm_page_context)' : 'statement_timestamp()'
    const effective = `crm_entitlement_is_effective(m.status,m.starts_at,m.ends_at,${at})`
    const column = field.sqlKind === 'starts_at' ? 'm.starts_at' : field.sqlKind === 'ends_at' ? 'm.ends_at'
      : `CASE WHEN m.status='active' AND NOT ${effective} THEN 'inactive' ELSE m.status END`
    return `(SELECT ${column} FROM association_memberships m
      JOIN association_membership_plans mp ON mp.workspace_id=m.workspace_id AND mp.id=m.plan_id
      WHERE m.workspace_id=e.workspace_id AND m.contact_id=e.id AND mp.plan_key=${plan}
      ORDER BY ${effective} DESC,m.starts_at DESC,m.id DESC LIMIT 1)`
  }
  if (rule.family === 'participation') {
    const event = param(state, field.sourceKey)
    const column = field.sqlKind === 'starts_at' ? 'ae.starts_at' : `CASE ar.status
      WHEN 'reserved' THEN 'registered'
      WHEN 'confirmed' THEN 'registered'
      WHEN 'checked_in' THEN 'attended'
      WHEN 'refunded' THEN 'cancelled'
      ELSE ar.status END`
    return `(SELECT ${column} FROM association_registrations ar
      JOIN association_events ae ON ae.workspace_id=ar.workspace_id AND ae.id=ar.event_id
      WHERE ar.workspace_id=e.workspace_id AND ar.attendee_contact_id=e.id AND ae.slug=${event}
      ORDER BY ae.starts_at DESC,ar.id DESC LIMIT 1)`
  }
  throw new CrmOperationsError('catalog_key_invalid', 'Segment field cannot be compiled.')
}

function compileRule(rule: CrmSegmentRule, field: CatalogEntry, state: CompileState): string {
  if (rule.family === 'custom' && field.sqlKind === 'multi_select') {
    const key = param(state, rule.field)
    if (rule.operator === 'is_empty') return `COALESCE(e.attributes->'custom_fields'->${key},'[]'::jsonb) = '[]'::jsonb`
    if (rule.operator === 'is_not_empty') return `COALESCE(e.attributes->'custom_fields'->${key},'[]'::jsonb) <> '[]'::jsonb`
    const values = rule.operator === 'in' || rule.operator === 'not_in'
      ? rule.value as unknown[] : [rule.value]
    const selected = param(state, values)
    const sql = `EXISTS (SELECT 1 FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(e.attributes->'custom_fields'->${key})='array'
        THEN e.attributes->'custom_fields'->${key} ELSE '[]'::jsonb END
    ) value WHERE value = ANY(${selected}::text[]))`
    return rule.operator === 'neq' || rule.operator === 'not_contains' || rule.operator === 'not_in'
      ? `NOT (${sql})` : sql
  }
  if (rule.family === 'tag') {
    if (rule.operator === 'is_empty') return `COALESCE(e.attributes->'tags','[]'::jsonb) = '[]'::jsonb`
    if (rule.operator === 'is_not_empty') return `COALESCE(e.attributes->'tags','[]'::jsonb) <> '[]'::jsonb`
    const values = rule.operator === 'in' || rule.operator === 'not_in'
      ? rule.value as unknown[] : [rule.value]
    const p = param(state, values)
    const sql = `COALESCE(e.attributes->'tags','[]'::jsonb) ?| ${p}::text[]`
    return rule.operator === 'neq' || rule.operator === 'not_contains' || rule.operator === 'not_in' ? `NOT (${sql})` : sql
  }
  if (rule.family === 'relationship') {
    const edge = param(state, rule.field)
    const base = `SELECT 1 FROM entity_links el WHERE el.workspace_id=e.workspace_id
      AND el.edge_type=${edge} AND el.retracted_at IS NULL AND el.valid_to IS NULL
      AND ((el.source_kind='entity' AND el.source_id=e.id) OR (el.target_kind='entity' AND el.target_id=e.id))`
    if (rule.operator === 'is_empty') return `NOT EXISTS (${base})`
    if (rule.operator === 'is_not_empty') return `EXISTS (${base})`
    const values = rule.operator === 'in' || rule.operator === 'not_in'
      ? rule.value as unknown[] : [rule.value]
    const ids = param(state, values)
    const sql = `EXISTS (${base} AND (el.source_id=ANY(${ids}::uuid[]) OR el.target_id=ANY(${ids}::uuid[])))`
    return rule.operator === 'neq' || rule.operator === 'not_in' ? `NOT (${sql})` : sql
  }
  return scalarPredicate(expressionFor(rule, field, state), rule, field, state)
}

export function compileCrmSegmentPredicate(
  predicate: CrmSegmentPredicate,
  catalog: CrmSegmentCatalog,
  startIndex = 1,
  pageTime = false,
): { sql: string; params: unknown[] } {
  const parsed = CrmSegmentPredicateSchema.parse(predicate)
  const issues = validateCrmSegmentCatalog(parsed, catalog)
  if (issues.length) {
    throw new CrmOperationsError('catalog_key_invalid', 'Segment predicate uses unavailable catalog values.', {
      issues: issues.slice(0, 100),
    })
  }
  const state: CompileState = {
    params: [], next: startIndex, pageTime,
    entries: catalog.fields as Map<string, CatalogEntry>,
  }
  const walk = (group: CrmSegmentPredicate): string => {
    const items = group.items.map((item) => item.type === 'group'
      ? `(${walk(item)})`
      : compileRule(item, state.entries.get(`${item.family}:${item.field}`)!, state))
    return items.join(group.combinator === 'and' ? ' AND ' : ' OR ')
  }
  return { sql: walk(parsed), params: state.params }
}

export type CrmSegmentReadStore = Pick<CrmOperationsReadPort,
  'listSegments' | 'getSegment' | 'previewSegment'> & {
    listSegmentCatalog(workspaceId: string, entityKind: EntityKind): Promise<CrmSegmentCatalogEntry[]>
    listCrmEventFilterCatalog(workspaceId: string): Promise<{
      eventTypes: string[]
      stableKeys: Array<{ kind: string; key: string; label: string }>
    }>
  }

export function createDbCrmSegmentStore(): CrmSegmentReadStore {
  const run = query as QueryFn
  const getSegment = async (workspaceId: string, segmentId: string) => {
    const result = await query<Record<string, unknown>>(
      `SELECT id,segment_key AS "segmentKey",name,description,
              entity_kind AS "entityKind",predicate,version,
              archived_at AS "archivedAt",created_at AS "createdAt",updated_at AS "updatedAt"
         FROM crm_segments WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, segmentId],
    )
    return result.rows[0] ?? null
  }
  return {
    async listSegmentCatalog(workspaceId, entityKind) {
      return (await loadCrmSegmentCatalog(run, workspaceId, entityKind)).entries
    },
    async listCrmEventFilterCatalog(workspaceId) {
      const stableKeys: Array<{ kind: string; key: string; label: string }> = []
      let cursor: string | undefined
      do {
        const page = await queryCrmPage<'rows', { kind: string; key: string; label: string }>(run, {
          workspaceId, resource: 'crm.workflow-event-catalog', key: 'rows', idType: 'text', params: [workspaceId],
          query: { limit: 100, cursor },
          sql: `SELECT 'definition:'||id::text AS id,created_at AS "createdAt",'definition' AS kind,definition_key AS key,label
             FROM crm_intake_definitions WHERE workspace_id=$1 AND active
           UNION ALL
           SELECT 'purpose:'||id::text,created_at,'purpose',purpose_key,label FROM crm_consent_purposes
            WHERE workspace_id=$1 AND archived_at IS NULL
           UNION ALL
           SELECT 'plan:'||id::text,created_at,'plan',plan_key,name FROM association_membership_plans WHERE workspace_id=$1
           UNION ALL
           SELECT 'event:'||id::text,created_at,'event',slug,title FROM association_events WHERE workspace_id=$1
           UNION ALL
           SELECT 'stage:'||id::text,created_at,'stage',legacy_key,name FROM crm_pipeline_stages
            WHERE workspace_id=$1 AND legacy_key IS NOT NULL`,
        })
        stableKeys.push(...page.rows.map(({ kind, key, label }) => ({ kind, key, label })))
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      return { eventTypes: [...CrmDomainEventTypeSchema.options], stableKeys }
    },
    async listSegments(workspaceId, filters = {}) {
      const { entityKind = 'person', includeArchived = false, ...pageQuery } = filters
      const [segments, loaded] = await Promise.all([
        queryCrmPage(run, {
          workspaceId, resource: 'crm.segments', key: 'segments', query: pageQuery,
          sql: `SELECT id,segment_key AS "segmentKey",name,description,
                  entity_kind AS "entityKind",predicate,version,
                  archived_at AS "archivedAt",created_at AS "createdAt",updated_at AS "updatedAt"
             FROM crm_segments WHERE workspace_id=$1 AND entity_kind=$2
              AND ($3::boolean OR archived_at IS NULL)`,
          params: [workspaceId, entityKind, includeArchived],
        }),
        loadCrmSegmentCatalog(run, workspaceId, entityKind),
      ])
      return { ...segments, catalog: loaded.entries }
    },
    getSegment,
    async previewSegment(workspaceId, segmentId, options = {}) {
      const segment = await getSegment(workspaceId, segmentId)
      if (!segment || segment.archivedAt) throw new CrmOperationsError('not_found', 'CRM segment was not found.')
      const entityKind = segment.entityKind as EntityKind
      const predicate = CrmSegmentPredicateSchema.parse(segment.predicate)
      const loaded = await loadCrmSegmentCatalog(run, workspaceId, entityKind)
      const { snapshotLimit = 1_000, snapshotCursor, ...pageQuery } = options
      if (!Number.isInteger(snapshotLimit) || snapshotLimit < 1 || snapshotLimit > 10_000) {
        throw new CrmOperationsError('invalid_input', 'snapshotLimit must be an integer from 1 to 10000.')
      }
      if (snapshotCursor !== undefined && (typeof snapshotCursor !== 'string' || snapshotCursor.length > 4096)) {
        throw new CrmOperationsError('invalid_input', 'Invalid CRM snapshot cursor.')
      }
      const parsed = CrmPageQuerySchema.parse({ ...pageQuery, limit: pageQuery.limit ?? 25 })
      const compiled = compileCrmSegmentPredicate(predicate, loaded.catalog, 5, true)
      const sql = `SELECT e.id,e.display_name AS name,e.kind,e.attributes,e.created_at AS "createdAt",e.updated_at AS "updatedAt",
                count(*) OVER()::text AS "totalCount"
           FROM entities e
          WHERE e.workspace_id=$1 AND e.kind=$2 AND e.valid_to IS NULL AND e.retracted_at IS NULL
            AND NOT (e.attributes ? 'crm_archived_at')
            AND ($3::timestamptz IS NULL OR e.created_at >= $3::timestamptz)
            AND ($4::timestamptz IS NULL OR e.created_at < $4::timestamptz)
            AND (${compiled.sql})`
      const params = [workspaceId, entityKind, parsed.createdAfter ? crmPageInstant(parsed.createdAfter) : null, parsed.createdBefore ? crmPageInstant(parsed.createdBefore) : null, ...compiled.params]
      const resource = `crm.segment-preview:${segmentId}:${segment.version}`
      const page = await queryCrmPage(run, { workspaceId, resource, key: 'rows', sql, params, query: parsed })
      const snapshotIds: string[] = []
      let cursor = snapshotCursor
      let snapshotNextCursor: string | null = null
      let count: number | undefined = page.rows[0] ? Number(page.rows[0].totalCount) : undefined
      do {
        const batch = await queryCrmPage(run, { workspaceId, resource, key: 'rows', sql, params,
          query: { ...parsed, limit: Math.min(100, snapshotLimit - snapshotIds.length), cursor } })
        if (count === undefined && batch.rows[0]) count = Number(batch.rows[0].totalCount)
        snapshotIds.push(...batch.rows.map((row) => String(row.id)))
        snapshotNextCursor = batch.nextCursor
        cursor = batch.nextCursor ?? undefined
      } while (cursor && snapshotIds.length < snapshotLimit)
      if (count === undefined) {
        // An exhausted continuation still reports the complete current count.
        const total = await run<{ count: string }>(`WITH crm_page_context AS (SELECT statement_timestamp() AS at)
          SELECT count(*)::text AS count FROM (${sql}) candidate`, params)
        count = Number(total.rows[0]?.count ?? 0)
      }
      return {
        rows: page.rows.map(({ totalCount: _totalCount, ...row }) => row), count,
        snapshotIds, nextCursor: page.nextCursor, snapshotNextCursor,
      }
    },
  }
}
