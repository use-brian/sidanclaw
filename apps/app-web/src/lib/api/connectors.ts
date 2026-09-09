/**
 * SDK for the Studio -> Connectors list (app-web).
 *
 * The connectors page used to hold both the `Connector` row shape and the
 * list fetch inline. They live here now so the intent prefetch
 * (`lib/surface-prefetch.ts`) can warm the same fetch the page reads on
 * mount, through the same cache key, without importing a 5,000-line page
 * component. Same wire contract as before: `GET /api/connectors?workspaceId=`
 * returns personal + workspace-scoped rows, and the storage bindings
 * (`gcs` / `s3` / `local`) collapse to their single manageable instance row.
 *
 * Spec: docs/architecture/integrations/mcp.md -> "Unified connectors - the
 * master-detail Studio surface"; docs/architecture/features/perceived-performance.md
 * -> "Instant-navigation contract".
 * [COMP:app-web/studio-connectors-cache]
 */

import { authFetch } from "@/lib/auth-fetch";
import type { ConnectorAuthType } from "@use-brian/shared/builtin-connectors";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type Connector = {
  id: string;
  /**
   * The connector_instance UUID - distinct from `id`, the provider slug.
   * Workspace-expose / grant calls key on this. Absent only for
   * never-connected built-in placeholders.
   */
  connectorInstanceId?: string;
  name: string;
  /** Per-instance, user-editable nickname (defaults to the provider name). */
  label?: string;
  /** Oldest instance of this provider - keeps canonical tools at runtime. */
  isPrimary?: boolean;
  /** Whether the user can connect ANOTHER instance of this provider. */
  addable?: boolean;
  /** A built-in provider with no instance yet (the bare connect affordance). */
  isPlaceholder?: boolean;
  description?: string;
  connected: boolean;
  /** Pipeline-C state; selects the stronger state-aware removal warning. */
  ingestionEnabled?: boolean;
  /**
   * Liveness (migration 294). "auth_failed" means the credentials stopped
   * working (a 401/403 at call time) and the connector needs reconnecting even
   * though `connected` is still true - drives the "Reconnect needed" state.
   */
  healthStatus?: "ok" | "auth_failed" | "degraded" | "unknown";
  custom?: boolean;
  url?: string;
  oauthRequired?: boolean;
  icon_url?: string;
  category?: "official" | "community";
  connectedEmail?: string;
  /**
   * Tracks which OAuth scope revision was used when the user last connected.
   * `gdrive` migrated from documents+spreadsheets+presentations to
   * `drive.file` + Picker (scopeVersion = 2). Unset / older values on a
   * connected row mean the user needs to reconnect to use the new flow.
   */
  scopeVersion?: number;
  /** Managed Picker access or customer-owned full-Drive read access. */
  driveAccessMode?: "picked_files" | "full_drive_readonly";
  /** Custom connectors only - how outbound MCP calls authenticate. */
  authType?: ConnectorAuthType;
  /** Custom-header connectors only - the non-secret header name. */
  authHeaderName?: string;
  /**
   * Read-only workspace-shared row - a connector available to you in this
   * workspace that you do NOT own (a teammate exposed it, or a legacy
   * team-native instance). No manage/connect/remove affordances; credentials
   * never leave the server. Set by the backend's "Available in this workspace"
   * list.
   */
  readonly?: boolean;
  /** Read-only rows only - how it reaches you: 'granted' | 'team_native'. */
  source?: "granted" | "team_native";
  /** Read-only granted rows only - display name of the member who shared it. */
  sharedBy?: string | null;
};

/**
 * Workspace-scoped storage bindings surface BOTH as an official "Connect"
 * placeholder and as the workspace binding instance. Collapse each to the
 * single manageable instance row (which carries the connected state + the
 * Remove affordance) whenever a binding exists.
 */
const COLLAPSE_TO_INSTANCE: readonly string[] = ["gcs", "s3", "local"];

/** Pure half of the list fetch: the storage-binding collapse. */
export function collapseConnectorRows(rows: Connector[]): Connector[] {
  let out = rows;
  for (const id of COLLAPSE_TO_INSTANCE) {
    if (out.some((r) => r.id === id && r.connectorInstanceId)) {
      out = out.filter((r) => !(r.id === id && !r.connectorInstanceId));
    }
  }
  return out;
}

/**
 * The connectors list for one workspace - the fetcher behind
 * `connectorsCacheKey(workspaceId)`. Throws on a non-OK response so the cache
 * keeps its last good rows instead of adopting an empty list.
 */
export async function fetchConnectorsList(workspaceId: string): Promise<Connector[]> {
  // Pass the active workspace so the API includes workspace-scoped connectors
  // (e.g. the BYO `gcs` storage binding) in the list, not just personal ones.
  const listUrl = workspaceId
    ? `${API_URL}/api/connectors?workspaceId=${encodeURIComponent(workspaceId)}`
    : `${API_URL}/api/connectors`;
  const res = await authFetch(listUrl);
  if (!res.ok) throw new Error(`connectors list failed (${res.status})`);
  const data = (await res.json()) as { connectors?: Connector[] } | null;
  if (!data?.connectors) throw new Error("connectors list: malformed response");
  return collapseConnectorRows(data.connectors);
}
