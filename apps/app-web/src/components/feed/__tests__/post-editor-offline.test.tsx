// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/dictionaries/en";

const state = vi.hoisted(() => ({ data: new Map<string, unknown>(), push: vi.fn(), canDraft: true }));
vi.mock("@/lib/user", () => ({ getUserInfo: () => ({ id: "viewer-a" }) }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn(async () => { throw new Error("offline"); }) }));
vi.mock("@/lib/i18n/client", async () => { const { en } = await import("@/lib/i18n/dictionaries/en"); return { useT: () => en }; });
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/lib/offline/use-offline-sync", () => ({ useIsOffline: () => true }));
vi.mock("@/lib/recorder/dock-recorder-bridge", () => ({ useGlobalDockRecorder: () => null }));
vi.mock("@/components/feed/tuning-chat-panel", () => ({ TuningChatPanel: () => null }));
vi.mock("@/components/feed/post-media-tray", () => ({ PostMediaTray: () => null }));
vi.mock("@/contexts/feed-profiles-context", () => ({ useFeedWorkspace: () => ({
  workspaceId: "workspace-1", name: "Demo", profiles: [], assistants: [{ id: "assistant-1", name: "Writer" }],
  canDraft: state.canDraft, me: { id: "viewer-a" }, role: "owner", brand: null,
}) }));
vi.mock("@/lib/offline/idb", () => ({
  idbGet: async (key: string) => structuredClone(state.data.get(key) ?? null),
  idbSet: async (key: string, value: unknown) => { state.data.set(key, structuredClone(value)); },
  idbDelete: async (key: string) => { state.data.delete(key); },
  idbUpdate: async (key: string, update: (v: unknown) => unknown) => {
    const next = update(structuredClone(state.data.get(key) ?? null));
    state.data.set(key, structuredClone(next)); return next;
  },
}));
import { PostEditor } from "../post-editor";
import { blankFeedContent, createLocalFeedPost, readLocalFeedPost, readFeedNewPostForm } from "@/lib/offline/feed-offline";
import { authFetch } from "@/lib/auth-fetch";

let root: Root;
let container: HTMLDivElement;
async function render(sessionId: string | null, platform: "threads" | "twitter" | "linkedin" = "threads") {
  await act(async () => { root.render(<PostEditor platform={platform} sessionId={sessionId} />); });
}
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function remount() {
  await act(async () => root.unmount());
  root = createRoot(container);
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.data.clear(); state.push.mockReset(); state.canDraft = true;
  vi.mocked(authFetch).mockClear();
  Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("[COMP:app-web/feed-offline] offline editor lifecycle", () => {
  it("saves caption keystrokes immediately and restores after closing the editor", async () => {
    const post = await createLocalFeedPost("assistant-1", "threads", blankFeedContent());
    await render(post.session.id);
    await type(container.querySelector("textarea")!, "Written during a flight");
    expect((await readLocalFeedPost("assistant-1", post.session.id))?.content.text).toBe("Written during a flight");
    // No debounce/timer needs to fire before the user navigates away.
    await remount(); await render(post.session.id);
    expect(container.querySelector("textarea")?.value).toBe("Written during a flight");
    expect(container.textContent).toContain(en.feedPage.postEditor.savedLocally);
    const commit = [...container.querySelectorAll("button")].find(b => b.textContent === en.feedPage.postEditor.useThisVersion)!;
    expect(commit.disabled).toBe(true);
    expect(authFetch).not.toHaveBeenCalled();
  });
  it("shows a cached AI proposal when a new post has never been typed into", async () => {
    const post = await createLocalFeedPost("assistant-1", "threads", blankFeedContent());
    const records = state.data.get("feed:working:viewer-a") as Record<string, typeof post>;
    records[`assistant-1:${post.session.id}`].newSession = false;
    state.data.set(`feed:cache:viewer-a:/api/sessions/${post.session.id}/messages`, [{
      role: "assistant", content: [{ type: "tool_use", name: "proposeDrafts", input: { drafts: [{ index: 1, text: "An AI suggestion" }] } }],
    }]);
    await render(post.session.id);
    expect(container.querySelector("textarea")?.value).toBe("An AI suggestion");
  });
  it("keeps an intentionally empty caption even when cached AI proposals exist", async () => {
    const post = await createLocalFeedPost("assistant-1", "threads", { ...blankFeedContent(), text: "My original caption" });
    const records = state.data.get("feed:working:viewer-a") as Record<string, typeof post>;
    records[`assistant-1:${post.session.id}`].newSession = false;
    state.data.set(`feed:cache:viewer-a:/api/sessions/${post.session.id}/messages`, [{
      role: "assistant", content: [{ type: "tool_use", name: "proposeDrafts", input: { drafts: [{ index: 1, text: "An AI suggestion" }] } }],
    }]);
    await render(post.session.id);
    await type(container.querySelector("textarea")!, "");
    expect(container.querySelector("textarea")?.value).toBe("");
    await remount(); await render(post.session.id);
    expect(container.querySelector("textarea")?.value).toBe("");
  });
  it("retains the new-post title and private brief before Create is pressed", async () => {
    await render(null);
    await type(container.querySelector('input[type="text"]')!, "New idea");
    await type(container.querySelector("textarea")!, "Private context, half finished");
    expect((await readFeedNewPostForm("assistant-1", "threads"))?.privateBrief).toBe("Private context, half finished");
    await remount(); await render(null);
    expect(container.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe("New idea");
    expect(container.querySelector("textarea")?.value).toBe("Private context, half finished");
  });
  it("restores unfinished article fields without requiring a valid URL", async () => {
    const post = await createLocalFeedPost("assistant-1", "linkedin", { ...blankFeedContent(), postFormat: "article" });
    await render(post.session.id, "linkedin");
    await type(container.querySelector<HTMLInputElement>('input[type="url"]')!, "https://exam");
    await type(container.querySelector<HTMLInputElement>(`input[placeholder="${en.feedPage.postEditor.articleTitlePlaceholder}"]`)!, "An unfinished headline");
    await remount(); await render(post.session.id, "linkedin");
    expect(container.querySelector<HTMLInputElement>('input[type="url"]')?.value).toBe("https://exam");
    expect((await readLocalFeedPost("assistant-1", post.session.id))?.content.article.title).toBe("An unfinished headline");
  });
  it("restores incomplete threads and title edits after navigation", async () => {
    const post = await createLocalFeedPost("assistant-1", "twitter", { ...blankFeedContent(), postFormat: "thread" });
    await render(post.session.id, "twitter");
    await type(container.querySelector("textarea")!, "Half a thread");
    await type(container.querySelector<HTMLInputElement>(`input[aria-label="${en.feedPage.postEditor.editTitle}"]`)!, "A new title");
    await remount(); await render(post.session.id, "twitter");
    expect(container.querySelector("textarea")?.value).toBe("Half a thread");
    expect(container.querySelector<HTMLInputElement>(`input[aria-label="${en.feedPage.postEditor.editTitle}"]`)?.value).toBe("A new title");
    expect((await readLocalFeedPost("assistant-1", post.session.id))?.content.threadSegments).toEqual(["Half a thread", ""]);
  });
});
