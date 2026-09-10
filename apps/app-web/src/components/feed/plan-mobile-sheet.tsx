"use client";

/**
 * Phone host for the Feed Plan rail's editors (responsive contract M1 / M5).
 *
 * The Plan surface's slot editor, month-brief editor, proposals and quick
 * actions live in an `aside` that is `hidden lg:block` and mount-gated on
 * `isLg`. Below 1024px (every phone and iPad portrait) tapping a calendar
 * chip, a cadence-gap ghost or "Plan it" therefore set `rail` state and
 * rendered NOTHING: a slot could not be created, edited, skipped or deleted,
 * and the month brief was unreachable. This sheet is the rail's phone host:
 * a bottom sheet in the `MobileChatDrawer` shape (backdrop, grab handle, ESC,
 * body-scroll lock, `h-[88dvh]`), driven by the SAME `rail` state the desktop
 * aside reads, so the two never disagree about what is open. The chat rail
 * itself is not hosted here: below `lg` the floating Feed dock is the live
 * chat host (P4), and a second mounted panel would double-subscribe.
 *
 * `lg:hidden` from the shell keeps the breakpoint logic in one place; the
 * component renders nothing while `open` is false (no stray backdrop during
 * SSR, and no hydration mismatch - `rail` starts on the chat state).
 *
 * `keepMounted` is the post editor's variant: its refine chat streams a
 * turn while the sheet is closed, so the children stay mounted off-screen
 * (`translate-y-full`, `inert`, no backdrop) instead of unmounting - the
 * `MobileChatDrawer` shape, which keeps its `FloatingChat` alive the same
 * way. The Plan board keeps the default: its editors hold no stream.
 *
 * [COMP:app-web/feed-plan-mobile-sheet]
 */

import { useEffect, useId } from "react";
import { X } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

export function PlanMobileSheet({
  open,
  title,
  onClose,
  className,
  keepMounted = false,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  /** Breakpoint gate, `lg:hidden` by default (the desktop aside owns `lg+`). */
  className?: string;
  /** Keep the children mounted (hidden, inert) while closed. */
  keepMounted?: boolean;
  children: React.ReactNode;
}) {
  const tp = useT().feedPage.plan;
  const panelId = useId();

  // ESC dismisses; bound at the window so the sheet needs no focus.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Body-scroll lock while open - the plan board sits behind the backdrop.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open && !keepMounted) return null;

  return (
    <div
      className={cn("contents lg:hidden", className)}
      data-plan-mobile-sheet
      data-open={open ? "true" : "false"}
    >
      {open ? (
        <button
          type="button"
          aria-label={tp.mobileSheetClose}
          onClick={onClose}
          className="fixed inset-0 z-40 bg-foreground/40 backdrop-blur-[2px]"
        />
      ) : null}
      <div
        id={panelId}
        role="dialog"
        aria-modal={open ? "true" : undefined}
        aria-label={title}
        aria-hidden={!open}
        inert={!open}
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 flex h-[88dvh] max-h-[88dvh] flex-col",
          "rounded-t-2xl border-t border-border bg-background shadow-2xl",
          "pb-[env(safe-area-inset-bottom)]",
          keepMounted && "transition-transform duration-300 ease-out will-change-transform",
          !open && "pointer-events-none translate-y-full",
        )}
      >
        <div className="shrink-0 select-none">
          <div className="flex justify-center pb-1 pt-2.5">
            <span aria-hidden className="h-1.5 w-10 rounded-full bg-muted-foreground/25" />
          </div>
          <header className="flex items-center justify-between gap-2 px-4 pb-2 pt-1">
            <span className="min-w-0 truncate text-sm font-semibold text-foreground">
              {title}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label={tp.mobileSheetClose}
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" aria-hidden />
            </button>
          </header>
        </div>
        <div className="relative min-h-0 flex-1 border-t border-border">{children}</div>
      </div>
    </div>
  );
}
