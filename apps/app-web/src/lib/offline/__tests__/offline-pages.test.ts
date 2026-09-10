import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { FRAGMENT_FIELD, pageToYDocUpdate } from "@use-brian/doc-model";

const state = vi.hoisted(() => ({ data: new Map<string, unknown>(), userId: "viewer-a", failStorage: false }));
vi.mock("@/lib/user", () => ({ getUserInfo: () => ({ id: state.userId }) }));
vi.mock("@/lib/offline/idb", () => ({
  idbGet: vi.fn(async (key: string) => structuredClone(state.data.get(key) ?? null)),
  idbSet: vi.fn(async (key: string, value: unknown) => { state.data.set(key, structuredClone(value)); }),
  idbDelete: vi.fn(async (key: string) => { state.data.delete(key); }),
  idbUpdate: vi.fn(async (key: string, update: (v: unknown) => unknown) => {
    if (state.failStorage) throw new Error("quota");
    const next = update(structuredClone(state.data.get(key) ?? null));
    state.data.set(key, structuredClone(next));
    return next;
  }),
}));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));
vi.mock("../sync-local-page", () => ({ syncLocalPage: vi.fn(async () => {}) }));
import { authFetch } from "@/lib/auth-fetch";
import { createDraft, getView, listViews } from "@/lib/api/views";
import { setOnline, offlineWrite, flushWriteQueue } from "../offline-writes";
import { syncLocalPage } from "../sync-local-page";
import { createLocalPage, flushLocalPages, readLocalPage, readLocalPages, readCachedPage, cachePage } from "../offline-pages";
const wid = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000002";
const childId = "00000000-0000-4000-8000-000000000003";
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  vi.clearAllMocks();
  state.data.clear(); state.userId = "viewer-a"; state.failStorage = false;
  setOnline(false);
  vi.stubGlobal("navigator", { onLine: false });
  vi.mocked(authFetch).mockReset();
  vi.mocked(syncLocalPage).mockReset().mockResolvedValue();
});

