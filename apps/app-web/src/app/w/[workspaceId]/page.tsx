"use client";

/**
 * The workspace root — forwards to the workspace's Home app.
 *
 * This used to be a server component that hard-redirected to `/p`. It cannot
 * be any more: which apps a workspace shows is configuration
 * (`workspaces.home_apps`, migration 385) and Page may be deselected, so a
 * fixed `/p` would drop those workspaces onto a surface that is not on their
 * strip. Home resolution is now one rule everywhere — the persisted app and
 * its last safe pathname, constrained to the configured list and falling back
 * to its first entry (`homePath`, `lib/operator-apps.ts`). The daily/+3
 * approvals cadence may then replace that resume destination with the explicit
 * Suggested briefing (`homeLandingPath`, `lib/suggested-landing.ts`).
 *
 * Resolution is client-side because the sticky selection lives in
 * localStorage. It sits under the workspace layout, so the config is already
 * in the sidebar-data provider — no extra fetch.
 *
 * **The dock decides the landing from the cache** (instant-navigation
 * contract N1). The Suggested decision needs the home dock's approval count,
 * and this route used to render NOTHING until `fetchHomeDock` resolved -
 * every cold entry to `/w/<id>` paid a round trip with a blank pane just to
 * pick a destination. The provider now reads the dock through the shared
 * `homeDockCacheKey` slot, so a dock the app already holds (a revisit, a
 * warm from another surface) decides synchronously on the first frame while
 * the provider revalidates behind it. Only a genuinely cold dock waits, and
 * while it does this route paints the destination's skeleton
 * (`SurfaceSkeletonFor` on the resume path, the shape `loading.tsx` uses)
 * rather than `null` (N4).
 *
 * The desktop quick-capture (`?capture=1`) and recorder (`?record=1`) hints
 * always land on `/p` regardless of config: both are doc-surface affordances
 * (open a fresh draft, start the dock recorder), so honouring them anywhere
 * else would silently drop what the user was capturing.
 * Stripe's one-shot `checkout` / `session_id` handoff is also preserved onto
 * the resolved Home path so the workspace plan gate can reconcile it there.
 *
 * Spec: docs/architecture/features/home-apps.md → "Home resolution";
 * docs/architecture/features/perceived-performance.md → "Instant-navigation
 * contract".
 * [COMP:app-web/workspace-root]
 */

import { Suspense, useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useSidebarData } from "@/components/doc/doc-sidebar-data";
import { SurfaceSkeletonFor } from "@/components/chrome/surface-skeleton";
import { surfaceFromPathname } from "@/lib/doc-page-url";
import { homePath } from "@/lib/operator-apps";
import { pendingApprovalTotal } from "@/lib/api/home-dock";
import { homeLandingPath } from "@/lib/suggested-landing";
import { forwardPlanGateCheckoutReturn } from "@/lib/plan-gate";
import { useBrianWorkspacePath } from "@/lib/siri-use-brian";

function WorkspaceRootRedirect() {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params?.workspaceId ?? "";
  const router = useRouter();
  const searchParams = useSearchParams();
  const { homeApps, dock, dockLoading } = useSidebarData();
  // The resume destination is known synchronously (localStorage + the
  // provider's config); only the Suggested override waits on the dock.
  const resumePath = workspaceId ? homePath(workspaceId, homeApps) : null;
  // A dock in hand - fresh or stale - decides now; the provider revalidates
  // behind the paint. Only a cold miss with a load in flight waits.
  const waitingForDock = dock === null && dockLoading;

  useEffect(() => {
    if (!workspaceId || !resumePath) return;
    const capture = searchParams?.get("capture") === "1";
    const record = searchParams?.get("record") === "1";
    if (capture || record) {
      router.replace(`/w/${workspaceId}/p?${capture ? "capture=1" : "record=1"}`);
      return;
    }
    const useBrianPath = useBrianWorkspacePath(
      workspaceId,
      searchParams?.get("useBrian"),
    );
    if (useBrianPath) {
      router.replace(useBrianPath);
      return;
    }
    if (waitingForDock) return;
    router.replace(
      forwardPlanGateCheckoutReturn(
        homeLandingPath(
          workspaceId,
          resumePath,
          pendingApprovalTotal(dock),
        ),
        searchParams?.toString() ?? "",
      ),
    );
  }, [dock, waitingForDock, resumePath, router, searchParams, workspaceId]);

  // Paint the frame of where we are going while the dock (cold only) or the
  // navigation itself is pending - never a blank pane.
  return <SurfaceSkeletonFor surface={surfaceFromPathname(resumePath ?? "")} />;
}

export default function WorkspaceRootPage() {
  return (
    <Suspense fallback={<SurfaceSkeletonFor surface={null} />}>
      <WorkspaceRootRedirect />
    </Suspense>
  );
}
