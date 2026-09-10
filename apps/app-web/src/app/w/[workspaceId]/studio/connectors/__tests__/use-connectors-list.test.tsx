// @vitest-environment jsdom
/**
 * [COMP:app-web/studio-connectors-cache] - the connectors list reads the
 * surface cache (instant-navigation contract N1-N8).
 *
 * Two behaviours matter and both are invisible in a happy-path test: (a) a
 * revisit paints the cached rows on the FIRST frame while the revalidation is
 * still pending - no skeleton, no "Loading connectors..." sentence, because
 * the whole point of the adoption is that entering Studio never blanks the
 * section; (b) a mark-stale (tab-visible, bfcache restore) keeps the rows on
 * screen while the refetch runs and swaps them in place when it lands - never
 * an empty frame in between. The page itself is 5,000 lines of forms, so the
 * data layer is exercised through a tiny host component.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const user = vi.hoisted(() => ({ id: "u1" as string | null }));
vi.mock("@/lib/user", () => ({
  getUserInfo: () => (user.id ? { id: user.id, name: "n", email: "e" } : null),
}));
const authFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth-fetch", () => ({ authFetch }));
// The prefetch module pulls the other surfaces' SDKs; none are called here.
vi.mock("@/lib/api/crm", () => ({ fetchCrmConfig: vi.fn() }));
vi.mock("@/lib/api/tasks", () => ({ fetchWorkspaceTasks: vi.fn() }));
vi.mock("@/lib/api/workflow", () => ({ listWorkflows: vi.fn() }));
vi.mock("@/lib/api/views", () => ({ getView: vi.fn() }));

import {
  loadSurfaceCache,
  markSurfaceCacheStale,
  readSurfaceCache,
  resetSurfaceCache,
} from "@/lib/surface-cache";
import { connectorsCacheKey } from "@/lib/surface-prefetch";
import {
  collapseConnectorRows,
  fetchConnectorsList,
  type Connector,
} from "@/lib/api/connectors";
import { useConnectorsList } from "../use-connectors-list";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const row = (id: string, extra: Partial<Connector> = {}): Connector => ({
  id,
  name: id.toUpperCase(),
  connected: false,
  ...extra,
});

/** Mirrors the page: a skeleton only when nothing is cached, else the rail rows. */
function Host({ workspaceId }: { workspaceId: string }) {
  const { connectors, loading, revalidating } = useConnectorsList(workspaceId);
  if (loading) return <div data-skeleton />;
  return (
    <ul data-revalidating={revalidating ? "true" : "false"}>
      {connectors.map((c) => (
        <li key={c.connectorInstanceId ?? c.id}>{c.name}</li>
      ))}
    </ul>
  );
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetSurfaceCache();
  authFetch.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("[COMP:app-web/studio-connectors-cache] Studio connectors list", () => {
  it("first paint from a warmed key renders the rows while the fetch is still pending (N1)", async () => {
    const key = connectorsCacheKey("w1");
    await loadSurfaceCache(key, async () => [row("gmail"), row("notion")]);
    // Age the entry so the mount revalidates - the request never resolves.
    markSurfaceCacheStale(key);
    authFetch.mockImplementation(() => new Promise(() => {}));

    await act(async () => {
      root.render(<Host workspaceId="w1" />);
    });

    expect(host.querySelector("[data-skeleton]")).toBeNull();
    expect(host.textContent).toContain("GMAIL");
    expect(host.textContent).toContain("NOTION");
    // The revalidation is in flight behind the paint, not in front of it.
    expect(host.querySelector("ul")?.getAttribute("data-revalidating")).toBe("true");
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(String(authFetch.mock.calls[0][0])).toContain("/api/connectors?workspaceId=w1");
  });

  it("paints the skeleton only on a cold entry, then the rows once the list lands", async () => {
    let release: (value: Response) => void = () => {};
    authFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    await act(async () => {
      root.render(<Host workspaceId="w1" />);
    });
    // Nothing cached: the cold branch is a skeleton, never a sentence.
    expect(host.querySelector("[data-skeleton]")).not.toBeNull();
    await act(async () => {
      release(jsonResponse({ connectors: [row("gcal")] }));
      await settle();
    });
    expect(host.querySelector("[data-skeleton]")).toBeNull();
    expect(host.textContent).toContain("GCAL");
  });

  it("a mark-stale repaints without a blank frame: rows stay up while revalidating, then update (N3)", async () => {
    const key = connectorsCacheKey("w1");
    await loadSurfaceCache(key, async () => [row("gmail")]);
    let release: (value: Response) => void = () => {};
    authFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );

    await act(async () => {
      root.render(<Host workspaceId="w1" />);
    });
    expect(host.textContent).toContain("GMAIL");
    expect(authFetch).not.toHaveBeenCalled();

    await act(async () => {
      markSurfaceCacheStale(key);
    });
    // The old rows are still on screen, the refetch runs behind them.
    expect(host.querySelector("[data-skeleton]")).toBeNull();
    expect(host.textContent).toContain("GMAIL");
    expect(host.querySelector("ul")?.getAttribute("data-revalidating")).toBe("true");
    expect(authFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      release(jsonResponse({ connectors: [row("gmail"), row("slack")] }));
      await settle();
    });
    expect(host.textContent).toContain("SLACK");
    expect(host.querySelector("ul")?.getAttribute("data-revalidating")).toBe("false");
  });

  it("keys the list per workspace AND viewer, so two accounts never share a rail (N2)", () => {
    expect(connectorsCacheKey("w1")).toBe("connectors:w1:u1");
    user.id = "u2";
    expect(connectorsCacheKey("w1")).toBe("connectors:w1:u2");
    user.id = "u1";
    expect(connectorsCacheKey("w2")).not.toBe(connectorsCacheKey("w1"));
  });

  it("mutate() edits the cached rows in place so a revisit paints the edit", async () => {
    const key = connectorsCacheKey("w1");
    await loadSurfaceCache(key, async () => [row("gmail")]);
    authFetch.mockImplementation(() => new Promise(() => {}));
    let api: ReturnType<typeof useConnectorsList> | null = null;
    function Probe() {
      api = useConnectorsList("w1");
      return null;
    }
    await act(async () => {
      root.render(<Probe />);
    });
    await act(async () => {
      api!.mutate((prev) => prev.map((c) => (c.id === "gmail" ? { ...c, connected: true } : c)));
    });
    expect(readSurfaceCache<Connector[]>(key).data?.[0]?.connected).toBe(true);
  });
});

