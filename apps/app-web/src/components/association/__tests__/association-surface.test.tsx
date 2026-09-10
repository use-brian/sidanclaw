// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ get: vi.fn(), change: vi.fn(), confirm: vi.fn(), orders: vi.fn(), orderChange: vi.fn() }));
vi.mock("@/lib/api/association", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/api/association")>(), getAssociationModuleSnapshot: api.get, changeAssociationModule: api.change,
  listAssociationOrders: api.orders, changeAssociationOrder: api.orderChange,
}));
vi.mock("@/lib/surface-prefetch", () => ({ associationModuleCacheKey: (workspaceId: string) => `association-module:${workspaceId}:viewer`,
  associationOrdersCacheKey: (workspaceId: string, cursor: string | null) => `association-orders:${workspaceId}:viewer:${cursor ?? "first"}` }));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: api.confirm }));
import { AssociationApiError } from "@/lib/api/association";
import { AssociationModuleControls } from "../module-controls";
import { AssociationOrdersPanel } from "../orders-panel";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { markSurfaceCacheStale, resetSurfaceCache } from "@/lib/surface-cache";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const t = en.associationPage;
let host: HTMLDivElement, root: Root;
const moduleRow = (state = "disabled", version = 1) => ({ workspaceId: "w1", state, version });
async function render(readOnly = false) {
  await act(async () => root.render(<I18nProvider locale="en" dict={en}><AssociationModuleControls workspaceId="w1" readOnly={readOnly} /></I18nProvider>));
}
async function click(label: string) {
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent === label)!.click(); });
}
beforeEach(() => {
  resetSurfaceCache(); vi.resetAllMocks();
  api.get.mockResolvedValue({ module: moduleRow(), canManage: true });
  api.confirm.mockResolvedValue(true);
  api.change.mockResolvedValue({ module: moduleRow("enabled", 2), changed: true, pendingOrders: 0 });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetSurfaceCache(); });

describe("[COMP:app-web/association] Independent module controls", () => {
  it("confirms the observed version and never changes Home or assistant grants", async () => {
    await render(); await click(t.enable);
    expect(api.confirm).toHaveBeenCalledWith(expect.objectContaining({ description: t.enableConfirm }));
    expect(api.change).toHaveBeenCalledExactlyOnceWith("w1", "enable", 1);
    expect(host.textContent).toContain(t.states.enabled);
    expect(host.textContent).toContain(t.moduleDescription);
    expect(host.querySelector('a[href="/w/w1/association?section=orders"]')).not.toBeNull();
  });
  it("keeps members and assistant permission notes read-only without hiding history", async () => {
    api.get.mockResolvedValue({ module: moduleRow(), canManage: false });
    await render();
    expect(host.textContent).toContain(t.ownerOnly);
    expect([...host.querySelectorAll("button")].some(button => button.textContent === t.enable)).toBe(false);
    await act(async () => { resetSurfaceCache(); });
    api.get.mockResolvedValue({ module: moduleRow(), canManage: true });
    await render(true);
    expect(host.textContent).toContain(t.savedPermissions);
    expect([...host.querySelectorAll("button")].some(button => button.textContent === t.enable)).toBe(false);
    expect(api.change).not.toHaveBeenCalled();
  });
  it("keeps a cancelled confirmation side-effect free", async () => {
    api.confirm.mockResolvedValue(false);
    await render(); await click(t.enable);
    expect(api.change).not.toHaveBeenCalled();
    expect(host.textContent).toContain(t.states.disabled);
  });
  it("refreshes a stale conflict before using the next observed version", async () => {
    await render();
    api.get.mockResolvedValue({ module: moduleRow("draining", 3), canManage: true });
    api.change.mockRejectedValueOnce(new AssociationApiError("stale_module_version", 409));
    await click(t.enable);
    expect(host.textContent).toContain(t.stale);
    expect(host.textContent).toContain(t.states.draining);
    api.change.mockRejectedValueOnce(new AssociationApiError("module_drain_pending", 409));
    await click(t.finish);
    expect(api.change).toHaveBeenLastCalledWith("w1", "finish_disable", 3);
    expect(host.textContent).toContain(t.pendingOrders);
  });
  it("keeps last-good state during failed refresh and disables changes", async () => {
    await render(); api.get.mockRejectedValue(new Error("offline"));
    await click(t.refresh);
    expect(host.textContent).toContain(t.states.disabled);
    expect(host.textContent).toContain(t.loadFailed);
    const enable = [...host.querySelectorAll("button")].find(button => button.textContent === t.enable)!;
    expect(enable.disabled).toBe(true);
    expect(api.change).not.toHaveBeenCalled();
  });
  it("revalidates the shared module cache on a workspace-config stale mark", async () => {
    await render(); api.get.mockResolvedValue({ module: moduleRow("draining", 5), canManage: true });
    await act(async () => markSurfaceCacheStale("association-module:w1"));
    expect(host.textContent).toContain(t.states.draining);
    expect(api.get).toHaveBeenCalledTimes(2);
  });
});

