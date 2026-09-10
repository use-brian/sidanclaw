"use client";

/**
 * Page-header action buttons (mig 321) — the human-approval gesture of the
 * page-actions feature. Renders every enabled binding that resolves for this
 * page (page-scoped + blueprint-scoped); a click confirms via `confirmDialog`
 * (with per-kind cost framing — a goal button starts credit-spending
 * autonomous work) and then invokes the action server-side. A workflow
 * invoke runs INLINE server-side and the resulting run appears in the
 * adjacent `PageWorkflowRuns` chip (`requestWorkflowRefresh` nudges it).
 *
 * Chrome, never a doc-model block: post-paint fetch, renders nothing when no
 * binding resolves, and a fetch failure hides the strip rather than erroring
 * the page.
 *
 * Two renderings over ONE flow (`usePageActions`): the desktop strip
 * (`PageActionButtons`, with its transient result pill) and the phone
 * variant (`PageActionMenuItems`), which the page header folds into its `...`
 * menu below `md` because a page with one binding plus a schedule and a run
 * overflowed the 332px action column and pushed the menu itself off-screen
 * (responsive contract M8; report B row 32). The menu variant reports its
 * outcome through `onFeedback` so the header can show it in its own notice
 * line (the menu has closed by the time the run resolves).
 *
 * [COMP:app-web/page-action-buttons]
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Play, Target } from "lucide-react";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { useT, format } from "@/lib/i18n/client";
import { requestWorkflowRefresh } from "@/lib/workflow-events";
import { cn } from "@/lib/utils";
import {
  invokePageAction,
  listPageActions,
  type PageActionRow,
} from "@/lib/api/page-actions";

/** The result line a run reports: its tone + localised text. */
export type PageActionFeedback = { tone: "ok" | "error"; text: string };

type Feedback = PageActionFeedback & { actionId: string };

/**
 * The fetch + confirm + invoke flow shared by both renderings. `run` resolves
 * to the feedback for the outcome, or `null` when the confirm was cancelled
 * (or another action is still busy).
 */
function usePageActions(pageId: string, workspaceId: string) {
  const dict = useT();
  const t = dict.docPage.pageActions;
  const [actions, setActions] = useState<PageActionRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setActions(await listPageActions(pageId));
    } catch {
      // Best-effort chrome — leave the strip hidden on fetch failure.
    }
  }, [pageId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: PageActionRow): Promise<PageActionFeedback | null> => {
    if (busyId) return null;
    const framing =
      action.action.kind === "goal" ? t.confirmGoal : t.confirmWorkflow;
    const confirmed = await confirmDialog({
      title: format(t.confirmTitle, { label: action.label }),
      description: action.confirmCopy ? `${framing}\n\n${action.confirmCopy}` : framing,
      confirmLabel: t.confirmRun,
      cancelLabel: t.cancel,
    });
    if (!confirmed) return null;

    setBusyId(action.id);
    const outcome = await invokePageAction(pageId, action.id);
    setBusyId(null);

    if (!outcome.ok) {
      return { tone: "error", text: outcome.error || t.failed };
    }
    if (outcome.result.kind === "goal") {
      return { tone: "ok", text: t.goalStarted };
    }
    // Workflow run — surface the terminal state; the runs chip carries the
    // detail link (nudge it to re-fetch).
    requestWorkflowRefresh(workspaceId);
    if (outcome.result.status === "failed") {
      return { tone: "error", text: outcome.result.error?.message || t.failed };
    }
    return { tone: "ok", text: t.done };
  };

  return { actions, busyId, run };
}

/** The action's leading glyph: spinner while busy, its icon, else the kind's. */
function ActionGlyph({ action, busy }: { action: PageActionRow; busy: boolean }) {
  if (busy) return <Loader2 className="size-3.5 animate-spin" aria-hidden />;
  if (action.icon) return <span aria-hidden>{action.icon}</span>;
  if (action.action.kind === "goal") return <Target className="size-3.5" aria-hidden />;
  return <Play className="size-3.5" aria-hidden />;
}

export function PageActionButtons({
  pageId,
  workspaceId,
  className,
}: {
  pageId: string;
  workspaceId: string;
  /** Layout hook for the host (the page header hides the strip below `md`). */
  className?: string;
}) {
  const { actions, busyId, run } = usePageActions(pageId, workspaceId);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  // Transient result pill; clears itself.
  useEffect(() => {
    if (!feedback) return;
    const tid = window.setTimeout(() => setFeedback(null), 6000);
    return () => window.clearTimeout(tid);
  }, [feedback]);

  const onClick = async (action: PageActionRow) => {
    setFeedback(null);
    const outcome = await run(action);
    if (outcome) setFeedback({ actionId: action.id, ...outcome });
  };

  if (actions.length === 0) return null;

  return (
    <div className={cn("flex items-center gap-1", className)}>
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          disabled={busyId !== null}
          onClick={() => void onClick(action)}
          title={action.confirmCopy ?? action.label}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-sm font-medium",
            "text-foreground transition-colors hover:bg-muted disabled:opacity-60",
          )}
        >
          <ActionGlyph action={action} busy={busyId === action.id} />
          <span className="max-w-32 truncate">{action.label}</span>
        </button>
      ))}
      {feedback && (
        <span
          className={cn(
            "ml-1 max-w-56 truncate rounded px-1.5 py-0.5 text-xs font-medium",
            feedback.tone === "ok"
              ? "bg-green-500/10 text-green-700 dark:text-green-400"
              : "bg-red-500/10 text-red-700 dark:text-red-400",
          )}
          title={feedback.text}
        >
          {feedback.text}
        </span>
      )}
    </div>
  );
}

/**
 * The same actions as `DropdownMenuItem` rows (plus a trailing separator) for
 * the page header's `...` menu below `md`. Renders nothing when no binding
 * resolves, so the menu carries no empty section.
 */
export function PageActionMenuItems({
  pageId,
  workspaceId,
  onFeedback,
}: {
  pageId: string;
  workspaceId: string;
  /** The run's outcome; the host shows it (the menu has closed by then). */
  onFeedback: (feedback: PageActionFeedback) => void;
}) {
  const { actions, busyId, run } = usePageActions(pageId, workspaceId);
  if (actions.length === 0) return null;
  return (
    <>
      {actions.map((action) => (
        <DropdownMenuItem
          key={action.id}
          data-page-action={action.id}
          disabled={busyId !== null}
          className="min-h-11 sm:min-h-0"
          onClick={() => {
            void run(action).then((outcome) => {
              if (outcome) onFeedback(outcome);
            });
          }}
        >
          <ActionGlyph action={action} busy={busyId === action.id} />
          <span className="min-w-0 flex-1 truncate">{action.label}</span>
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
    </>
  );
}