describe("[COMP:app-web/offline-pages] durable offline creation", () => {
  it("creates, navigates, and reloads a blank page without a network request", async () => {
    const page = await createDraft({ workspaceId: wid, teamspaceId: null });
    expect(page.id).toMatch(/^[\da-f-]{36}$/);
    expect(page.teamspaceId).toBeNull();
    // Each read comes from the serialized durable store, not a memory object.
    expect(await getView(page.id)).toEqual(page);
    expect(await listViews({ workspaceId: wid, state: "draft" })).toEqual([page]);
    const local = await readLocalPage(page.id);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, local!.seed);
    expect(doc.store.clients.size).toBeGreaterThan(0); // blank is editable
    doc.destroy();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("keeps private inheritance and orders offline parent then child", async () => {
    await createLocalPage({ id, workspaceId: wid, teamspaceId: null });
    const child = await createLocalPage({ id: childId, workspaceId: wid, nestParentId: id });
    expect(child.teamspaceId).toBeNull();
    expect(child.nestParentId).toBe(id);
    expect((await readLocalPages()).map((p) => p.view.id)).toEqual([id, childId]);
  });

  it("inherits a cached teamspace and project from a parent", async () => {
    const parent = await createLocalPage({ id, workspaceId: wid, teamspaceId: "teamspace-a" });
    await cachePage({ ...parent, id: "cached-parent", projectId: "project-a" });
    const child = await createLocalPage({ id: childId, workspaceId: wid, nestParentId: "cached-parent" });
    expect(child).toMatchObject({ teamspaceId: "teamspace-a", projectId: "project-a" });
  });

  it("rejects an unknown parent and does not claim success when storage fails", async () => {
    await expect(createLocalPage({ id, workspaceId: wid, nestParentId: "missing" })).rejects.toThrow("parent");
    state.failStorage = true;
    await expect(createDraft({ workspaceId: wid })).rejects.toThrow("storage");
    expect(await readLocalPages()).toEqual([]);
  });

  it("scopes local pages and metadata to the signed-in viewer", async () => {
    const page = await createLocalPage({ id, workspaceId: wid });
    await cachePage(page);
    state.userId = "viewer-b";
    expect(await readLocalPages()).toEqual([]);
    expect(await readCachedPage(id)).toBeNull();
  });

  it("coalesces a rename while a local page is waiting even if the network is up", async () => {
    await createLocalPage({ id, workspaceId: wid });
    setOnline(true);
    const exec = vi.fn();
    for (const name of ["First title", "Final title"]) {
      await offlineWrite({ kind: "view.rename", coalesceKey: `rename:${id}`, payload: { id, name }, exec });
    }
    expect((await getView(id)).name).toBe("Final title");
    expect((await listViews({ workspaceId: wid, state: "draft" }))[0].name).toBe("Final title");
    expect(exec).not.toHaveBeenCalled();
    await flushWriteQueue();
    expect(authFetch).not.toHaveBeenCalled(); // create must finish first
  });

  it("uses identical seed structs on both sides so templates do not duplicate", async () => {
    const page = await createLocalPage({ id, workspaceId: wid, name: "Notes", blocks: [{ kind: "text", id: "block-a", text: "Seed" }] });
    const local = (await readLocalPage(id))!;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, local.seed);
    const before = doc.getXmlFragment(FRAGMENT_FIELD).toString();
    Y.applyUpdate(doc, pageToYDocUpdate({ blocks: [{ kind: "text", id: "block-a", text: "Seed" }] }, "Notes"));
    expect(doc.getXmlFragment(FRAGMENT_FIELD).toString()).toBe(before);
    doc.destroy();
  });

  it("registers and syncs closed pages in order, retaining their stable URLs", async () => {
    await createLocalPage({ id, workspaceId: wid, name: "Parent" });
    await createLocalPage({ id: childId, workspaceId: wid, nestParentId: id });
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith("/views/draft")) {
        const input = JSON.parse(init!.body as string);
        return reply({ id: input.id }, 201);
      }
      return reply({ ok: true, clientAssignedPageIds: true });
    });
    await Promise.all([flushLocalPages(), flushLocalPages()]);
    expect(vi.mocked(syncLocalPage).mock.calls.map((call) => call[0])).toEqual([id, childId]);
    expect(await readLocalPages()).toEqual([]);
    expect((await readCachedPage(id))?.name).toBe("Parent");
    const creates = vi.mocked(authFetch).mock.calls.filter(([url]) => String(url).endsWith("/views/draft"));
    expect(creates.map(([, init]) => JSON.parse(init!.body as string).id)).toEqual([id, childId]);
  });

  it("does not issue creates against an older API that might ignore stable IDs", async () => {
    await createLocalPage({ id, workspaceId: wid });
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockImplementation(async () => reply({}, 404));
    await flushLocalPages();
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(authFetch).mock.calls[0][0])).toContain("offline-capabilities");
    expect(await readLocalPage(id)).not.toBeNull();
  });

  it("retains a failed create after repeated failures and blocks its children", async () => {
    await createLocalPage({ id, workspaceId: wid });
    await createLocalPage({ id: childId, workspaceId: wid, nestParentId: id });
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockResolvedValue(reply({}, 503));
    for (let n = 0; n < 7; n++) await flushLocalPages();
    expect((await readLocalPages()).length).toBe(2);
    expect(syncLocalPage).not.toHaveBeenCalled();
  });

  it("retries content sync without re-creating a registered page", async () => {
    await createLocalPage({ id, workspaceId: wid });
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockImplementation(async (url) => reply(String(url).endsWith("/views/draft") ? { id } : { ok: true, clientAssignedPageIds: true }));
    vi.mocked(syncLocalPage).mockRejectedValueOnce(new Error("connection lost"));
    await flushLocalPages();
    expect((await readLocalPage(id))?.registered).toBe(true);
    await flushLocalPages();
    expect(await readLocalPage(id)).toBeNull();
    expect(vi.mocked(authFetch).mock.calls.filter(([url]) => String(url).endsWith("/views/draft"))).toHaveLength(1);
  });

  it("does not lose a page created while another page is uploading", async () => {
    await createLocalPage({ id, workspaceId: wid });
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockImplementation(async () => reply({ id, clientAssignedPageIds: true }));
    vi.mocked(syncLocalPage).mockImplementationOnce(async () => {
      await createLocalPage({ id: childId, workspaceId: wid });
    });
    await flushLocalPages();
    expect((await readLocalPages()).map((p) => p.view.id)).toEqual([childId]);
  });

  it("retains the UUID if an online create loses its response", async () => {
    setOnline(true); vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const page = await createDraft({ workspaceId: wid });
    expect(JSON.parse(vi.mocked(authFetch).mock.calls[0][1]!.body as string).id).toBe(page.id);
    expect((await readLocalPage(page.id))?.view.id).toBe(page.id);
  });

  it("never treats an authoritative create denial as offline success", async () => {
    setOnline(true); vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockResolvedValue(reply({}, 403));
    await expect(createDraft({ workspaceId: wid })).rejects.toThrow("HTTP 403");
    expect(await readLocalPages()).toEqual([]);
  });

  it("caches fetched metadata for offline reopening but evicts it on denial", async () => {
    const page = await createLocalPage({ id, workspaceId: wid });
    state.data.clear(); vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockResolvedValueOnce(reply(page));
    expect(await getView(id)).toEqual(page);
    vi.stubGlobal("navigator", { onLine: false });
    expect(await getView(id)).toEqual(page);
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockResolvedValueOnce(reply({}, 403));
    await expect(getView(id)).rejects.toThrow("HTTP 403");
    expect(await readCachedPage(id)).toBeNull();
  });
});
