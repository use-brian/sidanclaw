/** Authenticated native Association member client. [COMP:app-web/association] */
import type { WorkspaceModule, WorkspaceModuleAction, WorkspaceModuleActionResult } from "@use-brian/shared";
import { authFetch } from "@/lib/auth-fetch";
import { getWorkspaceRole } from "@/lib/api/workspaces";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
export class AssociationApiError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
async function request<T>(path: string, input?: unknown): Promise<T> {
  const response = await authFetch(`${API_URL}${path}`, input === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  const body = await response.json();
  if (!response.ok) throw new AssociationApiError(typeof body?.error === "string" ? body.error : "unavailable", response.status);
  return body as T;
}
export type AssociationModuleSnapshot = { module: WorkspaceModule; canManage: boolean };
export async function getAssociationModuleSnapshot(workspaceId: string): Promise<AssociationModuleSnapshot> {
  const [{ module }, role] = await Promise.all([
    request<{ module: WorkspaceModule }>(`/api/crm/${encodeURIComponent(workspaceId)}/association/module`),
    getWorkspaceRole(workspaceId),
  ]);
  if (module?.workspaceId !== workspaceId || !["enabled", "draining", "disabled"].includes(module.state)
    || !Number.isInteger(module.version)) throw new AssociationApiError("invalid_response", 502);
  return { module, canManage: role === "owner" || role === "admin" };
}
export function changeAssociationModule(workspaceId: string, action: WorkspaceModuleAction, expectedVersion: number): Promise<WorkspaceModuleActionResult> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/modules/association/actions`, { action, expectedVersion });
}

export type AssociationOrder = {
  id: string; contactId: string; status: "pending" | "paid" | "failed" | "cancelled" | "refunded";
  currency: string; totalMinor: string; reservationExpiresAt: string | null;
  provider: string | null; providerReference: string | null; createdAt: string;
};
export type AssociationOrdersPage = { orders: AssociationOrder[]; nextCursor: string | null };
export async function listAssociationOrders(workspaceId: string, cursor?: string): Promise<AssociationOrdersPage> {
  const params = new URLSearchParams({ limit: "50", ...(cursor ? { cursor } : {}) });
  const page = await request<AssociationOrdersPage>(`/api/crm/${encodeURIComponent(workspaceId)}/association/orders?${params}`);
  if (!Array.isArray(page.orders) || (page.nextCursor !== null && typeof page.nextCursor !== "string")) throw new AssociationApiError("invalid_response", 502);
  return page;
}
export function changeAssociationOrder(workspaceId: string, orderId: string, action: "cancel" | "confirm-free"): Promise<{ order: AssociationOrder }> {
  return request(`/api/crm/${encodeURIComponent(workspaceId)}/association/orders/${encodeURIComponent(orderId)}/${action}`, {});
}

// Portable wire types; no server/core runtime enters the browser bundle.
export type AssociationPlan = { id:string;planKey:string;name:string;currency:string;feeMinor:string;billingPeriod:"one_time"|"monthly"|"annual"|"lifetime"|"manual";benefits:string[];eligibilityNote:string|null;published:boolean;activeFrom:string|null;activeTo:string|null;provider:string|null;providerPlanId:string|null };
export type AssociationEvent = {id:string;slug:string;title:string;description:string;startsAt:string;endsAt:string;timezone:string;mode:"venue"|"online"|"hybrid";venue:string|null;onlineUrl:string|null;registrationOpensAt:string|null;registrationClosesAt:string|null;capacity:number|null;status:"draft"|"published"|"cancelled"|"completed";canonicalUrl:string|null;programmeKey:string|null;metadata:Record<string,unknown>};
export type AssociationTicket = {id:string;key:string;name:string;currency:string;priceMinor:string;memberPriceMinor:string|null;eligiblePlanKeys:string[];capacity:number|null;perOrderLimit:number;saleStartsAt:string|null;saleEndsAt:string|null;status:"draft"|"on_sale"|"sold_out"|"closed";reservedCount:number;available:number|null};
export type AssociationRegistration = {id:string;eventId:string;ticketId:string|null;orderId:string|null;attendeeContactId:string|null;attendeeName:string;attendeeEmail:string|null;status:"reserved"|"confirmed"|"checked_in"|"cancelled"|"refunded"|"registered"|"attended"|"no_show";sourceKind:string;checkedInAt:string|null};
export type AssociationWaitlistRow = {id:string;contactId:string;contactName:string;eventId:string;ticketId:string;waitlistState:"waiting"|"offered"|"converted"|"closed";promotionId:string|null;orderId:string|null;reservationExpiresAt:string|null};
export type AssociationProviderReceipt = {id:string;provider:string;eventId:string;state:"pending"|"processing"|"applied"|"retry"|"needs_reconciliation";errorCode:string|null;attempts:number;nextAttemptAt:string|null;appliedAt:string|null;orderId:string|null;entitlementId:string|null};
export type AssociationMembership = import("./crm").CrmEntitlement;
type Rows = {retentionRuns:Record<string,unknown>&{id:string;status:string;createdAt:string};credentials:import("./crm-administration").CrmManagedCredential;plans:AssociationPlan;memberships:AssociationMembership;events:AssociationEvent;tickets:AssociationTicket;registrations:AssociationRegistration;waitlist:AssociationWaitlistRow;receipts:AssociationProviderReceipt;audit:import("./crm").CrmOperationsAuditEntry;deliveries:import("./crm").CrmEventDeliveryEntry};
export type AssociationResource = keyof Rows;
export type AssociationListQuery = {cursor?:string;eventId?:string;planId?:string;contactId?:string;includeClosed?:boolean;activeOnly?:boolean};
export async function listAssociationPage<K extends keyof Rows>(workspaceId:string,resource:K,query:AssociationListQuery={}):Promise<{items:Rows[K][];nextCursor:string|null}> {
  const base=`/api/crm/${encodeURIComponent(workspaceId)}`;
  const event=encodeURIComponent(query.eventId ?? "");
  const catalog={retentionRuns:["operations/retention/runs","runs"],credentials:["operations/integration-credentials","credentials"],plans:["operations/entitlement-plans","plans"],memberships:["operations/entitlements","entitlements"],events:["operations/events","events"],tickets:[`association/events/${event}/tickets`,"tickets"],registrations:[`association/events/${event}/registrations`,"registrations"],waitlist:["association/waitlist","submissions"],receipts:["association/provider-receipts","receipts"],audit:["operations/audit","entries"],deliveries:["operations/event-delivery","events"]} as const;
  const [path,key]=catalog[resource];
  const params=new URLSearchParams(resource==="tickets"?{}:{limit:"50"});
  for(const [name,value] of Object.entries(query)) if(value!==undefined && !(name==="eventId" && ["tickets","registrations"].includes(resource))) params.set(name,String(value));
  const response=await request<Record<string,unknown>>(`${base}/${path}?${params}`);
  const items=response[key],cursor=resource==="tickets"?null:response.nextCursor;
  if(!Array.isArray(items) || (cursor!==null && typeof cursor!=="string")) throw new AssociationApiError("invalid_response",502);
  return {items:items as Rows[K][],nextCursor:cursor};
}
export type AssociationPlanSave = Omit<AssociationPlan,"id"|"planKey"|"feeMinor"|"provider"|"providerPlanId"> & {key:string;feeMinor:number;provider?:string;providerPlanId?:string};
export function saveAssociationPlan(workspaceId:string,input:AssociationPlanSave) {
  return request<{record:AssociationPlan}>(`/api/crm/${encodeURIComponent(workspaceId)}/operations/entitlement-plans`,input);
}
export function saveAssociationEvent(workspaceId:string,input:Omit<AssociationEvent,"id">) {
  return request<{record:AssociationEvent}>(`/api/crm/${encodeURIComponent(workspaceId)}/operations/events`,input);
}
export function saveAssociationTicket(workspaceId:string,eventId:string,input:Omit<AssociationTicket,"id"|"priceMinor"|"memberPriceMinor"|"reservedCount"|"available"> & {priceMinor:number;memberPriceMinor:number|null}) {
  return request<{ticket:AssociationTicket}>(`/api/crm/${encodeURIComponent(workspaceId)}/association/events/${encodeURIComponent(eventId)}/tickets`,input);
}
export type AssociationReservation = {contactId:string;idempotencyKey:string;reservationMinutes:number;lines:Array<{ticketId:string;quantity:number;useMemberPrice:boolean;attendees:Array<{contactId?:string;name:string;email?:string}>}>};
export function reserveAssociationOrder(workspaceId:string,input:AssociationReservation) {
  return request<{order:AssociationOrder}>(`/api/crm/${encodeURIComponent(workspaceId)}/association/orders`,input);
}
export async function checkInAssociationAttendee(workspaceId:string,registrationId:string) {
  const response=await authFetch(`${API_URL}/api/crm/${encodeURIComponent(workspaceId)}/association/registrations/${encodeURIComponent(registrationId)}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:"checked_in"})});
  if(!response.ok) throw new AssociationApiError("save_failed",response.status);
}
export function offerAssociationPlace(workspaceId:string,submissionId:string,input:{promotionId:string;reservationMinutes:number;useMemberPrice:boolean}) {
  return request<{offer:{orderId:string}}>(`/api/crm/${encodeURIComponent(workspaceId)}/association/waitlist/${encodeURIComponent(submissionId)}/offer`,input);
}

