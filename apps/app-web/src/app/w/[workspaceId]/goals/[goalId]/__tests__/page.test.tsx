// @vitest-environment jsdom
/**
 * [COMP:app-web/goal-detail] The goal detail page paints from the surface
 * cache (instant-navigation contract N1 / N3 / N4): the shared
 * `goal:<wid>:<viewer>:<goalId>` slot on a revisit, the cached board row's
 * title while the slot is cold, and a mark-stale that repaints behind the
 * paint. Report E: this page used to `setGoal(undefined)` + "Loading…" on
 * every entry.
 */

import { Suspense, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { GoalDetail, GoalRow } from "@/lib/api/goals";
import {
  loadSurfaceCache,
  markSurfaceCacheStale,
  resetSurfaceCache,
} from "@/lib/surface-cache";
import { goalDetailCacheKey, goalsCacheKey } from "@/lib/surface-prefetch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/user", () => ({
  getUserInfo: () => ({ id: "u1", name: "n", email: "e" }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/lib/api/context-scopes", () => ({
  listContextTeams: vi.fn(async () => []),
  listContextProjects: vi.fn(async () => []),
}));
vi.mock("@/components/chat-app/goal-execution-activity", () => ({
  GoalExecutionActivity: () => null,
}));
vi.mock("@/components/context/context-scope-chips", () => ({
  ContextScopeChips: () => <span data-testid="scope-chips" />,
}));
vi.mock("@/components/context/context-scope-picker", () => ({
  ContextScopePicker: () => <div data-testid="scope-picker" />,
}));

const api = vi.hoisted(() => ({ getGoalDetail: vi.fn() }));
vi.mock("@/lib/api/goals", () => ({
  getGoalDetail: (...args: unknown[]) => api.getGoalDetail(...args),
  updateGoalContext: vi.fn(),
}));

import GoalDetailPage from "../page";

const dict = en as unknown as Dictionary;

const row = (outcome: string): GoalRow => ({
  id: "g1",
  outcome,
  status: "active",
  host: null,
  hostTitle: null,
  parentGoalId: null,
  recipeId: null,
  blockerReason: null,
  contextGroupId: null,
  contextProjectId: null,
  confirmedAt: "2026-09-01T00:00:00.000Z",
  hasWorkflow: false,
  originSessionId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});

const detail = (outcome: string): GoalDetail => ({
  ...row(outcome),
  doneWhen: { type: "hostTaskDone" } as unknown as GoalDetail["doneWhen"],
  means: {} as GoalDetail["means"],
  budget: {},
  policy: {} as GoalDetail["policy"],
  completionClaim: null,
  brief: null,
});

const pending = () => new Promise<never>(() => {});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={dict}>
        <Suspense fallback={null}>
          <GoalDetailPage params={Promise.resolve({ workspaceId: "w1", goalId: "g1" })} />
        </Suspense>
      </I18nProvider>,
    );
    await settle();
    await settle();
  });
}

beforeEach(() => {
  resetSurfaceCache();
  api.getGoalDetail.mockReset();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("[COMP:app-web/goal-detail] goal detail paints from the surface cache", () => {
  it("first paint renders the warmed detail while the fetch is still pending (no Loading text)", async () => {
    const key = goalDetailCacheKey("w1", "g1");
    await loadSurfaceCache(key, async () => detail("Ship the launch page"));
    markSurfaceCacheStale(key);
    api.getGoalDetail.mockReturnValue(pending());

    await mount();

    expect(host!.querySelector("h1")?.textContent).toBe("Ship the launch page");
    expect(host!.querySelector("[aria-busy]")).toBeNull();
    expect(host!.textContent).not.toContain(en.goalsPage.loading);
    expect(api.getGoalDetail).toHaveBeenCalledTimes(1);
  });

  it("a cold detail seeds its header from the cached board row and skeletons the rest (N4)", async () => {
    await loadSurfaceCache(goalsCacheKey("w1", "all"), async () => [row("Ship the launch page")]);
    api.getGoalDetail.mockReturnValue(pending());

    await mount();

    expect(host!.querySelector("h1")?.textContent).toBe("Ship the launch page");
    expect(host!.querySelector("[aria-busy]")).not.toBeNull();
    expect(host!.textContent).not.toContain(en.goalsPage.loading);
  });

  it("the goal primitive's mark-stale repaints behind the paint", async () => {
    const key = goalDetailCacheKey("w1", "g1");
    await loadSurfaceCache(key, async () => detail("Ship the launch page"));
    await mount();

    let resolveDetail: (g: GoalDetail) => void = () => {};
    api.getGoalDetail.mockReturnValue(
      new Promise<GoalDetail>((resolve) => {
        resolveDetail = resolve;
      }),
    );
    await act(async () => {
      markSurfaceCacheStale("goal:w1:");
      await settle();
    });
    expect(host!.querySelector("h1")?.textContent).toBe("Ship the launch page");
    expect(host!.querySelector("[aria-busy]")).toBeNull();

    await act(async () => {
      resolveDetail(detail("Ship the launch page, then announce it"));
      await settle();
    });
    expect(host!.querySelector("h1")?.textContent).toBe("Ship the launch page, then announce it");
  });
});
