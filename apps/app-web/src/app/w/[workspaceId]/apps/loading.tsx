/**
 * `apps/` fallback - covers entry into `/apps` and every sub-route swap under
 * it. A custom home app is one full-bleed pane under a chrome row - the page shape.
 * Before this boundary existed the pane blanked (or showed a bare "...") for
 * the whole segment load (instant-navigation contract N4).
 *
 * Spec: docs/architecture/features/perceived-performance.md
 */

import { SurfaceSkeletonFor } from "@/components/chrome/surface-skeleton";

export default function AppsLoading() {
  return <SurfaceSkeletonFor surface="apps" />;
}
