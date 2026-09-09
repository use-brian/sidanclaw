/**
 * The ONE spine-to-cache map (instant-navigation contract N3).
 *
 * The workspace event spine (`lib/workspace-events.ts`, mounted once in
 * `WorkspaceChrome`) routes server change signals to per-domain window
 * CustomEvents. Before this map every surface that wanted to react carried its
 * own listener and refetched through its own loader - and the two cached
 * surfaces that never got one (Tasks, CRM) painted a task or deal an assistant
 * wrote from chat into the sidebar counts but not into the open list until
 * the 30s stale window elapsed. This hook subscribes ONCE, beside
 * `useWorkspaceEvents`, and translates each domain event into
 * `markSurfaceCacheStale` calls on the cache-key prefixes that domain feeds.
 *
 * Mark stale, never invalidate: a spine signal is "something changed
 * somewhere", so the open list keeps painting and revalidates behind the
 * paint (`useCachedResource` already refetches a stale entry). Only a user
 * action that changed the row invalidates. The catch-up burst the spine fires
 * on every stream `open` and tab-visible therefore becomes a mark-stale burst
 * instead of a refetch burst: nothing refetches until a mounted surface
 * actually reads the key.
 *
 * `staleMarksFor` is the pure routing table so the map is unit-tested without
 * a window; the hook is the thin listener over it. Keys are workspace-first
 * (`<resource>:<workspaceId>...`), so every prefix below scopes to the one
 * workspace the chrome is showing; events that name another workspace are
 * ignored.
 *
 * Spec: docs/architecture/features/perceived-performance.md ->
 * "Instant-navigation contract"; docs/architecture/platform/realtime-sync.md
 * -> "Web client".
 * [COMP:app-web/surface-cache-invalidation]
 */

import { useEffect } from "react";
import { BRAIN_REFRESH_EVENT } from "@/lib/brain-events";
import { APPROVALS_REFRESH_EVENT } from "@/lib/approvals-events";
import { WORKFLOW_REFRESH_EVENT } from "@/lib/workflow-events";
import { ASSISTANT_REFRESH_EVENT } from "@/lib/assistant-events";
import { HOME_APPS_REFRESH_EVENT } from "@/lib/home-apps-events";
import { INBOX_REFRESH_EVENT } from "@/lib/inbox-refresh-events";
import {
  LIVE_REFRESH_EVENT,
  SKILL_REFRESH_EVENT,
} from "@/lib/workspace-events";
import { markSurfaceCacheStale } from "@/lib/surface-cache";

/**
 * Domain event -> the cache-key prefixes it makes stale, for one workspace.
 * A prefix ending in `:` is a family; a bare `<resource>:<wid>` is the family
 * of every viewer-keyed variant of that list (`tasks:<wid>:<viewer>`).
 *
 * Prefixes for surfaces that have not adopted the cache yet (`approvals:`,
 * `skills:`, `live:`, `inbox:`, `home-apps:`, `chat-roster:`) are listed now
 * so adoption is a one-line change on the surface, never a second map.
 */
export function staleMarksFor(event: string, workspaceId: string): string[] {
  switch (event) {
    case BRAIN_REFRESH_EVENT:
      // Tasks, contacts / companies / deals and the graph are all brain
      // primitives on the server side.
      return [`tasks:${workspaceId}`, `crm:${workspaceId}:`, `brain-graph:${workspaceId}:`];
    case APPROVALS_REFRESH_EVENT:
      return [`approvals:${workspaceId}`, `crm:${workspaceId}:`];
    case WORKFLOW_REFRESH_EVENT:
      // The detail key is mark-stale only, never invalidate: an open editable
      // draft must not be clobbered (realtime-sync.md -> editable-draft rule).
      return [`workflow:${workspaceId}`, `workflow-detail:${workspaceId}:`];
    case ASSISTANT_REFRESH_EVENT:
      return [`assistants:${workspaceId}`, `chat-roster:${workspaceId}`];
    case SKILL_REFRESH_EVENT:
      return [`skills:${workspaceId}`];
    case LIVE_REFRESH_EVENT:
      return [`live:${workspaceId}`];
    case INBOX_REFRESH_EVENT:
      return [`inbox:${workspaceId}`];
    case HOME_APPS_REFRESH_EVENT:
      return [`home-apps:${workspaceId}`, `association-module:${workspaceId}`];
    default:
      return [];
  }
}

/** Every domain event the map listens to. */
export const SURFACE_CACHE_SPINE_EVENTS: readonly string[] = [
  BRAIN_REFRESH_EVENT,
  APPROVALS_REFRESH_EVENT,
  WORKFLOW_REFRESH_EVENT,
  ASSISTANT_REFRESH_EVENT,
  SKILL_REFRESH_EVENT,
  LIVE_REFRESH_EVENT,
  INBOX_REFRESH_EVENT,
  HOME_APPS_REFRESH_EVENT,
];

/**
 * Apply one domain event to the cache: mark every prefix the event feeds.
 * Exported for the listener and for tests; an event whose detail names a
 * DIFFERENT workspace is ignored (a `null` / absent workspace id is the
 * catch-up shape and applies).
 */
export function applySpineEventToSurfaceCache(
  event: string,
  detail: { workspaceId?: string | null } | null | undefined,
  workspaceId: string,
): void {
  if (detail?.workspaceId && detail.workspaceId !== workspaceId) return;
  for (const prefix of staleMarksFor(event, workspaceId)) {
    markSurfaceCacheStale(prefix);
  }
}

/**
 * React hook - mounted ONCE in `WorkspaceChrome` beside `useWorkspaceEvents`.
 * Surfaces need no listener of their own to stay live: they read the cache,
 * and the cache goes stale here.
 */
export function useSurfaceCacheInvalidation(
  workspaceId: string | null | undefined,
): void {
  useEffect(() => {
    if (!workspaceId || typeof window === "undefined") return;
    const handlers = SURFACE_CACHE_SPINE_EVENTS.map((event) => {
      const handler = (e: Event) => {
        applySpineEventToSurfaceCache(
          event,
          (e as CustomEvent<{ workspaceId?: string | null }>).detail,
          workspaceId,
        );
      };
      window.addEventListener(event, handler);
      return [event, handler] as const;
    });
    return () => {
      for (const [event, handler] of handlers) {
        window.removeEventListener(event, handler);
      }
    };
  }, [workspaceId]);
}
