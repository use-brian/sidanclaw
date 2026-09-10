/**
 * `goals/` fallback - covers entry into `/goals` and every sub-route swap under
 * it. The goals index redirects into the doc-shell panel; this boundary covers the `[goalId]` detail route, a list-shaped page with its own chrome row.
 * Before this boundary existed the pane blanked (or showed a bare "...") for
 * the whole segment load (instant-navigation contract N4).
 *
 * Spec: docs/architecture/features/perceived-performance.md
 */

import { ListSurfaceSkeleton } from "@/components/chrome/surface-skeleton";

export default function GoalsLoading() {
  return <ListSurfaceSkeleton />;
}
