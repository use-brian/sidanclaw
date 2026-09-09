/** Normalized provider periods through canonical CRM commands. [COMP:crm/provider-inbox] */
import type { Pool, PoolClient } from 'pg'
import { CrmOperationsError, requireCrmIntegrationResources, type AssociationActor, type CrmOperationsContext,
  type ProviderEntitlementEvent, type ProviderInboxEnvelope } from '@use-brian/core'
import { createDbCrmOperationsStore } from '../db/crm-operations-store.js'
import { lockCrmIntegrationCredential } from '../db/crm-integration-store.js'
import { lockAssociationModule } from '../db/workspace-modules-store.js'
import { createCrmOperationsService } from '../crm-operations/service.js'
import { requireProviderEntitlementActor } from '../crm-operations/entitlement-periods.js'
import { receiveProviderInbox, type ProviderInboxHandlers, type ProviderInboxRow } from './provider-inbox.js'

function eventFor(envelope: ProviderInboxEnvelope): ProviderEntitlementEvent {
  if (envelope.target !== 'entitlement') throw new CrmOperationsError('invalid_input', 'Entitlement evidence is required.')
  return envelope.event
}
function contextFor(workspaceId: string, actor: AssociationActor, event: ProviderEntitlementEvent): CrmOperationsContext {
  const identity: CrmOperationsContext['actor'] = actor.credentialKind === 'provider'
    ? { kind: 'provider', provider: event.provider, eventId: event.eventId }
    : actor.credentialKind === 'system_job'
      ? { kind: 'system_job', job: 'entitlement_reconciliation', runId: actor.credentialId.slice('entitlement_reconciliation:'.length) }
      : actor.credentialKind === 'integration_key'
        ? { kind: 'integration_key', credentialId: actor.credentialId }
        : actor.credentialKind === 'oauth_token'
          ? { kind: 'oauth_token', credentialId: actor.credentialId }
          : { kind: 'brain_key', credentialId: actor.credentialId }
  return { workspaceId, actor: identity, authority: { role: 'system', canWrite: true, canConfigure: false, trustedIdentitySources: [],
    ...(actor.integration ? { integration: actor.integration } : {}) } }
}
async function readMembership(client: PoolClient, workspaceId: string, id: string): Promise<Record<string, unknown>> {
  const row = (await client.query(`SELECT id,contact_id AS "contactId",plan_id AS "planId",status,starts_at AS "startsAt",ends_at AS "endsAt",
    renewal_mode AS "renewalMode",provider,provider_membership_id AS "providerEntitlementId",provider_period_id AS "providerPeriodId",predecessor_id AS "predecessorId"
    FROM association_memberships WHERE workspace_id=$1 AND id=$2`, [workspaceId, id])).rows[0]
  if (!row) throw new CrmOperationsError('not_found', 'Entitlement is unavailable.')
  return row
}
export function createProviderEntitlementInbox(pool: Pool) {
  const handlers = (workspaceId: string): ProviderInboxHandlers => ({
    async authorize(client, envelope, actor, admittedActor) {
      const event = eventFor(envelope), command = event.command
      requireProviderEntitlementActor(actor, event.provider)
      if (actor.credentialKind === 'integration_key' && actor.integration?.credentialId !== actor.credentialId)
        throw new CrmOperationsError('not_authorized', 'Credential-derived integration authority is required.')
      const current = actor.credentialKind === 'integration_key' ? await lockCrmIntegrationCredential(client, workspaceId, actor.credentialId) : undefined
      await lockAssociationModule(client, workspaceId)
      const target = command.kind === 'grant_entitlement' ? { contactId: command.contactId, planId: command.planId, entitlementId: null }
        : (await client.query<{ contactId: string; planId: string; entitlementId: string }>('SELECT contact_id AS "contactId",plan_id AS "planId",id AS "entitlementId" FROM association_memberships WHERE workspace_id=$1 AND id=$2', [workspaceId, command.entitlementId])).rows[0]
      if (!target) throw new CrmOperationsError('not_found', 'Entitlement is unavailable.')
      for (const ceiling of [actor.integration, current, admittedActor?.integration]) if (ceiling) {
        requireCrmIntegrationResources(ceiling, 'crm.entitlements.write', { planIds: target.planId })
        requireCrmIntegrationResources(ceiling, 'association.provider_events.write', { providerKeys: event.provider })
      }
      if (!(await client.query(`SELECT 1 FROM entities c JOIN association_membership_plans p ON p.workspace_id=c.workspace_id
        WHERE c.workspace_id=$1 AND c.id=$2 AND c.kind='person' AND c.valid_to IS NULL AND c.retracted_at IS NULL AND p.id=$3`,
        [workspaceId, target.contactId, target.planId])).rowCount) throw new CrmOperationsError('not_found', 'Entitlement contact or plan is unavailable.')
      return target
    },
    async apply(client, envelope, actor) {
      const event = eventFor(envelope), command = event.command
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('crm-provider-period:'||$1::uuid::text||':'||$2::text||':'||$3::text,0))", [workspaceId, event.provider, event.providerReference])
      const later = await client.query(`SELECT 1 FROM association_integration_events WHERE workspace_id=$1 AND provider=$2 AND provider_reference=$3
        AND target_kind='entitlement' AND state='applied' AND occurred_at>$4::timestamptz LIMIT 1`, [workspaceId, event.provider, event.providerReference, event.occurredAt])
      if (later.rowCount) throw new CrmOperationsError('conflict', 'Newer verified provider state already exists.', { reason: 'provider_event_out_of_order' })
      if (command.kind === 'update_entitlement') {
        const row = (await client.query<{ provider: string; provider_membership_id: string; provider_period_id: string; same: boolean }>(`SELECT provider,provider_membership_id,provider_period_id,
          ($3::text IS NULL OR status=$3) AND (NOT $4::boolean OR ends_at IS NOT DISTINCT FROM $5::timestamptz)
            AND ($6::text IS NULL OR renewal_mode=$6) same
          FROM association_memberships WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
          [workspaceId, command.entitlementId, command.status ?? null, Object.hasOwn(command, 'endsAt'), command.endsAt ?? null, command.renewalMode ?? null])).rows[0]
        if (!row || row.provider !== event.provider || row.provider_membership_id !== event.providerReference || row.provider_period_id !== event.providerPeriodId)
          throw new CrmOperationsError('conflict', 'Provider object and period do not match the entitlement.')
        if (row.same) return { record: await readMembership(client, workspaceId, command.entitlementId), created: false }
      }
      const result = await createCrmOperationsService(createDbCrmOperationsStore(pool, client)).execute(contextFor(workspaceId, actor, event), command)
      return { record: await readMembership(client, workspaceId, String(result.record.id)), created: result.duplicate !== true }
    },
    read: (client, row) => readMembership(client, workspaceId, row.entitlement_id!),
  })
  return {
    submit: (workspaceId: string, event: ProviderEntitlementEvent, actor: AssociationActor) => receiveProviderInbox(pool, { target: 'entitlement', event }, actor, workspaceId, handlers(workspaceId)),
    retry: (row: ProviderInboxRow) => receiveProviderInbox(pool, row.normalized_payload, row.execution_actor, row.workspace_id, handlers(row.workspace_id), 'worker'),
  }
}
