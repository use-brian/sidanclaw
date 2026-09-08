/** CRM record subset for manifest/import clients; no general Brain authority.
 * [COMP:api/crm-integration-auth]
 */
import type { Pool } from 'pg'
import { z } from 'zod'
import { CrmPageQuerySchema, requireCrmIntegrationOperation } from '@use-brian/core'
import { getPool } from './client.js'
import type { CrmIntegrationPrincipal } from './crm-integration-store.js'
import { queryCrmPage } from '../crm-operations/pagination.js'

export const CrmIntegrationRecordsQuerySchema = CrmPageQuerySchema.extend({
  kind: z.enum(['person', 'company', 'deal']).default('person'),
  query: z.string().trim().max(200).optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
}).strict()
const COLUMNS = `e.id,e.kind,e.display_name AS name,e.canonical_id AS "canonicalId",
  e.attributes,e.aliases,e.sensitivity,e.created_at AS "createdAt",e.updated_at AS "updatedAt"`

export function createCrmIntegrationRecordReadStore(principal: CrmIntegrationPrincipal, pool: Pool = getPool()) {
  const authorize = () => requireCrmIntegrationOperation(principal, 'crm.records.read')
  return {
    async list(raw: unknown) {
      authorize()
      const input = CrmIntegrationRecordsQuerySchema.parse(raw)
      return queryCrmPage(pool.query.bind(pool), { workspaceId: principal.workspaceId, resource: 'crm.records', key: 'records',
        query: { limit: input.limit, cursor: input.cursor, createdAfter: input.createdAfter, createdBefore: input.createdBefore },
        sql: `SELECT ${COLUMNS}
         FROM entities e WHERE e.workspace_id=$1 AND e.kind=$2 AND e.valid_to IS NULL AND e.retracted_at IS NULL
           AND ($3::boolean OR NOT (e.attributes ? 'crm_archived_at'))
           AND ($4::text IS NULL OR e.display_name ILIKE '%' || $4 || '%' OR e.canonical_id ILIKE '%' || $4 || '%')`,
        params: [principal.workspaceId, input.kind, input.includeArchived === 'true', input.query || null] })
    },
    async get(rawId: unknown, rawQuery: unknown = {}) {
      authorize()
      const id = z.string().uuid().parse(rawId)
      const input = CrmIntegrationRecordsQuerySchema.pick({ includeArchived: true }).parse(rawQuery)
      const result = await pool.query<Record<string, unknown>>(`SELECT ${COLUMNS} FROM entities e WHERE e.workspace_id=$1 AND e.id=$2
        AND e.kind IN ('person','company','deal') AND e.valid_to IS NULL AND e.retracted_at IS NULL
        AND ($3::boolean OR NOT (e.attributes ? 'crm_archived_at'))`, [principal.workspaceId, id, input.includeArchived === 'true'])
      return result.rows[0] ?? null
    },
    async fields(raw: unknown = {}) {
      authorize()
      const input = CrmPageQuerySchema.extend({ entityKind: z.enum(['person', 'company', 'deal']).optional() }).parse(raw)
      return queryCrmPage(pool.query.bind(pool), { workspaceId: principal.workspaceId, resource: 'crm.record-fields', key: 'fields',
        query: { limit: input.limit, cursor: input.cursor, createdAfter: input.createdAfter, createdBefore: input.createdBefore },
        sql: `SELECT id,entity_kind AS "entityKind",field_key AS "fieldKey",label,
        field_type AS "fieldType",options,is_required AS "isRequired",position,created_at AS "createdAt",updated_at AS "updatedAt"
        FROM crm_field_definitions WHERE workspace_id=$1 AND archived_at IS NULL AND ($2::text IS NULL OR entity_kind=$2)`,
        params: [principal.workspaceId, input.entityKind ?? null] })
    },
  }
}
