/** Shared managed-mailbox policy and final recipient admission. [COMP:crm/delivery-policy] */
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { CrmOperationsError, evaluateCrmSendability, type CrmOperationsCommand, type CrmOperationsContext } from '@use-brian/core'
import { getPool, query } from '../db/client.js'
import { readCrmAddressSuppressions } from './suppression-tombstones.js'

export type CrmMailContext = { userId: string; workspaceId?: string; connectorInstanceId?: string }
export type CrmMailIntent = { crmPurposeKey?: string; crmTemplateKey?: string }
type Provider = 'gmail' | 'imap' | 'agentmail'
// This is the closed set of mail transports wired below, not all built-ins.
function isMailTransport(provider: string): provider is Provider {
  switch (provider) {
    case 'gmail':
    case 'imap':
    case 'agentmail': return true
    default: return false
  }
}
type Envelope = CrmMailIntent & { to: string | string[]; cc?: string[]; bcc?: string[]; scheduled?: boolean;
  unsupportedManagedPath?: 'provider_draft' | 'implicit_reply' }
type Policy = { id: string; connectorInstanceId: string; providerKey: string; version: number; managed: boolean;
  purposeKeys: string[]; templatePurposes: Record<string,string>; createdAt: Date; updatedAt: Date }
const projection = `id,connector_instance_id AS "connectorInstanceId",provider_key AS "providerKey",version,managed,
  purpose_keys AS "purposeKeys",template_purposes AS "templatePurposes",created_at AS "createdAt",updated_at AS "updatedAt"`
const scopeSchema = z.object({ userId: z.string().uuid(),workspaceId: z.string().uuid().optional(),connectorInstanceId: z.string().uuid().optional() }).strict()
const key = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/)
const intentSchema = z.object({ crmPurposeKey: key,crmTemplateKey: key.optional() }).strict()
const denied = (reason: string, details: Record<string,unknown> = {}) => new CrmOperationsError('conflict','Managed email delivery requires review.',{ reason,...details })

async function member(client: PoolClient, scope: CrmMailContext, admin = false) {
  const workspaceId = scope.workspaceId ?? (await client.query<{ id: string }>(
    `SELECT id FROM workspaces WHERE owner_user_id=$1 AND is_personal=true`,[scope.userId])).rows[0]?.id
  if (!workspaceId) throw denied('delivery_workspace_unavailable')
  const row = (await client.query<{ role: string }>(`SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`,[workspaceId,scope.userId])).rows[0]
  if (!row || (admin && !['owner','admin'].includes(row.role))) throw new CrmOperationsError('not_authorized','Current workspace membership is required for this mailbox operation.')
  return workspaceId
}
async function connector(client: PoolClient, workspaceId: string, scope: CrmMailContext, provider?: Provider) {
  const rows = await client.query<{ id: string; scope: string; userId: string | null; workspaceId: string | null; provider: Provider; connected: boolean; health: string }>(
    `SELECT id,scope,user_id AS "userId",workspace_id AS "workspaceId",provider,connected,health_status AS health FROM connector_instance
     WHERE ($1::uuid IS NOT NULL AND id=$1) OR ($1::uuid IS NULL AND scope='user' AND user_id=$2 AND provider=$3)
     ORDER BY created_at,id LIMIT 1 FOR SHARE`,[scope.connectorInstanceId ?? null,scope.userId,provider ?? null])
  const row = rows.rows[0]
  if (!row || !isMailTransport(row.provider) || (provider && row.provider!==provider)
    || !row.connected || row.health==='auth_failed') throw denied('delivery_connector_unavailable')
  if (row.scope==='workspace' && row.workspaceId!==workspaceId) throw new CrmOperationsError('not_authorized','The mailbox is unavailable in this workspace.')
  if (row.workspaceId!==workspaceId && row.userId!==scope.userId) {
    const grant = await client.query(`SELECT id FROM connector_grant WHERE connector_instance_id=$1 AND target_type='workspace' AND target_id=$2 FOR SHARE`,[row.id,workspaceId])
    if (!grant.rowCount) throw new CrmOperationsError('not_authorized','The mailbox is unavailable in this workspace.')
  }
  return row
}
const lockKey = (workspaceId: string, instanceId: string) => `crm-mailbox:${workspaceId}:${instanceId}`

