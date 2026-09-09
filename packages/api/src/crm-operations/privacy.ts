/**
 * Privacy lifecycle and operator visibility for CRM operations.
 *
 * Append-only evidence is immutable during normal product use. The explicit
 * erasure primitive below is the legal override: it removes personal linkage
 * and payload while retaining minimized execution receipts required by policy.
 *
 * [COMP:crm/operations-privacy]
 */

import type pg from 'pg'
import type { CrmPageQuery } from '@use-brian/core'
import { queryCrmPage } from './pagination.js'
import { getPool, query } from '../db/client.js'
import { retireCrmIntakeReceipts } from './privacy-policy.js'
import { acquireCrmPrivacyAdmission } from './privacy-admission.js'
import { retainCrmAddressSuppression } from './suppression-tombstones.js'
import { retireWorkflowCopies } from './workflow-copy-resolver.js'
import { CRM_PRIVACY_COVERAGE } from './privacy-coverage.js'
import { prepareCrmPrivacyCopies, assertCrmPrivacyCopiesResolvable, deleteCrmPrivacyCopies, retireCrmNotificationCopies } from './privacy-copy-resolver.js'

export const CRM_OPERATIONS_PRIVACY_TABLES = [
  'crm_intake_definitions',
  'crm_intake_definition_versions',
  'crm_intake_credentials',
  'crm_intake_credential_definitions',
  'crm_intake_idempotency',
  'crm_privacy_policies',
  'crm_privacy_previews',
  'crm_address_suppression_tombstones',
  'crm_managed_mailbox_policies',
  'crm_mailbox_integration_grants',
  'crm_delivery_receipts',
  'crm_delivery_receipt_contacts',
  'association_external_identities',
  'association_enquiries',
  'association_enquiry_notes',
  'crm_consent_purposes',
  'crm_consent_purpose_versions',
  'association_consent_events',
  'crm_suppression_events',
  'crm_segments',
  'association_membership_plans',
  'association_memberships',
  'association_events',
  'association_registrations',
  'association_audit_log',
  'workspace_audit_log',
  'workspace_modules',
  'crm_integration_credentials',
  'crm_integration_credential_grants',
  'crm_domain_event_outbox',
  'crm_import_jobs',
  'crm_import_sources',
  'crm_import_chunks',
  'crm_import_rows',
  'crm_import_errors',
] as const

type PrivacyTable = (typeof CRM_OPERATIONS_PRIVACY_TABLES)[number]

const EXPORT_PROJECTIONS: Record<PrivacyTable, string> = Object.fromEntries(
  CRM_OPERATIONS_PRIVACY_TABLES.map((table) => [table, '*']),
) as Record<PrivacyTable, string>

// A credential secret hash is authentication material, not exportable
// workspace content. Its non-secret lifecycle metadata remains visible.
EXPORT_PROJECTIONS.crm_intake_credentials = [
  'id', 'workspace_id', 'label', 'secret_prefix', 'created_by_user_id',
  'revoked_at', 'last_used_at', 'created_at', 'replay_scope_id', 'rotated_from_credential_id',
].join(',')
EXPORT_PROJECTIONS.crm_integration_credentials = [
  'id', 'workspace_id', 'label', 'secret_prefix', 'created_by_user_id',
  'expires_at', 'revoked_at', 'last_used_at', 'created_at',
].join(',')
// Original CSV bytes are a separate multi-subject processing artifact. The
// legacy operations export includes its inventory, never an implicit blob dump.
EXPORT_PROJECTIONS.crm_import_sources = [
  'id', 'workspace_id', 'source_key', 'source_hash', 'credential_id',
  'integration_grants', 'created_at', 'octet_length(content_bytes) AS byte_count',
].join(',')
EXPORT_PROJECTIONS.crm_address_suppression_tombstones = 'id,workspace_id,key_version,channel,purpose_key,reason_code,occurred_at,policy_version,created_at,expires_at,released_at,release_evidence_kind,release_evidence_id'

EXPORT_PROJECTIONS.crm_privacy_previews='id,workspace_id,owner_user_id,subject_id,policy_version,domain_summary,blockers,status,created_at,expires_at,consumed_at,receipt'

// Claim tokens and raw request fingerprints are private replay machinery.
EXPORT_PROJECTIONS.crm_delivery_receipts = 'workspace_id,delivery_id,connector_instance_id,provider_key,purpose_key,actor_kind,actor_credential_id,acting_user_id,envelope,status,provider_receipt,error_code,accepted_at,confirmed_at,redacted_at,created_at,updated_at'