const orderRow = (id = "order-one", status = "pending", totalMinor = "0") => ({ id, status, totalMinor, currency: "USD", contactId: "contact-one", reservationExpiresAt: null, provider: null, providerReference: null });
async function renderOrders() {
  await act(async () => root.render(<I18nProvider locale="en" dict={en}><AssociationOrdersPanel workspaceId="w1" /></I18nProvider>));
}
describe("[COMP:app-web/association] Order history and recovery", () => {
  it("follows the server continuation and returns to the cached preceding page", async () => {
    api.orders.mockImplementation(async (_workspaceId, cursor) => cursor
      ? { orders: [orderRow("order-next")], nextCursor: null }
      : { orders: Array.from({ length: 50 }, (_, i) => orderRow(`order-${i}`)), nextCursor: "next-cursor" });
    await renderOrders();
    expect(host.querySelectorAll("article")).toHaveLength(50);
    await click(t.next);
    expect(api.orders).toHaveBeenLastCalledWith("w1", "next-cursor");
    expect(host.querySelectorAll("article")).toHaveLength(1);
    await click(t.previous);
    expect(host.querySelectorAll("article")).toHaveLength(50);
  });
  it("uses the same order identity for reviewed cancellation and refreshes canonical state", async () => {
    api.orders.mockResolvedValue({ orders: [orderRow()], nextCursor: null });
    await renderOrders();
    api.orders.mockResolvedValue({ orders: [orderRow("order-one", "cancelled")], nextCursor: null });
    api.orderChange.mockResolvedValue({ order: orderRow("order-one", "cancelled") });
    await click(t.cancelOrder);
    expect(api.orderChange).toHaveBeenCalledExactlyOnceWith("w1", "order-one", "cancel");
    expect(host.textContent).toContain(t.orderStates.cancelled);
    expect(host.textContent).not.toContain(t.confirmFree);
  });
  it("never exposes free confirmation for a priced or settled order", async () => {
    api.orders.mockResolvedValue({ orders: [orderRow("priced", "pending", "100"), orderRow("paid", "paid")], nextCursor: null });
    await renderOrders();
    expect([...host.querySelectorAll("button")].filter(button => button.textContent === t.confirmFree)).toHaveLength(0);
    expect([...host.querySelectorAll("button")].filter(button => button.textContent === t.cancelOrder)).toHaveLength(1);
  });
  it("does not auto-retry an uncertain mutation or send a cancelled confirmation", async () => {
    api.orders.mockResolvedValue({ orders: [orderRow()], nextCursor: null });
    await renderOrders(); api.confirm.mockResolvedValueOnce(false);
    await click(t.confirmFree); expect(api.orderChange).not.toHaveBeenCalled();
    api.orderChange.mockRejectedValueOnce(new Error("response lost"));
    await click(t.confirmFree);
    expect(api.orderChange).toHaveBeenCalledExactlyOnceWith("w1", "order-one", "confirm-free");
    expect(host.textContent).toContain(t.orderSaveFailed);
  });
});
