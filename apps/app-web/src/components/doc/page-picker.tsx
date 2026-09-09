"use client";

/**
 * Page picker — the "Link to page" slash action's chooser.
 *
 * A small floating popover that lists the workspace's pages (drafts + saved),
 * filtered as you type, and calls `onPick` with the chosen page. The editor
 * (`collab-page-editor`) mounts it at the caret when the user picks "Link to
 * page" from the slash menu, then inserts a `child_page` embed pointing at the
 * selected page id. Backed by the same `fetchPages` resolver the `@page`
 * mention uses.
 *
 * Keyboard: ↑/↓ move, Enter picks, Esc closes. Click-outside closes. Mirrors
 * the slash-menu popup's interaction so the two feel identical.
 *
 * [COMP:app-web/page-picker]
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { fetchPages } from "@/lib/api/mentions";
import type { PageMentionItem } from "@/components/doc/mentions/mention-popup";
import { useT } from "@/lib/i18n/client";
import { clampPopupRect, measureViewport, onViewportChange } from "@/lib/popup-clamp";
import { isPhoneViewport } from "@/lib/viewport";

export type PagePickerProps = {
  workspaceId: string;
  /** Viewport coords (caret) to anchor the popover at. */
  position: { top: number; left: number };
  onPick: (page: PageMentionItem) => void;
  onClose: () => void;
};

export function PagePicker({ workspaceId, position, onPick, onClose }: PagePickerProps) {
  const t = useT().docPage.pagePicker;
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<PageMentionItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Where the popover actually lands: the caret position, clamped inside the
  // visible viewport and flipped above the caret when the keyboard leaves no
  // room below (responsive contract M5). Seeded with the raw caret so the
  // first paint is where the caret is; the layout effect corrects it before
  // the frame shows, and again whenever the visual viewport changes.
  const [placed, setPlaced] = useState(position);

  // Focus the search box on open. Not on a phone: the caret's keyboard is
  // already up and a second focus hop only scrolls the page (M4).
  useEffect(() => {
    if (!isPhoneViewport()) inputRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    const place = () => {
      const el = rootRef.current;
      if (!el) return;
      const next = clampPopupRect(
        { top: position.top, bottom: position.top, left: position.left },
        { width: el.offsetWidth || 288, height: el.offsetHeight || 300 },
        measureViewport(),
      );
      setPlaced((cur) =>
        cur.top === next.top && cur.left === next.left ? cur : { top: next.top, left: next.left },
      );
    };
    place();
    return onViewportChange(place);
  }, [position.top, position.left, items.length]);

  // Resolve pages on open + as the query changes. `fetchPages` caches the
  // roster per workspace, so each keystroke is a local filter.
  useEffect(() => {
    let cancelled = false;
    void fetchPages(workspaceId, query).then((rows) => {
      if (!cancelled) {
        setItems(rows);
        setSelectedIndex(0);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, query]);

  // Click-outside closes.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const pick = useCallback(
    (index: number) => {
      const item = items[index];
      if (item) onPick(item);
    },
    [items, onPick],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => (items.length === 0 ? 0 : (i + 1) % items.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => (items.length === 0 ? 0 : (i - 1 + items.length) % items.length));
      } else if (e.key === "Enter") {
        e.preventDefault();
        pick(selectedIndex);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [items.length, selectedIndex, pick, onClose],
  );

  return (
    <div
      ref={rootRef}
      data-page-picker="root"
      className="fixed z-50 w-[min(18rem,calc(100vw-1rem))] overflow-hidden rounded-md border border-border bg-popover text-sm shadow-lg"
      style={{ top: placed.top, left: placed.left }}
    >
      <div className="border-b border-border p-2">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t.searchPlaceholder}
          className="w-full bg-transparent px-1 py-0.5 text-[16px] text-foreground outline-none placeholder:text-muted-foreground/60 md:text-sm"
        />
      </div>
      <div className="max-h-72 overflow-y-auto py-1">
        {items.length === 0 ? (
          <div className="px-3 py-3 text-sm text-muted-foreground">{t.empty}</div>
        ) : (
          <ul role="listbox" aria-label={t.ariaLabel}>
            {items.map((item, index) => {
              const isActive = index === selectedIndex;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    data-page-id={item.id}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(index)}
                    className={
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-foreground transition-colors " +
                      (isActive ? "bg-accent text-accent-foreground" : "hover:bg-muted")
                    }
                  >
                    <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">
                      {item.title || t.untitled}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
