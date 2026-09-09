/**
 * PostgreSQL store for association operations.
 *
 * Every system-pool query repeats `workspace_id` in its predicate. Mutations
 * that create side effects (audit/outbox) and all inventory/payment changes
 * use one transaction, so callers never observe a record without its evidence
 * or a payment state without matching registrations.
 *
 * [COMP:crm/association-store]
 */

import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { CrmOperationsError, CrmEffectiveEntitlementQuerySchema, type CrmEffectiveEntitlementQuery, type CrmPageQuery, CrmIntegrationScopeError, requireCrmIntegrationResources, type CrmIntegrationOperation } from '@use-brian/core'
import { prepareProviderEntitlementPeriod, requireProviderEntitlementActor } from '../crm-operations/entitlement-periods.js'
import { mayTransitionCrmEntitlement } from '@use-brian/core'
import {lockAssociationInventory,refreshAssociationInventory} from '../association/inventory.js'
import { crmPageInstant, queryCrmPage } from '../crm-operations/pagination.js'
import { getPool } from './client.js'
import { lockCrmIntegrationCredential, type CrmIntegrationPrincipal } from './crm-integration-store.js'
import { crmEvidenceRequestHash, resolveCrmEvidenceReplay, type CrmEvidenceRequest } from '../crm-operations/evidence-replay.js'
import { lockAssociationModule, requireAssociationAdmission } from './workspace-modules-store.js'
import {
  AssociationError,
  associationFingerprint,
  mayTransitionOrder,
  type AssociationActor,
  type ConsentInput,
  type EnquiryCreateInput,
  type EnquiryNoteInput,
  type EnquiryStatus,
  type EnquiryUpdateInput,
  type EventInput,
  type ExternalIdentityInput,
  type MembershipInput,
  type MembershipUpdateInput,
  type OrderCreateInput,
  type OrderStatus,
  type PlanInput,
  type ProviderEventInput,
  mayTransitionRegistration,
  type RegistrationStatus,
  type RegistrationUpdateInput,
  type TicketInput,
} from '../association/domain.js'

export type AssociationRecord = Record<string, unknown>
export type AssociationPage = { items: AssociationRecord[]; nextCursor: string | null }
export type MutationResult = { record: AssociationRecord; created: boolean }

export type AssociationListInput = Omit<CrmPageQuery, 'cursor'> & {
  limit: number
  cursor: string | null
}

export type AssociationStore = {
  linkExternalIdentity(workspaceId: string, input: ExternalIdentityInput, actor: AssociationActor): Promise<MutationResult>
  resolveExternalIdentity(workspaceId: string, provider: string, providerSubject: string): Promise<AssociationRecord | null>
  createEnquiry(workspaceId: string, input: EnquiryCreateInput, actor: AssociationActor): Promise<MutationResult>
  listEnquiries(workspaceId: string, input: AssociationListInput & { status?: EnquiryStatus; queueKey?: string; ownerUserId?: string }): Promise<AssociationPage>
  updateEnquiry(workspaceId: string, id: string, input: EnquiryUpdateInput, actor: AssociationActor): Promise<AssociationRecord>
  addEnquiryNote(workspaceId: string, enquiryId: string, input: EnquiryNoteInput, actor: AssociationActor): Promise<AssociationRecord>
  listEnquiryNotes(workspaceId: string, enquiryId: string): Promise<AssociationRecord[]>
  appendConsent(workspaceId: string, input: ConsentInput, actor: AssociationActor): Promise<MutationResult>
  listConsents(workspaceId: string, contactId: string): Promise<{ events: AssociationRecord[]; effective: Record<string, string> }>
  upsertPlan(workspaceId: string, input: PlanInput, actor: AssociationActor): Promise<MutationResult>
  listPlans(workspaceId: string, input: AssociationListInput & { published?: boolean }): Promise<AssociationPage>
  createMembership(workspaceId: string, input: MembershipInput, actor: AssociationActor): Promise<MutationResult>
  listMemberships(workspaceId: string, contactId: string, filters?: CrmEffectiveEntitlementQuery): Promise<AssociationRecord[]>
  updateMembership(workspaceId: string, id: string, input: MembershipUpdateInput, actor: AssociationActor): Promise<AssociationRecord>
  upsertEvent(workspaceId: string, input: EventInput, actor: AssociationActor): Promise<MutationResult>
  listEvents(workspaceId: string, input: AssociationListInput & { status?: string }): Promise<AssociationPage>
  upsertTicket(workspaceId: string, eventId: string, input: TicketInput, actor: AssociationActor): Promise<MutationResult>
  listTickets(workspaceId: string, eventId: string): Promise<AssociationRecord[]>
  createOrder(workspaceId: string, input: OrderCreateInput, actor: AssociationActor): Promise<MutationResult>
  getOrder(workspaceId: string, id: string, actor?: AssociationActor): Promise<AssociationRecord | null>
  listOrders(workspaceId: string, input: AssociationListInput & { status?: OrderStatus; eventId?: string; contactId?: string; allowedEventIds?: readonly string[] }): Promise<AssociationPage & { total: number }>
  expireDueOrder(workspaceId:string,id:string,actor:AssociationActor):Promise<MutationResult>
  cancelOrder(workspaceId: string, id: string, actor: AssociationActor): Promise<MutationResult>
  confirmFreeOrder(workspaceId: string, id: string, actor: AssociationActor): Promise<MutationResult>
  reconcileProviderEvent(workspaceId: string, orderId: string, input: ProviderEventInput, actor: AssociationActor): Promise<MutationResult>
  listEventRegistrations(workspaceId: string, eventId: string, input: AssociationListInput & { status?: RegistrationStatus }): Promise<AssociationPage>
  getRegistrationManagement(workspaceId: string, id: string): Promise<{ sourceKind: string; eventId?: string } | null>
  updateRegistration(workspaceId: string, id: string, input: RegistrationUpdateInput, actor: AssociationActor): Promise<AssociationRecord>
  listNotifications(workspaceId: string, input: AssociationListInput & { status?: string }): Promise<AssociationPage>
}

type DbRow = QueryResultRow & Record<string, unknown>

function authorizeIntegration(actor: AssociationActor, operation: CrmIntegrationOperation,
  resources: Parameters<typeof requireCrmIntegrationResources>[2], current?: CrmIntegrationPrincipal): void {
  if (actor.credentialKind === 'integration_key' && actor.integration?.credentialId !== actor.credentialId) {
    throw new CrmIntegrationScopeError(operation)
  }
  if (actor.integration) requireCrmIntegrationResources(actor.integration, operation, resources)
  if (current) requireCrmIntegrationResources(current, operation, resources)
}

async function lockIntegrationActor(client: PoolClient, workspaceId: string, actor: AssociationActor): Promise<CrmIntegrationPrincipal | undefined> {
  if (actor.credentialKind !== 'integration_key') return undefined
  if (actor.integration?.credentialId !== actor.credentialId) throw new CrmIntegrationScopeError('association.orders.write')
  return lockCrmIntegrationCredential(client, workspaceId, actor.credentialId)
}

async function authorizeOrderIntegration(client: PoolClient, workspaceId: string, orderId: string, actor: AssociationActor,
  operation: CrmIntegrationOperation, provider?: string, current?: CrmIntegrationPrincipal): Promise<void> {
  if (!actor.integration && actor.credentialKind !== 'integration_key') return
  const events = await client.query<{ event_id: string }>(`SELECT DISTINCT t.event_id FROM association_order_lines l
    JOIN association_ticket_types t ON t.workspace_id=l.workspace_id AND t.id=l.ticket_id
    WHERE l.workspace_id=$1 AND l.order_id=$2`, [workspaceId, orderId])
  authorizeIntegration(actor, operation, { eventIds: events.rows.map((row) => row.event_id), ...(provider ? { providerKeys: provider } : {}) }, current)
}

