// @vitest-environment jsdom
/**
 * [COMP:app-web/shopify-surface-cache] The Shopify sidebar panel reads the
 * surface cache instead of fetching its own copy (instant-navigation contract
 * N1-N4, N7).
 *
 *  - Reachability comes from the SAME `shopify:<wid>` key the surface reads,
 *    and the drafts group from its own `shopify-drafts:<wid>` key: with both
 *    warm, the drafts, the admin deep links and the shop footer paint on the
 *    first frame with every fetch still pending (N1 / N2).
 *  - A cold drafts key paints skeleton rows in the sub-row geometry, never a
 *    "Loading..." sentence (N4).
 *  - The drafts fetcher asks for the shop identity and the draft products in
 *    ONE parallel round (N7) - the old panel chained three requests.
 *  - A stale mark keeps the drafts painted while the revalidation runs and
 *    swaps in the refreshed list when it lands (N3).
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
import { shopifyDraftsCacheKey, shopifyToolsCacheKey } from "@/lib/surface-prefetch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws-1/shopify",
  useSearchParams: () => new URLSearchParams("section=draft"),
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

const api = vi.hoisted(() => ({ listTools: vi.fn(), callTool: vi.fn() }));
vi.mock("@/lib/api/shopify", () => api);

import { ShopifySidebarPanel } from "../shopify-sidebar-panel";

const WORKSPACE = "ws-1";
const CONNECTED = { tools: ["shopifyGetShop", "shopifyListProducts"], connected: true };
const DRAFTS = {
  shop: { name: "Brian Test", domain: "brian-test.myshopify.com" },
  drafts: [{ id: "gid://shopify/Product/9", title: "Hojicha Black Maca", updated_at: "2026-08-06" }],
};
const pending = () => new Promise<never>(() => {});

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(ticks = 4) {
  for (let i = 0; i < ticks; i += 1) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={en}>
        <ShopifySidebarPanel workspaceId={WORKSPACE} />
      </I18nProvider>,
    );
  });
  await settle();
}

const text = () => host?.textContent ?? "";
const skeleton = () => host?.querySelector("[data-shopify-drafts-skeleton]") ?? null;

describe("[COMP:app-web/shopify-surface-cache] Shopify sidebar panel first paint", () => {
  beforeEach(() => {
    resetSurfaceCache();
    window.localStorage.clear();
    api.listTools.mockReset();
    api.callTool.mockReset();
  });
  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    host?.remove();
    host = null;
  });

  it("paints the drafts and the shop footer from warmed keys with every fetch still pending (N1, N2)", async () => {
    await loadSurfaceCache(shopifyToolsCacheKey(WORKSPACE), async () => CONNECTED);
    await loadSurfaceCache(shopifyDraftsCacheKey(WORKSPACE), async () => DRAFTS);
    api.listTools.mockImplementation(pending);
    api.callTool.mockImplementation(pending);
    await mount();
    expect(text()).toContain("Hojicha Black Maca");
    expect(text()).toContain("Brian Test");
    expect(text()).not.toContain(en.shopifyApp.loading);
    expect(skeleton()).toBeNull();
    // The admin deep link is built from the cached shop domain.
    expect(host!.querySelector('a[href="https://brian-test.myshopify.com/admin/products/9"]')).not.toBeNull();
    // Fresh keys are painted, not refetched.
    expect(api.listTools).not.toHaveBeenCalled();
    expect(api.callTool).not.toHaveBeenCalled();
  });

  it("paints skeleton rows, never a sentence, while the drafts key is cold (N4)", async () => {
    await loadSurfaceCache(shopifyToolsCacheKey(WORKSPACE), async () => CONNECTED);
    api.listTools.mockImplementation(pending);
    api.callTool.mockImplementation(pending);
    await mount();
    expect(skeleton()).not.toBeNull();
    expect(text()).not.toContain(en.shopifyApp.loading);
    // The section rows never wait on the store.
    expect(text()).toContain(en.shopifyApp.tabDraft);
    expect(text()).toContain(en.shopifyApp.tabAnalyse);
  });

  it("asks for the shop and the draft products in one parallel round (N7)", async () => {
    await loadSurfaceCache(shopifyToolsCacheKey(WORKSPACE), async () => CONNECTED);
    api.listTools.mockImplementation(pending);
    api.callTool.mockImplementation(pending);
    await mount();
    // Both tool calls are in flight before either has answered.
    const tools = api.callTool.mock.calls.map((call) => call[1]);
    expect(tools).toEqual(expect.arrayContaining(["shopifyGetShop", "shopifyListProducts"]));
    expect(tools).toHaveLength(2);
  });

  it("keeps the drafts painted through a stale mark and swaps in the refreshed list (N3)", async () => {
    await loadSurfaceCache(shopifyToolsCacheKey(WORKSPACE), async () => CONNECTED);
    await loadSurfaceCache(shopifyDraftsCacheKey(WORKSPACE), async () => DRAFTS);
    api.listTools.mockImplementation(pending);
    const release: Record<string, (value: unknown) => void> = {};
    api.callTool.mockImplementation(
      (_ws: string, tool: string) =>
        new Promise((resolve) => {
          release[tool] = resolve;
        }),
    );
    await mount();
    expect(text()).toContain("Hojicha Black Maca");

    await act(async () => {
      markSurfaceCacheStale(shopifyDraftsCacheKey(WORKSPACE));
    });
    await settle();
    expect(api.callTool).toHaveBeenCalledTimes(2);
    // No blank frame: the old rows stay up while the revalidation runs.
    expect(text()).toContain("Hojicha Black Maca");
    expect(skeleton()).toBeNull();

    await act(async () => {
      release.shopifyGetShop({ name: "Brian Test", myshopify_domain: "brian-test.myshopify.com" });
      release.shopifyListProducts({
        items: [{ id: "gid://shopify/Product/12", title: "Yuzu Kombucha", updated_at: "2026-09-01" }],
      });
    });
    await settle();
    expect(text()).toContain("Yuzu Kombucha");
    expect(text()).not.toContain("Hojicha Black Maca");
  });

  it("never asks the store for drafts while reachability says the store is not shared", async () => {
    await loadSurfaceCache(shopifyToolsCacheKey(WORKSPACE), async () => ({ tools: [], connected: false }));
    api.listTools.mockImplementation(pending);
    api.callTool.mockImplementation(pending);
    await mount();
    expect(api.callTool).not.toHaveBeenCalled();
    expect(text()).toContain(en.shopifyApp.notConnected);
    expect(text()).toContain(en.shopifyApp.tabDraft);
  });
});
