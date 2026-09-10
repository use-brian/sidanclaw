/** Durable Feed working copies and reconnect replay. [COMP:app-web/feed-offline] */
import { authFetch } from "@/lib/auth-fetch";
import type { FeedDraftSessionSummary } from "@/lib/api/feed";
import type { FeedPlatform } from "@/lib/feed-nav";
import type { FeedArticleFields, FeedPostFormat } from "@/lib/feed-post-versions";
import type { PostMedia } from "@/lib/feed-media";
import { notifyFeedPostsChanged } from "@/lib/feed-posts-events";
import { idbGet, idbUpdate } from "./idb";
import { FEED_API_URL, feedCachedJson, feedOwner } from "./feed-cache";

export const FEED_LOCAL_CHANGED = "feed:local-changed";
export type FeedWorkingContent = {
  title: string; privateBrief: string; text: string; textEdited?: boolean; postFormat: FeedPostFormat;
  threadSegments: string[]; article: FeedArticleFields; media: PostMedia[];
};
type FeedWorkingCopy = { revision: number; mutationId: string; content: FeedWorkingContent };
export type LocalFeedPost = FeedWorkingCopy & {
  assistantId: string; session: FeedDraftSessionSummary;
  inFlight?: FeedWorkingCopy & { baseTitle?: string; create?: { platform: FeedPlatform } };
  dirty: boolean; newSession: boolean; error?: "conflict" | "blocked";
};
type Records = Record<string, LocalFeedPost>;
const key = (owner: string) => `feed:working:${owner}`;
const recordKey = (assistantId: string, sessionId: string) => `${assistantId}:${sessionId}`;
const changed = () => { if (typeof window !== "undefined") window.dispatchEvent(new Event(FEED_LOCAL_CHANGED)); };
function ownerRequired() { const owner = feedOwner(); if (!owner) throw new Error("No local identity"); return owner; }
export const blankFeedContent = (): FeedWorkingContent => ({ title: "", privateBrief: "", text: "", textEdited: false, postFormat: "post", threadSegments: ["", ""], article: { sourceUrl: "", title: "", description: "" }, media: [] });

export async function readLocalFeedPosts(): Promise<LocalFeedPost[]> {
  const owner = feedOwner();
  const records = owner ? await idbGet<Records>(key(owner)) : null;
  return feedOwner() === owner ? Object.values(records ?? {}) : [];
}
export async function readLocalFeedPost(assistantId: string, sessionId: string): Promise<LocalFeedPost | null> {
  return (await readLocalFeedPosts()).find(p => p.assistantId === assistantId && p.session.id === sessionId) ?? null;
}
export async function createLocalFeedPost(assistantId: string, platform: FeedPlatform, content: FeedWorkingContent): Promise<LocalFeedPost> {
  const owner = ownerRequired();
  const id = crypto.randomUUID();
  const time = new Date().toISOString();
  const record: LocalFeedPost = {
    assistantId, revision: 0, mutationId: crypto.randomUUID(),
    content: { ...content, textEdited: content.textEdited || Boolean(content.text) },
    dirty: true, newSession: true,
    session: { id, platform, title: `[${platform}] ${content.title || "New draft"}`,
      startedBy: { id: owner, name: null }, createdAt: time, lastActiveAt: time,
      preview: content.privateBrief, replyTarget: null, draftText: content.text,
      selectedDraft: null, seedKind: "freeform",
      draftCounts: { pending: 0, ready: 0, posted: 0, rejected: 0, deleted: 0 } },
  };
  await idbUpdate<Records>(key(owner), old => {
    if (feedOwner() !== owner) throw new Error("Local identity changed");
    return { ...old, [recordKey(assistantId, id)]: record };
  });
  changed(); notifyFeedPostsChanged();
  return record;
}

/** Initial restore must not overwrite a keystroke from another window. */
export async function loadFeedWorkingCopy(assistantId: string, session: FeedDraftSessionSummary, fallback: FeedWorkingContent): Promise<LocalFeedPost> {
  const owner = ownerRequired();
  const local = await readLocalFeedPost(assistantId, session.id);
  if (local?.dirty) return local;
  const remote = await feedCachedJson<{ copy: FeedWorkingCopy | null }>(
    `/api/distribution/${assistantId}/post-working-copies/${session.id}`,
  ).catch(() => null);
  if (feedOwner() !== owner) throw new Error("Local identity changed");
  const id = recordKey(assistantId, session.id);
  const records = await idbUpdate<Records>(key(owner), old => {
    if (feedOwner() !== owner) throw new Error("Local identity changed");
    if (old?.[id]?.dirty) return old;
    const baseline = { revision: 0, mutationId: crypto.randomUUID(), content: fallback };
    const copy = remote ? remote.copy ?? baseline : local ?? baseline;
    return { ...old, [id]: { ...copy, assistantId, session, dirty: false, newSession: false } };
  });
  return records[id];
}

