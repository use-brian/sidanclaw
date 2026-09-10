"use client";

/**
 * Chat operator surface route — thin wrapper: the meat lives in
 * `@/components/chat-app/chat-surface` (`[COMP:app-web/chat-surface]`) so the
 * desktop SPA can import the client component directly (the feed-port
 * disposition rule, feed-web-consolidation §6/§10). The Suspense boundary
 * covers `useSearchParams` (the `?s=<sessionId>` open-thread state); its
 * fallback is the same rail skeleton `chat/loading.tsx` paints, never a bare
 * "…" (instant-navigation contract N4) - the surface itself paints its
 * roster and lists from the cache the moment it mounts.
 *
 * Spec: docs/architecture/features/chat-app.md.
 */

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { ChatSurface } from "@/components/chat-app/chat-surface";
import { RailSurfaceSkeleton } from "@/components/chrome/surface-skeleton";

export default function ChatPage() {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params?.workspaceId ?? "";
  return (
    <Suspense fallback={<RailSurfaceSkeleton />}>
      <ChatSurface workspaceId={workspaceId} />
    </Suspense>
  );
}
