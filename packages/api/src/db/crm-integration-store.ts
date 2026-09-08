/** CRM-only credential lifecycle/authentication. [COMP:api/crm-integration-auth] */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import {
  CrmIntegrationGrantsSchema, CrmOperationsError,
  type CrmIntegrationAuthority, type CrmIntegrationGrant,
  type CrmPage, type CrmPageQuery,
} from '@use-brian/core'
import { applyRLSGucs, getAppPool, getPool } from './client.js'
import { hashSecret, verifySecret } from './api-key-store.js'
import { queryCrmPage } from '../crm-operations/pagination.js'

export const CreateCrmIntegrationCredentialSchema = z.object({
  label: z.string().trim().min(1).max(200),
  expiresAt: z.string().datetime({ offset: true }),
  grants: CrmIntegrationGrantsSchema,
  revokeCredentialId: z.string().uuid().optional(),
}).strict()
export type CreateCrmIntegrationCredential = z.infer<typeof CreateCrmIntegrationCredentialSchema>
export interface CrmIntegrationCredential {
  id: string
  workspaceId: string
  label: string
  prefix: string
  expiresAt: Date
  revokedAt: Date | null
  createdAt: Date
  createdByUserId: string | null
  lastUsedAt: Date | null
  grants: CrmIntegrationGrant[]
}
export interface CrmIntegrationPrincipal extends CrmIntegrationAuthority { workspaceId: string }

const COLUMNS = `c.id,c.workspace_id AS "workspaceId",c.label,c.secret_prefix AS prefix,
  c.expires_at AS "expiresAt",c.revoked_at AS "revokedAt",c.created_at AS "createdAt",
  c.created_by_user_id AS "createdByUserId",c.last_used_at AS "lastUsedAt"`
const GRANTS = `coalesce((SELECT jsonb_agg(jsonb_build_object('operation',g.operation,'selectors',g.selectors) ORDER BY g.operation)
  FROM crm_integration_credential_grants g WHERE g.workspace_id=c.workspace_id AND g.credential_id=c.id),'[]'::jsonb) AS grants`

export function parseCrmIntegrationToken(token: string): { credentialId: string; secret: string } | null {
  const matched = /^sk_crm_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})_([A-Za-z0-9_-]{43})$/i.exec(token)
  return matched ? { credentialId: matched[1], secret: matched[2] } : null
}

async function adminTransaction<T>(pool: Pool, workspaceId: string, userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, userId)
    const member = await client.query(`SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role IN ('owner','admin') FOR SHARE`, [workspaceId, userId])
    if (!member.rowCount) throw new CrmOperationsError('not_authorized', 'An owner or admin member is required for integration credentials.')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client.release() }
}

const RESOURCE_TABLES = {
  definitionIds: ['crm_intake_definitions', 'id'], purposeKeys: ['crm_consent_purposes', 'purpose_key'],
  planIds: ['association_membership_plans', 'id'], eventIds: ['association_events', 'id'],
} as const

async function validateResourceOwnership(client: PoolClient, workspaceId: string, grants: CrmIntegrationGrant[]) {
  for (const grant of grants) {
    for (const dimension of Object.keys(RESOURCE_TABLES) as Array<keyof typeof RESOURCE_TABLES>) {
      const selection = grant.selectors[dimension]
      if (!selection || selection === 'all') continue
      const [table, column] = RESOURCE_TABLES[dimension]
      const rows = await client.query(`SELECT ${column}::text AS value FROM ${table} WHERE workspace_id=$1 AND ${column}::text=ANY($2::text[])`, [workspaceId, selection])
      const found = new Set(rows.rows.map((row) => String(row.value)))
      if (selection.some((value) => !found.has(value))) throw new CrmOperationsError('invalid_input', 'A selected integration resource is unavailable in this workspace.', { dimension })
    }
  }
}

