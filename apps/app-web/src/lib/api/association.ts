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
