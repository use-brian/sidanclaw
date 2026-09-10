"use client";

// [COMP:app-web/view-config-group-by-menu]
/**
 * Phase 3 — Group-by menu.
 *
 * Single-column grouping for table views (Phase 4 will graduate this to
 * the Board axis as well). The trigger button shows "Group by Status"
 * when active, "No grouping" otherwise.
 *
 * Only **groupable** property kinds appear in the picker —
 * `select` / `status` / `person` / `multi-select` (tags) / `relation`
 * / `created_by` / `last_edited_by`. Free-text, numbers, and dates are
 * not groupable in v1 (Notion's behavior — dates need a bucket strategy
 * and numbers need bins, both deferred).
 *
 * Stateless wrt the larger app — `value` is the property field name (or
 * null) and `onChange(next)` fires when the user commits a change.
 */

import { useMemo, useState } from "react";
import { Layers } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/lib/i18n/client";
import type { A2UIColumn } from "@use-brian/views-renderer";
import type { PropertyKind } from "./filter-bar";

/** The "No grouping" row's value (`Select` treats `null` as no value). */
const NO_GROUP = "__none__";

/**
 * Kinds that are valid group axes. Exported so the toolbar / tests can
 * read the same source of truth.
 */
export const GROUPABLE_KINDS: ReadonlySet<PropertyKind> = new Set<PropertyKind>([
  "select",
  "status",
  "person",
  "tags",
  "relation",
  "created_by",
  "last_edited_by",
]);

export function isGroupableColumn(col: A2UIColumn): boolean {
  if (!col.kind) return false;
  return GROUPABLE_KINDS.has(col.kind);
}

export type GroupByMenuProps = {
  columns: readonly A2UIColumn[];
  value: string | null;
  onChange: (next: string | null) => void;
  className?: string;
};

export function GroupByMenu({
  columns,
  value,
  onChange,
  className,
}: GroupByMenuProps) {
  const t = useT().docPage.viewToolbar;
  const [open, setOpen] = useState(false);

  const groupable = columns.filter(isGroupableColumn);

  const currentCol = value ? columns.find((c) => c.field === value) : null;
  const buttonLabel = currentCol
    ? `${t.groupByButton}: ${currentCol.header}`
    : t.groupByButton;

  const propertyItems = useMemo(
    () =>
      ({
        [NO_GROUP]: t.groupByEmpty,
        ...Object.fromEntries(groupable.map((c) => [c.field, c.header])),
      }) as Record<string, string>,
    // `groupable` is derived from `columns` each render; key on the source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columns, t.groupByEmpty],
  );

  const handleChange = (next: unknown) => {
    const field = typeof next === "string" ? next : "";
    onChange(!field || field === NO_GROUP ? null : field);
  };

  const handleClear = () => {
    onChange(null);
    setOpen(false);
  };

  // The popover is the project `Popover` primitive (base-ui Positioner) so it
  // flips and clamps inside a 360px viewport (responsive contract M5; report
  // B row 35); the picker is the project `Select` (report B row 54).
  return (
    <div className={"relative " + (className ?? "")}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              data-action="open-group-by"
              aria-label={t.groupByButtonAria}
              aria-haspopup="dialog"
              aria-expanded={open}
              className={
                "inline-flex h-9 items-center gap-1 rounded-md border border-border px-2 text-xs md:h-7 " +
                (value
                  ? "bg-muted text-foreground"
                  : "bg-background text-muted-foreground hover:bg-muted hover:text-foreground")
              }
            >
              <Layers className="h-3.5 w-3.5" aria-hidden />
              <span>{buttonLabel}</span>
            </button>
          }
        />
        <PopoverContent
          align="start"
          role="dialog"
          aria-label={t.groupByButton}
          data-popover="group-by"
          className="w-[min(18rem,calc(100vw-1rem))] p-3 text-sm"
        >
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t.groupByPickProperty}
              </span>
              <Select
                value={value ?? NO_GROUP}
                items={propertyItems}
                onValueChange={handleChange}
              >
                <SelectTrigger
                  data-field="property"
                  aria-label={t.groupByPickProperty}
                  className="h-11 w-full md:h-8"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  <SelectItem value={NO_GROUP}>{t.groupByEmpty}</SelectItem>
                  {groupable.map((c) => (
                    <SelectItem key={c.field} value={c.field}>
                      {c.header}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {value ? (
              <button
                type="button"
                data-action="clear-group-by"
                onClick={handleClear}
                className="h-9 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground md:h-7"
              >
                {t.groupByClear}
              </button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
