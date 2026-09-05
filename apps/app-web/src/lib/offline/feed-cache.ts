/** Viewer-scoped Feed reads. [COMP:app-web/feed-offline] */
import { authFetch } from "@/lib/auth-fetch";
import { getUserInfo } from "@/lib/user";
import { desktopBridge, isDesktopAuth } from "@/lib/desktop-auth-source";
import { idbDelete, idbGet, idbSet } from "./idb";

export const FEED_API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
export const feedOwner = () => getUserInfo()?.id ?? "";
class FeedReadError extends Error {
  constructor(public status: number) { super(`Feed API ${status}`); }
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
