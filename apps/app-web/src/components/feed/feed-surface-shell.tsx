"use client";

/**
 * Feed surface shell — the client wrapper every `/w/[id]/feed/*` route
 * renders inside (mounted by `feed/layout.tsx`).
 *
 * Mounts the shared operator top bar (`[COMP:app-web/operator-topbar]`)
 * above the readiness gate — chrome on every feed state — and owns the feed
 * pane's one `overflow-y-auto` scroll container beneath it.
 *
 * Owns the `FeedProfilesProvider` and gates children on its readiness so
 * ported feed pages keep feed-web's assumption that the workspace context is
 * synchronously available (docs/plans/feed-web-consolidation.md §4). The
 * provider reads the surface cache, so a revisit is READY on the first frame
 * (instant-navigation N1); the gate's cold branch is a geometry-matched
 * skeleton of the Plan landing, never a sentence (N4 / N5). Once the
 * workspace state is READY it also mounts the feed-scoped tuning-chat dock
 * (`<FeedFloatingChat />`) under a `chatDockSuppression` hold — replacing
 * feed-web's workspace-layout mount — so every feed route SWAPS the global
 * `WorkspaceChrome` dock for the feed dock; two docks never coexist. The
 * loading/error gate renders neither the dock nor the hold.
 *
 * [COMP:app-web/feed-surface-shell]
 */

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { MessageSquareText, Plus } from "lucide-react";
import {
  FeedProfilesProvider,
  useFeedWorkspaceState,
} from "@/contexts/feed-profiles-context";
import { chatDockSuppression } from "@/lib/chat-dock-suppress";
import { FeedFloatingChat } from "@/components/feed/feed-floating-chat";
import { PlatformIcon } from "@/components/feed/platform-icon";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { Skeleton } from "@/components/skeleton";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  FEED_PLATFORMS,
  defaultFeedPlatform,
  feedPath,
  feedPostIdFromPathname,
  type FeedPlatform,
} from "@/lib/feed-nav";
import { requestFeedChatOpen } from "@/lib/feed-chat-seed";

export function FeedSurfaceShell(props: {
  workspaceId: string;
  children: ReactNode;
}) {
  return (
    <FeedProfilesProvider workspaceId={props.workspaceId}>
      <div className="flex h-full min-h-0 flex-col">
        {/* Chrome — the shared operator top bar, ABOVE the readiness gate so
            it renders on every feed state (loading / error / onboarding
            included) ([COMP:app-web/operator-topbar]). The wrapper below it
            owns the feed pane's one scroll container; pages with their own
            full-height scroller (Voice, draft detail) fill it with `h-full`
            so the outer never overflows. */}
        <OperatorTopbar
          app="feed"
          right={
            <>
              <FeedNewPostTopbarAction />
              <FeedChatTopbarAction />
            </>
          }
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <FeedReadyGate>{props.children}</FeedReadyGate>
        </div>
      </div>
    </FeedProfilesProvider>
  );
}

/**
 * Intent-first authoring from anywhere on the surface
 * (docs/plans/feed-plan-chat-first.md P12): a platform picker defaulting to
 * the workspace's last-used platform, routing to the existing new-post form
 * — so deliberate writing never requires walking the sidebar to a
 * platform's post list. Thought-first capture stays the Plan strip's job.
 */
function FeedNewPostTopbarAction() {
  const state = useFeedWorkspaceState();
  const router = useRouter();
  const t = useT().feedPage;
  if (state.status !== "ready") return null;
  const ws = state.value;
  if (ws.profiles.length === 0 && ws.assistants.length === 0) return null;
  const preferred = defaultFeedPlatform(
    ws.workspaceId,
    ws.profiles.map((p) => p.platform),
  );
  // Last-used first; the rest keep the canonical order.
  const platforms: FeedPlatform[] = [
    preferred,
    ...FEED_PLATFORMS.filter((p) => p !== preferred),
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t.postEditor.newPost}
            className="h-9 md:h-8 gap-1.5 px-2.5 text-xs text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <Plus className="size-3.5" aria-hidden />
            <span>{t.postEditor.newPost}</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {platforms.map((platform) => (
          <DropdownMenuItem
            key={platform}
            onClick={() =>
              router.push(
                feedPath(ws.workspaceId, { platform, segment: "posts" }),
              )
            }
          >
            <PlatformIcon platform={platform} className="size-3.5" />
            {t.platformLabels[platform]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Persistent, explicit entry to the Feed's one master control conversation. */
function FeedChatTopbarAction() {
  const pathname = usePathname() ?? "";
  const state = useFeedWorkspaceState();
  const t = useT().feedPage.tuningChat;
  if (feedPostIdFromPathname(pathname) !== null || state.status !== "ready") {
    return null;
  }
  if (state.value.profiles.length === 0 && state.value.assistants.length === 0) {
    return null;
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={requestFeedChatOpen}
      aria-label={t.openAria}
      title={t.openAria}
      className="h-9 md:h-8 gap-1.5 px-2.5 text-xs text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
    >
      <MessageSquareText className="size-3.5" aria-hidden />
      <span>{t.topbarAction}</span>
    </Button>
  );
}

/**
 * The cold-cache fallback: the Plan landing's silhouette (header line,
 * capture strip, the month calendar block) at the pane's real padding, so a
 * first-ever visit paints the frame the real content swaps into. Decorative
 * only - `aria-hidden`, no strings - like every surface skeleton
 * (`components/chrome/surface-skeleton.tsx`). It replaces the "Loading your
 * feed workspace..." sentence this gate rendered on EVERY entry; a revisit
 * never reaches it because the provider paints from the cache.
 */
function FeedGateSkeleton() {
  return (
    <div
      aria-hidden
      data-feed-gate-skeleton
      className="animate-fade-in px-4 py-5 md:px-6"
    >
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-72 max-w-full" />
        </div>
        <Skeleton className="h-12 w-full rounded-xl" />
        <div className="flex justify-end">
          <Skeleton className="h-9 w-40 rounded-md md:h-6" />
        </div>
        <div className="overflow-hidden rounded-xl border border-border/60">
          <div className="grid grid-cols-7 border-b border-border/60 bg-muted/30 px-2 py-2">
            {Array.from({ length: 7 }).map((_, i) => (
              <Skeleton key={i} className="h-3 w-8" />
            ))}
          </div>
          <div className="grid grid-cols-7">
            {Array.from({ length: 35 }).map((_, i) => (
              <div
                key={i}
                className="min-h-[64px] border-b border-r border-border/60 p-1.5 md:min-h-[104px]"
              >
                <Skeleton className="size-5 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function FeedReadyGate(props: { children: ReactNode }) {
  const t = useT().feedPage;
  const state = useFeedWorkspaceState();

  if (state.status === "loading") return <FeedGateSkeleton />;

  if (state.status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <div className="text-sm text-muted-foreground">{t.shell.loadError}</div>
        <Button variant="outline" size="sm" onClick={state.retry}>
          {t.shell.retry}
        </Button>
      </div>
    );
  }

  return (
    <>
      {props.children}
      <FeedDockHost />
    </>
  );
}

/**
 * The feed-scoped tuning dock + its global-dock suppression hold. Mounted
 * only in the READY branch, so the hold's lifetime is exactly the dock's:
 * while any feed route is on screen the `WorkspaceChrome` dock hides
 * (display:none, stays mounted) and the feed dock stands in for it.
 */
function FeedDockHost() {
  useEffect(() => chatDockSuppression.suppress(), []);
  return <FeedFloatingChat />;
}