/** Retire content without reopening a stable delivery identity. Caller holds person locks. */
export async function redactCrmDeliveryReceipts(client:pg.PoolClient,workspaceId:string,contactId?:string):Promise<void> {
  await client.query(`UPDATE crm_delivery_receipts r SET envelope=NULL,provider_receipt=NULL,redacted_at=COALESCE(redacted_at,clock_timestamp()),
    status=CASE WHEN status='dispatching' THEN 'needs_reconciliation' ELSE status END,
    error_code=CASE WHEN status='dispatching' THEN 'delivery_erased_during_dispatch' ELSE error_code END,updated_at=clock_timestamp()
    WHERE workspace_id=$1 AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM crm_delivery_receipt_contacts c
      WHERE c.workspace_id=r.workspace_id AND c.delivery_id=r.delivery_id AND c.contact_id=$2))`,[workspaceId,contactId ?? null])
}

export type CrmOperationsPrivacyExport = {
  schema: 'crm-operations-privacy-v1'
  workspaceId: string
  exportedAt: string
  tables: Record<string, unknown[]>
}

export async function exportCrmOperationsPrivacy(
  workspaceId: string,
): Promise<CrmOperationsPrivacyExport> {
  const tables: Record<string, unknown[]> = {}
  for (const table of CRM_OPERATIONS_PRIVACY_TABLES) {
    const result = await query(`SELECT ${EXPORT_PROJECTIONS[table]} FROM ${table} WHERE workspace_id=$1`, [workspaceId])
    tables[table] = result.rows
  }
  return {
    schema: 'crm-operations-privacy-v1',
    workspaceId,
    exportedAt: new Date().toISOString(),
    tables,
  }
}

/**
 * Erase operation-owned personal linkage before an entity hard delete.
 * The caller supplies the hard-purge transaction client so this cannot commit
 * independently of the entity DELETE and correction audit shell.
 */