/** Complete, fail-closed export from the existing authorized member read plane. */
export async function exportAssociationAttendees(workspaceId:string,eventId:string,purposeKey:string):Promise<string> {
  const {fetchCrmRecord,checkCrmSendability}=await import("./crm");
  const contacts=new Map<string,Promise<string|null>>();
  const lines=[["registrationId","contactId","name","email","status"].join(",")];
  const csv=(value:string)=>`"${(/^[\s]*[=+@-]/.test(value)?"'":"")+value.replace(/"/g,'""')}"`;
  const seen=new Set<string>();let cursor:string|undefined;
  do {
    const page=await listAssociationPage(workspaceId,"registrations",{eventId,cursor});
    // Bound request concurrency and retain each current contact assessment once.
    for(let offset=0;offset<page.items.length;offset+=8) {
      const rows=await Promise.all(page.items.slice(offset,offset+8).map(async row=>{
        if(!row.attendeeContactId || !["confirmed","checked_in","registered","attended"].includes(row.status)) return null;
        const id=row.attendeeContactId;
        if(!contacts.has(id)) contacts.set(id,(async()=>{
          const [person,verdict]=await Promise.all([fetchCrmRecord(workspaceId,id),checkCrmSendability(workspaceId,id,"email",purposeKey)]);
          return person?.record.kind==="contact" && !person.record.archivedAt && verdict.verdict==="allowed" ? person.record.email : null;
        })());
        const email=await contacts.get(id)!;
        if(!email || email.trim().toLowerCase()!==row.attendeeEmail?.trim().toLowerCase()) return null;
        return [row.id,id,row.attendeeName,email,row.status].map(csv).join(",");
      }));
      lines.push(...rows.filter((row):row is string=>row!==null));
    }
    if(page.nextCursor && seen.has(page.nextCursor)) throw new AssociationApiError("invalid_cursor",502);
    if(page.nextCursor) seen.add(page.nextCursor);
    cursor=page.nextCursor ?? undefined;
  } while(cursor);
  return lines.join("\r\n")+"\r\n";
}
