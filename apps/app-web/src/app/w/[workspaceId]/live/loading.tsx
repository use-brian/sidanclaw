/**
 * `live/` fallback - covers entry into `/live` and every sub-route swap under
 * it. Live is master-detail (roster rail + watch pane) with no chrome-rendering layout, so this boundary owns the topbar row too.
 * Before this boundary existed the pane blanked (or showed a bare "...") for
 * the whole segment load (instant-navigation contract N4).
 *
 * Spec: docs/architecture/features/perceived-performance.md
 */

import { RailSurfaceSkeleton } from "@/components/chrome/surface-skeleton";

export default function LiveLoading() {
  return <RailSurfaceSkeleton />;
}
