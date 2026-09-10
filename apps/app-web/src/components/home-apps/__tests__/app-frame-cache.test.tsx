// @vitest-environment jsdom
/**
 * [COMP:app-web/surface-cache-tail] The custom Home app frame paints from the
 * surface cache (instant-navigation contract N1 / N3 / N4).
 *
 * (a) A warmed `home-app-session:<wid>:<viewer>:<appId>` key mounts the
 * iframe on the FIRST frame while the session fetch is still pending - no
 * skeleton, no "Loading the app" sentence. (b) A mark-stale (what
 * `HOME_APPS_REFRESH_EVENT` sends) keeps the frame mounted while the session
 * revalidates, then adopts the new entry URL.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ fetchHomeAppSession: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/operator/operator-topbar", () => ({
  OperatorTopbar: ({ customApp }: { customApp?: { name: string } }) => (
    <div data-testid="topbar">{customApp?.name}</div>
  ),
}));
vi.mock("@/lib/api/home-apps", () => ({
  fetchHomeAppSession: (...args: unknown[]) => api.fetchHomeAppSession(...args),
}));
vi.mock("@/lib/i18n/client", async () => {
  const { en } = await import("@/lib/i18n/dictionaries/en");
  return { useT: () => en, format: (s: string) => s };
});

import type { HomeAppSession } from "@/lib/api/home-apps";
import { AppFrame } from "../app-frame";
import { homeAppSessionCacheKey } from "@/lib/surface-prefetch";
import { loadSurfaceCache, markSurfaceCacheStale, resetSurfaceCache } from "@/lib/surface-cache";

const KEY = homeAppSessionCacheKey("ws-1", "app-1");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function session(overrides: Partial<HomeAppSession> = {}): HomeAppSession {
  return {
    id: "app-1",
    name: "Dash",
    description: null,
    icon: null,
    status: "active",
    syncError: null,
    lastSyncedAt: null,
    renderable: true,
    requestedScopes: null,
    grantedScopes: null,
    entryUrl: "/api/home-apps/app-1/entry?sig=one",
    bridgeToken: "masked-token",
    bridgeTokenTtlMs: 600_000,
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<AppFrame workspaceId="ws-1" appId="app-1" />);
    await settle();
  });
}

const frame = () => container!.querySelector("iframe");
const skeleton = () => container!.querySelector('[data-testid="home-app-skeleton"]');

beforeEach(() => {
  resetSurfaceCache();
  api.fetchHomeAppSession.mockReset();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("[COMP:app-web/surface-cache-tail] Custom app frame from the surface cache", () => {
  it("paints a cold entry as the pane skeleton under the chrome, never a sentence", async () => {
    api.fetchHomeAppSession.mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(skeleton()).not.toBeNull();
    expect(frame()).toBeNull();
    expect(container!.textContent).not.toContain("Loading the app");
  });

  it("first paint from a warmed key mounts the iframe while the session fetch is still pending", async () => {
    await loadSurfaceCache(KEY, async () => session());
    markSurfaceCacheStale(KEY);
    api.fetchHomeAppSession.mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(api.fetchHomeAppSession).toHaveBeenCalledTimes(1);
    expect(skeleton()).toBeNull();
    expect(frame()?.getAttribute("src")).toContain("/api/home-apps/app-1/entry?sig=one");
    expect(container!.textContent).toContain("Dash");
  });

  it("a mark-stale keeps the frame mounted while the session revalidates, then adopts the new entry", async () => {
    await loadSurfaceCache(KEY, async () => session());
    let release: (value: HomeAppSession) => void = () => {};
    api.fetchHomeAppSession.mockImplementation(
      () => new Promise<HomeAppSession>((resolve) => { release = resolve; }),
    );
    await mount();
    expect(api.fetchHomeAppSession).not.toHaveBeenCalled();

    await act(async () => {
      markSurfaceCacheStale("home-app-session:ws-1:");
      await settle();
    });
    expect(api.fetchHomeAppSession).toHaveBeenCalledTimes(1);
    expect(frame()?.getAttribute("src")).toContain("sig=one");
    expect(skeleton()).toBeNull();

    await act(async () => {
      release(session({ entryUrl: "/api/home-apps/app-1/entry?sig=two" }));
      await settle();
    });
    expect(frame()?.getAttribute("src")).toContain("sig=two");
  });
});
