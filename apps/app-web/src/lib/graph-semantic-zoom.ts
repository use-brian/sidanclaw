// [COMP:app-web/graph-semantic-zoom]
/** Pure lifecycle decisions for the Brain graph's server-backed drill-down. */

/**
 * The full graph skeleton is a cold-start affordance only. A group/search
 * projection request must preserve the already-painted canvas; replacing it
 * with the skeleton destroys spatial context and makes every zoom feel like a
 * route reload.
 */
export function shouldShowGraphLoader(input: {
  initialLoading: boolean;
  scopeLoading: boolean;
  hasDimensions: boolean;
  hasRenderer: boolean;
}): boolean {
  return input.initialLoading || !input.hasDimensions || !input.hasRenderer;
}

export function graphScopeCacheKey(input: {
  workspaceId: string;
  viewpointAssistantId?: string | null;
  showMemory?: boolean;
  scopeId?: string | null;
  focusQuery?: string | null;
  /** Exact-id focus (the chat-audit highlight) - order-insensitive. */
  focusIds?: readonly string[] | null;
  revealFocus?: boolean;
}): string {
  const ids =
    input.focusIds && input.focusIds.length > 0
      ? [...input.focusIds].sort().join(",")
      : "";
  return [
    input.workspaceId,
    input.viewpointAssistantId ?? "",
    input.showMemory ? "memory" : "",
    input.scopeId ?? "overview",
    input.focusQuery?.trim().toLocaleLowerCase() ?? "",
    ids,
    ids && input.revealFocus ? "reveal" : "",
  ].join("\x00");
}
