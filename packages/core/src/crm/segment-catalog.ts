/** Shared live/projected segment vocabulary. [COMP:crm/segments] */
import type { CrmSegmentCatalog, CrmSegmentCatalogEntry, CrmSegmentOperator } from './segments.js'
type EntityKind = 'person' | 'company' | 'deal'
const TEXT_OPS: CrmSegmentOperator[] = ['eq', 'neq', 'contains', 'not_contains', 'in', 'not_in', 'is_empty', 'is_not_empty']
const NUMBER_OPS: CrmSegmentOperator[] = ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty']
const DATE_OPS: CrmSegmentOperator[] = ['eq', 'neq', 'before', 'after', 'is_empty', 'is_not_empty']
const BOOLEAN_OPS: CrmSegmentOperator[] = ['eq', 'neq', 'is_empty', 'is_not_empty']
const UUID_OPS: CrmSegmentOperator[] = ['eq', 'neq', 'in', 'not_in', 'is_empty', 'is_not_empty']
const ENUM_OPS: CrmSegmentOperator[] = ['eq', 'neq', 'in', 'not_in', 'is_empty', 'is_not_empty']

type FieldType = CrmSegmentCatalogEntry['valueType']
export type CrmSegmentCatalogField = CrmSegmentCatalogEntry & { sqlKind?: string; sourceKey?: string }

function entry(
  family: CrmSegmentCatalogField['family'],
  field: string,
  label: string,
  valueType: FieldType,
  operators: CrmSegmentOperator[],
  options: Partial<Pick<CrmSegmentCatalogField, 'validValues' | 'sqlKind' | 'sourceKey'>> = {},
): CrmSegmentCatalogField {
  return { family, field, label, valueType, operators, ...options }
}

function baseCatalog(kind: EntityKind): CrmSegmentCatalogField[] {
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

export function buildCrmSegmentCatalog(input: {
  entityKind: EntityKind
  customFields: Array<{ fieldKey: string; label: string; fieldType: string; options: unknown }>
  relationships: Array<{ edgeType: string; description: string }>
  purposes: Array<{ purposeKey: string; label: string }>
  plans: Array<{ planKey: string; name: string }>
  events: Array<{ slug: string; title: string }>
}): { entries: CrmSegmentCatalogField[]; catalog: CrmSegmentCatalog } {
  const { entityKind } = input
  const entries: CrmSegmentCatalogField[] = [...baseCatalog(entityKind)]
  for (const row of input.customFields) {
    const typed = customFieldType(row.fieldType)
    const validValues = Array.isArray(row.options)
      ? row.options.filter((value): value is string => typeof value === 'string')
      : undefined
    entries.push(entry('custom', row.fieldKey, row.label, typed.valueType, typed.operators, {
      validValues,
      ...(row.fieldType === 'multi_select' ? { sqlKind: 'multi_select' } : {}),
    }))
  }
  for (const row of input.relationships) {
    if (!/^[a-z][a-z0-9_-]{0,62}$/.test(row.edgeType)) continue
    entries.push(entry('relationship', row.edgeType, row.description, 'uuid', UUID_OPS))
  }
  if (entityKind === 'person') {
    for (const row of input.purposes) {
      entries.push(entry('consent', row.purposeKey, row.label, 'enum', ENUM_OPS, {
        validValues: ['granted', 'withdrawn', 'none'], sourceKey: row.purposeKey,
      }))
    }
    for (const channel of ['all', 'email', 'sms', 'phone', 'whatsapp', 'telegram', 'slack']) {
      entries.push(entry('suppression', channel, `Suppression: ${channel}`, 'enum', ENUM_OPS, {
        validValues: ['suppressed', 'released', 'none'], sourceKey: channel,
      }))
    }
    for (const row of input.plans) {
      entries.push(entry('entitlement', row.planKey, row.name, 'enum', ENUM_OPS, {
        validValues: ['pending', 'active', 'expired', 'cancelled', 'inactive', 'none'], sqlKind: 'status', sourceKey: row.planKey,
      }))
      if (`${row.planKey}_starts_at`.length <= 63) entries.push(entry('entitlement', `${row.planKey}_starts_at`, `${row.name} starts at`, 'date', DATE_OPS, { sqlKind: 'starts_at', sourceKey: row.planKey }))
      if (`${row.planKey}_ends_at`.length <= 63) entries.push(entry('entitlement', `${row.planKey}_ends_at`, `${row.name} ends at`, 'date', DATE_OPS, { sqlKind: 'ends_at', sourceKey: row.planKey }))
    }
    for (const row of input.events) {
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