async function settleWithoutProvider(pool: Pool, workspaceId: string, id: string, actor: AssociationActor, action: 'cancel' | 'confirm_free' | 'expire'): Promise<MutationResult> {
  if(action==='expire' && !(actor.credentialKind==='system_job' && /^association_expiry:[a-f0-9-]{36}$/i.test(actor.credentialId)))
    throw new CrmOperationsError('not_authorized','Due reservation expiry requires its dedicated system job')
  return transaction(pool, async (client) => {
    const integration = await lockIntegrationActor(client, workspaceId, actor)
    await lockAssociationModule(client, workspaceId)
    await authorizeOrderIntegration(client, workspaceId, id, actor, 'association.orders.write', undefined, integration)
    const inventoryEvents=await lockAssociationInventory(client,workspaceId,{orderId:id})
    const current = await client.query<{ status: OrderStatus; total_minor: string; unexpired: boolean }>(
      `SELECT status,total_minor::text,reservation_expires_at>clock_timestamp() AS unexpired FROM association_orders
       WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [workspaceId, id])
    const order = current.rows[0]
    if (!order) {
      if(action==='expire')return {record:{id,changed:false},created:false}
      throw new AssociationError('not_found', 'order not found')
    }
    if(action==='expire') {
      const due=(await client.query<{due:boolean}>(`SELECT reservation_expires_at<=clock_timestamp() due FROM association_orders WHERE workspace_id=$1 AND id=$2`,[workspaceId,id])).rows[0]?.due
      if(order.status!=='pending' || !due)return {record:(await getOrderRecord(client,workspaceId,id))!,created:false}
    }
    const target = action === 'confirm_free' ? 'paid' : 'cancelled'
    if (action === 'confirm_free' && order.total_minor !== '0') throw new AssociationError('invalid_transition', 'Only a zero-total order can be confirmed without payment evidence')
    if (order.status === target) return { record: (await getOrderRecord(client, workspaceId, id))!, created: false }
    if (order.status !== 'pending') throw new AssociationError('invalid_transition', 'Only a pending order can be settled by this command')
    if (action === 'confirm_free' && !(await client.query<{unexpired:boolean}>('SELECT reservation_expires_at>clock_timestamp() unexpired FROM association_orders WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0]?.unexpired) throw new AssociationError('not_available', 'The free-order reservation expired; create a new order after availability is checked')
    await client.query(`UPDATE association_orders SET status=$3,reservation_expires_at=NULL WHERE workspace_id=$1 AND id=$2`, [workspaceId, id, target])
    await client.query(`UPDATE association_registrations SET status=$3,reservation_expires_at=NULL
      WHERE workspace_id=$1 AND order_id=$2 AND status='reserved'`, [workspaceId, id, target === 'paid' ? 'confirmed' : 'cancelled'])
    if (action === 'confirm_free') await client.query(`INSERT INTO association_notification_outbox
      (workspace_id,source_kind,source_id,template_key,recipient_kind,recipient_ref,payload)
      SELECT workspace_id,'order',id,'order_receipt','contact',contact_id::text,jsonb_build_object('orderId',id)
      FROM association_orders WHERE workspace_id=$1 AND id=$2 ON CONFLICT DO NOTHING`, [workspaceId, id])
    await refreshAssociationInventory(client,workspaceId,inventoryEvents,actor.credentialKind)
    await audit(client, workspaceId, action === 'expire' ? 'order.expired' : action === 'cancel' ? 'order.cancelled' : 'order.free_confirmed', 'order', id, actor)
    return { record: (await getOrderRecord(client, workspaceId, id))!, created: true }
  })
}

const IDENTITY_SELECT = `
  id, workspace_id AS "workspaceId", contact_id AS "contactId", provider,
  provider_subject AS "providerSubject", created_at AS "createdAt", updated_at AS "updatedAt"`
const ENQUIRY_SELECT = `
  id, workspace_id AS "workspaceId", contact_id AS "contactId", source,
  source_submission_id AS "sourceSubmissionId", subject, message,
  submitted_data AS "submittedData", status, queue_key AS "queueKey",
  owner_user_id AS "ownerUserId", submitted_at AS "submittedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"`
const ENQUIRY_NOTE_SELECT = `
  id, workspace_id AS "workspaceId", enquiry_id AS "enquiryId", body,
  actor_kind AS "actorKind", actor_credential_id AS "actorCredentialId",
  acting_user_id AS "actingUserId", created_at AS "createdAt"`
const CONSENT_SELECT = `
  id, workspace_id AS "workspaceId", contact_id AS "contactId", purpose, action,
  wording_version AS "wordingVersion", source, occurred_at AS "occurredAt",
  wording_snapshot AS wording, wording_hash AS "wordingHash",
  wording_version_id AS "wordingVersionId", wording_locale AS "wordingLocale",
  provider, provider_event_id AS "providerEventId", metadata,
  created_at AS "createdAt"`
const PLAN_SELECT = `
  id, workspace_id AS "workspaceId", plan_key AS "key", name, currency,
  fee_minor::text AS "feeMinor", billing_period AS "billingPeriod", benefits,
  eligibility_note AS "eligibilityNote", active_from AS "activeFrom",
  active_to AS "activeTo", published, provider, provider_plan_id AS "providerPlanId",
  created_at AS "createdAt", updated_at AS "updatedAt"`
const MEMBERSHIP_SELECT = `
  m.id, m.workspace_id AS "workspaceId", m.contact_id AS "contactId",
  m.plan_id AS "planId", p.plan_key AS "planKey", p.name AS "planName",
  m.idempotency_key AS "idempotencyKey", m.status, m.starts_at AS "startsAt",
  m.ends_at AS "endsAt", m.renewal_mode AS "renewalMode", m.provider,
  m.provider_membership_id AS "providerMembershipId", m.provider_period_id AS "providerPeriodId", m.predecessor_id AS "predecessorId",
  m.created_at AS "createdAt", m.updated_at AS "updatedAt"`
const EVENT_SELECT = `
  id, workspace_id AS "workspaceId", slug, programme_key AS "programmeKey",
  title, description, starts_at AS "startsAt", ends_at AS "endsAt", timezone,
  mode, venue, online_url AS "onlineUrl",
  registration_opens_at AS "registrationOpensAt",
  registration_closes_at AS "registrationClosesAt", capacity, status,
  canonical_url AS "canonicalUrl", metadata,
  created_at AS "createdAt", updated_at AS "updatedAt"`
const TICKET_SELECT = `
  t.id, t.workspace_id AS "workspaceId", t.event_id AS "eventId",
  t.ticket_key AS "key", t.name, t.currency,
  t.price_minor::text AS "priceMinor", t.member_price_minor::text AS "memberPriceMinor",
  t.eligible_plan_keys AS "eligiblePlanKeys", t.capacity,
  t.per_order_limit AS "perOrderLimit", t.sale_starts_at AS "saleStartsAt",
  t.sale_ends_at AS "saleEndsAt", t.status,
  COALESCE(i.reserved_count, 0)::int AS "reservedCount",
  CASE WHEN t.capacity IS NULL THEN NULL
       ELSE GREATEST(t.capacity - COALESCE(i.reserved_count, 0), 0)::int END AS "available",
  t.created_at AS "createdAt", t.updated_at AS "updatedAt"`
const ORDER_SELECT = `
  id, workspace_id AS "workspaceId", contact_id AS "contactId",
  idempotency_key AS "idempotencyKey", status, currency,
  subtotal_minor::text AS "subtotalMinor", discount_minor::text AS "discountMinor",
  total_minor::text AS "totalMinor", reservation_expires_at AS "reservationExpiresAt",
  provider, provider_reference AS "providerReference", metadata,
  created_at AS "createdAt", updated_at AS "updatedAt"`
const REGISTRATION_SELECT = `
  id, workspace_id AS "workspaceId", order_id AS "orderId",
  order_line_id AS "orderLineId", event_id AS "eventId", ticket_id AS "ticketId",
  attendee_contact_id AS "attendeeContactId", attendee_name AS "attendeeName",
  attendee_email AS "attendeeEmail", attendee_metadata AS "attendeeMetadata",
  status, reservation_expires_at AS "reservationExpiresAt",
  checked_in_at AS "checkedInAt", source_kind AS "sourceKind", source_id AS "sourceId", historical_import AS "historicalImport",
  created_at AS "createdAt", updated_at AS "updatedAt"`
const NOTIFICATION_SELECT = `
  id, workspace_id AS "workspaceId", source_kind AS "sourceKind",
  source_id AS "sourceId", template_key AS "templateKey",
  recipient_kind AS "recipientKind", recipient_ref AS "recipientRef", payload,
  status, attempts, retired_at AS "retiredAt", retired_from_status AS "retiredFromStatus", next_attempt_at AS "nextAttemptAt",
  provider_message_id AS "providerMessageId", last_error AS "lastError",
  created_at AS "createdAt", updated_at AS "updatedAt"`

async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const value = await fn(client)
    await client.query('COMMIT')
    return value
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function requirePerson(client: PoolClient, workspaceId: string, contactId: string): Promise<void> {
  const found = await client.query(
    `SELECT 1 FROM entities
      WHERE workspace_id = $1 AND id = $2 AND kind = 'person' AND valid_to IS NULL`,
    [workspaceId, contactId],
  )
  if (!found.rowCount) {
    throw new AssociationError('contact_required', 'contactId must identify a live CRM person in this workspace')
  }
}

async function requireWorkspaceUser(client: PoolClient, workspaceId: string, userId: string): Promise<void> {
  const found = await client.query(
    `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  )
  if (!found.rowCount) throw new AssociationError('not_found', 'ownerUserId is not a workspace member')
}

async function audit(
  client: PoolClient,
  workspaceId: string,
  action: string,
  subjectKind: string,
  subjectId: string,
  actor: AssociationActor,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO association_audit_log
       (workspace_id, action, subject_kind, subject_id, actor_kind,
        actor_credential_id, acting_user_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [workspaceId, action, subjectKind, subjectId, actor.credentialKind,
      actor.credentialId, actor.actingUserId ?? null, metadata],
  )
}

function page(pool: Pool, workspaceId: string, resource: string, input: AssociationListInput, sql: string, params: unknown[]): Promise<AssociationPage> {
  return queryCrmPage(pool.query.bind(pool), { workspaceId, resource, key: 'items', sql, params,
    query: { limit: input.limit, cursor: input.cursor ?? undefined, createdAfter: input.createdAfter, createdBefore: input.createdBefore } })
}

async function getOrderRecord(client: Pick<PoolClient, 'query'>, workspaceId: string, id: string): Promise<AssociationRecord | null> {
  const orderResult = await client.query<DbRow>(
    `SELECT ${ORDER_SELECT} FROM association_orders WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  )
  const order = orderResult.rows[0]
  if (!order) return null
  const [lines, registrations] = await Promise.all([
    client.query<DbRow>(
      `SELECT l.id, l.order_id AS "orderId", l.ticket_id AS "ticketId",
              t.ticket_key AS "ticketKey", t.name AS "ticketName", l.quantity,
              l.unit_price_minor::text AS "unitPriceMinor",
              l.discount_minor::text AS "discountMinor",
              l.line_total_minor::text AS "lineTotalMinor",
              l.pricing_basis AS "pricingBasis",
              l.eligible_membership_id AS "eligibleMembershipId",
              l.created_at AS "createdAt"
         FROM association_order_lines l
         JOIN association_ticket_types t ON t.workspace_id = l.workspace_id AND t.id = l.ticket_id
        WHERE l.workspace_id = $1 AND l.order_id = $2
        ORDER BY l.created_at, l.id`,
      [workspaceId, id],
    ),
    client.query<DbRow>(
      `SELECT ${REGISTRATION_SELECT}
         FROM association_registrations
        WHERE workspace_id = $1 AND order_id = $2
        ORDER BY created_at, id`,
      [workspaceId, id],
    ),
  ])
  return { ...order, lines: lines.rows, registrations: registrations.rows }
}


export async function saveCrmEntitlementPlanRecord(client: PoolClient, workspaceId: string, input: PlanInput): Promise<MutationResult> {
  const before = await client.query<{ id: string }>(
    `SELECT id FROM association_membership_plans WHERE workspace_id = $1 AND plan_key = $2`,
    [workspaceId, input.key],
  )
  const result = await client.query<DbRow>(
    `INSERT INTO association_membership_plans
       (workspace_id, plan_key, name, currency, fee_minor, billing_period,
        benefits, eligibility_note, active_from, active_to, published,
        provider, provider_plan_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (workspace_id, plan_key) DO UPDATE SET
       name = EXCLUDED.name, currency = EXCLUDED.currency,
       fee_minor = EXCLUDED.fee_minor, billing_period = EXCLUDED.billing_period,
       benefits = EXCLUDED.benefits, eligibility_note = EXCLUDED.eligibility_note,
       active_from = EXCLUDED.active_from, active_to = EXCLUDED.active_to,
       published = EXCLUDED.published, provider = EXCLUDED.provider,
       provider_plan_id = EXCLUDED.provider_plan_id
     RETURNING ${PLAN_SELECT}`,
    [workspaceId, input.key, input.name, input.currency, input.feeMinor,
      input.billingPeriod, input.benefits, input.eligibilityNote ?? null,
      input.activeFrom ?? null, input.activeTo ?? null, input.published,
      input.provider ?? null, input.providerPlanId ?? null],
  )
  const plan = result.rows[0]
  const created = before.rows.length === 0
  return { record: plan, created }
}


export async function saveCrmEventRecord(client: PoolClient, workspaceId: string, input: EventInput, actorKind='system_job'): Promise<MutationResult> {
  const before = await client.query<{ id: string }>(
    `SELECT id FROM association_events WHERE workspace_id = $1 AND slug = $2`,
    [workspaceId, input.slug],
  )
  if(before.rows[0])await lockAssociationInventory(client,workspaceId,{eventIds:[before.rows[0].id]})
  const result = await client.query<DbRow>(
    `INSERT INTO association_events
       (workspace_id, slug, programme_key, title, description, starts_at,
        ends_at, timezone, mode, venue, online_url, registration_opens_at,
        registration_closes_at, capacity, status, canonical_url, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (workspace_id, slug) DO UPDATE SET
       programme_key = EXCLUDED.programme_key, title = EXCLUDED.title,
       description = EXCLUDED.description, starts_at = EXCLUDED.starts_at,
       ends_at = EXCLUDED.ends_at, timezone = EXCLUDED.timezone,
       mode = EXCLUDED.mode, venue = EXCLUDED.venue,
       online_url = EXCLUDED.online_url,
       registration_opens_at = EXCLUDED.registration_opens_at,
       registration_closes_at = EXCLUDED.registration_closes_at,
       capacity = EXCLUDED.capacity, status = EXCLUDED.status,
       canonical_url = EXCLUDED.canonical_url, metadata = EXCLUDED.metadata
     RETURNING ${EVENT_SELECT}`,
    [workspaceId, input.slug, input.programmeKey ?? null, input.title,
      input.description, input.startsAt, input.endsAt, input.timezone,
      input.mode, input.venue ?? null, input.onlineUrl ?? null,
      input.registrationOpensAt ?? null, input.registrationClosesAt ?? null,
      input.capacity ?? null, input.status, input.canonicalUrl ?? null,
      input.metadata],
  )
  const event = result.rows[0]
  await refreshAssociationInventory(client,workspaceId,[String(event.id)],actorKind)
  const created = before.rows.length === 0
  return { record: event, created }
}

export function createAssociationStore(pool: Pool = getPool()): AssociationStore {
  return {
    async linkExternalIdentity(workspaceId, input, actor) {
      return transaction(pool, async (client) => {
        await requirePerson(client, workspaceId, input.contactId)
        const inserted = await client.query<DbRow>(
          `INSERT INTO association_external_identities
             (workspace_id, contact_id, provider, provider_subject)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (workspace_id, provider, provider_subject) DO NOTHING
           RETURNING ${IDENTITY_SELECT}`,
          [workspaceId, input.contactId, input.provider, input.providerSubject],
        )
        if (inserted.rows[0]) {
          await audit(client, workspaceId, 'external_identity.linked', 'external_identity', String(inserted.rows[0].id), actor)
          return { record: inserted.rows[0], created: true }
        }
        const existing = await client.query<DbRow>(
          `SELECT ${IDENTITY_SELECT} FROM association_external_identities
            WHERE workspace_id = $1 AND provider = $2 AND provider_subject = $3`,
          [workspaceId, input.provider, input.providerSubject],
        )
        if (!existing.rows[0]) throw new AssociationError('conflict', 'provider identity could not be resolved after a concurrent link')
        if (existing.rows[0].contactId !== input.contactId) {
          throw new AssociationError('conflict', 'provider identity is already linked to another contact')
        }
        return { record: existing.rows[0], created: false }
      })
    },

    async resolveExternalIdentity(workspaceId, provider, providerSubject) {
      const result = await pool.query<DbRow>(
        `SELECT ${IDENTITY_SELECT} FROM association_external_identities
          WHERE workspace_id = $1 AND provider = $2 AND provider_subject = $3`,
        [workspaceId, provider, providerSubject],
      )
      return result.rows[0] ?? null
    },

    async createEnquiry(workspaceId, input, actor) {
      return transaction(pool, async (client) => {
        const fingerprint = associationFingerprint(input)
        await requirePerson(client, workspaceId, input.contactId)
        const inserted = await client.query<DbRow>(
          `INSERT INTO association_enquiries
             (workspace_id, contact_id, source, source_submission_id,
              request_fingerprint, subject, message, queue_key, submitted_at, submitted_data)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz, now()),$10)
           ON CONFLICT (workspace_id, source, source_submission_id) DO NOTHING
           RETURNING ${ENQUIRY_SELECT}`,
          [workspaceId, input.contactId, input.source, input.sourceSubmissionId,
            fingerprint, input.subject, input.message, input.queueKey,
            input.submittedAt ?? null, input.submittedData],
        )
        if (!inserted.rows[0]) {
          const existing = await client.query<DbRow>(
            `SELECT ${ENQUIRY_SELECT}, request_fingerprint AS "requestFingerprint"
               FROM association_enquiries
              WHERE workspace_id = $1 AND source = $2 AND source_submission_id = $3`,
            [workspaceId, input.source, input.sourceSubmissionId],
          )
          if (!existing.rows[0]) throw new AssociationError('conflict', 'enquiry could not be resolved after a concurrent submission')
          if (existing.rows[0].requestFingerprint !== fingerprint) {
            throw new AssociationError('conflict', 'source submission id was already used for a different enquiry')
          }
          const { requestFingerprint: _ignored, ...record } = existing.rows[0]
          return { record, created: false }
        }
        const enquiry = inserted.rows[0]
        await client.query(
          `INSERT INTO association_notification_outbox
             (workspace_id, source_kind, source_id, template_key,
              recipient_kind, recipient_ref, payload)
           VALUES
             ($1,'enquiry',$2,'enquiry_acknowledgement','contact',$3,$4),
             ($1,'enquiry',$2,'enquiry_staff_alert','queue',$5,$4)`,
          [workspaceId, enquiry.id, input.contactId,
            { enquiryId: enquiry.id, subject: input.subject }, input.queueKey],
        )
        await audit(client, workspaceId, 'enquiry.created', 'enquiry', String(enquiry.id), actor, {
          source: input.source,
          queueKey: input.queueKey,
        })
        return { record: enquiry, created: true }
      })
    },

    async listEnquiries(workspaceId, input) {
      const conditions = ['workspace_id = $1']
      const values: unknown[] = [workspaceId]
      if (input.status) {
        values.push(input.status)
        conditions.push(`status = $${values.length}`)
      }
      if (input.queueKey) {
        values.push(input.queueKey)
        conditions.push(`queue_key = $${values.length}`)
      }
      if (input.ownerUserId) {
        values.push(input.ownerUserId)
        conditions.push(`owner_user_id = $${values.length}`)
      }
      return page(pool, workspaceId, 'association.enquiries', input,
        `SELECT ${ENQUIRY_SELECT} FROM association_enquiries WHERE ${conditions.join(' AND ')}`, values)
    },

    async updateEnquiry(workspaceId, id, input, actor) {
      return transaction(pool, async (client) => {
        if (input.ownerUserId) await requireWorkspaceUser(client, workspaceId, input.ownerUserId)
        const result = await client.query<DbRow>(
          `UPDATE association_enquiries
              SET status = COALESCE($3, status),
                  queue_key = COALESCE($4, queue_key),
                  owner_user_id = CASE WHEN $5::boolean THEN $6::uuid ELSE owner_user_id END
            WHERE workspace_id = $1 AND id = $2
            RETURNING ${ENQUIRY_SELECT}`,
          [workspaceId, id, input.status ?? null, input.queueKey ?? null,
            Object.prototype.hasOwnProperty.call(input, 'ownerUserId'), input.ownerUserId ?? null],
        )
        const enquiry = result.rows[0]
        if (!enquiry) throw new AssociationError('not_found', 'enquiry not found')
        await audit(client, workspaceId, 'enquiry.updated', 'enquiry', id, actor, input)
        return enquiry
      })
    },

    async addEnquiryNote(workspaceId, enquiryId, input, actor) {
      return transaction(pool, async (client) => {
        const enquiry = await client.query(
          `SELECT 1 FROM association_enquiries WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, enquiryId],
        )
        if (!enquiry.rowCount) throw new AssociationError('not_found', 'enquiry not found')
        const result = await client.query<DbRow>(
          `INSERT INTO association_enquiry_notes
             (workspace_id, enquiry_id, body, actor_kind,
              actor_credential_id, acting_user_id)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${ENQUIRY_NOTE_SELECT}`,
          [workspaceId, enquiryId, input.body, actor.credentialKind,
            actor.credentialId, actor.actingUserId ?? null],
        )
        const note = result.rows[0]
        await audit(client, workspaceId, 'enquiry.note_added', 'enquiry', enquiryId, actor, {
          noteId: note.id,
        })
        return note
      })
    },

    async listEnquiryNotes(workspaceId, enquiryId) {
      const result = await pool.query<DbRow>(
        `SELECT ${ENQUIRY_NOTE_SELECT} FROM association_enquiry_notes
          WHERE workspace_id = $1 AND enquiry_id = $2
          ORDER BY created_at, id`,
        [workspaceId, enquiryId],
      )
      return result.rows
    },

    async appendConsent(workspaceId, input, actor) {
      return transaction(pool, async (client) => {
        const request: CrmEvidenceRequest = { kind: 'consent', contactId: input.contactId,
          purposeKey: input.purpose, action: input.action, wordingVersion: input.wordingVersion,
          locale: input.locale,
          source: input.source, occurredAt: input.occurredAt, metadata: input.metadata }
        const replay = () => client.query<DbRow>(
          `SELECT ${CONSENT_SELECT}, request_fingerprint AS "__requestHash",
                  to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "__occurredAt"
             FROM association_consent_events
            WHERE workspace_id=$1 AND provider=$2 AND provider_event_id=$3`,
          [workspaceId, input.provider, input.providerEventId],
        )
        if (input.provider && input.providerEventId) {
          const existing = await replay()
          if (existing.rows[0]) return { record: resolveCrmEvidenceReplay(existing.rows[0], request), created: false }
        }
        await requirePerson(client, workspaceId, input.contactId)
        const catalog = await client.query<DbRow>(
          `SELECT p.id AS "purposeId", p.archived_at AS "archivedAt", v.id AS "versionId",
            v.wording_snapshot AS wording, v.wording_hash AS "wordingHash", v.default_locale AS "defaultLocale",
            v.locale_wordings AS "localeWordings", v.locale_wording_hashes AS "localeWordingHashes"
           FROM crm_consent_purposes p LEFT JOIN crm_consent_purpose_versions v
             ON v.workspace_id=p.workspace_id AND v.purpose_id=p.id AND v.version=$3
           WHERE p.workspace_id=$1 AND p.purpose_key=$2`, [workspaceId,input.purpose,input.wordingVersion])
        const purpose = catalog.rows[0]
        if (purpose && (purpose.archivedAt || !purpose.versionId)) {
          throw new AssociationError('conflict', 'Consent purpose or wording version is unavailable.')
        }
        if (!purpose && input.locale) throw new AssociationError('conflict', 'Localized consent requires a catalogued wording version.')
        const localized = input.locale ? (purpose?.localeWordings as Record<string, string> | undefined)?.[input.locale] : undefined
        const result = await client.query<DbRow>(
          `INSERT INTO association_consent_events
             (workspace_id, contact_id, purpose, action, wording_version, source,
              occurred_at, provider, provider_event_id, metadata, request_fingerprint,
              purpose_id,wording_version_id,wording_snapshot,wording_hash,wording_locale)
           VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, now()),$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (workspace_id, provider, provider_event_id)
             WHERE provider IS NOT NULL DO NOTHING
           RETURNING ${CONSENT_SELECT}`,
          [workspaceId, input.contactId, input.purpose, input.action,
            input.wordingVersion, input.source, input.occurredAt ?? null,
            input.provider ?? null, input.providerEventId ?? null, input.metadata,
            input.provider ? crmEvidenceRequestHash(request) : null,
            purpose?.purposeId ?? null, purpose?.versionId ?? null, localized ?? purpose?.wording ?? null,
            localized ? (purpose!.localeWordingHashes as Record<string,string>)[input.locale!] : purpose?.wordingHash ?? null,
            localized ? input.locale : purpose?.defaultLocale ?? null],
        )
        if (!result.rows[0] && input.provider && input.providerEventId) {
          const raced = await replay()
          if (!raced.rows[0]) throw new AssociationError('conflict', 'consent event could not be resolved after a concurrent submission')
          return { record: resolveCrmEvidenceReplay(raced.rows[0], request), created: false }
        }
        const consent = result.rows[0]
        await audit(client, workspaceId, `consent.${input.action}`, 'consent_event', String(consent.id), actor, {
          contactId: input.contactId, purpose: input.purpose, wordingVersion: input.wordingVersion,
        })
        return { record: consent, created: true }
      })
    },

    async listConsents(workspaceId, contactId) {
      const result = await pool.query<DbRow>(
        `SELECT ${CONSENT_SELECT} FROM association_consent_events
          WHERE workspace_id = $1 AND contact_id = $2
          ORDER BY occurred_at DESC, created_at DESC, id DESC`,
        [workspaceId, contactId],
      )
      const effective: Record<string, string> = {}
      for (const event of result.rows) {
        const purpose = String(event.purpose)
        if (!(purpose in effective)) effective[purpose] = String(event.action)
      }
      return { events: result.rows, effective }
    },

    async upsertPlan(workspaceId, input, actor) {
      return transaction(pool, async (client) => {
        const saved = await saveCrmEntitlementPlanRecord(client, workspaceId, input)
        await audit(client, workspaceId, saved.created ? 'plan.created' : 'plan.updated', 'membership_plan', String(saved.record.id), actor)
        return saved
      })
    },

    async listPlans(workspaceId, input) {
      const conditions = ['workspace_id = $1']
      const values: unknown[] = [workspaceId]
      if (input.published !== undefined) {
        values.push(input.published)
        conditions.push(`published = $${values.length}`)
      }
      return page(pool, workspaceId, 'association.plans', input,
        `SELECT ${PLAN_SELECT} FROM association_membership_plans WHERE ${conditions.join(' AND ')}`, values)
    },

    async createMembership(workspaceId, input, actor) {
      return transaction(pool, async (client) => {
        const integration = await lockIntegrationActor(client, workspaceId, actor)
        authorizeIntegration(actor, 'crm.entitlements.write', { planIds: input.planId }, integration)
        if (input.provider) {
          requireProviderEntitlementActor(actor, input.provider)
          authorizeIntegration(actor, 'association.provider_events.write', { providerKeys: input.provider }, integration)
        }
        const period = await prepareProviderEntitlementPeriod(client, workspaceId, { ...input, providerEntitlementId: input.providerMembershipId })
        const fingerprint = period?.requestHash ?? associationFingerprint(input)
        const existing = await client.query<DbRow>(
          `SELECT ${MEMBERSHIP_SELECT}, m.request_fingerprint AS "requestFingerprint"
             FROM association_memberships m
             JOIN association_membership_plans p
               ON p.workspace_id = m.workspace_id AND p.id = m.plan_id
            WHERE m.workspace_id = $1 AND (m.idempotency_key = $2 OR m.id=$3) ORDER BY (m.idempotency_key=$2) DESC FOR UPDATE OF m`,
          [workspaceId, input.idempotencyKey, period?.existingId ?? null],
        )
        if (existing.rows[0]) {
          if (existing.rows[0].requestFingerprint !== fingerprint) {
            throw new AssociationError('conflict', 'idempotency key was already used for a different membership')
          }
          const { requestFingerprint: _ignored, ...record } = existing.rows[0]
          return { record, created: false }
        }
        await requirePerson(client, workspaceId, input.contactId)
        const plan = await client.query(
          `SELECT 1 FROM association_membership_plans WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, input.planId],
        )
        if (!plan.rowCount) throw new AssociationError('not_found', 'membership plan not found')
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO association_memberships
             (workspace_id, contact_id, plan_id, idempotency_key,
              request_fingerprint, status, starts_at, ends_at, renewal_mode,
              provider, provider_membership_id, provider_period_id, predecessor_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
           RETURNING id`,
          [workspaceId, input.contactId, input.planId, input.idempotencyKey,
            fingerprint, input.status, input.startsAt, input.endsAt ?? null,
            input.renewalMode, input.provider ?? null, input.providerMembershipId ?? null, input.providerPeriodId ?? null, input.predecessorId ?? null],
        )
        if (!inserted.rows[0]) {
          const raced = await client.query<DbRow>(
            `SELECT ${MEMBERSHIP_SELECT}, m.request_fingerprint AS "requestFingerprint"
               FROM association_memberships m
               JOIN association_membership_plans p
                 ON p.workspace_id = m.workspace_id AND p.id = m.plan_id
              WHERE m.workspace_id = $1 AND m.idempotency_key = $2`,
            [workspaceId, input.idempotencyKey],
          )
          if (!raced.rows[0]) throw new AssociationError('conflict', 'membership could not be resolved after a concurrent submission')
          if (raced.rows[0].requestFingerprint !== fingerprint) {
            throw new AssociationError('conflict', 'idempotency key was already used for a different membership')
          }
          const { requestFingerprint: _ignored, ...record } = raced.rows[0]
          return { record, created: false }
        }
        const membership = await client.query<DbRow>(
          `SELECT ${MEMBERSHIP_SELECT} FROM association_memberships m
             JOIN association_membership_plans p
               ON p.workspace_id = m.workspace_id AND p.id = m.plan_id
            WHERE m.workspace_id = $1 AND m.id = $2`,
          [workspaceId, inserted.rows[0].id],
        )
        await audit(client, workspaceId, 'membership.created', 'membership', inserted.rows[0].id, actor, {
          contactId: input.contactId,
          planId: input.planId,
          status: input.status,
        })
        return { record: membership.rows[0], created: true }
      })
    },

    async listMemberships(workspaceId, contactId, filters = {}) {
      const input = CrmEffectiveEntitlementQuerySchema.parse(filters)
      const at = 'coalesce($4::timestamptz,statement_timestamp())'
      const result = await pool.query<DbRow>(
        `SELECT ${MEMBERSHIP_SELECT},
             crm_entitlement_is_effective(m.status,m.starts_at,m.ends_at,${at}) AS "isEffective",
             to_char(${at} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "effectiveAt"
           FROM association_memberships m JOIN association_membership_plans p
             ON p.workspace_id=m.workspace_id AND p.id=m.plan_id
          WHERE m.workspace_id=$1 AND m.contact_id=$2
            AND (NOT $3::boolean OR crm_entitlement_is_effective(m.status,m.starts_at,m.ends_at,${at}))
          ORDER BY m.created_at DESC,m.id DESC`,
        [workspaceId, contactId, input.activeOnly ?? false, input.effectiveAt ? crmPageInstant(input.effectiveAt) : null],
      )
      return result.rows
    },

    async updateMembership(workspaceId, id, input, actor) {
      return transaction(pool, async (client) => {
        const integration = await lockIntegrationActor(client, workspaceId, actor)
        const current = await client.query<{ starts_at: Date; status: string; plan_id: string; provider: string | null }>(
          `SELECT starts_at,status,plan_id,provider FROM association_memberships
            WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
          [workspaceId, id],
        )
        if (!current.rows[0]) throw new AssociationError('not_found', 'membership not found')
        const membership = current.rows[0]
        authorizeIntegration(actor, 'crm.entitlements.write', { planIds: membership.plan_id }, integration)
        if (membership.provider) {
          requireProviderEntitlementActor(actor, membership.provider)
          authorizeIntegration(actor, 'association.provider_events.write', { providerKeys: membership.provider }, integration)
        }
        if (input.status && !mayTransitionCrmEntitlement(membership.status, input.status)) {
          throw new AssociationError('invalid_transition', 'Terminal membership cannot be revived; renew with a new period.')
        }
        if (input.endsAt && new Date(input.endsAt) <= current.rows[0].starts_at) {
          throw new AssociationError('conflict', 'endsAt must be after startsAt')
        }
        await client.query(
          `UPDATE association_memberships
              SET status = COALESCE($3, status),
                  ends_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE ends_at END,
                  renewal_mode = COALESCE($6, renewal_mode)
            WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, id, input.status ?? null,
            Object.prototype.hasOwnProperty.call(input, 'endsAt'), input.endsAt ?? null,
            input.renewalMode ?? null],
        )
        const result = await client.query<DbRow>(
          `SELECT ${MEMBERSHIP_SELECT} FROM association_memberships m
             JOIN association_membership_plans p
               ON p.workspace_id = m.workspace_id AND p.id = m.plan_id
            WHERE m.workspace_id = $1 AND m.id = $2`,
          [workspaceId, id],
        )
        await audit(client, workspaceId, 'membership.updated', 'membership', id, actor, input)
        return result.rows[0]
      })
    },

    async upsertEvent(workspaceId, input, actor) {
      return transaction(pool, async (client) => {
        const saved = await saveCrmEventRecord(client, workspaceId, input, actor.credentialKind)
        await audit(client, workspaceId, saved.created ? 'event.created' : 'event.updated', 'event', String(saved.record.id), actor)
        return saved
      })
    },

    async listEvents(workspaceId, input) {
      const conditions = ['workspace_id = $1']
      const values: unknown[] = [workspaceId]
      if (input.status) {
        values.push(input.status)
        conditions.push(`status = $${values.length}`)
      }
      return page(pool, workspaceId, 'association.events', input,
        `SELECT ${EVENT_SELECT} FROM association_events WHERE ${conditions.join(' AND ')}`, values)
    },

    async upsertTicket(workspaceId, eventId, input, actor) {
      return transaction(pool, async (client) => {
        const integration = await lockIntegrationActor(client, workspaceId, actor)
        const module = await lockAssociationModule(client, workspaceId)
        requireAssociationAdmission(module)
        authorizeIntegration(actor, 'crm.catalog.configure', { eventIds: eventId }, integration)
        await lockAssociationInventory(client,workspaceId,{eventIds:[eventId]})
        const event = await client.query(
          `SELECT 1 FROM association_events WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, eventId],
        )
        if (!event.rowCount) throw new AssociationError('not_found', 'event not found')
        if (input.eligiblePlanKeys.length > 0) {
          const plans = await client.query<{ id: string; plan_key: string }>(
            `SELECT id,plan_key FROM association_membership_plans
              WHERE workspace_id = $1 AND plan_key = ANY($2::text[])`,
            [workspaceId, input.eligiblePlanKeys],
          )
          const found = new Set(plans.rows.map((plan) => plan.plan_key))
          const missing = input.eligiblePlanKeys.filter((key) => !found.has(key))
          if (missing.length > 0) {
            throw new AssociationError('not_found', 'one or more eligible membership plan keys do not exist', { missing })
          }
          authorizeIntegration(actor, 'crm.catalog.configure', { planIds: plans.rows.map((plan) => plan.id) }, integration)
        }
        const before = await client.query<{ id: string }>(
          `SELECT id FROM association_ticket_types WHERE workspace_id = $1 AND event_id = $2 AND ticket_key = $3`,
          [workspaceId, eventId, input.key],
        )
        const result = await client.query<DbRow>(
          `INSERT INTO association_ticket_types
             (workspace_id, event_id, ticket_key, name, currency, price_minor,
              member_price_minor, eligible_plan_keys, capacity, per_order_limit,
              sale_starts_at, sale_ends_at, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (event_id, ticket_key) DO UPDATE SET
             name = EXCLUDED.name, currency = EXCLUDED.currency,
             price_minor = EXCLUDED.price_minor,
             member_price_minor = EXCLUDED.member_price_minor,
             eligible_plan_keys = EXCLUDED.eligible_plan_keys,
             capacity = EXCLUDED.capacity, per_order_limit = EXCLUDED.per_order_limit,
             sale_starts_at = EXCLUDED.sale_starts_at,
             sale_ends_at = EXCLUDED.sale_ends_at, status = EXCLUDED.status
           RETURNING id`,
          [workspaceId, eventId, input.key, input.name, input.currency,
            input.priceMinor, input.memberPriceMinor ?? null, input.eligiblePlanKeys,
            input.capacity ?? null, input.perOrderLimit, input.saleStartsAt ?? null,
            input.saleEndsAt ?? null, input.status],
        )
        const tickets = await client.query<DbRow>(
          `SELECT ${TICKET_SELECT}
             FROM association_ticket_types t
             LEFT JOIN LATERAL (
               SELECT count(*)::int AS reserved_count FROM association_registrations r
                WHERE r.workspace_id = t.workspace_id AND r.ticket_id = t.id
                  AND NOT r.historical_import AND (r.status IN ('confirmed','checked_in','registered','attended')
                    OR (r.status = 'reserved' AND r.reservation_expires_at > statement_timestamp()))
             ) i ON true
            WHERE t.workspace_id = $1 AND t.id = $2`,
          [workspaceId, result.rows[0].id],
        )
        const created = before.rows.length === 0
        await refreshAssociationInventory(client,workspaceId,[eventId],actor.credentialKind)
        await audit(client, workspaceId, created ? 'ticket.created' : 'ticket.updated', 'ticket', String(result.rows[0].id), actor, { eventId })
        return { record: tickets.rows[0], created }
      })
    },

    async listTickets(workspaceId, eventId) {
      const result = await pool.query<DbRow>(
        `SELECT ${TICKET_SELECT}
           FROM association_ticket_types t
           LEFT JOIN LATERAL (
             SELECT count(*)::int AS reserved_count FROM association_registrations r
              WHERE r.workspace_id = t.workspace_id AND r.ticket_id = t.id
                AND NOT r.historical_import AND (r.status IN ('confirmed','checked_in','registered','attended')
                  OR (r.status = 'reserved' AND r.reservation_expires_at > statement_timestamp()))
           ) i ON true
          WHERE t.workspace_id = $1 AND t.event_id = $2
          ORDER BY t.created_at, t.id`,
        [workspaceId, eventId],
      )
      return result.rows
    },

    async createOrder(workspaceId, input, actor) {
      return transaction(pool, async (client) => {
        const integration = await lockIntegrationActor(client, workspaceId, actor)
        const module = await lockAssociationModule(client, workspaceId)
        const fingerprint = associationFingerprint(input)
        const existing = await client.query<DbRow>(
          `SELECT id, request_fingerprint AS "requestFingerprint"
             FROM association_orders
            WHERE workspace_id = $1 AND idempotency_key = $2 FOR UPDATE`,
          [workspaceId, input.idempotencyKey],
        )
        if (existing.rows[0]) {
          await authorizeOrderIntegration(client, workspaceId, String(existing.rows[0].id), actor, 'association.orders.write', undefined, integration)
          if (existing.rows[0].requestFingerprint !== fingerprint) {
            throw new AssociationError('conflict', 'idempotency key was already used for a different order')
          }
          const record = await getOrderRecord(client, workspaceId, String(existing.rows[0].id))
          return { record: record!, created: false }
        }
        requireAssociationAdmission(module)
        await requirePerson(client, workspaceId, input.contactId)
        const ticketIds = input.lines.map((line) => line.ticketId)
        const inventoryEvents=await lockAssociationInventory(client,workspaceId,{ticketIds})
        const lockedMemberships = input.lines.some(line => line.useMemberPrice)
          ? (await client.query<{ id: string }>(`SELECT id FROM association_memberships
              WHERE workspace_id=$1 AND contact_id=$2 AND status='active' ORDER BY id FOR SHARE`,
            [workspaceId, input.contactId])).rows.map(row => row.id) : []
        const admittedAt=(await client.query<{instant:string}>('SELECT clock_timestamp()::text instant')).rows[0].instant
        const ticketsResult = await client.query<{
          id: string
          event_id: string
          currency: string
          price_minor: string
          member_price_minor: string | null
          eligible_plan_keys: string[]
          capacity: number | null
          per_order_limit: number
          sale_starts_at: Date | null
          sale_ends_at: Date | null
          status: string
          admissible: boolean
          event_status: string
          event_capacity: number | null
          registration_opens_at: Date | null
          registration_closes_at: Date | null
        }>(
          `SELECT t.id, t.event_id, t.currency, t.price_minor::text,
                  t.member_price_minor::text, t.eligible_plan_keys, t.capacity,
                  t.per_order_limit, t.sale_starts_at, t.sale_ends_at, t.status,
                  e.status AS event_status, e.capacity AS event_capacity,
                  e.registration_opens_at, e.registration_closes_at,
                  (t.status='on_sale' AND e.status='published' AND e.ends_at>$3::timestamptz
                    AND(t.sale_starts_at IS NULL OR t.sale_starts_at<=$3::timestamptz)
                    AND(t.sale_ends_at IS NULL OR t.sale_ends_at>$3::timestamptz)
                    AND(e.registration_opens_at IS NULL OR e.registration_opens_at<=$3::timestamptz)
                    AND(e.registration_closes_at IS NULL OR e.registration_closes_at>$3::timestamptz)) AS admissible
             FROM association_ticket_types t
             JOIN association_events e
               ON e.workspace_id = t.workspace_id AND e.id = t.event_id
            WHERE t.workspace_id = $1 AND t.id = ANY($2::uuid[])
            ORDER BY t.id`,
          [workspaceId, ticketIds, admittedAt],
        )
        if (ticketsResult.rows.length !== ticketIds.length) {
          throw new AssociationError('not_found', 'one or more ticket types were not found')
        }
        authorizeIntegration(actor, 'association.orders.write', { eventIds: ticketsResult.rows.map((ticket) => ticket.event_id) }, integration)
        // A concurrent retry with the same request blocks on the same ticket
        // locks. Re-check after acquiring them so the loser returns the
        // winner's order instead of reserving inventory twice or surfacing a
        // unique-index error.
        const racedOrder = await client.query<DbRow>(
          `SELECT id, request_fingerprint AS "requestFingerprint"
             FROM association_orders
            WHERE workspace_id = $1 AND idempotency_key = $2`,
          [workspaceId, input.idempotencyKey],
        )
        if (racedOrder.rows[0]) {
          if (racedOrder.rows[0].requestFingerprint !== fingerprint) {
            throw new AssociationError('conflict', 'idempotency key was already used for a different order')
          }
          return {
            record: (await getOrderRecord(client, workspaceId, String(racedOrder.rows[0].id)))!,
            created: false,
          }
        }
        const tickets = new Map(ticketsResult.rows.map((ticket) => [ticket.id, ticket]))
        const currencies = new Set(ticketsResult.rows.map((ticket) => ticket.currency))
        if (currencies.size !== 1) throw new AssociationError('conflict', 'one order cannot mix currencies')

        const inventory = await client.query<{ ticket_id: string; event_id: string; used: number }>(
          `SELECT ticket_id, event_id, count(*)::int AS used
             FROM association_registrations
            WHERE workspace_id = $1
              AND NOT historical_import AND (status IN ('confirmed','checked_in','registered','attended')
                OR (status = 'reserved' AND reservation_expires_at > $4::timestamptz))
              AND (ticket_id = ANY($2::uuid[]) OR event_id = ANY($3::uuid[]))
            GROUP BY ticket_id, event_id`,
          [workspaceId, ticketIds, inventoryEvents, admittedAt],
        )
        const ticketUsed = new Map<string, number>()
        const eventUsed = new Map<string, number>()
        for (const row of inventory.rows) {
          ticketUsed.set(row.ticket_id, (ticketUsed.get(row.ticket_id) ?? 0) + row.used)
          eventUsed.set(row.event_id, (eventUsed.get(row.event_id) ?? 0) + row.used)
        }
        const requestedByEvent = new Map<string, number>()
        for (const line of input.lines) {
          const ticket = tickets.get(line.ticketId)!
          requestedByEvent.set(ticket.event_id, (requestedByEvent.get(ticket.event_id) ?? 0) + line.quantity)
        }

        for (const line of input.lines) {
          const ticket = tickets.get(line.ticketId)!
          if (!ticket.admissible) {
            throw new AssociationError('not_available', 'ticket is not currently on sale', { ticketId: line.ticketId })
          }
          if (line.quantity > ticket.per_order_limit) {
            throw new AssociationError('not_available', 'ticket quantity exceeds its per-order limit', { ticketId: line.ticketId })
          }
          if (ticket.capacity !== null && (ticketUsed.get(ticket.id) ?? 0) + line.quantity > ticket.capacity) {
            throw new AssociationError('not_available', 'ticket capacity is exhausted', { ticketId: line.ticketId })
          }
          if (ticket.event_capacity !== null
            && (eventUsed.get(ticket.event_id) ?? 0) + (requestedByEvent.get(ticket.event_id) ?? 0) > ticket.event_capacity) {
            throw new AssociationError('not_available', 'event capacity is exhausted', { eventId: ticket.event_id })
          }
        }

        const pricedLines: Array<{
          input: OrderCreateInput['lines'][number]
          ticket: (typeof ticketsResult.rows)[number]
          unitPrice: number
          publicPrice: number
          membershipId: string | null
        }> = []
        for (const line of input.lines) {
          const ticket = tickets.get(line.ticketId)!
          const publicPrice = Number(ticket.price_minor)
          let membershipId: string | null = null
          let unitPrice = publicPrice
          if (line.useMemberPrice) {
            if (ticket.member_price_minor === null) {
              throw new AssociationError('member_price_ineligible', 'ticket has no member price', { ticketId: line.ticketId })
            }
            const eligibility = await client.query<{ id: string }>(
              `SELECT m.id FROM association_memberships m
                 JOIN association_membership_plans p
                   ON p.workspace_id = m.workspace_id AND p.id = m.plan_id
                WHERE m.workspace_id = $1 AND m.contact_id = $2
                  AND m.id=ANY($4::uuid[])
                  AND crm_entitlement_is_effective(m.status,m.starts_at,m.ends_at,clock_timestamp())
                  AND (cardinality($3::text[]) = 0 OR p.plan_key = ANY($3::text[]))
                ORDER BY m.starts_at DESC LIMIT 1`,
              [workspaceId, input.contactId, ticket.eligible_plan_keys, lockedMemberships],
            )
            membershipId = eligibility.rows[0]?.id ?? null
            if (!membershipId) {
              throw new AssociationError('member_price_ineligible', 'contact has no eligible active membership', { ticketId: line.ticketId })
            }
            unitPrice = Number(ticket.member_price_minor)
          }
          pricedLines.push({ input: line, ticket, unitPrice, publicPrice, membershipId })
        }
        const subtotal = pricedLines.reduce((sum, line) => sum + line.publicPrice * line.input.quantity, 0)
        const total = pricedLines.reduce((sum, line) => sum + line.unitPrice * line.input.quantity, 0)
        const discount = subtotal - total
        const reservationExpiresAt=(await client.query<{deadline:string}>(
          "SELECT ($1::timestamptz+$2::integer*interval '1 minute')::text deadline",[admittedAt,input.reservationMinutes])).rows[0].deadline
        const orderResult = await client.query<{ id: string }>(
          `INSERT INTO association_orders
             (workspace_id, contact_id, idempotency_key, request_fingerprint,
              status, currency, subtotal_minor, discount_minor, total_minor,
              reservation_expires_at, metadata)
           VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10) RETURNING id`,
          [workspaceId, input.contactId, input.idempotencyKey, fingerprint,
            [...currencies][0], subtotal, discount, total, reservationExpiresAt,
            input.metadata],
        )
        const orderId = orderResult.rows[0].id
        for (const priced of pricedLines) {
          const lineTotal = priced.unitPrice * priced.input.quantity
          const lineDiscount = (priced.publicPrice - priced.unitPrice) * priced.input.quantity
          const lineResult = await client.query<{ id: string }>(
            `INSERT INTO association_order_lines
               (workspace_id, order_id, ticket_id, quantity, unit_price_minor,
                discount_minor, line_total_minor, pricing_basis, eligible_membership_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [workspaceId, orderId, priced.ticket.id, priced.input.quantity,
              priced.unitPrice, lineDiscount, lineTotal,
              priced.membershipId ? 'member' : 'public', priced.membershipId],
          )
          for (const [attendeeIndex, attendee] of priced.input.attendees.entries()) {
            if (attendee.contactId) await requirePerson(client, workspaceId, attendee.contactId)
            await client.query(
              `INSERT INTO association_registrations
                 (workspace_id, order_id, order_line_id, event_id, ticket_id,
                  attendee_contact_id, attendee_name, attendee_email,
                  attendee_metadata, status, reservation_expires_at,
                  source_kind, source_id, request_fingerprint)
               VALUES ($1,$2,$3::uuid,$4,$5,$6,$7,$8,$9,'reserved',$10,'commerce',$3::text,$11)`,
              [workspaceId, orderId, lineResult.rows[0].id, priced.ticket.event_id,
                priced.ticket.id, attendee.contactId ?? null, attendee.name,
                attendee.email ?? null, attendee.metadata, reservationExpiresAt,
                associationFingerprint({ order: fingerprint, ticketId: priced.ticket.id, attendeeIndex })],
            )
          }
        }
        await refreshAssociationInventory(client,workspaceId,inventoryEvents,actor.credentialKind)
        await audit(client, workspaceId, 'order.reserved', 'order', orderId, actor, {
          contactId: input.contactId,
          totalMinor: total,
          currency: [...currencies][0],
        })
        return { record: (await getOrderRecord(client, workspaceId, orderId))!, created: true }
      })
    },

    async getOrder(workspaceId, id, actor) {
      const client = await pool.connect()
      try {
        if (actor) await authorizeOrderIntegration(client, workspaceId, id, actor, 'association.read')
        return await getOrderRecord(client, workspaceId, id)
      } finally {
        client.release()
      }
    },

    async listOrders(workspaceId, input) {
      const conditions = ['workspace_id=$1']
      const values: unknown[] = [workspaceId]
      if (input.status) { values.push(input.status); conditions.push(`status=$${values.length}`) }
      if (input.contactId) { values.push(input.contactId); conditions.push(`contact_id=$${values.length}`) }
      if (input.eventId) {
        values.push(input.eventId)
        conditions.push(`EXISTS (SELECT 1 FROM association_order_lines l JOIN association_ticket_types t ON t.workspace_id=l.workspace_id AND t.id=l.ticket_id
          WHERE l.workspace_id=$1 AND l.order_id=association_orders.id AND t.event_id=$${values.length})`)
      }
      if (input.allowedEventIds) {
        values.push([...input.allowedEventIds].sort())
        conditions.push(`EXISTS (SELECT 1 FROM association_order_lines l WHERE l.workspace_id=$1 AND l.order_id=association_orders.id)`)
        conditions.push(`NOT EXISTS (SELECT 1 FROM association_order_lines l JOIN association_ticket_types t ON t.workspace_id=l.workspace_id AND t.id=l.ticket_id
          WHERE l.workspace_id=$1 AND l.order_id=association_orders.id AND NOT (t.event_id=ANY($${values.length}::uuid[])))`)
      }
      const count = await pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM association_orders WHERE ${conditions.join(' AND ')}`, values)
      const result = await page(pool, workspaceId, 'association.orders', input,
        `SELECT ${ORDER_SELECT} FROM association_orders WHERE ${conditions.join(' AND ')}`, values)
      return { ...result, total: count.rows[0].total }
    },

    expireDueOrder: (workspaceId,id,actor)=>settleWithoutProvider(pool,workspaceId,id,actor,'expire'),
    cancelOrder: (workspaceId, id, actor) => settleWithoutProvider(pool, workspaceId, id, actor, 'cancel'),
    confirmFreeOrder: (workspaceId, id, actor) => settleWithoutProvider(pool, workspaceId, id, actor, 'confirm_free'),

    async reconcileProviderEvent(workspaceId, orderId, input, actor) {
      return transaction(pool, async (client) => {
        const integration = await lockIntegrationActor(client, workspaceId, actor)
        await lockAssociationModule(client, workspaceId)
        await authorizeOrderIntegration(client, workspaceId, orderId, actor, 'association.provider_events.write', input.provider, integration)
        const inventoryEvents=await lockAssociationInventory(client,workspaceId,{orderId})
        const replay = await client.query<{
          order_id: string
          target_status: OrderStatus
        }>(
          `SELECT order_id, target_status FROM association_provider_events
            WHERE workspace_id = $1 AND provider = $2 AND provider_event_id = $3`,
          [workspaceId, input.provider, input.eventId],
        )
        if (replay.rows[0]) {
          if (replay.rows[0].order_id !== orderId || replay.rows[0].target_status !== input.targetStatus) {
            throw new AssociationError('conflict', 'provider event id was already used for a different transition')
          }
          return { record: (await getOrderRecord(client, workspaceId, orderId))!, created: false }
        }
        const orderResult = await client.query<{
          status: OrderStatus
          reservation_expires_at: Date | null
        }>(
          `SELECT status, reservation_expires_at FROM association_orders
            WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
          [workspaceId, orderId],
        )
        const order = orderResult.rows[0]
        if (!order) throw new AssociationError('not_found', 'order not found')
        const racedEvent = await client.query<{
          order_id: string
          target_status: OrderStatus
        }>(
          `SELECT order_id, target_status FROM association_provider_events
            WHERE workspace_id = $1 AND provider = $2 AND provider_event_id = $3`,
          [workspaceId, input.provider, input.eventId],
        )
        if (racedEvent.rows[0]) {
          if (racedEvent.rows[0].order_id !== orderId || racedEvent.rows[0].target_status !== input.targetStatus) {
            throw new AssociationError('conflict', 'provider event id was already used for a different transition')
          }
          return { record: (await getOrderRecord(client, workspaceId, orderId))!, created: false }
        }
        if (!mayTransitionOrder(order.status, input.targetStatus)) {
          throw new AssociationError('invalid_transition', `order cannot transition from ${order.status} to ${input.targetStatus}`)
        }
        if (order.status === 'pending' && input.targetStatus === 'paid'
          && !(await client.query<{unexpired:boolean}>('SELECT reservation_expires_at>clock_timestamp() unexpired FROM association_orders WHERE workspace_id=$1 AND id=$2',[workspaceId,orderId])).rows[0]?.unexpired) {
          throw new AssociationError(
            'not_available',
            'the order reservation expired before payment confirmation; manual reconciliation is required',
          )
        }
        await client.query(
          `INSERT INTO association_provider_events
             (workspace_id, order_id, provider, provider_event_id, target_status,
              provider_reference, occurred_at, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [workspaceId, orderId, input.provider, input.eventId, input.targetStatus,
            input.providerReference ?? null, input.occurredAt, input.metadata],
        )
        await client.query(
          `UPDATE association_orders SET status = $3, provider = $4,
                  provider_reference = COALESCE($5, provider_reference),
                  reservation_expires_at = CASE WHEN $3 = 'pending' THEN reservation_expires_at ELSE NULL END
            WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, orderId, input.targetStatus, input.provider,
            input.providerReference ?? null],
        )
        const registrationStatus = input.targetStatus === 'paid' ? 'confirmed'
          : input.targetStatus === 'refunded' ? 'refunded' : 'cancelled'
        await client.query(
          `UPDATE association_registrations
              SET status = $3,
                  reservation_expires_at = NULL
            WHERE workspace_id = $1 AND order_id = $2
              AND status IN ('reserved','confirmed')`,
          [workspaceId, orderId, registrationStatus],
        )
        if (input.targetStatus === 'paid') {
          const orderContact = await client.query<{ contact_id: string }>(
            `SELECT contact_id FROM association_orders WHERE workspace_id = $1 AND id = $2`,
            [workspaceId, orderId],
          )
          await client.query(
            `INSERT INTO association_notification_outbox
               (workspace_id, source_kind, source_id, template_key,
                recipient_kind, recipient_ref, payload)
             VALUES
               ($1,'order',$2,'order_receipt','contact',$3,$4),
               ($1,'order',$2,'order_paid_staff_alert','queue','registrations',$4)
             ON CONFLICT DO NOTHING`,
            [workspaceId, orderId, orderContact.rows[0].contact_id, { orderId }],
          )
        }
        await refreshAssociationInventory(client,workspaceId,inventoryEvents,actor.credentialKind)
        await audit(client, workspaceId, `order.${input.targetStatus}`, 'order', orderId, actor, {
          provider: input.provider,
          providerEventId: input.eventId,
          from: order.status,
          to: input.targetStatus,
        })
        return { record: (await getOrderRecord(client, workspaceId, orderId))!, created: true }
      })
    },

    async listEventRegistrations(workspaceId, eventId, input) {
      const event = await pool.query(
        `SELECT 1 FROM association_events WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, eventId],
      )
      if (!event.rowCount) throw new AssociationError('not_found', 'event not found')
      const conditions = ['workspace_id = $1', 'event_id = $2']
      const values: unknown[] = [workspaceId, eventId]
      if (input.status) {
        values.push(input.status)
        conditions.push(`status = $${values.length}`)
      }
      return page(pool, workspaceId, 'association.registrations', input,
        `SELECT ${REGISTRATION_SELECT} FROM association_registrations WHERE ${conditions.join(' AND ')}`, values)
    },

    async getRegistrationManagement(workspaceId, id) {
      const result = await pool.query<{ sourceKind: string; eventId: string }>(
        `SELECT source_kind AS "sourceKind",event_id AS "eventId" FROM association_registrations
          WHERE workspace_id=$1 AND id=$2`,
        [workspaceId, id],
      )
      return result.rows[0] ?? null
    },

    async updateRegistration(workspaceId, id, input, actor) {
      return transaction(pool, async (client) => {
        const integration = await lockIntegrationActor(client, workspaceId, actor)
        await lockAssociationModule(client, workspaceId)
        if (actor.integration || actor.credentialKind === 'integration_key') {
          const resource = await client.query<{ event_id: string }>('SELECT event_id FROM association_registrations WHERE workspace_id=$1 AND id=$2', [workspaceId, id])
          authorizeIntegration(actor, 'association.orders.write', { eventIds: resource.rows.map((row) => row.event_id) }, integration)
        }
        const inventoryEvents=await lockAssociationInventory(client,workspaceId,{registrationId:id})
        const current = await client.query<{ status: RegistrationStatus; source_kind: string }>(
          `SELECT status,source_kind FROM association_registrations
            WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
          [workspaceId, id],
        )
        const registration = current.rows[0]
        if (!registration) throw new AssociationError('not_found', 'registration not found')
        if (registration.source_kind !== 'commerce') throw new AssociationError('invalid_transition', 'Non-commerce participation uses CRM participation commands.')
        if (!mayTransitionRegistration(registration.status, input.status)) {
          throw new AssociationError(
            'invalid_transition',
            `registration cannot transition from ${registration.status} to ${input.status}`,
          )
        }
        const result = await client.query<DbRow>(
          `UPDATE association_registrations
              SET status = $3,
                  reservation_expires_at = CASE WHEN $3 = 'cancelled' THEN NULL ELSE reservation_expires_at END,
                  checked_in_at = CASE WHEN $3 = 'checked_in' THEN now() ELSE checked_in_at END
            WHERE workspace_id = $1 AND id = $2
            RETURNING ${REGISTRATION_SELECT}`,
          [workspaceId, id, input.status],
        )
        await refreshAssociationInventory(client,workspaceId,inventoryEvents,actor.credentialKind)
        await audit(client, workspaceId, `registration.${input.status}`, 'registration', id, actor, {
          from: registration.status,
          to: input.status,
        })
        return result.rows[0]
      })
    },

    async listNotifications(workspaceId, input) {
      const conditions = ['workspace_id = $1']
      const values: unknown[] = [workspaceId]
      if (input.status) {
        values.push(input.status)
        conditions.push(`status = $${values.length}`)
      }
      return page(pool, workspaceId, 'association.notifications', input,
        `SELECT ${NOTIFICATION_SELECT} FROM association_notification_outbox WHERE ${conditions.join(' AND ')}`, values)
    },
  }
}
