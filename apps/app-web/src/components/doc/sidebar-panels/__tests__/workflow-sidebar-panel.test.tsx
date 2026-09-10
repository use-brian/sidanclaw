// @vitest-environment jsdom
/**
 * [COMP:app-web/sidebar-panel-workflow] The workflow quick-switcher reads the
 * SURFACE's cache key (instant-navigation contract N1-N3).
 *
 * The panel remounts on every surface entry (the sidebar body is
 * surface-aware), and it used to `listWorkflows` on its own each time: a
 * second request for the list the page had just fetched, and a "…" flash
 * while it waited. Now it reads `surfaceDataKey("workflow", wid)` - the slot
 * the rail hover warms and the list page reads - so a warmed key paints the
 * rows on the first frame with no fetch of its own, and a spine mark-stale
 * repaints behind the rows instead of blanking them.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import {
  loadSurfaceCache,
  markSurfaceCacheStale,
  resetSurfaceCache,
} from "@/lib/surface-cache";
import { surfaceDataKey } from "@/lib/surface-prefetch";
import type { WorkflowSummary } from "@/lib/api/workflow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/w1/workflow/wf-2",
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/user", () => ({
  getUserInfo: () => ({ id: "u1", name: "n", email: "e" }),
}));

const api = vi.hoisted(() => ({
  listWorkflows: vi.fn<() => Promise<WorkflowSummary[]>>(),
}));

vi.mock("@/lib/api/workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/workflow")>()),
  listWorkflows: api.listWorkflows,
}));

import { WorkflowSidebarPanel } from "../workflow-sidebar-panel";

function row(id: string, name: string, extra: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return {
    id,
    workspaceId: "w1",
    name,
    enabled: true,
    trigger: { kind: "manual" },
    stepCount: 1,
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...extra,
  };
}

const ROWS: WorkflowSummary[] = [
  row("wf-1", "Morning digest"),
  row("wf-2", "Weekly report"),
  row("wf-3", "Old one", { lifecycleState: "archived" }),
];

/** A fetch that never resolves - the "still pending" half of the contract. */
const pending = () => new Promise<WorkflowSummary[]>(() => {});
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

let root: Root;
let container: HTMLDivElement;

async function render() {
  await act(async () => {
    root.render(
      <I18nProvider locale="en" dict={en}>
        <WorkflowSidebarPanel workspaceId="w1" />
      </I18nProvider>,
    );
  });
}

beforeEach(() => {
  resetSurfaceCache();
  api.listWorkflows.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("[COMP:app-web/sidebar-panel-workflow] paints from the surface key", () => {
  it("renders the rows on the first frame from a warmed key while the fetch is still pending (no fetch of its own)", async () => {
    await loadSurfaceCache(surfaceDataKey("workflow", "w1")!, async () => ROWS);
    api.listWorkflows.mockImplementation(pending);

    await render();

    expect(container.textContent).toContain("Morning digest");
    expect(container.textContent).toContain("Weekly report");
    // No skeleton, no "…" - and the archived row is the list page's business.
    expect(container.querySelector('[data-testid="workflow-sidebar-skeleton"]')).toBeNull();
    expect(container.textContent).not.toContain("…");
    expect(container.textContent).not.toContain("Old one");
    // The key was fresh, so the panel issued NO request of its own.
    expect(api.listWorkflows).not.toHaveBeenCalled();
    // The open workflow is highlighted off the pathname.
    expect(container.querySelector('a[aria-current="page"]')?.getAttribute("href")).toBe(
      "/w/w1/workflow/wf-2",
    );
  });

  it("paints skeleton rows, never a sentence, when nothing is cached", async () => {
    api.listWorkflows.mockImplementation(pending);
    await render();
    expect(container.querySelector('[data-testid="workflow-sidebar-skeleton"]')).not.toBeNull();
    expect(container.textContent).not.toContain("…");
    expect(container.textContent).not.toMatch(/loading/i);
  });

  it("keeps the rows on screen through a spine mark-stale and swaps in the revalidated list", async () => {
    await loadSurfaceCache(surfaceDataKey("workflow", "w1")!, async () => ROWS);
    let resolve!: (rows: WorkflowSummary[]) => void;
    api.listWorkflows.mockImplementation(
      () => new Promise<WorkflowSummary[]>((r) => { resolve = r; }),
    );
    await render();
    expect(container.textContent).toContain("Morning digest");

    // The spine's signal: stale, not gone. The rows stay while it refetches.
    await act(async () => { markSurfaceCacheStale("workflow:w1"); });
    expect(container.textContent).toContain("Morning digest");
    expect(container.querySelector('[data-testid="workflow-sidebar-skeleton"]')).toBeNull();
    expect(api.listWorkflows).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve([row("wf-1", "Morning digest"), row("wf-4", "Brand new")]);
    });
    await settle();
    expect(container.textContent).toContain("Brand new");
    expect(container.textContent).not.toContain("Weekly report");
  });
});