describe("[COMP:app-web/studio-connectors-cache] fetchConnectorsList", () => {
  it("collapses a workspace storage binding to its single manageable instance row", () => {
    const rows = collapseConnectorRows([
      row("gcs"),
      row("gcs", { connectorInstanceId: "i1", connected: true }),
      row("s3"),
      row("local", { connectorInstanceId: "i2", connected: true }),
      row("local"),
      row("gmail"),
    ]);
    expect(rows.map((r) => `${r.id}:${r.connectorInstanceId ?? "-"}`)).toEqual([
      "gcs:i1",
      "s3:-",
      "local:i2",
      "gmail:-",
    ]);
  });

  it("throws on a non-OK response so the cache keeps its last good rows", async () => {
    authFetch.mockImplementation(async () => jsonResponse({ error: "nope" }, 500));
    await expect(fetchConnectorsList("w1")).rejects.toThrow();
    // A failed revalidation must not blank a list the user is reading: the
    // store keeps the previous value and only records the error.
    const key = connectorsCacheKey("w1");
    await loadSurfaceCache(key, async () => [row("gmail")]);
    await loadSurfaceCache(key, () => fetchConnectorsList("w1"));
    expect(readSurfaceCache<Connector[]>(key).data).toEqual([row("gmail")]);
    expect(readSurfaceCache(key).error).toBeInstanceOf(Error);
  });
});
