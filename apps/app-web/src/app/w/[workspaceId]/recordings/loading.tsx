/**
 * `recordings/` fallback - covers entry into `/recordings` and every sub-route swap under
 * it. The recording detail route is a media pane plus transcript cards - the grid shape, with its own chrome row.
 * Before this boundary existed the pane blanked (or showed a bare "...") for
 * the whole segment load (instant-navigation contract N4).
 *
 * Spec: docs/architecture/features/perceived-performance.md
 */

import { GridSurfaceSkeleton } from "@/components/chrome/surface-skeleton";

export default function RecordingsLoading() {
  return <GridSurfaceSkeleton />;
}
