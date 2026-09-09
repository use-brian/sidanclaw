// @vitest-environment jsdom
/**
 * [COMP:app-web/surface-cache-invalidation] The ONE spine-to-cache map
 * (instant-navigation contract N3).
 *
 * Two findings this pins. Tasks and CRM read the surface cache but never
 * subscribed to the spine, so a task or deal an assistant wrote from chat
 * reached the sidebar counts (which do subscribe) but not the open list until
 * the 30s stale window elapsed. And a spine signal must mark stale, never
 * invalidate: the open list keeps painting and revalidates behind the paint.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { BRAIN_REFRESH_EVENT } from "@/lib/brain-events";
import { APPROVALS_REFRESH_EVENT } from "@/lib/approvals-events";
import { WORKFLOW_REFRESH_EVENT } from "@/lib/workflow-events";
import { ASSISTANT_REFRESH_EVENT } from "@/lib/assistant-events";
import { SKILL_REFRESH_EVENT, LIVE_REFRESH_EVENT } from "@/lib/workspace-events";
import {
  SURFACE_CACHE_SPINE_EVENTS,
  applySpineEventToSurfaceCache,
  staleMarksFor,
} from "@/lib/surface-cache-invalidation";
import {
  isSurfaceCacheStale,
  loadSurfaceCache,
  readSurfaceCache,
  resetSurfaceCache,
} from "@/lib/surface-cache";

describe("[COMP:app-web/surface-cache-invalidation] routing table", () => {
  it("maps the brain primitives to the Tasks list, every CRM region and the graph", () => {
    expect(staleMarksFor(BRAIN_REFRESH_EVENT, "w1")).toEqual([
      "tasks:w1",
      "crm:w1:",
      "brain-graph:w1:",
    ]);
  });

  it("maps the orchestration primitives to their surfaces", () => {
    expect(staleMarksFor(APPROVALS_REFRESH_EVENT, "w1")).toContain("approvals:w1");
    expect(staleMarksFor(WORKFLOW_REFRESH_EVENT, "w1")).toEqual([
      "workflow:w1",
      "workflow-detail:w1:",
    ]);
    expect(staleMarksFor(ASSISTANT_REFRESH_EVENT, "w1")).toEqual([
      "assistants:w1",
      "chat-roster:w1",
    ]);
    expect(staleMarksFor(SKILL_REFRESH_EVENT, "w1")).toEqual(["skills:w1"]);
    expect(staleMarksFor(LIVE_REFRESH_EVENT, "w1")).toEqual(["live:w1"]);
  });

  it("every listened event has at least one prefix, and every prefix is workspace-first", () => {
    for (const event of SURFACE_CACHE_SPINE_EVENTS) {
      const marks = staleMarksFor(event, "w1");
      expect(marks.length).toBeGreaterThan(0);
      for (const prefix of marks) expect(prefix).toMatch(/^[a-z-]+:w1(:|$)/);
    }
  });

  it("returns nothing for an event it does not know (a newer client vocabulary must not throw)", () => {
    expect(staleMarksFor("sidan:something-new", "w1")).toEqual([]);
  });
});

describe("[COMP:app-web/surface-cache-invalidation] marks stale without dropping data", () => {
  beforeEach(() => {
    resetSurfaceCache();
  });

  it("BRAIN_REFRESH_EVENT makes tasks:<wid> and crm:<wid>: stale and keeps their rows", async () => {
    // Viewer-keyed variants are what the surfaces actually read.
    await loadSurfaceCache("tasks:w1:u1", async () => ["t1"]);
    await loadSurfaceCache("crm:w1:u1:config", async () => ({ pipelines: [] }));
    await loadSurfaceCache("tasks:w2:u1", async () => ["other"]);
    expect(isSurfaceCacheStale("tasks:w1:u1")).toBe(false);

    applySpineEventToSurfaceCache(BRAIN_REFRESH_EVENT, { workspaceId: "w1" }, "w1");

    expect(isSurfaceCacheStale("tasks:w1:u1")).toBe(true);
    expect(isSurfaceCacheStale("crm:w1:u1:config")).toBe(true);
    // Stale, not gone: the open list keeps painting while it revalidates.
    expect(readSurfaceCache<string[]>("tasks:w1:u1").data).toEqual(["t1"]);
    expect(readSurfaceCache("crm:w1:u1:config").data).toEqual({ pipelines: [] });
    // Another workspace's list is untouched.
    expect(isSurfaceCacheStale("tasks:w2:u1")).toBe(false);
  });

  it("ignores an event that names a different workspace, applies the catch-up shape", async () => {
    await loadSurfaceCache("tasks:w1:u1", async () => ["t1"]);
    applySpineEventToSurfaceCache(BRAIN_REFRESH_EVENT, { workspaceId: "w9" }, "w1");
    expect(isSurfaceCacheStale("tasks:w1:u1")).toBe(false);
    // The stream's catch-up burst carries no workspace id on some events.
    applySpineEventToSurfaceCache(BRAIN_REFRESH_EVENT, null, "w1");
    expect(isSurfaceCacheStale("tasks:w1:u1")).toBe(true);
  });
});

import { HOME_APPS_REFRESH_EVENT } from "@/lib/home-apps-events";

describe("[COMP:app-web/surface-cache-invalidation] Association module signals", () => {
  it("marks the viewer-scoped module state on workspace configuration changes", () => {
    expect(staleMarksFor(HOME_APPS_REFRESH_EVENT, "w1")).toContain("association-module:w1");
  });
});
