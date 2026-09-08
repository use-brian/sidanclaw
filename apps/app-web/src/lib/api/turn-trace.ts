/**
 * Turn-trace SDK (app-web) - the chat-audit browser's read side.
 *
 * Wraps the two member-gated sessions routes the turn ledger serves
 * (`docs/architecture/engine/turn-ledger.md` -> "The audit read model"):
 *
 *   - `GET /api/sessions/:id/turns/:messageId/trace` - the epoch-routed
 *     trace: `fidelity: 'full'` (pointer-only `turn_events` steps) or
 *     `fidelity: 'legacy'` (a best-effort composition for pre-epoch turns).
 *   - `GET /api/sessions/:id/turns/payloads/:hash` - the ONLY content path.
 *     An erased payload answers 410 with an explicit marker; the SDK keeps
 *     that distinction (`{ erased: true }`), never a silent empty string.
 *
 * Both return `null` on any other failure so the audit panel can render an
 * honest "trace unavailable" line instead of throwing into the Brain page.
 *
 * Spec: docs/architecture/features/chat-audit.md -> "Read model".
 * [COMP:app-web/turn-audit]
 */

import { authFetch } from "@/lib/auth-fetch";
import type { TurnTrace } from "@/lib/turn-audit";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export async function fetchTurnTrace(
  sessionId: string,
  messageId: string,
  opts?: { signal?: AbortSignal },
): Promise<TurnTrace | null> {
  try {
    const res = await authFetch(
      `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(messageId)}/trace`,
      opts?.signal ? { signal: opts.signal } : {},
    );
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<TurnTrace>;
    if (!Array.isArray(data.steps)) return null;
    return {
      fidelity: data.fidelity === "full" ? "full" : "legacy",
      preEpoch: typeof data.preEpoch === "boolean" ? data.preEpoch : null,
      sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
      steps: data.steps.map((s, index) => ({
        ordinal: typeof s.ordinal === "number" ? s.ordinal : index,
        kind: typeof s.kind === "string" ? s.kind : "other",
        actor: typeof s.actor === "string" ? s.actor : undefined,
        metadata:
          s.metadata && typeof s.metadata === "object"
            ? (s.metadata as Record<string, unknown>)
            : {},
        payloadRefs: Array.isArray(s.payloadRefs)
          ? s.payloadRefs.filter((r): r is string => typeof r === "string")
          : [],
        at: typeof s.at === "string" ? s.at : null,
      })),
    };
  } catch {
    return null;
  }
}

export type TurnPayload =
  | { kind: "text"; text: string; mediaType: string }
  | { kind: "erased" };

/**
 * Dereference one payload hash. JSON payloads (messages, tool inputs,
 * responses) come back as their raw text; the caller decides how to
 * present them (`formatPayloadPreview` in `lib/turn-audit.ts`).
 */
export async function fetchTurnPayload(
  sessionId: string,
  hash: string,
  opts?: { signal?: AbortSignal },
): Promise<TurnPayload | null> {
  try {
    const res = await authFetch(
      `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/turns/payloads/${encodeURIComponent(hash)}`,
      opts?.signal ? { signal: opts.signal } : {},
    );
    if (res.status === 410) return { kind: "erased" };
    if (!res.ok) return null;
    const mediaType = res.headers.get("content-type") ?? "text/plain";
    const text = await res.text();
    return { kind: "text", text, mediaType };
  } catch {
    return null;
  }
}
