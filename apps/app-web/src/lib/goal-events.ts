/**
 * The `goal` primitive's domain event (goals board / Triage panel / goal
 * detail — docs/architecture/features/goals.md), mirroring
 * `approvals-events.ts`.
 *
 * Two legs feed it. The SERVER leg: `workspace-events.ts` routes every
 * `goal` change on `GET /api/brain/stream` here, so a draft the triage judge
 * minted from a worker, or a goal an assistant confirmed from chat, reaches an
 * open board on every tab and device. The SAME-TAB leg: a panel that just
 * confirmed / worked / discarded a goal calls `requestGoalRefresh` so its own
 * tab repaints without a NOTIFY round-trip (the same-tab CustomEvents rule in
 * realtime-sync.md).
 *
 * Nobody refetches off this event directly: the ONE spine-to-cache map
 * (`surface-cache-invalidation.ts`) marks `goals:<wid>`, `triage:<wid>` and
 * `goal:<wid>:` stale, and every mounted surface reading those keys
 * revalidates behind its paint. That is what let the panels drop their local
 * `refetchTick` (instant-navigation contract N3).
 */

export const GOAL_REFRESH_EVENT = "sidan:goal-refresh";

export type GoalRefreshDetail = {
  /** Scopes the refresh to a specific workspace. */
  workspaceId: string | null;
  /** The goal that changed, when the emitter knows it. */
  rowId?: string;
};

export function requestGoalRefresh(
  workspaceId: string | null,
  rowId?: string,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<GoalRefreshDetail>(GOAL_REFRESH_EVENT, {
      detail: { workspaceId, rowId },
    }),
  );
}