export async function saveCrmManagedMailboxPolicy(client: PoolClient, context: CrmOperationsContext,
  command: Extract<CrmOperationsCommand,{kind:'save_managed_mailbox_policy'}>) {
  if (context.actor.kind!=='user') throw new CrmOperationsError('not_authorized','A current owner or admin must approve mailbox management.')
  const scope = { userId: context.actor.userId,workspaceId: context.workspaceId,connectorInstanceId: command.connectorInstanceId }
  await member(client,scope,true)
  await connector(client,context.workspaceId,scope)
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lockKey(context.workspaceId,command.connectorInstanceId)])
  const existing = (await client.query<Policy>(`SELECT ${projection} FROM crm_managed_mailbox_policies WHERE workspace_id=$1 AND connector_instance_id=$2 FOR UPDATE`,[context.workspaceId,command.connectorInstanceId])).rows[0]
  if ((existing?.version ?? 0)!==command.expectedVersion) throw denied('stale_mailbox_policy_version')
  if (existing && existing.providerKey!==command.providerKey) throw denied('mailbox_provider_key_immutable')
  const purposes = await client.query(`SELECT purpose_key FROM crm_consent_purposes WHERE workspace_id=$1 AND purpose_key=ANY($2::text[]) AND archived_at IS NULL ORDER BY purpose_key FOR SHARE`,[context.workspaceId,command.purposeKeys])
  if (purposes.rowCount!==command.purposeKeys.length) throw denied('mailbox_purpose_unavailable')
  const purposeKeys = [...command.purposeKeys].sort(), templatePurposes = Object.fromEntries(Object.entries(command.templatePurposes).sort(([a],[b])=>a.localeCompare(b)))
  if (existing && existing.managed===command.managed && JSON.stringify([...existing.purposeKeys].sort())===JSON.stringify(purposeKeys)
    && JSON.stringify(Object.fromEntries(Object.entries(existing.templatePurposes).sort(([a],[b])=>a.localeCompare(b))))===JSON.stringify(templatePurposes)) return { record: existing,changed: false }
  const values = [context.workspaceId,command.connectorInstanceId,command.providerKey,command.expectedVersion+1,command.managed,purposeKeys,JSON.stringify(templatePurposes),context.actor.userId]
  const saved = await client.query<Policy>(`INSERT INTO crm_managed_mailbox_policies(workspace_id,connector_instance_id,provider_key,version,managed,purpose_keys,template_purposes,approved_by_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(workspace_id,connector_instance_id) DO UPDATE SET
      version=EXCLUDED.version,managed=EXCLUDED.managed,purpose_keys=EXCLUDED.purpose_keys,template_purposes=EXCLUDED.template_purposes,
      approved_by_user_id=EXCLUDED.approved_by_user_id,updated_at=clock_timestamp() RETURNING ${projection}`,values)
  return { record: saved.rows[0]!,changed: true }
}

export async function readCrmManagedMailboxPolicy(workspaceId: string, instanceId: string) {
  return (await query<Policy>(`SELECT ${projection} FROM crm_managed_mailbox_policies WHERE workspace_id=$1 AND connector_instance_id=$2`,[workspaceId,instanceId])).rows[0] ?? null
}

function recipients(envelope: Envelope) {
  const raw = [...(Array.isArray(envelope.to) ? envelope.to : [envelope.to]),...(envelope.cc ?? []),...(envelope.bcc ?? [])]
  if (!raw.length || raw.length>1000) throw denied('delivery_recipient_count_invalid')
  return raw.map((address,index) => {
    if (typeof address!=='string' || /[\r\n]/.test(address) || !z.string().email().max(320).safeParse(address.trim()).success) throw denied('delivery_recipient_invalid',{ recipientIndex: index })
    return address.trim().toLowerCase()
  })
}

