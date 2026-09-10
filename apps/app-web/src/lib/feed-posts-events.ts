/**
 * One-shot signal telling the Feed sidebar's post list to refetch.
 *
 * The post list lives in the SIDEBAR now (feed-revamp.md D14), and the sidebar
 * is mounted by the persistent `/w/[workspaceId]` layout, so it never
 * unmounts during SPA navigation. A mount-only effect there would fire once
 * per full page load and the list could never self-heal after the pane
 * created, renamed, or resolved a post - the exact persistent-layout bug the
 * root CLAUDE.md calls out.
 *
 * A CustomEvent rather than a context: the emitters are deep inside the pane
 * (the editor, the version chips, the approve/reject actions) and would
 * otherwise each need a provider threaded down just to say "the list moved".
 *
 * Since the post lists moved onto the surface cache (instant-navigation N3)
 * the signal's real work is the mark-stale on the `feed-sessions:*` family:
 * every mounted reader (the sidebar rail, the per-platform posts list)
 * revalidates behind its paint, and nothing else has to listen. The
 * CustomEvent still fires for non-data side effects.
 *
 * [COMP:app-web/feed-posts-events]
 */

import { markSurfaceCacheStale } from "@/lib/surface-cache";
import { feedSessionsCacheFamily } from "@/lib/surface-prefetch";

const FEED_POSTS_CHANGED_EVENT = "feed:posts-changed";

/** Mark every cached post list stale and announce the change. No-op on SSR. */
export function notifyFeedPostsChanged(): void {
  if (typeof window === "undefined") return;
  markSurfaceCacheStale(feedSessionsCacheFamily());
  window.dispatchEvent(new CustomEvent(FEED_POSTS_CHANGED_EVENT));
}
