/** [COMP:crm/operations-pagination] Complete CRM collection consumers. */
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));
import { authFetch } from "@/lib/auth-fetch";
import {
  listCrmIntakeDefinitions, listCrmIntakeCredentials, listCrmSubmissions,
  listCrmConsentPurposes, listCrmEntitlementPlans, listCrmEntitlements,
  listCrmEvents, listCrmParticipation, listCrmOperationsAudit, listCrmEventDelivery,
  listCrmSegments, previewCrmSegment,
} from "../crm";

const fetch = vi.mocked(authFetch);
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => vi.resetAllMocks());
describe("[COMP:crm/operations-pagination] Operations SDK follows every page", () => {
  it.each([
    ["definitions", () => listCrmIntakeDefinitions("fixture")],
    ["credentials", () => listCrmIntakeCredentials("fixture")],
    ["submissions", () => listCrmSubmissions("fixture", { status: "new", limit: 50 })],
    ["purposes", () => listCrmConsentPurposes("fixture", true)],
    ["plans", () => listCrmEntitlementPlans("fixture", { published: true })],
    ["entitlements", () => listCrmEntitlements("fixture", { contactId: "fixture-contact" })],
    ["events", () => listCrmEvents("fixture", { status: "published" })],
    ["participation", () => listCrmParticipation("fixture", { sourceKind: "manual" })],
    ["entries", () => listCrmOperationsAudit("fixture")],
    ["events", () => listCrmEventDelivery("fixture")],
  ] as const)("collects %s beyond the first hundred without changing filters", async (key, list) => {
    fetch.mockResolvedValueOnce(response({ [key]: Array.from({ length: 100 }, (_, id) => ({ id })), nextCursor: "fixture_cursor" }));
    fetch.mockResolvedValueOnce(response({ [key]: [{ id: 100 }], nextCursor: null }));
    const result = await list();
    expect(result).toHaveLength(101);
    const first = new URL(String(fetch.mock.calls[0][0]));
    const second = new URL(String(fetch.mock.calls[1][0]));
    expect(second.pathname).toBe(first.pathname);
    expect(second.searchParams.get("cursor")).toBe("fixture_cursor");
    second.searchParams.delete("cursor");
    expect(second.search).toBe(first.search);
  });
  it("keeps one cursor parameter while completing segment lists and snapshots", async () => {
    fetch.mockResolvedValueOnce(response({ segments: [{ id: "1" }], catalog: [{ field: "name" }], nextCursor: "one" }));
    fetch.mockResolvedValueOnce(response({ segments: [{ id: "2" }], catalog: [], nextCursor: "two" }));
    fetch.mockResolvedValueOnce(response({ segments: [{ id: "3" }], catalog: [], nextCursor: null }));
    expect(await listCrmSegments("fixture", "person")).toEqual({ segments: [{ id: "1" }, { id: "2" }, { id: "3" }], catalog: [{ field: "name" }] });
    expect(new URL(String(fetch.mock.calls[2][0])).searchParams.getAll("cursor")).toEqual(["two"]);
    fetch.mockResolvedValueOnce(response({ rows: [{ id: "1" }], count: 2, snapshotIds: ["1"], snapshotNextCursor: "ids" }));
    fetch.mockResolvedValueOnce(response({ rows: [{ id: "1" }], count: 2, snapshotIds: ["2"], snapshotNextCursor: null }));
    expect(await previewCrmSegment("fixture", "segment")).toEqual({ rows: [{ id: "1" }], count: 2, snapshotIds: ["1", "2"] });
    expect(new URL(String(fetch.mock.calls[4][0])).searchParams.get("snapshotCursor")).toBe("ids");
  });
  it("rejects a partial snapshot when a later segment page fails", async () => {
    fetch.mockResolvedValueOnce(response({ rows: [], count: 2, snapshotIds: ["1"], snapshotNextCursor: "ids" }));
    fetch.mockResolvedValueOnce(response({ error: "unavailable" }, 503));
    await expect(previewCrmSegment("fixture", "segment")).rejects.toThrow("unavailable");
  });
  it("fails a later request instead of returning an incomplete catalog", async () => {
    fetch.mockResolvedValueOnce(response({ plans: [{ id: "first" }], nextCursor: "next" }));
    fetch.mockResolvedValueOnce(response({ error: "unavailable" }, 503));
    await expect(listCrmEntitlementPlans("fixture")).rejects.toThrow("unavailable");
  });
  it("stops a repeated continuation instead of issuing an unbounded request loop", async () => {
    fetch.mockImplementation(async () => response({ plans: [{ id: "first" }], nextCursor: "same" }));
    await expect(listCrmEntitlementPlans("fixture")).rejects.toThrow("invalid_crm_cursor");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
