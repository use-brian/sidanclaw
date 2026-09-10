// @vitest-environment jsdom
/**
 * [COMP:app-web/inbox-panel] The Inbox flyout on the surface cache
 * (instant-navigation contract N1 / N3 / N4, report E "Inbox (flyout)" row).
 *
 * Before: `fetchInbox` on every open and three pulsing rows each time. Now an
 * open paints the cached rows with the revalidation still pending, a spine
 * mark-stale (`inbox:<wid>`) repaints without a blank frame, the panel costs
 * no request before its first open, and opening a row drops it from the
 * cached payload so the slide-out and the next open never show it again.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxPayload } from "@/lib/api/inbox";
import {
  loadSurfaceCache,
  markSurfaceCacheStale,
  readSurfaceCache,
  resetSurfaceCache,
} from "@/lib/surface-cache";
import { inboxCacheKey } from "@/lib/surface-prefetch";
import { en } from "@/lib/i18n/dictionaries/en";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

vi.mock("@/lib/user", () => ({
  getUserInfo: () => ({ id: "u1", name: "n", email: "e" }),
}));
vi.mock("@/lib/i18n/client", () => ({ useT: () => en }));

const fetchInbox = vi.fn<(workspaceId: string) => Promise<InboxPayload>>();
const markInboxRead = vi.fn(async () => {});
const dismissInboxReply = vi.fn(async () => {});
vi.mock("@/lib/api/inbox", () => ({
  fetchInbox: (...a: [string]) => fetchInbox(...a),
  markInboxRead: (...a: unknown[]) => markInboxRead(...(a as [])),
  dismissInboxReply: (...a: unknown[]) => dismissInboxReply(...(a as [])),
}));

// The avatar and markdown preview pull the comment tree; the panel's contract
// here is which ROWS it paints and when.
vi.mock("@/components/doc/comment-thread-body", () => ({
  Avatar: ({ name }: { name: string }) => <span data-avatar>{name}</span>,
}));
vi.mock("@/components/doc/preview-markdown", () => ({
  PreviewMarkdown: ({ text }: { text: string }) => <span>{text}</span>,
}));

import { InboxPanel } from "../inbox-panel";

function payload(overrides: Partial<InboxPayload> = {}): InboxPayload {
  return {
    pending: [
      {
        threadId: "thread-1",
        pageId: "page-1",
        pageTitle: "Pricing doc",
        quote: "Can we ship this?",
      } as unknown as InboxPayload["pending"][number],
    ],
    mentions: [
      {
        kind: "mention",
        id: "mention-1",
        pageId: "page-2",
        pageTitle: "Roadmap",
        actorUserId: "user-2",
        actorName: "Sam",
        preview: "please look",
        createdAt: "2026-09-01T00:00:00.000Z",
        readAt: null,
      } as unknown as InboxPayload["mentions"][number],
    ],
    pendingCount: 1,
    unreadMentionCount: 1,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

let root: Root | null = null;
let container: HTMLDivElement;
const onOpenPage = vi.fn();

function panel(open: boolean) {
  return (
    <InboxPanel
      open={open}
      workspaceId="w1"
      sidebarCollapsed={false}
      onClose={() => {}}
      onOpenPage={onOpenPage}
      onOpenRoom={() => {}}
    />
  );
}

async function render(open: boolean) {
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => {
    root!.render(panel(open));
  });
}

const skeleton = () => container.querySelector("[data-inbox-skeleton]");

beforeEach(() => {
  resetSurfaceCache();
  fetchInbox.mockReset();
  onOpenPage.mockReset();
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
});

describe("[COMP:app-web/inbox-panel] Inbox flyout on the surface cache", () => {
  it("paints the cached rows on open with the revalidation still pending (no skeleton)", async () => {
    await loadSurfaceCache(inboxCacheKey("w1"), async () => payload());
    fetchInbox.mockReturnValue(new Promise(() => {}));
    await render(true);
    expect(container.textContent).toContain("Pricing doc");
    expect(container.textContent).toContain("Roadmap");
    expect(skeleton()).toBeNull();
    // An open always revalidates behind the paint.
    expect(fetchInbox).toHaveBeenCalledTimes(1);
  });

  it("a spine mark-stale (`inbox:<wid>`) repaints without a blank frame, then adopts the new payload", async () => {
    await loadSurfaceCache(inboxCacheKey("w1"), async () => payload());
    const first = deferred<InboxPayload>();
    fetchInbox.mockReturnValueOnce(first.promise);
    await render(true);
    await act(async () => {
      first.resolve(payload());
      await settle();
    });

    const next = deferred<InboxPayload>();
    fetchInbox.mockReturnValueOnce(next.promise);
    await act(async () => {
      markSurfaceCacheStale("inbox:w1");
      await settle();
    });
    expect(fetchInbox).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Pricing doc");
    expect(skeleton()).toBeNull();

    await act(async () => {
      next.resolve(
        payload({
          pending: [],
          pendingCount: 0,
          mentions: [
            {
              kind: "mention",
              id: "mention-2",
              pageId: "page-3",
              pageTitle: "Launch plan",
              actorUserId: "user-3",
              actorName: "Ada",
              preview: null,
              createdAt: "2026-09-02T00:00:00.000Z",
              readAt: null,
            } as unknown as InboxPayload["mentions"][number],
          ],
        }),
      );
      await settle();
    });
    expect(container.textContent).not.toContain("Pricing doc");
    expect(container.textContent).toContain("Launch plan");
  });

  it("costs no request before its first open, one on open, and paints a skeleton only when cold", async () => {
    const first = deferred<InboxPayload>();
    fetchInbox.mockReturnValue(first.promise);
    await render(false);
    expect(fetchInbox).not.toHaveBeenCalled();

    await render(true);
    expect(fetchInbox).toHaveBeenCalledTimes(1);
    expect(skeleton()).not.toBeNull();

    await act(async () => {
      first.resolve(payload());
      await settle();
    });
    expect(skeleton()).toBeNull();
    expect(container.textContent).toContain("Pricing doc");
  });

  it("opening a row drops it from the cached payload, so the slide-out and the next open never show it", async () => {
    await loadSurfaceCache(inboxCacheKey("w1"), async () => payload());
    fetchInbox.mockReturnValue(new Promise(() => {}));
    await render(true);
    const row = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Pricing doc"),
    );
    expect(row).toBeTruthy();
    await act(async () => {
      row!.click();
      await settle();
    });
    expect(onOpenPage).toHaveBeenCalledWith("page-1");
    expect(dismissInboxReply).toHaveBeenCalledWith("w1", "thread-1");
    expect(container.textContent).not.toContain("Pricing doc");
    const cached = readSurfaceCache<InboxPayload>(inboxCacheKey("w1")).data;
    expect(cached?.pending).toEqual([]);
    expect(cached?.pendingCount).toBe(0);
  });
});
