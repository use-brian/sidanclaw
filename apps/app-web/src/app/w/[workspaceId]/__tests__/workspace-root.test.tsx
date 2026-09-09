// @vitest-environment jsdom
/**
 * [COMP:app-web/workspace-root] The workspace root decides its landing from
 * the cached dock (instant-navigation contract N1 / N4).
 *
 * Report E "Worst offenders" #5: this route rendered NOTHING until
 * `fetchHomeDock` resolved, purely to decide whether to land on Suggested.
 * Now: a dock already in hand (fresh or stale, the provider revalidates
 * behind) decides synchronously; a genuinely cold dock paints the
 * destination's skeleton instead of `null`; a cold failure (no dock, load
 * over) still lands on the resume path rather than hanging.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceId: "w1" }),
  useRouter: () => ({ replace, push: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

const sidebar = vi.hoisted(() => ({
  state: {
    homeApps: [] as unknown[],
    dock: null as { count: number } | null,
    dockLoading: true,
  },
}));
vi.mock("@/components/doc/doc-sidebar-data", () => ({
  useSidebarData: () => sidebar.state,
}));
vi.mock("@/components/chrome/surface-skeleton", () => ({
  SurfaceSkeletonFor: ({ surface }: { surface: string | null }) => (
    <div data-testid="skeleton" data-surface={surface ?? ""} />
  ),
}));
vi.mock("@/lib/operator-apps", () => ({
  homePath: (workspaceId: string) => `/w/${workspaceId}/p`,
}));
vi.mock("@/lib/suggested-landing", () => ({
  homeLandingPath: (workspaceId: string, resume: string, count: number) =>
    count > 0 ? `/w/${workspaceId}/p?suggested=1` : resume,
}));
vi.mock("@/lib/api/home-dock", () => ({
  pendingApprovalTotal: (dock: { count: number } | null) => dock?.count ?? 0,
}));
vi.mock("@/lib/plan-gate", () => ({
  forwardPlanGateCheckoutReturn: (path: string) => path,
}));
vi.mock("@/lib/siri-use-brian", () => ({ useBrianWorkspacePath: () => null }));

import WorkspaceRootPage from "../page";

describe("[COMP:app-web/workspace-root] lands from the cached dock", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    replace.mockReset();
    sidebar.state = { homeApps: [], dock: null, dockLoading: true };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  function mount() {
    act(() => {
      root!.render(<WorkspaceRootPage />);
    });
  }

  const skeleton = () =>
    container!.querySelector<HTMLElement>('[data-testid="skeleton"]');

  it("decides synchronously from a dock already in hand, even while it revalidates", () => {
    // `dockLoading` is false whenever a value exists; a stale dock being
    // revalidated behind the paint still reports a value. Both shapes decide.
    sidebar.state = { homeApps: [], dock: { count: 2 }, dockLoading: false };
    mount();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/w/w1/p?suggested=1");
  });

  it("paints the destination's skeleton, not nothing, while a cold dock loads", () => {
    sidebar.state = { homeApps: [], dock: null, dockLoading: true };
    mount();
    expect(replace).not.toHaveBeenCalled();
    const frame = skeleton();
    expect(frame).not.toBeNull();
    // The frame matches where we are going (the resume path is the doc surface).
    expect(frame!.dataset.surface).toBe("p");
    expect(container!.textContent).not.toMatch(/loading/i);
  });

  it("lands on the resume path once a cold load ends with no dock", () => {
    sidebar.state = { homeApps: [], dock: null, dockLoading: false };
    mount();
    expect(replace).toHaveBeenCalledWith("/w/w1/p");
  });

  it("re-decides when the dock lands after a cold wait", () => {
    sidebar.state = { homeApps: [], dock: null, dockLoading: true };
    mount();
    expect(replace).not.toHaveBeenCalled();
    sidebar.state = { homeApps: [], dock: { count: 0 }, dockLoading: false };
    act(() => {
      root!.render(<WorkspaceRootPage />);
    });
    expect(replace).toHaveBeenCalledWith("/w/w1/p");
  });
});
