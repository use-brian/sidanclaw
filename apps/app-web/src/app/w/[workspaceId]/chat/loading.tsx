/**
 * `chat/` fallback - covers entry into `/chat` and every sub-route swap under
 * it. Chat opens as a narrow session rail beside a wide transcript; the surface has no chrome-rendering layout, so this boundary owns the topbar row too.
 * Before this boundary existed the pane blanked (or showed a bare "...") for
 * the whole segment load (instant-navigation contract N4).
 *
 * Spec: docs/architecture/features/perceived-performance.md
 */

import { RailSurfaceSkeleton } from "@/components/chrome/surface-skeleton";

export default function ChatLoading() {
  return <RailSurfaceSkeleton />;
}
