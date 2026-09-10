// @vitest-environment jsdom

/**
 * [COMP:app-web/surface-content-cache] The IndexedDB tier beneath the
 * surface cache (instant-navigation plan §6.4: Tasks, CRM config + current
 * collection).
 *
 * Pinned: keys carry viewer + workspace + resource and a stored copy is only
 * hydrated for the memory key it was written for; the hook seeds memory from
 * disk BEFORE the network answers and then revalidates; a different viewer
 * never sees another viewer's copy; every network success is persisted; an
 * authoritative 401 / 403 / 404 evicts both tiers and never falls back.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const storage = vi.hoisted(() => new Map<string, unknown>());
const idb = vi.hoisted(() => ({
  idbGet: vi.fn(async (key: string) => storage.get(key) ?? null),
  idbSet: vi.fn(async (key: string, value: unknown) => {
    storage.set(key, value);
  }),
  idbDelete: vi.fn(async (key: string) => {
    storage.delete(key);
  }),
}));
vi.mock("@/lib/offline/idb", () => idb);

const user = vi.hoisted(() => ({ id: "u1" as string | null }));
vi.mock("@/lib/user", () => ({
  getUserInfo: () => (user.id ? { id: user.id, name: "n", email: "e" } : null),
}));

import {
  invalidateSurfaceCache,
  readSurfaceCache,
  resetSurfaceCache,
  useCachedResource,
} from "@/lib/surface-cache";
import {
  isAuthoritativeSurfaceDenial,
  readSurfaceContentCache,
  surfaceContentCacheKey,
  surfaceContentCacheScope,
  useSurfaceContentCache,
  writeSurfaceContentCache,
} from "@/lib/offline/surface-content-cache";

const isRows = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function Probe({ memoryKey, fetch }: { memoryKey: string; fetch: () => Promise<string[]> }) {
  const fetchRows = useSurfaceContentCache<string[]>({
    key: memoryKey,
    workspaceId: "w1",
    resource: "tasks",
    isValue: isRows,
    fetch,
  });
  const rows = useCachedResource<string[]>(memoryKey, fetchRows);
  return (
    <div data-state={rows.data ? "rows" : rows.error ? "error" : "cold"}>
      {rows.data ? rows.data.join(",") : rows.error ? "error" : "cold"}
    </div>
  );
}

async function render(memoryKey: string, fetch: () => Promise<string[]>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe memoryKey={memoryKey} fetch={fetch} />);
    await Promise.resolve();
  });
  await settle();
}

const text = () => container!.textContent;

beforeEach(() => {
  storage.clear();
  idb.idbGet.mockClear();
  idb.idbSet.mockClear();
  idb.idbDelete.mockClear();
  user.id = "u1";
  resetSurfaceCache();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("[COMP:app-web/surface-content-cache] keys and envelopes", () => {
  it("keys by viewer, workspace and resource", () => {
    const key = surfaceContentCacheKey({ viewerId: "u1", workspaceId: "w1" }, "tasks");
    expect(key).toBe("surface-content:v1:u1:w1:tasks");
    expect(key).not.toBe(surfaceContentCacheKey({ viewerId: "u2", workspaceId: "w1" }, "tasks"));
    expect(key).not.toBe(surfaceContentCacheKey({ viewerId: "u1", workspaceId: "w2" }, "tasks"));
  });

  it("has no scope, hence no disk tier, without a signed-in viewer", () => {
    expect(surfaceContentCacheScope("w1")).toEqual({ viewerId: "u1", workspaceId: "w1" });
    user.id = null;
    expect(surfaceContentCacheScope("w1")).toBeNull();
  });

  it("hydrates only for the memory key the copy was written under (single-slot resources)", async () => {
    const scope = { viewerId: "u1", workspaceId: "w1" };
    await writeSurfaceContentCache(scope, "crm:collection", "crm:w1:u1:collection:deals:table:a", ["x"]);
    expect(
      await readSurfaceContentCache(scope, "crm:collection", "crm:w1:u1:collection:deals:table:a", isRows),
    ).toMatchObject({ value: ["x"] });
    // A different filter's key must not paint the previous filter's rows.
    expect(
      await readSurfaceContentCache(scope, "crm:collection", "crm:w1:u1:collection:deals:table:b", isRows),
    ).toBeNull();
  });

  it("rejects a copy that fails the shape guard", async () => {
    const scope = { viewerId: "u1", workspaceId: "w1" };
    await writeSurfaceContentCache(scope, "tasks", "tasks:w1:u1", [1, 2] as unknown as string[]);
    expect(await readSurfaceContentCache(scope, "tasks", "tasks:w1:u1", isRows)).toBeNull();
  });

  it("recognises an authoritative denial by status property or message suffix only", () => {
    expect(isAuthoritativeSurfaceDenial(Object.assign(new Error("Forbidden"), { status: 403 }))).toBe(true);
    expect(isAuthoritativeSurfaceDenial(Object.assign(new Error("boom"), { status: 500 }))).toBe(false);
    expect(isAuthoritativeSurfaceDenial(new Error("Failed to load tasks (404)"))).toBe(true);
    expect(isAuthoritativeSurfaceDenial(new Error("Failed to load tasks (502)"))).toBe(false);
    expect(isAuthoritativeSurfaceDenial(new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("[COMP:app-web/surface-content-cache] hydration through the surface cache", () => {
  const key = "tasks:w1:u1";

  it("seeds memory from disk BEFORE the network answers, then revalidates behind the paint", async () => {
    await writeSurfaceContentCache({ viewerId: "u1", workspaceId: "w1" }, "tasks", key, ["disk-a", "disk-b"]);
    const fetch = vi.fn(() => new Promise<string[]>(() => {}));

    await render(key, fetch);

    // Painted from disk while the request is still pending (the whole point).
    expect(text()).toBe("disk-a,disk-b");
    // And marked stale, so the hook revalidated over the network exactly once.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(readSurfaceCache<string[]>(key).revalidating).toBe(true);
  });

  it("is viewer-keyed: another viewer's copy is never painted", async () => {
    await writeSurfaceContentCache({ viewerId: "u1", workspaceId: "w1" }, "tasks", key, ["theirs"]);
    user.id = "u2";
    const fetch = vi.fn(() => new Promise<string[]>(() => {}));

    await render("tasks:w1:u2", fetch);

    expect(text()).toBe("cold");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("persists every network success under the viewer's key", async () => {
    const fetch = vi.fn(async () => ["net-a"]);

    await render(key, fetch);

    expect(text()).toBe("net-a");
    expect(idb.idbSet).toHaveBeenCalledWith(
      "surface-content:v1:u1:w1:tasks",
      expect.objectContaining({ key, value: ["net-a"] }),
    );
  });

  it("evicts both tiers on an authoritative denial and never falls back to the copy", async () => {
    await writeSurfaceContentCache({ viewerId: "u1", workspaceId: "w1" }, "tasks", key, ["stale-copy"]);
    const fetch = vi.fn(async () => {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    });

    await render(key, fetch);
    await settle();

    expect(idb.idbDelete).toHaveBeenCalledWith("surface-content:v1:u1:w1:tasks");
    expect(storage.has("surface-content:v1:u1:w1:tasks")).toBe(false);
    expect(readSurfaceCache<string[]>(key).data).toBeUndefined();
    expect(text()).toBe("error");
  });

  it("leaves a warm memory entry alone (the disk copy is only for a cold load)", async () => {
    await writeSurfaceContentCache({ viewerId: "u1", workspaceId: "w1" }, "tasks", key, ["disk"]);
    invalidateSurfaceCache(key);
    const { loadSurfaceCache } = await import("@/lib/surface-cache");
    await loadSurfaceCache(key, async () => ["memory"]);
    const fetch = vi.fn(() => new Promise<string[]>(() => {}));

    await render(key, fetch);

    expect(text()).toBe("memory");
    expect(idb.idbGet).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
