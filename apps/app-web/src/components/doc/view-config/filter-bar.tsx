"use client";

// [COMP:app-web/view-config-filter-bar]
/**
 * Phase 3 — Filter bar.
 *
 * Above-table single-condition filter UI. Shows one chip per active
 * filter; the trailing "+ Filter" button opens a popover that walks the
 * user through: property picker → operator picker → value editor.
 *
 * Operators are property-kind aware so the model can't be asked to
 * apply a numeric `>` against a text column. The catalog is exported as
 * `OPERATORS_BY_KIND` so tests + sibling toolbar components can read
 * the same source of truth.
 *
 * This component is stateless wrt the larger app — `value` is the
 * authoritative filter list (controlled), and `onChange(next)` fires
 * whenever the user adds, edits, or removes a chip.
 *
 * The popover is the project `Popover` primitive (base-ui Positioner) so it
 * flips and clamps inside a 360px viewport instead of running off the right
 * edge from an `absolute left-0` panel (responsive contract M5; report B row
 * 35), and its pickers are the project `Select` (never a native `<select>`,
 * root CLAUDE.md anti-pattern; report B row 54). The popup is a portal, so
 * the closed-state SSR markup still carries no popover root.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { Filter as FilterIcon, X as XIcon } from "lucide-react";
import { Popover, PopoverContent } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/lib/i18n/client";
import type { A2UIColumn } from "@use-brian/views-renderer";

/**
 * Local mirror of `PropertyKind` — the renderer's `types.ts` defines
 * this union but doesn't re-export it from the package barrel. Mirrored
 * here (and in `group-by-menu.tsx`) so the operator catalog can be
 * keyed by kind without crossing the package boundary.
 */
export type PropertyKind =
  | "text"
  | "select"
  | "tags"
  | "person"
  | "relation"
  | "date"
  | "number"
  | "status"
  | "files"
  | "checkbox"
  | "url"
  | "email"
  | "phone"
  | "created_time"
  | "created_by"
  | "last_edited_time"
  | "last_edited_by";

// ── Operator catalog ──────────────────────────────────────────────────

/**
 * One filter condition produced by this component. The op id matches a
 * key under `viewToolbar.operators` in the dictionary (e.g. `contains`,
 * `eq`). Value is shaped per-operator:
 *   * text-shaped ops → `string`
 *   * number ops → `number`
 *   * select / status `is` / `is_not` → `string`
 *   * `is_any_of` → `string[]`
 *   * date `is` / `before` / `after` → ISO date string
 *   * date `between` → `[isoFrom, isoTo]`
 *   * checkbox → `boolean`
 *   * person `is` / `is_not` → person id `string`
 */
export type Filter = {
  propertyName: string;
  op: string;
  value: unknown;
};

/**
 * Operator catalog — keyed by property kind. The undefined / `text`
 * fallback applies to text-shaped columns (`text`, `url`, `email`,
 * `phone`, and any column without a `kind`). All ops referenced here
 * must have a label in `viewToolbar.operators`; the dictionary type
 * enforces it at compile time.
 */