export async function redactCrmOperationsForContact(
  client: pg.PoolClient,
  workspaceId: string,
  contactId: string,
): Promise<void> {
  const person = await client.query<{ isPerson: boolean }>(
    `SELECT kind='person' AS "isPerson" FROM entities WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
    [workspaceId, contactId],
  )
  if (!person.rows[0]?.isPerson) return
  await prepareCrmPrivacyCopies(client,workspaceId,contactId)
  await assertCrmPrivacyCopiesResolvable(client,workspaceId,contactId)
  await client.query('DELETE FROM crm_privacy_previews WHERE workspace_id=$1 AND subject_id=$2',[workspaceId,contactId])
  await retainCrmAddressSuppression(client,workspaceId,contactId)
  // Resolve audit references before clearing the attendee/enquiry/membership
  // links on which attribution depends. Reuse the preview/export predicates.
  for (const [domain, assignments] of [
    ['association_audit_log', "metadata=jsonb_build_object('erased',true)"],
    ['workspace_audit_log', "subject_id=NULL,details=jsonb_build_object('erased',true)"],
    ['brain_row_versions', "before_image=NULL,erased_at=COALESCE(erased_at,clock_timestamp()),mutation_reason='Personal data erased',workspace_id=$1"],
    ['correction_audit', "reason='Personal data erased',ticket_reference=NULL,row_snapshot=jsonb_build_object('erased',true),detail=jsonb_build_object('erased',true)"],
  ] as const) {
    const entry = CRM_PRIVACY_COVERAGE.find((candidate) => candidate.domain === domain)!
    await client.query(`WITH privacy_args AS (SELECT $1::uuid workspace_id,$2::uuid contact_id)
      UPDATE ${domain} t SET ${assignments}
      WHERE (${entry.workspacePredicate ?? 't.workspace_id=$1'}) AND (${entry.subjectWhere})`, [workspaceId, contactId])
  }
  await retireWorkflowCopies(client,workspaceId)
  await retireCrmNotificationCopies(client,workspaceId,contactId)
  await redactCrmDeliveryReceipts(client,workspaceId,contactId)
  // Match retention's enquiry -> receipt ordering. Holding a receipt before
  // its enquiry would deadlock against a concurrent retention transaction.
  await client.query(`SELECT id FROM association_enquiries WHERE workspace_id=$1 AND contact_id=$2 ORDER BY id FOR UPDATE`,
    [workspaceId, contactId])
  await retireCrmIntakeReceipts(client, workspaceId, { contactId })

  // Commerce participation can be retention-bound and therefore uses a
  // pseudonymous shell. Non-commerce rows use the same shell because their
  // attendee columns are equally identifying and the event chronology may be
  // required independently of the erased subject.
  await client.query(
    `UPDATE association_registrations
        SET attendee_contact_id=NULL, attendee_name='Erased participant',
            attendee_email=NULL, attendee_metadata='{}'::jsonb
      WHERE workspace_id=$1 AND attendee_contact_id=$2`,
    [workspaceId, contactId],
  )
  await client.query(
    `UPDATE crm_import_errors e SET row_snapshot='{}'::jsonb,
            message='Row data erased by privacy request'
       FROM crm_import_rows r
      WHERE e.workspace_id=$1 AND r.workspace_id=e.workspace_id
        AND r.job_id=e.job_id AND r.row_number=e.row_number
        AND r.entity_id=$2`,
    [workspaceId, contactId],
  )
  await client.query(
    `UPDATE crm_import_rows SET entity_id=NULL
      WHERE workspace_id=$1 AND entity_id=$2`,
    [workspaceId, contactId],
  )
  // The remaining direct contact FKs are CASCADE-bound to entities. The
  // explicit deletes document the legal behavior and keep it stable if a
  // future migration changes an FK action.
  await deleteCrmPrivacyCopies(client,workspaceId,contactId)
  for (const table of [
    'crm_suppression_events',
    'association_consent_events',
    'association_memberships',
    'association_enquiries',
    'association_external_identities',
  ]) {
    await client.query(`DELETE FROM ${table} WHERE workspace_id=$1 AND contact_id=$2`, [workspaceId, contactId])
  }
}

export type CrmOperationsRetentionResult = {
  before: string
  deleted: Record<string, number>
  total: number
}

/**
 * Explicit policy hook. There is intentionally no implicit default cutoff:
 * operators must configure real retention/legal policy before scheduling it.
 */
export async function pruneCrmOperationsRetention(
  workspaceId: string,
  before: Date,
): Promise<CrmOperationsRetentionResult> {
  if (!Number.isFinite(before.getTime())) throw new Error('Retention cutoff must be a valid instant.')
  const client = await getPool().connect()
  const deleted: Record<string, number> = {}
  try {
    await client.query('BEGIN')
    await acquireCrmPrivacyAdmission(client,workspaceId)
    const enquiries = await client.query<{ id: string }>(
      `SELECT id FROM association_enquiries WHERE workspace_id=$1
        AND status IN ('resolved','spam') AND updated_at<$2 ORDER BY id FOR UPDATE`, [workspaceId, before])
    const submissionIds = enquiries.rows.map((row) => row.id)
    const retiredReceiptsDeleted = await retireCrmIntakeReceipts(client, workspaceId, { submissionIds })
    const remove = async (name: string, sql: string, values: unknown[]) => {
      const result = await client.query(sql, values)
      deleted[name] = result.rowCount ?? 0
    }
    await remove('crm_import_jobs',
      `DELETE FROM crm_import_jobs WHERE workspace_id=$1
        AND status IN ('completed','cancelled','failed') AND updated_at < $2`,
      [workspaceId, before])
    await remove('crm_domain_event_outbox',
      `DELETE FROM crm_domain_event_outbox e WHERE workspace_id=$1
        AND status='delivered' AND created_at < $2
        AND NOT EXISTS(SELECT 1 FROM workflow_runs r
          WHERE r.workspace_id=e.workspace_id AND r.crm_event_id=e.id)`,
      [workspaceId, before])
    await remove('crm_intake_idempotency',
      `DELETE FROM crm_intake_idempotency WHERE workspace_id=$1 AND status='retired'
        AND replay_expires_at<=clock_timestamp()`, [workspaceId])
    deleted.crm_intake_idempotency! += retiredReceiptsDeleted
    await remove('association_enquiries',
      `DELETE FROM association_enquiries WHERE workspace_id=$1
        AND id=ANY($2::uuid[])`, [workspaceId, submissionIds])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  return {
    before: before.toISOString(),
    deleted,
    total: Object.values(deleted).reduce((sum, count) => sum + count, 0),
  }
}

export async function listCrmOperationsAudit(workspaceId: string, filters: CrmPageQuery = {}) {
  return queryCrmPage(query, { workspaceId, resource: 'crm.audit', key: 'entries', query: filters,
    sql: `SELECT id,action,subject_kind AS "subjectKind",subject_id AS "subjectId",
            actor_kind AS "actorKind",created_at AS "occurredAt",created_at AS "createdAt",metadata AS details
       FROM association_audit_log WHERE workspace_id=$1 AND action LIKE 'crm.%'`,
    params: [workspaceId],
  })
}

export async function listCrmEventDelivery(workspaceId: string, filters: CrmPageQuery = {}) {
  return queryCrmPage(query, { workspaceId, resource: 'crm.event-delivery', key: 'events', query: filters,
    sql: `SELECT id,event_type AS "eventType",subject_kind AS "subjectKind",
            subject_id AS "subjectId",status,attempts,created_at AS "createdAt",
            occurred_at AS "occurredAt",delivered_at AS "deliveredAt",
            retired_at AS "retiredAt",retired_from_status AS "retiredFromStatus"
       FROM crm_domain_event_outbox WHERE workspace_id=$1`,
    params: [workspaceId],
  })
}
