/**
 * `office/` fallback - covers entry into `/office` and every sub-route swap under
 * it. Office home is a card grid under its own operator topbar; `office/layout.tsx` renders no chrome (it only layers the intercepted dialogs), so this boundary owns the topbar row too.
 * Before this boundary existed the pane blanked (or showed a bare "...") for
 * the whole segment load (instant-navigation contract N4).
 *
 * Spec: docs/architecture/features/perceived-performance.md
 */

import { GridSurfaceSkeleton } from "@/components/chrome/surface-skeleton";

export default function OfficeLoading() {
  return <GridSurfaceSkeleton />;
}
