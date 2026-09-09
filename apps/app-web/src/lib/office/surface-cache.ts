/**
 * Office-side helpers over the ONE surface cache (`lib/surface-cache.ts`).
 *
 * Office has no workspace-event spine primitive (`realtime-sync.md`: the
 * spine covers pages, tasks, CRM, approvals, workflows, assistants, skills,
 * live and inbox - not office artifacts), so the two surfaces cannot rely on
 * `useSurfaceCacheInvalidation` to go stale when a teammate edits. Their
 * revalidation triggers are therefore the other two the instant-navigation
 * contract names (N3): mount, and the tab coming back to the foreground.
 * `useOfficeCacheRevalidation` is the second one - it MARKS stale, never
 * invalidates, so the list or editor keeps painting while it refetches.
 *
 * `officeArtifactFromListCache` is what lets the editor paint its chrome
 * (title, family) on the first frame after a tap on a home card: the home
 * just rendered that row from `office:<wid>:…`, so the shell reads it back
 * while the artifact row and snapshot are still in flight.
 *
 * Spec: docs/architecture/features/perceived-performance.md ->
 * "Instant-navigation contract". [COMP:app-web/office-surface-cache]
 */

import { useEffect } from "react";
import type { OfficeArtifact } from "@/lib/office/api";
import { markSurfaceCacheStale, readSurfaceCache } from "@/lib/surface-cache";
import { officeListCacheKey, type OfficeListView } from "@/lib/surface-prefetch";

/** Every lifecycle view the home lists, in the order a tap most likely came from. */
const OFFICE_LIST_VIEWS: readonly OfficeListView[] = ["active", "archived", "trash", "retained"];

/**
 * The artifact's row as the home last painted it, from whichever view's
 * cached list carries it - or null when no list of this workspace is cached.
 * A list row is the same `OfficeArtifact` shape the row endpoint returns, so
 * the shell can paint title / family / role from it; it is never used to
 * decide anything the snapshot decides.
 */
export function officeArtifactFromListCache(workspaceId: string, artifactId: string): OfficeArtifact | null {
  for (const view of OFFICE_LIST_VIEWS) {
    const rows = readSurfaceCache<OfficeArtifact[]>(officeListCacheKey(workspaceId, view)).data;
    const row = rows?.find((candidate) => candidate.artifactId === artifactId);
    if (row) return row;
  }
  return null;
}

/**
 * Mark the given cache prefixes stale whenever the tab returns to the
 * foreground. Stale, not gone: the mounted surface repaints from what it has
 * and `useCachedResource` refetches behind the paint.
 */
export function useOfficeCacheRevalidation(prefixes: readonly string[]): void {
  const joined = prefixes.join("|");
  useEffect(() => {
    if (typeof document === "undefined" || !joined) return;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      for (const prefix of joined.split("|")) markSurfaceCacheStale(prefix);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [joined]);
}
