"use client";


/**
 * Feed workspace context — the app-web replacement for feed-web's
 * `TeamContextProvider` (`apps/feed-web/src/lib/workspace-context.tsx`).
 *
 * feed-web resolved this server-side in its workspace layout; here the read
 * is CLIENT-side so the same provider works in the Vite desktop SPA, which
 * has no server layouts (docs/plans/feed-web-consolidation.md §4).
 * `FeedSurfaceShell` gates its children on `status === "ready"`, so ported
 * feed pages keep their original assumption that the context is
 * synchronously populated.
 *
 * The record comes from the surface cache (instant-navigation contract N1 /
 * N2): `useCachedResource(feedWorkspaceCacheKey(wid))` over
 * `loadFeedWorkspaceRecord` (`lib/feed-surface-cache.ts`), which answers
 * from IndexedDB on a cold key and revalidates behind the paint. A revisit
 * therefore renders the last-known workspace on the first frame instead of
 * the five-request gate report E named as the app's worst offender; the
 * workspace event spine marks the key stale (`surface-cache-invalidation.ts`)
 * so a rename or a new brand voice repairs every open tab.
 *
 * Value shape mirrors feed-web's `WorkspaceContextValue` (workspaceId, name,
 * role, canDraft, me, profiles) plus `refresh()` for post-connect reloads.
 * Workspace identity comes from `/api/workspaces/:id`; profiles from the
 * feed SDK. OSS returns a successful empty profile list because connections
 * are hosted-only; unexpected profile failures still degrade to `[]` so the
 * open planning surface remains usable.
 *
 * [COMP:app-web/feed-profiles-context]
 */

import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { useCachedResource } from "@/lib/surface-cache";
import { feedWorkspaceCacheKey } from "@/lib/surface-prefetch";
import {
  deriveCanDraft,
  loadFeedWorkspaceRecord,
  type FeedWorkspaceRecord,
} from "@/lib/feed-surface-cache";

// The pure permission rule lives beside the loader now; re-exported so the
// existing callers and tests keep their import.
export { deriveCanDraft };

/**
 * The cached record plus `refresh()`. Field notes:
 *  - `canDraft`: whether this user can interact with the feed/draft-app —
 *    create & save drafts, approve/reject saved drafts. True for owner/admin
 *    unconditionally; for `role === 'member'` it reflects the
 *    `workspace_members.can_draft` column an admin/owner can toggle in the
 *    feed settings members page.
 *  - `me`: identity of the requesting user — used by collaborative surfaces
 *    (team-shared draft sessions) to dedupe own-events from bus broadcasts
 *    and skip presence flicker for self.
 *  - `profiles`: per-platform connection summary; drives the sidebar
 *    platform pill and every per-platform page's assistant resolution.
 *  - `assistants`: the workspace's distribution assistants (`kind='app'`,
 *    `appType='distribution'`) regardless of connection state. The Create
 *    surfaces (drafts / ready / voice) resolve their assistant from HERE, so
 *    a brand voice created without any OAuth connection is fully usable
 *    (docs/plans/feed-create-split.md D7).
 *  - `brand`: the workspace's APPROVED brand record, or null
 *    (feed-revamp-depth D35). Read once here so the preview, the Voice page
 *    and the composer brand check share it. Never the draft. Null means
 *    "render exactly what shipped before brand existed" -- no consumer may
 *    hard-depend on it.
 *  - `cloudLink`: native hosted capability or verified paid Cloud Link
 *    state in OSS.
 *  - `refresh`: re-read the record (after an OAuth connect / disconnect).
 */
export type FeedWorkspaceValue = FeedWorkspaceRecord & {
  refresh: () => Promise<void>;
};

type FeedWorkspaceState =
  | { status: "loading" }
  | { status: "error"; retry: () => void }
  | { status: "ready"; value: FeedWorkspaceValue };

const FeedWorkspaceContext = createContext<FeedWorkspaceState | null>(null);

export function FeedProfilesProvider(props: {
  workspaceId: string;
  children: ReactNode;
}) {
  const { workspaceId } = props;
  const key = workspaceId ? feedWorkspaceCacheKey(workspaceId) : null;
  const resource = useCachedResource<FeedWorkspaceRecord>(key, () =>
    loadFeedWorkspaceRecord(workspaceId, key as string),
  );
  const { data, error, revalidating, refresh } = resource;

  // The three states the gate reads, derived from the cache entry: a value
  // (fresh, stale, or a failed revalidation's last-good copy) is ready; an
  // error with nothing to paint is the error branch and exposes the retry;
  // everything else is the first load.
  const value = useMemo<FeedWorkspaceState>(() => {
    if (data !== undefined) {
      return {
        status: "ready",
        value: {
          ...data,
          refresh: async () => {
            await refresh();
          },
        },
      };
    }
    if (error !== undefined && !revalidating) {
      return {
        status: "error",
        retry: () => {
          void refresh();
        },
      };
    }
    return { status: "loading" };
  }, [data, error, revalidating, refresh]);

  return (
    <FeedWorkspaceContext.Provider value={value}>
      {props.children}
    </FeedWorkspaceContext.Provider>
  );
}

/** The raw load state — only the surface shell needs this (loading/error UI). */
export function useFeedWorkspaceState(): FeedWorkspaceState {
  const state = useContext(FeedWorkspaceContext);
  if (!state) {
    throw new Error(
      "useFeedWorkspaceState must be used inside a FeedProfilesProvider",
    );
  }
  return state;
}

/**
 * The resolved feed workspace. Ported feed pages call this where they called
 * feed-web's `useWorkspaceContext()`; the shell guarantees readiness below
 * it, so consumers never see the loading/error states.
 */
export function useFeedWorkspace(): FeedWorkspaceValue {
  const state = useFeedWorkspaceState();
  if (state.status !== "ready") {
    throw new Error(
      "useFeedWorkspace read before ready — mount it under FeedSurfaceShell",
    );
  }
  return state.value;
}
