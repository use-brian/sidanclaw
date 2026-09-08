/**
 * [COMP:app-web/surface-prefetch] — the pure half of intent prefetch: the cache
 * keys, the warm targets, and the workspace id parsed out of a link's href.
 *
 * These matter because the KEY IS THE CONTRACT. A hover warms
 * `surfaceDataKey('tasks', wid)` and the Tasks surface mounts reading the same
 * call. If the two ever produce different strings the prefetch still "works" —
 * it just fills a slot nobody reads, and every navigation silently pays full
 * price again while looking like it was optimised. That is exactly what the
 * CRM warm did until 2026-09-08: it filled the bare `crm:<wid>` key while the
 * surface read `crm:<wid>:config`, `:collection:...`, `:lookups`, ... and
 * never the bare one. So beyond pinning the strings, the last block reads each
 * surface's SOURCE and checks it builds its key with the builder the warm
 * target uses.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const user = vi.hoisted(() => ({ id: null as string | null }));
vi.mock("@/lib/user", () => ({
  getUserInfo: () => (user.id ? { id: user.id, name: "n", email: "e" } : null),
}));
// The warm targets import the API SDKs; they are never called here.
vi.mock("@/lib/api/crm", () => ({ fetchCrmConfig: vi.fn() }));
vi.mock("@/lib/api/tasks", () => ({ fetchWorkspaceTasks: vi.fn() }));
vi.mock("@/lib/api/workflow", () => ({ listWorkflows: vi.fn() }));
vi.mock("@/lib/api/views", () => ({ getView: vi.fn() }));

import {
  crmConfigCacheKey,
  docPageCacheKey,
  surfaceDataKey,
  warmTargetFor,
  workspaceIdFromPath,
  type WarmableSurface,
} from "@/lib/surface-prefetch";

afterEach(() => {
  user.id = null;
});

describe("[COMP:app-web/surface-prefetch] Surface prefetch keys", () => {
  it("keys the warmable surfaces per workspace", () => {
    expect(surfaceDataKey("tasks", "w1")).toBe("tasks:w1");
    expect(surfaceDataKey("crm", "w1")).toBe("crm:w1");
    expect(surfaceDataKey("workflow", "w1")).toBe("workflow:w1");
  });

  it("appends the signed-in viewer so two accounts in one tab never share a list (N2)", () => {
    // Rows depend on the caller's RLS visibility; the multi-account switcher
    // can change the viewer without a reload.
    user.id = "u1";
    expect(surfaceDataKey("tasks", "w1")).toBe("tasks:w1:u1");
    expect(surfaceDataKey("crm", "w1")).toBe("crm:w1:u1");
    expect(crmConfigCacheKey("w1")).toBe("crm:w1:u1:config");
    user.id = "u2";
    expect(surfaceDataKey("tasks", "w1")).not.toBe("tasks:w1:u1");
  });

  it("keeps the workspace FIRST so prefix marks and invalidations still match every viewer variant", () => {
    user.id = "u1";
    for (const key of [surfaceDataKey("tasks", "w1")!, crmConfigCacheKey("w1")]) {
      expect(key.startsWith("tasks:w1") || key.startsWith("crm:w1:")).toBe(true);
    }
  });

  it("scopes keys by workspace so two workspaces never share a list", () => {
    expect(surfaceDataKey("tasks", "w1")).not.toBe(surfaceDataKey("tasks", "w2"));
  });

  it("returns null for surfaces with no single landing list", () => {
    // Brain's graph, Studio's per-section fetches and the doc surface's
    // per-page metadata are deliberately not keyed here — a half-right key
    // would mask a miss rather than warm anything.
    expect(surfaceDataKey("brain", "w1")).toBeNull();
    expect(surfaceDataKey("studio", "w1")).toBeNull();
    expect(surfaceDataKey("p", "w1")).toBeNull();
    expect(surfaceDataKey(null, "w1")).toBeNull();
  });

  it("returns null without a workspace id", () => {
    expect(surfaceDataKey("tasks", null)).toBeNull();
    expect(surfaceDataKey("tasks", undefined)).toBeNull();
    expect(surfaceDataKey("tasks", "")).toBeNull();
  });

  it("keys doc pages per page, not per surface", () => {
    expect(docPageCacheKey("abc")).toBe("page:abc");
    expect(docPageCacheKey("abc")).not.toBe(docPageCacheKey("def"));
  });

  it("parses the workspace id out of an in-app href", () => {
    expect(workspaceIdFromPath("/w/w1/tasks")).toBe("w1");
    expect(workspaceIdFromPath("/w/w1/p/page-id")).toBe("w1");
    expect(workspaceIdFromPath("/w/w1")).toBe("w1");
    expect(workspaceIdFromPath("/w/w1?x=1")).toBe("w1");
  });

  it("returns null for hrefs outside a workspace", () => {
    expect(workspaceIdFromPath("/teams")).toBeNull();
    expect(workspaceIdFromPath("/login")).toBeNull();
    expect(workspaceIdFromPath("")).toBeNull();
  });
});

/**
 * Every warm key must equal a key its surface reads. The warm target names
 * the builder; the surface's source must call that same builder for the same
 * surface. A warm that fills a slot nobody reads is silent by construction,
 * so this is the only place it can fail.
 */
describe("[COMP:app-web/surface-prefetch] every warm key is a key its surface reads", () => {
  const src = (rel: string) => readFileSync(resolve(process.cwd(), "src", rel), "utf8");
  const SURFACES: Record<WarmableSurface, { source: string; builder: string }> = {
    tasks: {
      source: "components/tasks/tasks-surface.tsx",
      builder: 'surfaceDataKey("tasks", workspaceId)',
    },
    crm: {
      source: "components/crm/crm-surface.tsx",
      builder: "crmConfigCacheKey(workspaceId)",
    },
    workflow: {
      source: "app/w/[workspaceId]/workflow/page.tsx",
      builder: 'surfaceDataKey("workflow", activeId)',
    },
  };

  for (const [surface, { source, builder }] of Object.entries(SURFACES) as Array<
    [WarmableSurface, { source: string; builder: string }]
  >) {
    it(`${surface}: the surface reads the builder the warm target fills`, () => {
      user.id = "u1";
      const target = warmTargetFor(surface, "w1");
      const expected =
        surface === "crm" ? crmConfigCacheKey("w1") : surfaceDataKey(surface, "w1");
      expect(target.key).toBe(expected);
      expect(typeof target.fetch).toBe("function");
      // The surface builds its key through the SAME builder, from the prefetch
      // module — never a hand-rebuilt string.
      const text = src(source);
      expect(text).toContain(builder);
      expect(text).toContain('from "@/lib/surface-prefetch"');
    });
  }

  it("the CRM warm fills the config region, the first thing the surface needs to paint", () => {
    expect(warmTargetFor("crm", "w1").key).toMatch(/^crm:w1(:[^:]+)?:config$/);
    // The bare root key is a family prefix, not a slot anything reads.
    expect(src("components/crm/crm-surface.tsx")).not.toMatch(/useCachedResource\(\s*crmKey\s*,/);
  });
});
