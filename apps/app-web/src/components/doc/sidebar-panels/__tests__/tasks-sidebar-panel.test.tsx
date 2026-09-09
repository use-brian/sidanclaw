// @vitest-environment jsdom

/**
 * [COMP:app-web/tasks-sidebar-panel] The Tasks rail reads the SURFACE's
 * cache key instead of fetching a private copy.
 *
 * The panel remounts on every surface entry. Its old mount-effect
 * `fetchWorkspaceTasks` paid a second request and blanked the counts each
 * time while the identical rows sat in `tasks:<wid>`. Pinned here: a warmed
 * key paints the counts with NO request of the panel's own; the spine's
 * mark-stale keeps the counts up while revalidating (no blank frame); a cold
 * cache shows skeleton pills, never nothing.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { TaskRow } from "@/lib/api/tasks";
import {
  loadSurfaceCache,
  markSurfaceCacheStale,
  resetSurfaceCache,
} from "@/lib/surface-cache";
import { surfaceDataKey } from "@/lib/surface-prefetch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/w1/tasks",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: { href: string; children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const taskApi = vi.hoisted(() => ({ fetchWorkspaceTasks: vi.fn() }));
vi.mock("@/lib/api/tasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/tasks")>()),
  fetchWorkspaceTasks: taskApi.fetchWorkspaceTasks,
}));

import { TasksSidebarPanel } from "../tasks-sidebar-panel";

const NOW = "2026-09-09T09:00:00.000Z";

function task(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    title: `Task ${id}`,
    status: "todo",
    assigneeId: "member-1",
    due: "2026-09-20T00:00:00.000Z",
    tags: [],
    parentId: null,
    attributes: {},
    updatedAt: NOW,
    ...overrides,
  };
}

const rows: TaskRow[] = [
  task("a", { assigneeId: null, due: null }),
  task("b", { status: "done" }),
];

const key = surfaceDataKey("tasks", "w1")!;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={en}>
        <TasksSidebarPanel workspaceId="w1" />
      </I18nProvider>,
    );
    await Promise.resolve();
  });
}

const allTasksCount = () =>
  container!
    .querySelector(`a[href="/w/w1/tasks"]`)
    ?.querySelector("span.tabular-nums")?.textContent ?? null;
const skeletons = () => container!.querySelectorAll("[data-sidebar-count-skeleton]").length;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  resetSurfaceCache();
  taskApi.fetchWorkspaceTasks.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("[COMP:app-web/tasks-sidebar-panel] counts from the surface's cache key", () => {
  it("paints counts from the warmed surface key with NO request of its own", async () => {
    await loadSurfaceCache(key, async () => rows);
    // A pending request that never resolves: if the panel fetched for itself
    // the counts would never appear.
    taskApi.fetchWorkspaceTasks.mockReturnValue(new Promise<TaskRow[]>(() => {}));

    await render();

    expect(allTasksCount()).toBe("2");
    expect(skeletons()).toBe(0);
    expect(taskApi.fetchWorkspaceTasks).not.toHaveBeenCalled();
  });

  it("keeps the counts painted through a spine mark-stale and updates when the revalidation lands", async () => {
    await loadSurfaceCache(key, async () => rows);
    let resolve!: (value: TaskRow[]) => void;
    taskApi.fetchWorkspaceTasks.mockReturnValue(new Promise<TaskRow[]>((r) => { resolve = r; }));
    await render();

    await act(async () => {
      // What the ONE spine map does on BRAIN_REFRESH_EVENT.
      markSurfaceCacheStale("tasks:w1");
    });
    await settle();

    // No blank frame: the old count stays while the refetch runs.
    expect(allTasksCount()).toBe("2");
    expect(skeletons()).toBe(0);
    expect(taskApi.fetchWorkspaceTasks).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve([...rows, task("c")]);
    });
    await settle();
    expect(allTasksCount()).toBe("3");
  });

  it("shows skeleton pills, never nothing, while a cold cache loads", async () => {
    taskApi.fetchWorkspaceTasks.mockReturnValue(new Promise<TaskRow[]>(() => {}));
    await render();

    expect(allTasksCount()).toBeNull();
    expect(skeletons()).toBeGreaterThan(0);
    // The cold load is the surface key's load, shared with the surface.
    expect(taskApi.fetchWorkspaceTasks).toHaveBeenCalledTimes(1);
  });

  it("carries no BRAIN_REFRESH_EVENT listener of its own (the spine map owns it)", () => {
    // Read the source: a listener here would be a second map.
    return import("node:fs").then(({ readFileSync }) =>
      import("node:path").then(({ resolve }) => {
        const src = readFileSync(
          resolve(process.cwd(), "src/components/doc/sidebar-panels/tasks-sidebar-panel.tsx"),
          "utf8",
        );
        expect(src).not.toMatch(/addEventListener\(\s*BRAIN_REFRESH_EVENT/);
        expect(src).not.toContain('from "@/lib/brain-events"');
        expect(src).toContain('surfaceDataKey("tasks", workspaceId)');
      }),
    );
  });
});
