"use client";

// [COMP:app-web/view-config-toolbar]
/**
 * Phase 3 — View toolbar container.
 *
 * Hosts the four view-config affordances (search, filter, sort, group,
 * properties) and renders them in a single row above the table. Each
 * affordance is stateless — `value` + `onChange` props — and this
 * container is itself stateless: it relays the surrounding view-state
 * down through the affordances unchanged.
 *
 * Used by `block-data.tsx` in Phase 4 — that wiring lands in a follow-up
 * batch (do not modify block-data.tsx here).
 */

import { useState } from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { A2UIColumn } from "@use-brian/views-renderer";

import { FilterBar, type Filter } from "./filter-bar";
import { SortMenu, type Sort } from "./sort-menu";
import { GroupByMenu } from "./group-by-menu";
import { PropertyToggleMenu } from "./property-toggle-menu";

export type ViewToolbarValue = {
  search: string;
  filters: readonly Filter[];
  sort: Sort | null;
  groupBy: string | null;
  visibleProperties: readonly string[];
  order: readonly string[];
  /**
   * Notion-database persisted view-state carried alongside the toolbar's own
   * controls (the column header menu writes these; the toolbar passes them
   * through untouched). `columnWidths` is keyed by column `field`; `frozenCount`
   * is the number of sticky-left columns. Both round-trip to `binding.display`.
   */
  columnWidths: Readonly<Record<string, number>>;
  frozenCount: number;
};

export type ViewToolbarProps = {
  columns: readonly A2UIColumn[];
  value: ViewToolbarValue;
  onChange: (next: ViewToolbarValue) => void;
  className?: string;
};

export function ViewToolbar({
  columns,
  value,
  onChange,
  className,
}: ViewToolbarProps) {
  const t = useT().docPage.viewToolbar;
  // Phone (responsive contract M2 / M8; report B row 34): the host cannot
  // hover-reveal the toolbar, and the five controls run ~450px wide at 390px,
  // so below `md` they collapse behind one "View options" button and wrap
  // when expanded. From `md` the button is hidden and the row is the single
  // non-wrapping strip it always was.
  const [expanded, setExpanded] = useState(false);
  const activeCount =
    value.filters.length + (value.sort ? 1 : 0) + (value.groupBy ? 1 : 0);

  const patch = (delta: Partial<ViewToolbarValue>) => {
    onChange({ ...value, ...delta });
  };

  return (
    <div
      data-component="view-toolbar"
      className={
        // Single non-wrapping row from `md` — the host (`embed-view`) reveals
        // this inline beside the table title via opacity, so it must keep a
        // constant height there (no wrap → no reflow). No bottom border: the
        // table's own column-header rule provides the separation.
        "flex flex-wrap items-center gap-2 md:flex-nowrap " + (className ?? "")
      }
    >
      <button
        type="button"
        data-action="view-options"
        aria-expanded={expanded}
        aria-label={t.viewOptionsAria}
        onClick={() => setExpanded((v) => !v)}
        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground md:hidden"
      >
        <SlidersHorizontal className="size-3.5" aria-hidden />
        <span>{t.viewOptions}</span>
        {activeCount > 0 ? (
          <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[0.625rem] font-semibold leading-4 text-muted-foreground">
            {activeCount}
          </span>
        ) : null}
      </button>
      <div
        data-view-toolbar-controls
        className={cn(
          "w-full flex-wrap items-center gap-2 md:flex md:w-auto md:min-w-0 md:flex-1 md:flex-nowrap",
          expanded ? "flex" : "hidden",
        )}
      >
        {/* Search */}
        <div className="relative w-full sm:w-44">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            type="search"
            data-field="search"
            aria-label={t.searchAria}
            placeholder={t.searchPlaceholder}
            value={value.search}
            onChange={(e) => patch({ search: e.target.value })}
            className="h-9 w-full rounded-md border border-border bg-background pl-7 pr-2 text-[16px] outline-none focus-visible:shadow-none md:h-7 md:text-xs"
          />
        </div>

        <FilterBar
          columns={columns}
          value={value.filters}
          onChange={(filters) => patch({ filters })}
        />

        <SortMenu
          columns={columns}
          value={value.sort}
          onChange={(sort) => patch({ sort })}
        />

        <GroupByMenu
          columns={columns}
          value={value.groupBy}
          onChange={(groupBy) => patch({ groupBy })}
        />

        <div className="ml-auto">
          <PropertyToggleMenu
            columns={columns}
            visibleProperties={value.visibleProperties}
            order={value.order}
            onChange={(visibleProperties, order) =>
              patch({ visibleProperties, order })
            }
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Default toolbar value derived from a column list — every column
 * visible, in declared order, no filters / sort / group. Callers can
 * `{ ...defaultViewToolbarValue(columns), sort: ... }` to seed state.
 */
export function defaultViewToolbarValue(
  columns: readonly A2UIColumn[],
): ViewToolbarValue {
  const fields = columns.map((c) => c.field);
  return {
    search: "",
    filters: [],
    sort: null,
    groupBy: null,
    visibleProperties: fields,
    order: fields,
    columnWidths: {},
    frozenCount: 1,
  };
}
