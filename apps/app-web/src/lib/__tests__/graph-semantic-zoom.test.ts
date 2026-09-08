import { describe, expect, it } from "vitest";
import {
  graphScopeCacheKey,
  shouldShowGraphLoader,
} from "@/lib/graph-semantic-zoom";

describe("[COMP:app-web/graph-semantic-zoom] graph drill-down lifecycle", () => {
  it("shows the full skeleton during the initial graph load", () => {
    expect(
      shouldShowGraphLoader({
        initialLoading: true,
        scopeLoading: false,
        hasDimensions: true,
        hasRenderer: true,
      }),
    ).toBe(true);
  });

  it("preserves the painted graph while a child scope loads", () => {
    expect(
      shouldShowGraphLoader({
        initialLoading: false,
        scopeLoading: true,
        hasDimensions: true,
        hasRenderer: true,
      }),
    ).toBe(false);
  });

  it("covers renderer and first-measure readiness without scope reloads", () => {
    expect(
      shouldShowGraphLoader({
        initialLoading: false,
        scopeLoading: false,
        hasDimensions: false,
        hasRenderer: true,
      }),
    ).toBe(true);
    expect(
      shouldShowGraphLoader({
        initialLoading: false,
        scopeLoading: false,
        hasDimensions: true,
        hasRenderer: false,
      }),
    ).toBe(true);
  });

  it("keys scope cache entries by viewer projection and normalized focus", () => {
    const base = graphScopeCacheKey({
      workspaceId: "ws",
      viewpointAssistantId: "assistant",
      showMemory: true,
      scopeId: "group-a",
      focusQuery: "  Acme  ",
    });
    expect(base).toBe(
      graphScopeCacheKey({
        workspaceId: "ws",
        viewpointAssistantId: "assistant",
        showMemory: true,
        scopeId: "group-a",
        focusQuery: "acme",
      }),
    );
    expect(base).not.toBe(
      graphScopeCacheKey({
        workspaceId: "ws",
        viewpointAssistantId: "other",
        showMemory: true,
        scopeId: "group-a",
        focusQuery: "acme",
      }),
    );
  });

  it("keys an id focus order-insensitively and separates reveal from mark", () => {
    const plain = graphScopeCacheKey({ workspaceId: "ws" });
    const marked = graphScopeCacheKey({ workspaceId: "ws", focusIds: ["b", "a"] });
    expect(marked).not.toBe(plain);
    expect(marked).toBe(graphScopeCacheKey({ workspaceId: "ws", focusIds: ["a", "b"] }));
    expect(graphScopeCacheKey({ workspaceId: "ws", focusIds: ["a", "b"], revealFocus: true })).not.toBe(
      marked,
    );
    // Reveal without ids is not a distinct projection.
    expect(graphScopeCacheKey({ workspaceId: "ws", revealFocus: true })).toBe(plain);
    expect(graphScopeCacheKey({ workspaceId: "ws", focusIds: [] })).toBe(plain);
  });
});
