/**
 * Offline write manager for ALL clients (originally Phase 5 of
 * docs/plans/doc-desktop-bundled-offline.md, un-gated when the web app went
 * offline-first). Wraps the *non-Yjs* REST writes (page rename / icon /
 * clearance / full-width today) so they queue when offline and replay on
 * reconnect, instead of failing. In-doc edits already survive offline via
 * Yjs + `y-indexeddb`; this covers the metadata writes around them.
 *
 * While the `online` flag (kept fresh by `use-offline-sync`) is up,
 * `offlineWrite` runs the SDK call directly — identical to calling it inline.
 * Offline, it queues.
 *
 * Metadata includes locally-created pages. Their durable creation outbox
 * registers pages before this queue replays. Failed writes remain pending.
 *
 * [COMP:app-web/offline-writes]
 */

import {
  renameView,
  setViewIcon,
  setViewFullWidth,
  setViewClearance,
} from "@/lib/api/views";
import { idbGet, idbUpdate } from "./idb";
import {
  enqueueWrite,
  serializeQueue,
  parseQueue,
  type QueuedWrite,
} from "./write-queue";

const QUEUE_KEY = "offline:write-queue";

// ── Connectivity flag (kept fresh by use-offline-sync) ─────────
// Defaults online so writes go straight through before the hook mounts.
let online = true;
const onlineListeners = new Set<(online: boolean) => void>();
export function setOnline(value: boolean): void {
  if (online === value) return;
  online = value;
  for (const l of onlineListeners) l(online);
}
export function getOnline(): boolean {
  return online;
}
/** Subscribe to connectivity changes (drives `useIsOffline()`). */
export function subscribeOnline(listener: (online: boolean) => void): () => void {
  onlineListeners.add(listener);
  return () => {
    onlineListeners.delete(listener);
  };
}

// ── The persisted queue ────────────────────────────────────────
let queue: QueuedWrite[] = [];
let loaded = false;
const countListeners = new Set<(count: number) => void>();

function emitCount(): void {
  for (const l of countListeners) l(queue.length);
}

/** Subscribe to the pending-write count (for the "N pending" badge). */
export function subscribePendingCount(listener: (count: number) => void): () => void {
  countListeners.add(listener);
  listener(queue.length);
  return () => {
    countListeners.delete(listener);
  };
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  const raw = await idbGet<string>(QUEUE_KEY);
  queue = raw ? parseQueue(raw) : [];
  loaded = true;
  emitCount();
}

async function updateQueue(update: (current: QueuedWrite[]) => QueuedWrite[]): Promise<void> {
  const raw = await idbUpdate<string>(QUEUE_KEY, (value) => serializeQueue(update(value ? parseQueue(value) : [])));
  queue = parseQueue(raw);
  loaded = true;
  emitCount();
}

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `op-${Date.now().toString(36)}-${Math.round(Math.random() * 1e9).toString(36)}`;
  }
}

export interface OfflineWriteSpec<R> {
  /** Op kind (must have an entry in EXECUTORS for replay). */
  kind: string;
  /** Coalesce key, or null to keep individually. */
  coalesceKey: string | null;
  /** Serializable args the replay executor needs. */
  payload: unknown;
  /** The live SDK call (used online). */
  exec: () => Promise<R>;
  /** Apply the server result (online). */
  onResult?: (result: R) => void;
  /** Apply an optimistic local update (offline — there's no server result). */
  optimistic?: () => void;
}

/**
 * Run a write now (online) — calling `exec` then `onResult`, propagating
 * errors so the caller's existing try/catch surfaces them — OR, when offline,
 * enqueue it for replay and apply the optimistic update without throwing.
 */
export async function offlineWrite<R>(spec: OfflineWriteSpec<R>): Promise<void> {
  const payload = spec.payload as { id?: string; name?: string; icon?: string | null; fullWidth?: boolean; clearance?: "public" | "internal" | "confidential" };
  const { readLocalPage, patchLocalPage } = await import("./offline-pages");
  const local = payload?.id ? await readLocalPage(payload.id) : null;
  await ensureLoaded();
  const pendingForPage = payload?.id && queue.some((op) => (op.payload as { id?: string })?.id === payload.id);
  if (online && !local && !pendingForPage) {
    const result = await spec.exec();
    spec.onResult?.(result);
    return;
  }
  await updateQueue((current) => enqueueWrite(current, {
    id: randomId(),
    kind: spec.kind,
    payload: spec.payload,
    coalesceKey: spec.coalesceKey,
    enqueuedAt: Date.now(),
    attempts: 0,
  }));
  if (payload?.id) {
    const patch = spec.kind === "view.rename" ? { name: payload.name, nameOrigin: "user" as const }
      : spec.kind === "view.icon" ? { icon: payload.icon }
      : spec.kind === "view.fullWidth" ? { fullWidth: payload.fullWidth }
      : spec.kind === "view.clearance" ? { clearance: payload.clearance } : {};
    await patchLocalPage(payload.id, patch);
  }
  spec.optimistic?.();
}

// ── Replay ──────────────────────────────────────────────────────
// Maps a queued op's kind + payload back to the real SDK call. Keep in sync with
// the `offline*` wrappers below.
type RenamePayload = { id: string; name: string };
type IconPayload = { id: string; icon: string | null };
type FullWidthPayload = { id: string; fullWidth: boolean };
type ClearancePayload = { id: string; clearance: "public" | "internal" | "confidential" };

const EXECUTORS: Record<string, (payload: unknown) => Promise<unknown>> = {
  "view.rename": (p) => renameView((p as RenamePayload).id, (p as RenamePayload).name),
  "view.icon": (p) => setViewIcon((p as IconPayload).id, (p as IconPayload).icon),
  "view.fullWidth": (p) => setViewFullWidth((p as FullWidthPayload).id, (p as FullWidthPayload).fullWidth),
  "view.clearance": (p) => setViewClearance((p as ClearancePayload).id, (p as ClearancePayload).clearance),
};

let flushing: Promise<void> | null = null;
/** Replay one snapshot; concurrently appended/coalesced writes are preserved. */
export function flushWriteQueue(): Promise<void> {
  if (flushing) return flushing;
  flushing = flush().finally(() => { flushing = null; });
  return flushing;
}
async function flush(): Promise<void> {
  await ensureLoaded();
  // Re-read on every attempt, including after another tab writes to IndexedDB.
  queue = parseQueue((await idbGet<string>(QUEUE_KEY)) ?? "[]");
  emitCount();
  for (const op of queue.slice()) {
    try {
      const { readLocalPage } = await import("./offline-pages");
      const id = (op.payload as { id?: string })?.id;
      if (id && await readLocalPage(id)) return;
      const fn = EXECUTORS[op.kind];
      if (!fn) throw new Error(`Unknown queued write: ${op.kind}`);
      await fn(op.payload);
      await updateQueue((current) => current.filter((q) =>
        q.id !== op.id || JSON.stringify(q) !== JSON.stringify(op)));
    } catch {
      // Authored changes must never disappear after repeated network failures.
      return;
    }
  }
}