/** Partial patches merge inside one IndexedDB transaction, including empty fields. */
export async function patchFeedWorkingCopy(assistantId: string, sessionId: string, patch: Partial<FeedWorkingContent>): Promise<LocalFeedPost> {
  const owner = ownerRequired();
  const id = recordKey(assistantId, sessionId);
  const records = await idbUpdate<Records>(key(owner), old => {
    if (feedOwner() !== owner) throw new Error("Local identity changed");
    const current = old?.[id];
    if (!current) throw new Error("Working copy not loaded");
    const content = { ...current.content, ...patch, ...(patch.text !== undefined ? { textEdited: true } : {}) };
    if (JSON.stringify(content) === JSON.stringify(current.content)) return old!;
    return { ...old, [id]: { ...current, content, dirty: true, mutationId: crypto.randomUUID() } };
  });
  changed(); return records[id];
}

export async function mergeLocalFeedSessions(assistantId: string, sessions: FeedDraftSessionSummary[], platform?: FeedPlatform) {
  const merged = new Map(sessions.map(s => [s.id, s]));
  for (const post of await readLocalFeedPosts()) {
    if (post.assistantId !== assistantId || (platform && post.session.platform !== platform)) continue;
    const remote = merged.get(post.session.id);
    if (!remote && !post.dirty) continue;
    merged.set(post.session.id, { ...(remote ?? post.session),
      ...(post.dirty ? { title: `[${post.session.platform}] ${post.content.title || "New draft"}` } : {}),
      draftText: post.content.text || remote?.draftText || null,
    });
  }
  return [...merged.values()];
}

let flushing: Promise<void> | null = null;
export function flushFeedWorkingCopies(): Promise<void> {
  if (flushing) return flushing;
  flushing = replay().finally(() => { flushing = null; });
  return flushing;
}
async function replay() {
  const owner = feedOwner();
  if (!owner || !navigator.onLine) return;
  for (const post of await readLocalFeedPosts()) {
    if (!post.dirty || post.error === "conflict") continue;
    if (!navigator.onLine || feedOwner() !== owner) return;
    try {
      const id = recordKey(post.assistantId, post.session.id);
      // Persist the exact request before sending. A response can disappear
      // while newer keystrokes are saved; retry the old request first.
      const records = await idbUpdate<Records>(key(owner), old => {
        if (feedOwner() !== owner) throw new Error("Local identity changed");
        const current = old?.[id];
        if (!current?.dirty) return old ?? {};
        return { ...old, [id]: { ...current, inFlight: current.inFlight ?? {
          revision: current.revision, mutationId: current.mutationId, content: current.content,
          baseTitle: current.session.title,
          ...(current.newSession ? { create: { platform: current.session.platform } } : {}),
        } } };
      });
      const flight = records[id]?.inFlight;
      if (!flight || feedOwner() !== owner) continue;
      const response = await authFetch(`${FEED_API_URL}/api/distribution/${post.assistantId}/post-working-copies/${post.session.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify(flight),
      });
      if (feedOwner() !== owner) return;
      if (!response.ok) {
        if ([400, 403, 404, 409].includes(response.status)) {
          let updated = false;
          await idbUpdate<Records>(key(owner), old => {
            if (feedOwner() !== owner) throw new Error("Local identity changed");
            const current = old?.[id];
            const error = response.status === 409 ? "conflict" : "blocked";
            if (!current || current.inFlight?.mutationId !== flight.mutationId || current.error === error) return old ?? {};
            updated = true;
            return { ...old, [id]: { ...current, error } };
          });
          if (updated) changed();
        }
        continue;
      }
      const { copy } = await response.json() as { copy: FeedWorkingCopy };
      if (copy.mutationId !== flight.mutationId || copy.revision !== flight.revision + 1) continue;
      await idbUpdate<Records>(key(owner), old => {
        if (feedOwner() !== owner) throw new Error("Local identity changed");
        const current = old?.[id];
        if (!current || current.inFlight?.mutationId !== flight.mutationId) return old ?? {};
        return { ...old, [id]: { ...current, revision: copy.revision, newSession: false, inFlight: undefined,
          dirty: current.mutationId !== flight.mutationId, error: undefined } };
      });
      changed(); notifyFeedPostsChanged();
    } catch { /* Durable work remains pending. Other posts may still sync. */ }
  }
}

/** Resolve a conflict without overwriting the shared copy. */
export async function forkLocalFeedPost(post: LocalFeedPost) {
  const owner = ownerRequired();
  const current = await readLocalFeedPost(post.assistantId, post.session.id);
  if (!current || feedOwner() !== owner) throw new Error("Local identity changed");
  const created = await createLocalFeedPost(post.assistantId, post.session.platform, current.content);
  await idbUpdate<Records>(key(owner), old => {
    if (feedOwner() !== owner) throw new Error("Local identity changed");
    const id = recordKey(post.assistantId, post.session.id);
    // Another window may still be editing the original during recovery.
    if (old?.[id]?.mutationId !== current.mutationId) return old ?? {};
    const next = { ...old }; delete next[id]; return next;
  });
  changed(); return created;
}

export async function readFeedNewPostForm(assistantId: string, platform: FeedPlatform) {
  const owner = feedOwner();
  const form = await idbGet<FeedWorkingContent>(`feed:form:${owner}:${assistantId}:${platform}`);
  return feedOwner() === owner ? form : null;
}
export async function writeFeedNewPostForm(assistantId: string, platform: FeedPlatform, content: FeedWorkingContent) {
  const owner = ownerRequired();
  await idbUpdate(`feed:form:${owner}:${assistantId}:${platform}`, () => {
    if (feedOwner() !== owner) throw new Error("Local identity changed");
    return content;
  });
}
