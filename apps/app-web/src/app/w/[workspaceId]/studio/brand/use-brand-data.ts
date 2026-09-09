"use client";

/**
 * Studio -> Brand data layer (instant-navigation contract N1 / N2 / N7).
 *
 * One key (`brandCacheKey`) holds the default brand record, whether the
 * caller may approve, and the approved-version history. The versions read
 * needs the brand id the `/default` read returns (`listVersions` takes a
 * real id), so it is a data dependency INSIDE the one fetcher rather than a
 * second effect; the 404 branch (no brand yet) reads the list endpoint for
 * `canApprove` and returns an empty snapshot.
 *
 * The page is an editable-draft surface: a revalidated record is adopted
 * into the form only when the form is not dirty (the workflow-editor rule in
 * realtime-sync.md), and no spine primitive covers brand today.
 *
 * [COMP:app-web/studio-lists-cache]
 */

import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import { useCallback } from "react";
import { authFetch } from "@/lib/auth-fetch";
import type { BrandRecordLike } from "@/lib/brand-form";
import { mutateSurfaceCache, useCachedResource } from "@/lib/surface-cache";
import { brandCacheKey } from "@/lib/surface-prefetch";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

export type BrandSummary = {
  id: string;
  slug: string;
  name: string;
  isDefault: boolean;
  status: "draft" | "active" | "superseded";
  activeVersion: number | null;
  hasDraft: boolean;
};

export type BrandDetail = BrandSummary & {
  draft: BrandRecordLike | null;
  activeRecord: BrandRecordLike | null;
};

export type BrandVersion = {
  id: string;
  version: number;
  approvedBy: string | null;
  approvedAt: string;
};

export type BrandSnapshot = {
  /** null when the workspace has no brand record yet (the create state). */
  brand: BrandDetail | null;
  canApprove: boolean;
  versions: BrandVersion[];
};

export function brandApiBase(workspaceId: string): string {
  return `${API_URL}/api/workspaces/${workspaceId}/brand`;
}

export async function fetchBrandSnapshot(workspaceId: string): Promise<BrandSnapshot> {
  const base = brandApiBase(workspaceId);
  const res = await authFetch(`${base}/default`);
  if (res.status === 404) {
    const listRes = await authFetch(base);
    const canApprove = listRes.ok ? Boolean((await listRes.json()).canApprove) : false;
    return { brand: null, canApprove, versions: [] };
  }
  if (!res.ok) throw new Error(String(res.status));
  const body = (await res.json()) as { brand: BrandDetail; canApprove?: boolean };
  const vRes = await authFetch(`${base}/${body.brand.id}/versions`);
  const versions = vRes.ok
    ? (((await vRes.json()).versions ?? []) as BrandVersion[])
    : [];
  return { brand: body.brand, canApprove: Boolean(body.canApprove), versions };
}

export function useBrandData(workspaceId: string | null) {
  const key = workspaceId ? brandCacheKey(workspaceId) : null;
  const res = useCachedResource<BrandSnapshot>(key, () =>
    fetchBrandSnapshot(workspaceId as string),
  );

  /** Write a saved record back so the next visit paints it (draft save). */
  const updateBrand = useCallback(
    (brand: BrandDetail) => {
      mutateSurfaceCache<BrandSnapshot>(key, (prev) => ({ ...prev, brand }));
    },
    [key],
  );

  return {
    /** undefined until the first snapshot lands (cold) - the skeleton state. */
    data: res.data,
    loading: res.loading,
    revalidating: res.revalidating,
    error: res.data === undefined ? res.error : undefined,
    refresh: res.refresh,
    updateBrand,
  };
}
