import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ data: new Map<string, unknown>(), owner: "viewer-a", quota: false }));
vi.mock("@/lib/user", () => ({ getUserInfo: () => ({ id: state.owner }) }));
vi.mock("../idb", () => ({
  idbGet: async (key: string) => structuredClone(state.data.get(key) ?? null),
  idbSet: async (key: string, value: unknown) => { state.data.set(key, structuredClone(value)); },
  idbDelete: async (key: string) => { state.data.delete(key); },
  idbUpdate: async (key: string, update: (v: unknown) => unknown) => {
    if (state.quota) throw new Error("quota");
    const next = update(structuredClone(state.data.get(key) ?? null));
    state.data.set(key, structuredClone(next)); return next;
  },
}));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));
import { authFetch } from "@/lib/auth-fetch";
import { feedCachedJson } from "../feed-cache";
import { fetchFeedDraftSessions } from "@/lib/api/feed";
import { blankFeedContent, createLocalFeedPost, patchFeedWorkingCopy, readLocalFeedPost,
  readLocalFeedPosts, flushFeedWorkingCopies, forkLocalFeedPost, loadFeedWorkingCopy,
  readFeedNewPostForm, writeFeedNewPostForm } from "../feed-offline";

const assistant = "assistant-1";
const content = () => ({ ...blankFeedContent(), title: "Launch notes", text: "First paragraph" });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function syncReply(_url: unknown, init?: RequestInit) {
  const request = JSON.parse(init!.body as string);
  return Promise.resolve(reply({ copy: { ...request, revision: request.revision + 1 } }));
}
beforeEach(() => {
  state.data.clear(); state.owner = "viewer-a"; state.quota = false;
  vi.stubGlobal("navigator", { onLine: false });
  vi.mocked(authFetch).mockReset();
});

