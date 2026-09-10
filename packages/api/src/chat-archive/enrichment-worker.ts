/**
 * Drains the message store's enrichment queue through canonical Pipeline B.
 *
 * The direction is inverted from the previous design. The archive owns its own
 * database now, so it also owns the ledger of which messages have been enriched
 * — it builds and leases the windows, and this worker pulls them. That leaves
 * exactly one owner of that state, and a consumer that dies mid-window strands
 * nothing: the lease expires and the window becomes claimable again.
 *
 * This worker deliberately contains no extraction logic. It renders nothing,
 * groups nothing, and decides nothing about eligibility; it moves already-formed
 * windows into the existing `BrainEpisodeIngestor` so entity, memory, task,
 * sensitivity, provenance, usage and charge behaviour stay identical to every
 * other episode source.
 *
 * [COMP:integrations/chat-archive-enrichment]
 */

import type { BrainEpisodeIngestor } from '../ingest-port.js'
import type { MessageStoreClient, EnrichmentWindow } from './message-store-client.js'

const DEFAULT_INTERVAL_MS = 30_000

/**
 * Windows claimed per tick.
 *
 * Each one costs an LLM extraction, and the lease is held for the whole batch,
 * so this is deliberately small: claiming more than can be processed promptly
 * just parks work under an expiring lease.
 */
const DEFAULT_BATCH = 3

export type ChatArchiveEnrichmentDeps = {
  client: MessageStoreClient
  ingest: BrainEpisodeIngestor
  /** Resolves the assistant that owns derived records for a workspace. */
  resolveAssistantId: (workspaceId: string, userId: string) => Promise<string | null>
  intervalMs?: number
  batchSize?: number
  logger?: Pick<Console, 'warn' | 'error'>
}

export type ChatArchiveEnrichmentWorker = {
  start(): void
  stop(): void
  /** Drains one batch. Exported so tests can step the worker deterministically. */
  runOnce(): Promise<void>
}

/**
 * Map the window's senders onto the provider-verified refs Pipeline B needs to
 * resolve a person to an existing contact instead of creating another.
 *
 * Extraction names people from the rendered text, so the ref is keyed on the
 * same resolved name the store rendered them under. A participant the store
 * left unnamed is skipped: it either has no name or shares one with another
 * sender, and in both cases no name can select it safely.
 *
 * The namespace is the provider plus the archive connector instance, both read
 * off the window. Neither may be assumed: a subject id is opaque, so binding a
 * WeChat id under `provider: 'whatsapp'`, or a JID under another account's
 * instance, silently attaches one person's identity to another's. A window
 * missing either yields no refs at all rather than identities that could
 * collide.
 */
export function personExternalRefsFor(
  window: EnrichmentWindow,
): Array<{ name: string; externalRef: Record<string, unknown>; phone?: string }> {
  const instanceId = window.source_ref?.archive_instance_id
  if (typeof instanceId !== 'string' || instanceId.trim() === '') return []
  const provider = typeof window.source === 'string' ? window.source.trim().toLowerCase() : ''
  if (provider === '') return []
  return (window.participants ?? [])
    .filter((p) => p.sender_id.trim() !== '' && p.display_name.trim() !== '')
    .map((p) => ({
      name: p.display_name,
      externalRef: { provider, id: p.sender_id, instance_id: instanceId },
      ...(p.phone ? { phone: p.phone } : {}),
    }))
}

export function createChatArchiveEnrichmentWorker(
  deps: ChatArchiveEnrichmentDeps,
): ChatArchiveEnrichmentWorker {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const batchSize = deps.batchSize ?? DEFAULT_BATCH
  const logger = deps.logger ?? console
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false

  async function processWindow(window: EnrichmentWindow): Promise<void> {
    try {
      const assistantId = await deps.resolveAssistantId(window.workspace_id, window.owner_user_id)
      if (!assistantId) {
        // Not a failure of this window: the workspace has no assistant to own
        // the derived records. Reporting it back lets the store retry later
        // rather than burning attempts here.
        await deps.client.failEnrichmentWindow(window.window_id, 'workspace has no primary assistant')
        return
      }

      const result = await deps.ingest({
        workspaceId: window.workspace_id,
        userId: window.owner_user_id,
        assistantId,
        content: window.rendered_text,
        occurredAt: new Date(window.window_end),
        sourceKind: 'channel_window',
        sourceRef: window.source_ref,
        contentRef: window.source_ref,
        personExternalRefs: personExternalRefsFor(window),
      })
      await deps.client.completeEnrichmentWindow(window.window_id, result.episodeId)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      logger.warn(`[chat-archive] enrichment failed for window ${window.window_id}: ${reason}`)
      try {
        await deps.client.failEnrichmentWindow(window.window_id, reason)
      } catch (reportErr) {
        // The lease will expire and the window returns to the queue on its own,
        // so a failed report costs a delay rather than the work itself.
        logger.error(`[chat-archive] could not report enrichment failure: ${String(reportErr)}`)
      }
    }
  }

  async function runOnce(): Promise<void> {
    if (running) return
    running = true
    try {
      const windows = await deps.client.claimEnrichmentWindows(batchSize)
      // Sequential on purpose: extraction is the expensive resource, and running
      // a batch concurrently would multiply peak model load for no throughput
      // gain the queue cannot already provide by handing out more windows.
      for (const window of windows) {
        await processWindow(window)
      }
    } catch (err) {
      // An unreachable store is expected during its restarts. The next tick
      // retries; nothing is lost because the store owns the ledger.
      logger.warn(`[chat-archive] enrichment claim failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      running = false
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => void runOnce(), intervalMs)
      timer.unref?.()
      void runOnce()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    runOnce,
  }
}
