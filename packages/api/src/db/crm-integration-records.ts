/** CRM record subset for manifest/import clients; no general Brain authority.
 * [COMP:api/crm-integration-auth]
 */
import type { Pool } from 'pg'
import { z } from 'zod'
import { CrmOperationsError, requireCrmIntegrationOperation, decodeAssociationCursor, encodeAssociationCursor } from '@use-brian/core'
import { getPool } from './client.js'
import type { CrmIntegrationPrincipal } from './crm-integration-store.js'

export const CrmIntegrationRecordsQuerySchema = z.object({
  kind: z.enum(['person', 'company', 'deal']).default('person'),
  query: z.string().trim().max(200).optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(1000).optional(),
}).strict()
const COLUMNS = `e.id,e.kind,e.display_name AS name,e.canonical_id AS "canonicalId",
  e.attributes,e.aliases,e.sensitivity,e.created_at AS "createdAt",e.updated_at AS "updatedAt"`

export function createCrmIntegrationRecordReadStore(principal: CrmIntegrationPrincipal, pool: Pool = getPool()) {
  const authorize = () => requireCrmIntegrationOperation(principal, 'crm.records.read')
  return {
    async list(raw: unknown) {
      authorize()
      const input = CrmIntegrationRecordsQuerySchema.parse(raw)
      const cursor = decodeAssociationCursor(input.cursor)
      if (input.cursor && !cursor) throw new CrmOperationsError('invalid_input', 'Invalid record cursor.')
      const rows = await pool.query<Record<string, unknown> & { cursorCreatedAt: string; id: string }>(
        `SELECT ${COLUMNS},to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorCreatedAt"
         FROM entities e WHERE e.workspace_id=$1 AND e.kind=$2 AND e.valid_to IS NULL AND e.retracted_at IS NULL
           AND ($3::boolean OR NOT (e.attributes ? 'crm_archived_at'))
           AND ($4::text IS NULL OR e.display_name ILIKE '%' || $4 || '%' OR e.canonical_id ILIKE '%' || $4 || '%')
           AND ($5::timestamptz IS NULL OR (e.created_at,e.id)<($5::timestamptz,$6::uuid))
         ORDER BY e.created_at DESC,e.id DESC LIMIT $7`,
        [principal.workspaceId, input.kind, input.includeArchived === 'true', input.query ?? null,
          cursor?.createdAt ?? null, cursor?.id ?? null, input.limit + 1])
      const selected = rows.rows.slice(0, input.limit), last = selected.at(-1)
      return { records: selected.map(({ cursorCreatedAt: _cursor, ...row }) => row),
        nextCursor: rows.rows.length > input.limit && last ? encodeAssociationCursor({ createdAt: last.cursorCreatedAt, id: last.id }) : null }
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
    async fields() {
      authorize()
      const result = await pool.query(`SELECT id,entity_kind AS "entityKind",field_key AS "fieldKey",label,
        field_type AS "fieldType",options,is_required AS "isRequired",position,created_at AS "createdAt",updated_at AS "updatedAt"
        FROM crm_field_definitions WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY created_at,id`, [principal.workspaceId])
      return result.rows
    },
  }
}