export const OPERATORS_BY_KIND: Record<string, readonly string[]> = {
  text: ["contains", "equals", "starts_with"],
  url: ["contains", "equals", "starts_with"],
  email: ["contains", "equals", "starts_with"],
  phone: ["contains", "equals", "starts_with"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte"],
  select: ["is", "is_not", "is_any_of"],
  status: ["is", "is_not", "is_any_of"],
  tags: ["is", "is_not", "is_any_of"],
  date: ["is", "before", "after", "between"],
  created_time: ["is", "before", "after", "between"],
  last_edited_time: ["is", "before", "after", "between"],
  checkbox: ["is_checked", "is_unchecked"],
  person: ["is", "is_not"],
  relation: ["is", "is_not"],
  created_by: ["is", "is_not"],
  last_edited_by: ["is", "is_not"],
  files: ["is_checked", "is_unchecked"],
};

export function operatorsForKind(kind: PropertyKind | undefined): readonly string[] {
  return OPERATORS_BY_KIND[kind ?? "text"] ?? OPERATORS_BY_KIND.text;
}

/**
 * Some operators have no value editor — checkbox `is_checked` /
 * `is_unchecked` carry their truth in the op id itself. The popover
 * skips the value step when the op falls in this set.
 */
export const VALUE_LESS_OPS = new Set(["is_checked", "is_unchecked"]);

// ── Props ─────────────────────────────────────────────────────────────

export type FilterBarProps = {
  /** Columns the user can filter over. */
  columns: readonly A2UIColumn[];
  /** Controlled filter list — render order is chip order. */
  value: readonly Filter[];
  onChange: (next: Filter[]) => void;
  className?: string;
};

// ── Component ─────────────────────────────────────────────────────────

export function FilterBar({ columns, value, onChange, className }: FilterBarProps) {
  const t = useT().docPage.viewToolbar;
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  // `openIndex` semantics:
  //   * null — popover closed
  //   * value.length — editing the trailing "+ Filter" (a fresh row)
  //   * 0..value.length-1 — editing the chip at that index
  // The popover anchors to whichever control opened it (the "+ Filter"
  // button or the chip being edited), so the Positioner can flip / shift
  // it against that element.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const openAt = (index: number, el: HTMLElement) => {
    setAnchor(el);
    setOpenIndex(index);
  };

  const handleRemove = (index: number) => {
    const next = value.slice();
    next.splice(index, 1);
    onChange(next);
    setOpenIndex(null);
  };

  const handleCommit = (index: number, filter: Filter) => {
    const next = value.slice();
    if (index === value.length) {
      next.push(filter);
    } else {
      next[index] = filter;
    }
    onChange(next);
    setOpenIndex(null);
  };

  const handleCancel = () => {
    setOpenIndex(null);
  };

  return (
    <div
      data-component="filter-bar"
      className={
        "relative flex flex-wrap items-center gap-1.5 " + (className ?? "")
      }
    >
      {value.length === 0 ? (
        <button
          type="button"
          data-action="add-filter"
          aria-label={t.filterButtonAria}
          aria-haspopup="dialog"
          aria-expanded={openIndex === 0}
          onClick={(e) => openAt(value.length, e.currentTarget)}
          className="inline-flex h-9 items-center gap-1 rounded-md border border-dashed border-border bg-background px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground md:h-7"
        >
          <FilterIcon className="h-3.5 w-3.5" aria-hidden />
          <span>{t.filterButton}</span>
        </button>
      ) : (
        <>
          {value.map((filter, i) => (
            <FilterChip
              key={`${filter.propertyName}-${i}`}
              filter={filter}
              columns={columns}
              onEdit={(el) => openAt(i, el)}
              onRemove={() => handleRemove(i)}
              removeLabel={t.filterRemoveAria}
              operatorLabel={(op) => operatorLabelFor(op, t.operators)}
            />
          ))}
          <button
            type="button"
            data-action="add-filter"
            aria-label={t.filterButtonAria}
            aria-haspopup="dialog"
            aria-expanded={openIndex === value.length}
            onClick={(e) => openAt(value.length, e.currentTarget)}
            className="inline-flex h-9 items-center gap-1 rounded-md border border-dashed border-border bg-background px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground md:h-7"
          >
            <span>{t.filterAddAnother}</span>
          </button>
        </>
      )}

      <Popover
        open={openIndex !== null}
        onOpenChange={(open) => {
          if (!open) setOpenIndex(null);
        }}
      >
        <PopoverContent
          anchor={anchor}
          align="start"
          role="dialog"
          aria-label={t.filterButton}
          data-popover="filter"
          className="w-[min(20rem,calc(100vw-1rem))] p-3"
        >
          {openIndex !== null ? (
            <FilterPopover
              columns={columns}
              initial={openIndex < value.length ? value[openIndex] : null}
              onCommit={(filter) => handleCommit(openIndex, filter)}
              onCancel={handleCancel}
            />
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ── Chip ──────────────────────────────────────────────────────────────

function FilterChip({
  filter,
  columns,
  onEdit,
  onRemove,
  removeLabel,
  operatorLabel,
}: {
  filter: Filter;
  columns: readonly A2UIColumn[];
  /** Receives the chip's edit control so the popover can anchor to it. */
  onEdit: (el: HTMLElement) => void;
  onRemove: () => void;
  removeLabel: string;
  operatorLabel: (op: string) => string;
}) {
  const col = columns.find((c) => c.field === filter.propertyName);
  const propLabel = col?.header ?? filter.propertyName;
  const valueText = renderFilterValue(filter);
  return (
    <span
      data-chip="filter"
      data-property={filter.propertyName}
      className="inline-flex h-9 items-center gap-1 rounded-md border border-border bg-muted/40 px-2 text-xs text-foreground md:h-7"
    >
      <button
        type="button"
        data-action="edit-chip"
        onClick={(e) => onEdit(e.currentTarget)}
        className="inline-flex items-center gap-1 outline-none hover:text-foreground"
      >
        <span className="font-medium">{propLabel}</span>
        <span className="text-muted-foreground">{operatorLabel(filter.op)}</span>
        {valueText ? <span className="font-mono">{valueText}</span> : null}
      </button>
      <button
        type="button"
        data-action="remove-chip"
        aria-label={removeLabel}
        onClick={onRemove}
        className="-mr-1 flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-border hover:text-foreground md:size-4"
      >
        <XIcon className="h-3 w-3" aria-hidden />
      </button>
    </span>
  );
}

/**
 * Render a filter value as a chip-friendly string. Arrays join with
 * `,`; primitives stringify. Null/undefined collapses to empty.
 */
export function renderFilterValue(filter: Filter): string {
  if (VALUE_LESS_OPS.has(filter.op)) return "";
  const v = filter.value;
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  return JSON.stringify(v);
}

function operatorLabelFor(
  op: string,
  catalog: Record<string, string>,
): string {
  return catalog[op] ?? op;
}

// ── Popover ───────────────────────────────────────────────────────────

function FilterPopover({
  columns,
  initial,
  onCommit,
  onCancel,
}: {
  columns: readonly A2UIColumn[];
  initial: Filter | null;
  onCommit: (filter: Filter) => void;
  onCancel: () => void;
}) {
  const t = useT().docPage.viewToolbar;
  const [propertyName, setPropertyName] = useState<string>(
    initial?.propertyName ?? columns[0]?.field ?? "",
  );
  const col = useMemo(
    () => columns.find((c) => c.field === propertyName),
    [columns, propertyName],
  );
  const ops = useMemo(() => operatorsForKind(col?.kind), [col]);
  const [op, setOp] = useState<string>(initial?.op ?? ops[0] ?? "contains");
  const [valueInput, setValueInput] = useState<string>(
    initial && !VALUE_LESS_OPS.has(initial.op)
      ? Array.isArray(initial.value)
        ? (initial.value as unknown[]).map(String).join(", ")
        : String(initial.value ?? "")
      : "",
  );
  // Outside-press and Escape are the Popover primitive's (`onOpenChange`),
  // so this panel only owns the field state and Enter-to-apply.

  // When the property changes, reset op to first valid for the new kind.
  useEffect(() => {
    if (!ops.includes(op)) {
      setOp(ops[0] ?? "contains");
    }
  }, [ops, op]);

  // Label maps for the two pickers (`Select` renders the chosen value's label
  // through `items`).
  const propertyItems = useMemo(
    () => Object.fromEntries(columns.map((c) => [c.field, c.header])) as Record<string, string>,
    [columns],
  );
  const opItems = useMemo(
    () => Object.fromEntries(ops.map((o) => [o, operatorLabelFor(o, t.operators)])) as Record<string, string>,
    [ops, t.operators],
  );

  const handleValueChange = (e: ChangeEvent<HTMLInputElement>) => {
    setValueInput(e.target.value);
  };

  const handleApply = useCallback(() => {
    let value: unknown = valueInput;
    if (VALUE_LESS_OPS.has(op)) {
      value = null;
    } else if (op === "is_any_of") {
      value = valueInput
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (col?.kind === "number") {
      const n = Number(valueInput);
      value = Number.isFinite(n) ? n : 0;
    } else if (col?.kind === "checkbox") {
      value = valueInput.toLowerCase() === "true";
    }
    onCommit({ propertyName, op, value });
  }, [valueInput, op, col, propertyName, onCommit]);

  const handleKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
      e.preventDefault();
      handleApply();
    }
  };

  return (
    <div onKeyDown={handleKey} className="text-sm">
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            {t.filterPickProperty}
          </span>
          <Select
            value={propertyName}
            items={propertyItems}
            onValueChange={(v) => {
              if (v) setPropertyName(String(v));
            }}
          >
            <SelectTrigger
              data-field="property"
              aria-label={t.filterPickProperty}
              className="h-11 w-full md:h-8"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              {columns.map((c) => (
                <SelectItem key={c.field} value={c.field}>
                  {c.header}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            {t.filterPickOperator}
          </span>
          <Select
            value={op}
            items={opItems}
            onValueChange={(v) => {
              if (v) setOp(String(v));
            }}
          >
            <SelectTrigger
              data-field="operator"
              aria-label={t.filterPickOperator}
              className="h-11 w-full md:h-8"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              {ops.map((o) => (
                <SelectItem key={o} value={o}>
                  {operatorLabelFor(o, t.operators)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {!VALUE_LESS_OPS.has(op) ? (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t.filterValuePlaceholder}
            </span>
            {/* 16px on a phone (iOS zooms a smaller field on focus, M4); the
                date type keeps the platform's own picker. */}
            <input
              data-field="value"
              type={col?.kind === "number" ? "number" : col?.kind === "date" ? "date" : "text"}
              value={valueInput}
              onChange={handleValueChange}
              placeholder={t.filterValuePlaceholder}
              className="h-11 rounded-md border border-border bg-background px-2 text-[16px] md:h-8 md:text-sm"
            />
          </label>
        ) : null}
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            data-action="cancel"
            onClick={onCancel}
            className="h-9 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted md:h-7"
          >
            {t.close}
          </button>
          <button
            type="button"
            data-action="apply"
            onClick={handleApply}
            className="h-9 rounded-md bg-action px-2 text-xs text-action-foreground hover:bg-action/90 md:h-7"
          >
            {t.apply}
          </button>
        </div>
      </div>
    </div>
  );
}