describe("[COMP:app-web/feed-offline] durable authoring and replay", () => {
  it("creates and reloads an offline post and lists it without a network", async () => {
    const post = await createLocalFeedPost(assistant, "threads", content());
    expect((await fetchFeedDraftSessions(assistant, "threads"))[0].id).toBe(post.session.id);
    await patchFeedWorkingCopy(assistant, post.session.id, { text: "", postFormat: "thread", threadSegments: ["Partial", ""] });
    const restored = await readLocalFeedPost(assistant, post.session.id);
    expect(restored?.content).toMatchObject({ text: "", title: "Launch notes", threadSegments: ["Partial", ""] });
    expect(authFetch).not.toHaveBeenCalled();
  });
  it("persists incomplete new-post forms and isolates viewers", async () => {
    await writeFeedNewPostForm(assistant, "linkedin", { ...content(), privateBrief: "An unfinished thought" });
    expect((await readFeedNewPostForm(assistant, "linkedin"))?.privateBrief).toBe("An unfinished thought");
    await createLocalFeedPost(assistant, "threads", content());
    state.owner = "viewer-b";
    expect(await readLocalFeedPosts()).toEqual([]);
    expect(await readFeedNewPostForm(assistant, "linkedin")).toBeNull();
  });
  it("does not claim a save or create when device storage rejects the write", async () => {
    state.quota = true;
    await expect(createLocalFeedPost(assistant, "threads", content())).rejects.toThrow("quota");
    expect(await readLocalFeedPosts()).toEqual([]);
  });
  it("syncs a closed editor's new post on online startup", async () => {
    const post = await createLocalFeedPost(assistant, "threads", content());
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockImplementation(syncReply);
    await flushFeedWorkingCopies();
    expect(authFetch).toHaveBeenCalledWith(expect.stringContaining(post.session.id), expect.objectContaining({ method: "PUT" }));
    expect(await readLocalFeedPost(assistant, post.session.id)).toMatchObject({ dirty: false, newSession: false, revision: 1 });
    await flushFeedWorkingCopies();
    expect(authFetch).toHaveBeenCalledOnce();
  });
  it("retains edits made during a flush and syncs the next revision", async () => {
    const post = await createLocalFeedPost(assistant, "threads", content());
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockImplementationOnce(async (url, init) => {
      await patchFeedWorkingCopy(assistant, post.session.id, { text: "Newer keystrokes" });
      return syncReply(url, init);
    }).mockImplementation(syncReply);
    await flushFeedWorkingCopies();
    expect(await readLocalFeedPost(assistant, post.session.id)).toMatchObject({ dirty: true, revision: 1, content: { text: "Newer keystrokes" } });
    await flushFeedWorkingCopies();
    expect(await readLocalFeedPost(assistant, post.session.id)).toMatchObject({ dirty: false, revision: 2 });
  });
  it("retries the same persisted mutation after a lost response, even after more editing", async () => {
    const post = await createLocalFeedPost(assistant, "threads", content());
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockRejectedValueOnce(new TypeError("response lost")).mockImplementation(syncReply);
    await flushFeedWorkingCopies();
    const sent = vi.mocked(authFetch).mock.calls[0][1]?.body;
    await patchFeedWorkingCopy(assistant, post.session.id, { text: "After the lost response" });
    await flushFeedWorkingCopies();
    expect(vi.mocked(authFetch).mock.calls[1][1]?.body).toBe(sent);
    expect((await readLocalFeedPost(assistant, post.session.id))?.dirty).toBe(true);
    await flushFeedWorkingCopies();
    expect(await readLocalFeedPost(assistant, post.session.id)).toMatchObject({ dirty: false, revision: 2, content: { text: "After the lost response" } });
  });
  it("keeps conflicts for recovery and copies local work to a separate post", async () => {
    const post = await createLocalFeedPost(assistant, "threads", content());
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockResolvedValue(reply({}, 409));
    await flushFeedWorkingCopies(); await flushFeedWorkingCopies();
    expect(authFetch).toHaveBeenCalledOnce();
    const conflict = (await readLocalFeedPost(assistant, post.session.id))!;
    expect(conflict).toMatchObject({ dirty: true, error: "conflict" });
    const recovered = await forkLocalFeedPost(conflict);
    expect(recovered.session.id).not.toBe(post.session.id);
    expect(recovered.content).toEqual(post.content);
    expect(await readLocalFeedPost(assistant, post.session.id)).toBeNull();
  });
  it("retains work on denied permission and never writes using a changed viewer", async () => {
    const post = await createLocalFeedPost(assistant, "threads", content());
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockResolvedValueOnce(reply({}, 403));
    await flushFeedWorkingCopies();
    expect(await readLocalFeedPost(assistant, post.session.id)).toMatchObject({ dirty: true, error: "blocked" });
    state.owner = "viewer-b";
    await flushFeedWorkingCopies();
    expect(authFetch).toHaveBeenCalledOnce();
  });
  it("restores an existing remote working copy but never replaces unsynced typing", async () => {
    const post = await createLocalFeedPost(assistant, "threads", content());
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockImplementation(syncReply);
    await flushFeedWorkingCopies();
    vi.mocked(authFetch).mockResolvedValue(reply({ copy: { revision: 2, mutationId: "remote", content: { ...content(), text: "From another device" } } }));
    expect((await loadFeedWorkingCopy(assistant, post.session, content())).content.text).toBe("From another device");
    await patchFeedWorkingCopy(assistant, post.session.id, { text: "Local unfinished revision" });
    expect((await loadFeedWorkingCopy(assistant, post.session, content())).content.text).toBe("Local unfinished revision");
  });
  it("caches reads for airplane navigation but evicts an authoritative access denial", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockResolvedValueOnce(reply({ name: "Demo workspace" }));
    await feedCachedJson("/api/workspaces/workspace-1");
    vi.stubGlobal("navigator", { onLine: false });
    expect(await feedCachedJson("/api/workspaces/workspace-1")).toEqual({ name: "Demo workspace" });
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockResolvedValueOnce(reply({}, 403));
    await expect(feedCachedJson("/api/workspaces/workspace-1")).rejects.toThrow("403");
    vi.stubGlobal("navigator", { onLine: false });
    await expect(feedCachedJson("/api/workspaces/workspace-1")).rejects.toThrow();
  });
});
