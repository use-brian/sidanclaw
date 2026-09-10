/** Viewer-scoped Feed reads. [COMP:app-web/feed-offline] */
import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import { authFetch } from "@/lib/auth-fetch";
import { getUserInfo } from "@/lib/user";
import { desktopBridge, isDesktopAuth } from "@/lib/desktop-auth-source";
import { loadSurfaceCache, readSurfaceCache } from "@/lib/surface-cache";
import { idbDelete, idbGet, idbSet } from "./idb";

export const FEED_API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";
export const feedOwner = () => getUserInfo()?.id ?? "";
export class FeedReadError extends Error {
  constructor(public status: number) { super(`Feed API ${status}`); }
}

/** A 401 / 403 / 404 is the server saying "not yours": evict, never fall back. */
export function isAuthoritativeFeedDenial(error: unknown): boolean {
  return error instanceof FeedReadError && [401, 403, 404].includes(error.status);
}

const cacheKey = (owner: string, path: string) => `feed:cache:${owner}:${path}`;

/**
 * PAINT-FIRST read of a cached Feed response (instant-navigation contract N1).
 * Unlike `feedCachedJson`, which is network-first and only returns the disk
 * copy when the network is down, this returns whatever the viewer's IndexedDB
 * tier holds regardless of connectivity, so a surface can render it on the
 * first frame and revalidate behind it. Viewer-scoped by construction: the key
 * carries the signed-in id, and an identity change mid-read returns nothing.
 * `path` is the API path `feedCachedJson` stored, or a composed-record name
 * written by `writeFeedCachedJson`.
 */
export async function readFeedCachedJson<T>(path: string): Promise<T | null> {
  const owner = feedOwner();
  if (!owner) return null;
  const cached = await idbGet<T>(cacheKey(owner, path));
  return cached !== null && feedOwner() === owner ? cached : null;
}

/** Store a composed record under the same viewer-scoped namespace. Best-effort. */
export async function writeFeedCachedJson(path: string, value: unknown): Promise<void> {
  const owner = feedOwner();
  if (!owner) return;
  await idbSet(cacheKey(owner, path), value);
}

/** Drop a composed record (an authoritative denial, a sign-out sweep). */
export async function deleteFeedCachedJson(path: string): Promise<void> {
  const owner = feedOwner();
  if (!owner) return;
  await idbDelete(cacheKey(owner, path));
}

/**
 * The Feed surfaces' disk tier, composed over `useCachedResource`.
 *
 * A COLD memory key (nothing cached for this workspace + viewer yet: a reload,
 * a first visit this session) resolves with the IndexedDB copy the moment the
 * disk answers, and the network request - started at the same time, never
 * after - lands behind it through a second `loadSurfaceCache` write. The
 * surface therefore paints last-known rows in milliseconds and patches in
 * place when the server answers. A WARM key skips the disk entirely: memory
 * is always at least as fresh as disk, so a revalidation or an explicit
 * `refresh()` is network-only. Nothing on disk means the network is awaited
 * as before. The network loader owns disk writes and denial evictions.
 */
export async function feedPaintFirst<T>(
  key: string,
  disk: () => Promise<T | null>,
  network: () => Promise<T>,
): Promise<T> {
  if (readSurfaceCache<T>(key).data !== undefined) return network();
  const fresh = network();
  // A disk hit returns before `fresh` settles; the rejection is observed by
  // the background write below, so it must not also surface as unhandled.
  fresh.catch(() => undefined);
  const cached = await disk().catch(() => null);
  if (cached === null) return fresh;
  void fresh.then(
    (value) => {
      void loadSurfaceCache(key, async () => value);
    },
    () => undefined,
  );
  return cached;
}
export async function feedCachedJson<T>(path: string): Promise<T> {
  const owner = feedOwner();
  const key = `feed:cache:${owner}:${path}`;
  const cached = owner ? await idbGet<T>(key) : null;
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    if (cached !== null && feedOwner() === owner) return cached;
    throw new FeedReadError(0);
  }
  try {
    const response = await authFetch(`${FEED_API_URL}${path}`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new FeedReadError(response.status);
    const value = await response.json() as T;
    if (feedOwner() !== owner) throw new FeedReadError(401);
    if (owner) await idbSet(key, value);
    return value;
  } catch (error) {
    const transient = !(error instanceof FeedReadError) || error.status >= 500 ||
      (error.status === 401 && isDesktopAuth() && Boolean(
        desktopBridge()?.getAccessToken?.() || desktopBridge()?.getRefreshToken?.(),
      ));
    if (!transient) await idbDelete(key);
    if (transient && cached !== null && feedOwner() === owner) return cached;
    throw error;
  }
}
