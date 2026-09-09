// @vitest-environment jsdom
/**
 * [COMP:app-web/brain-entity] The entity detail route paints from the
 * surface cache (instant-navigation contract N1 / N3 / N4) - the
 * representative of the four Brain detail routes (entity, entry, skill,
 * blueprint), which all read a `brain-*:<wid>:<viewer>:<id>` slot and fall
 * back to a header + section skeleton, never the old "…" placeholder.
 */

import { Suspense, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { EntityRollup } from "@/lib/api/brain";
import {
  loadSurfaceCache,
  markSurfaceCacheStale,
  resetSurfaceCache,
} from "@/lib/surface-cache";
import { brainEntityCacheKey } from "@/lib/surface-prefetch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaces: () => ({ activeId: "w1", workspaces: [], active: null }),
}));
vi.mock("@/lib/workspace-context", () => ({
  useWorkspaceContext: () => ({ me: { id: "u1" } }),
}));
vi.mock("@/lib/user", () => ({
  getUserInfo: () => ({ id: "u1", name: "n", email: "e" }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/lib/offline/brain-content-cache", () => ({
  readBrainContentCache: vi.fn(async () => null),
  isRecordValue: (v: unknown) => !!v && typeof v === "object",
}));
vi.mock("@/components/brain/entity-row", () => ({
  EntityRow: ({ row }: { row: { name: string } }) => <div>{row.name}</div>,
}));
vi.mock("@/components/provenance/provenance-sheet", () => ({
  ProvenanceSheet: () => null,
}));
vi.mock("@/components/context/reclassify-context-dialog", () => ({
  ReclassifyContextButton: () => null,
}));

const api = vi.hoisted(() => ({ getEntity: vi.fn() }));
vi.mock("@/lib/api/brain", () => ({
  getEntity: (...args: unknown[]) => api.getEntity(...args),
}));

import BrainEntityPage from "../page";

const dict = en as unknown as Dictionary;

const entity = (name: string): EntityRollup =>
  ({
    id: "e1",
    kind: "company",
    name,
    sensitivity: "internal",
    aliases: [],
    attributes: {},
    authorship: { createdByUserId: "u1", createdByAssistantId: null, sourceEpisodeId: null },
    summary: { memoriesCount: 0, tasksCount: 0, filesCount: 0, knowledgeCount: 0, episodesCount: 0 },
    embedded: { recentMemories: [], openTasks: [], files: [], knowledge: [], recentEpisodes: [], edges: [] },
    pendingChanges: [],
  }) as unknown as EntityRollup;

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
          <BrainEntityPage params={Promise.resolve({ workspaceId: "w1", entityId: "e1" })} />
        </Suspense>
      </I18nProvider>,
    );
    await settle();
    await settle();
  });
}

beforeEach(() => {
  resetSurfaceCache();
  api.getEntity.mockReset();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("[COMP:app-web/brain-entity] entity detail paints from the surface cache", () => {
  it("first paint renders the warmed entity while the fetch is still pending (no placeholder)", async () => {
    const key = brainEntityCacheKey("w1", "e1");
    await loadSurfaceCache(key, async () => entity("Acme Example"));
    markSurfaceCacheStale(key);
    api.getEntity.mockReturnValue(pending());

    await mount();

    expect(host!.querySelector("h1")?.textContent).toBe("Acme Example");
    expect(host!.querySelector("[aria-busy]")).toBeNull();
    expect(host!.textContent).not.toContain("…");
    expect(api.getEntity).toHaveBeenCalledTimes(1);
  });

  it("a cold cache paints a header + section skeleton, never the old placeholder (N4)", async () => {
    api.getEntity.mockReturnValue(pending());
    await mount();
    expect(host!.querySelector("[aria-busy]")).not.toBeNull();
    expect(host!.textContent).not.toContain("…");
  });

  it("a brain mark-stale repaints behind the paint", async () => {
    const key = brainEntityCacheKey("w1", "e1");
    await loadSurfaceCache(key, async () => entity("Acme Example"));
    await mount();

    let resolveEntity: (e: EntityRollup) => void = () => {};
    api.getEntity.mockReturnValue(
      new Promise<EntityRollup>((resolve) => {
        resolveEntity = resolve;
      }),
    );
    await act(async () => {
      markSurfaceCacheStale("brain-entity:w1:");
      await settle();
    });
    expect(host!.querySelector("h1")?.textContent).toBe("Acme Example");
    expect(host!.querySelector("[aria-busy]")).toBeNull();

    await act(async () => {
      resolveEntity(entity("Acme Example Ltd"));
      await settle();
    });
    expect(host!.querySelector("h1")?.textContent).toBe("Acme Example Ltd");
  });
});