export function createCrmIntegrationStore(pool: Pool = getPool(), memberPool: Pool = getAppPool()) {
  return {
    async create(workspaceId: string, userId: string, raw: CreateCrmIntegrationCredential): Promise<CrmIntegrationCredential & { oneTimeSecret: string }> {
      const input = CreateCrmIntegrationCredentialSchema.parse(raw)
      // Hash outside the DB transaction; no credential is usable before commit.
      const id = randomUUID()
      const secret = randomBytes(32).toString('base64url')
      const plaintext = `sk_crm_${id}_${secret}`
      const secretHash = await hashSecret(secret)
      return adminTransaction(memberPool, workspaceId, userId, async (client) => {
        const time = await client.query<{ valid: boolean }>('SELECT $1::timestamptz>clock_timestamp() AS valid', [input.expiresAt])
        if (!time.rows[0].valid) throw new CrmOperationsError('invalid_input', 'Credential expiry must be in the future.')
        await validateResourceOwnership(client, workspaceId, input.grants)
        await client.query(`INSERT INTO crm_integration_credentials (id,workspace_id,label,secret_prefix,secret_hash,expires_at,created_by_user_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, workspaceId, input.label, plaintext.slice(0, 15), secretHash, input.expiresAt, userId])
        for (const grant of input.grants) await client.query(`INSERT INTO crm_integration_credential_grants (workspace_id,credential_id,operation,selectors)
          VALUES ($1,$2,$3,$4)`, [workspaceId, id, grant.operation, JSON.stringify(grant.selectors)])
        if (input.revokeCredentialId) {
          const old = await client.query(`UPDATE crm_integration_credentials SET revoked_at=coalesce(revoked_at,now())
            WHERE workspace_id=$1 AND id=$2 RETURNING id`, [workspaceId, input.revokeCredentialId])
          if (!old.rowCount) throw new CrmOperationsError('not_found', 'Credential selected for rotation is unavailable.')
        }
        await client.query(`INSERT INTO workspace_audit_log (workspace_id,actor_user_id,event_type,subject_id,details)
          VALUES ($1,$2,'crm.integration_credential_created',$3,$4)`, [workspaceId, userId, id,
          { operationCount: input.grants.length, expiresAt: input.expiresAt, revokedCredentialId: input.revokeCredentialId ?? null }])
        const result = await client.query<CrmIntegrationCredential>(`SELECT ${COLUMNS},${GRANTS} FROM crm_integration_credentials c WHERE c.workspace_id=$1 AND c.id=$2`, [workspaceId, id])
        return { ...result.rows[0], oneTimeSecret: plaintext }
      })
    },
    async listForMember(workspaceId: string, userId: string, filters: CrmPageQuery = {}): Promise<CrmPage<'credentials', CrmIntegrationCredential>> {
      return adminTransaction(memberPool, workspaceId, userId, async (client) => {
        return queryCrmPage<'credentials', CrmIntegrationCredential>(client.query.bind(client), {
          workspaceId, resource: 'crm.integration-credentials', key: 'credentials', query: filters,
          sql: `SELECT ${COLUMNS},${GRANTS} FROM crm_integration_credentials c WHERE c.workspace_id=$1`, params: [workspaceId],
        })
      })
    },
    async revoke(workspaceId: string, userId: string, credentialId: string): Promise<boolean> {
      return adminTransaction(memberPool, workspaceId, userId, async (client) => {
        const result = await client.query(`UPDATE crm_integration_credentials SET revoked_at=now()
          WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING id`, [workspaceId, credentialId])
        if (!result.rowCount) return false
        await client.query(`INSERT INTO workspace_audit_log (workspace_id,actor_user_id,event_type,subject_id,details)
          VALUES ($1,$2,'crm.integration_credential_revoked',$3,'{}')`, [workspaceId, userId, credentialId])
        return true
      })
    },
    async authenticate(token: string): Promise<CrmIntegrationPrincipal | null> {
      const parsed = parseCrmIntegrationToken(token)
      if (!parsed) return null
      const result = await pool.query<CrmIntegrationCredential & { secretHash: string }>(
        `SELECT ${COLUMNS},${GRANTS},c.secret_hash AS "secretHash" FROM crm_integration_credentials c
         WHERE c.id=$1 AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()`, [parsed.credentialId])
      const row = result.rows[0]
      if (!row || !(await verifySecret(parsed.secret, row.secretHash))) return null
      // Unknown/malformed persisted grants fail closed, never partially load.
      const grants = CrmIntegrationGrantsSchema.safeParse(row.grants)
      if (!grants.success) return null
      const active = await pool.query(`UPDATE crm_integration_credentials SET last_used_at=clock_timestamp()
        WHERE id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp() RETURNING id`, [row.id])
      if (!active.rowCount) return null
      return { workspaceId: row.workspaceId, credentialId: row.id, grants: grants.data }
    },
  }
}
export type CrmIntegrationStore = ReturnType<typeof createCrmIntegrationStore>
