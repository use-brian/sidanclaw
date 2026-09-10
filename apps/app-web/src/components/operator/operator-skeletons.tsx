/**
 * Cold-body skeletons for the operator surfaces (Tasks, CRM) - the part of
 * the surface UNDER its chrome. The route-level `ListSurfaceSkeleton`
 * (`components/chrome/surface-skeleton.tsx`) draws chrome + strip + rows for
 * a cold route entry; these draw only the rows or the board, for the moments
 * the chrome is already on screen and just the body is cold: a section
 * switch, a filter whose collection has not landed, a reload before the disk
 * tier answers. Painting these inside the existing header is what turns
 * "Loading..." into a fill (instant-navigation contract N4 / N5).
 *
 * Decorative only: `aria-hidden`, no strings, built on the one `<Skeleton>`
 * primitive so there is no second shimmer system.
 *
 * [COMP:app-web/operator-filter-bar] (shared operator chrome)
 */

import { Skeleton } from "@/components/skeleton";

/**
 * Dense list rows: a checkbox box, a title bar, and trailing cells from `md`
 * (below `md` the operator tables stack into cards, which have no trailing
 * columns). Matches `ListSurfaceSkeleton`'s row rhythm.
 */
export function OperatorRowsSkeleton({ rows = 9 }: { rows?: number }) {
  return (
    <div className="animate-fade-in" aria-hidden data-operator-skeleton="rows">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 border-b border-border/40 px-4 py-2.5"
        >
          <Skeleton className="size-5 shrink-0 rounded-[5px] md:size-4" />
          <Skeleton className="h-3.5" style={{ width: `${34 + ((i * 13) % 38)}%` }} />
          <Skeleton className="ml-auto hidden h-3.5 w-20 md:block" />
          <Skeleton className="hidden h-3.5 w-14 md:block" />
          <Skeleton className="hidden h-3.5 w-16 md:block" />
        </div>
      ))}
    </div>
  );
}

/**
 * Kanban board: `w-72` columns of cards under a dot + label header, the
 * geometry both `TaskBoard` and `CrmBoard` share.
 */
export function OperatorBoardSkeleton({ columns = 3 }: { columns?: number }) {
  return (
    <div
      className="flex h-full min-w-max gap-3 p-4 animate-fade-in"
      aria-hidden
      data-operator-skeleton="board"
    >
      {Array.from({ length: columns }).map((_, c) => (
        <div key={c} className="flex w-72 shrink-0 flex-col rounded-2xl bg-muted/30">
          <div className="flex items-center gap-1.5 px-3.5 pb-1 pt-2.5">
            <Skeleton className="size-2 rounded-full" />
            <Skeleton className="h-3 w-20" />
          </div>
          <div className="flex flex-col gap-2 p-2 pt-1">
            {Array.from({ length: 3 - (c % 2) }).map((_, i) => (
              <div key={i} className="space-y-2 rounded-xl border border-border/60 bg-card p-3">
                <Skeleton
                  className="h-3.5"
                  style={{ width: `${55 + ((i * 17 + c * 9) % 35)}%` }}
                />
                <div className="flex items-center gap-2">
                  <Skeleton className="h-3 w-12" />
                  <Skeleton className="h-3 w-10" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