/** Invocation is inside the final admission transaction, after approvals. */
export async function withCrmMailAdmission<T>(rawScope: CrmMailContext | undefined, provider: Provider, envelope: Envelope, invoke: () => Promise<T>): Promise<T> {
  const scope = scopeSchema.safeParse(rawScope)
  if (!scope.success) throw denied('delivery_context_required')
  const client = await getPool().connect()
  let invoking = false, accepted = false
  try {
    await client.query('BEGIN')
    const workspaceId = await member(client,scope.data)
    const instance = await connector(client,workspaceId,scope.data,provider)
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[lockKey(workspaceId,instance.id)])
    const policy = (await client.query<Policy>(`SELECT ${projection} FROM crm_managed_mailbox_policies WHERE workspace_id=$1 AND connector_instance_id=$2 FOR SHARE`,[workspaceId,instance.id])).rows[0]
    if (policy?.managed || envelope.crmPurposeKey || envelope.crmTemplateKey) {
      if (!policy?.managed) throw denied('mailbox_management_unconfigured')
      if (envelope.scheduled) throw denied('managed_provider_scheduling_unavailable')
      if (envelope.unsupportedManagedPath) throw denied('managed_recipient_snapshot_required', { path: envelope.unsupportedManagedPath })
      const intent = intentSchema.safeParse({ crmPurposeKey: envelope.crmPurposeKey,...(envelope.crmTemplateKey ? { crmTemplateKey: envelope.crmTemplateKey } : {}) })
      if (!intent.success) throw denied('delivery_purpose_required',{ purposeKeys: policy.purposeKeys })
      const { crmPurposeKey,crmTemplateKey } = intent.data
      if (!policy.purposeKeys.includes(crmPurposeKey)) throw denied('delivery_purpose_not_allowed', { purposeKeys: policy.purposeKeys })
      if (crmTemplateKey && policy.templatePurposes[crmTemplateKey]!==crmPurposeKey) throw denied('delivery_template_purpose_mismatch', {
        templateKeys: Object.entries(policy.templatePurposes).filter(([,purpose]) => purpose===crmPurposeKey).map(([template]) => template),
      })
      const addresses = recipients(envelope)
      const purpose = (await client.query<{ archived: boolean; requiresConsent: boolean; applicableChannels: ('email')[] }>(`SELECT archived_at IS NOT NULL AS archived,requires_consent AS "requiresConsent",applicable_channels AS "applicableChannels"
        FROM crm_consent_purposes WHERE workspace_id=$1 AND purpose_key=$2 FOR SHARE`,[workspaceId,crmPurposeKey])).rows[0]
      if (!purpose) throw denied('delivery_purpose_unavailable')
      const people = (await client.query<{ id: string; email: string }>(`SELECT id,lower(btrim(COALESCE(NULLIF(attributes->>'email',''),canonical_id))) AS email
        FROM entities WHERE workspace_id=$1 AND kind='person' AND valid_to IS NULL AND retracted_at IS NULL
          AND lower(btrim(COALESCE(NULLIF(attributes->>'email',''),canonical_id)))=ANY($2::text[]) ORDER BY id FOR SHARE`,[workspaceId,addresses])).rows
      for (const [index,address] of addresses.entries()) {
        const matches = people.filter((person)=>person.email===address)
        // Check retained evidence even without a person, so erasure remains a
        // known restriction rather than becoming an ordinary unknown identity.
        const retained = await readCrmAddressSuppressions(client,workspaceId,'email',address,crmPurposeKey)
        if (retained.length) throw denied('delivery_recipient_blocked',{ recipientIndex: index,reasonCodes: ['address_suppression'] })
        if (matches.length!==1) throw denied(matches.length ? 'delivery_identity_ambiguous' : 'delivery_identity_unresolved',{ recipientIndex: index })
        const contactId = matches[0]!.id
        const stamp = `to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"`
        const consent = await client.query<{ id: string; action:'granted'|'withdrawn'; occurredAt:string; createdAt:string }>(`SELECT id,action,${stamp} FROM association_consent_events
          WHERE workspace_id=$1 AND contact_id=$2 AND purpose=$3 ORDER BY occurred_at DESC,created_at DESC,id DESC LIMIT 1`,[workspaceId,contactId,crmPurposeKey])
        const suppression = await client.query<{ id:string; channel:'all'|'email'; action:'suppressed'|'released'; occurredAt:string; createdAt:string }>(`SELECT DISTINCT ON(channel) id,channel,action,${stamp} FROM crm_suppression_events
          WHERE workspace_id=$1 AND contact_id=$2 AND channel IN('all','email') ORDER BY channel,occurred_at DESC,created_at DESC,id DESC`,[workspaceId,contactId])
        const verdict = evaluateCrmSendability({ channel:'email',hasContactMethod:true,purpose,consentEvents:consent.rows,suppressionEvents:suppression.rows })
        if (verdict.verdict!=='allowed') throw denied('delivery_recipient_not_allowed',{ recipientIndex:index,verdict:verdict.verdict,reasonCodes:verdict.reasons })
      }
    }
    invoking = true
    const result = await invoke()
    accepted = true
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(()=>{})
    if (invoking) {
      const status = error && typeof error==='object' && 'status' in error && typeof error.status==='number' ? error.status : undefined
      const rejected = !accepted && status!==undefined && status>=400 && status<500 && ![408,429].includes(status)
      const fixed = denied(rejected ? 'provider_rejected' : 'provider_outcome_unknown',status ? { status } : {})
      if (status) Object.assign(fixed,{ status })
      throw fixed
    }
    throw error
  }
  finally { client.release() }
}
