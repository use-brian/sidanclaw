"use client";

/**
 * Shopify operator surface route — thin wrapper, matching the CRM/Feed
 * disposition: the meat lives in `@/components/shopify/shopify-surface`
 * (`[COMP:app-web/shopify-app]`) so the desktop SPA can import the client
 * component directly. The Suspense boundary covers `useSearchParams` (the
 * `?section=` codec).
 *
 * Spec: docs/architecture/integrations/shopify.md → "The built-in app".
 */

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { SurfaceSkeletonFor } from "@/components/chrome/surface-skeleton";
import { ShopifySurface } from "@/components/shopify/shopify-surface";

export default function ShopifyPage() {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params?.workspaceId ?? "";
  return (
    // The same rail frame `loading.tsx` draws, so a `useSearchParams` bailout
    // never swaps the skeleton for a bare ellipsis (N4).
    <Suspense fallback={<SurfaceSkeletonFor surface="shopify" />}>
      <ShopifySurface workspaceId={workspaceId} />
    </Suspense>
  );
}
