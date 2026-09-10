"use client";

/**
 * Drag-and-drop file support for app-web surfaces. A host spreads `dropProps`
 * onto the container that owns the drop and uses `isDragging` for its overlay.
 * Every owner receives a DOM marker. A workspace-wide fallback can therefore
 * defer to a more specific descendant owner even when that control is disabled.
 *
 * The enter/leave counter (so moving over child elements doesn't flicker the
 * overlay — the same pattern apps/web's chat composer uses) lives in the pure
 * `dragReducer` below, which is unit-tested without a DOM. Only drags that
 * actually carry files arm the overlay, so dragging editor blocks around never
 * triggers it.
 *
 * [COMP:app-web/file-drop]
 */

import * as React from "react";

export type DragState = { depth: number; active: boolean };
const IDLE: DragState = { depth: 0, active: false };

/**
 * Pure drag-depth state machine. `enter`/`leave` are balanced across nested
 * children (dragenter on a child fires before dragleave on the parent), so the
 * overlay only clears once the pointer has truly left the container. `reset`
 * is used on drop and as a safety clear.
 */
export function dragReducer(state: DragState, action: "enter" | "leave" | "reset"): DragState {
  switch (action) {
    case "enter":
      return { depth: state.depth + 1, active: true };
    case "leave": {
      const depth = Math.max(0, state.depth - 1);
      return { depth, active: depth > 0 };
    }
    case "reset":
      return IDLE;
  }
}

/** True when a drag actually carries files (vs. dragging text / editor blocks). */
export function carriesFiles(types: readonly string[] | undefined): boolean {
  return Array.from(types ?? []).includes("Files");
}

const FILE_DROP_OWNER_ATTRIBUTE = "data-file-drop-owner";
const FILE_DROP_OWNER_SELECTOR = `[${FILE_DROP_OWNER_ATTRIBUTE}]`;

/** True when the event began inside a more specific marked drop surface. */
export function isFileDropOwnedByDescendant(
  target: EventTarget | null,
  currentTarget: EventTarget | null,
): boolean {
  const closest = (target as { closest?: (selector: string) => unknown } | null)?.closest;
  if (typeof closest !== "function") return false;
  const owner = closest.call(target, FILE_DROP_OWNER_SELECTOR);
  return owner != null && owner !== currentTarget;
}

export type FileDropApi = {
  isDragging: boolean;
  dropProps: {
    "data-file-drop-owner": "true";
    onDragEnter: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
};

export function useFileDrop(
  onFiles: (files: FileList) => void,
  opts?: { disabled?: boolean; fallback?: boolean },
): FileDropApi {
  const [state, dispatch] = React.useReducer(dragReducer, IDLE);
  const disabled = opts?.disabled ?? false;
  const fallback = opts?.fallback ?? false;

  // Keep the callback in a ref so dropProps stays referentially stable.
  const onFilesRef = React.useRef(onFiles);
  onFilesRef.current = onFiles;

  React.useEffect(() => {
    if (!state.active) return;
    const reset = () => dispatch("reset");
    window.addEventListener("drop", reset, true);
    window.addEventListener("dragend", reset, true);
    return () => {
      window.removeEventListener("drop", reset, true);
      window.removeEventListener("dragend", reset, true);
    };
  }, [state.active]);

  const dropProps = React.useMemo(
    () => ({
      "data-file-drop-owner": "true" as const,
      onDragEnter(e: React.DragEvent) {
        if (!carriesFiles(e.dataTransfer?.types)) return;
        if (fallback && isFileDropOwnedByDescendant(e.target, e.currentTarget)) {
          dispatch("reset");
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        if (disabled) return;
        dispatch("enter");
      },
      onDragOver(e: React.DragEvent) {
        if (!carriesFiles(e.dataTransfer?.types)) return;
        if (fallback && isFileDropOwnedByDescendant(e.target, e.currentTarget)) return;
        // preventDefault is required for onDrop to fire.
        e.preventDefault();
        e.stopPropagation();
      },
      onDragLeave(e: React.DragEvent) {
        if (!carriesFiles(e.dataTransfer?.types)) return;
        if (fallback && isFileDropOwnedByDescendant(e.target, e.currentTarget)) {
          dispatch("reset");
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        if (disabled) return;
        dispatch("leave");
      },
      onDrop(e: React.DragEvent) {
        if (!carriesFiles(e.dataTransfer?.types)) return;
        if (fallback && isFileDropOwnedByDescendant(e.target, e.currentTarget)) {
          dispatch("reset");
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        dispatch("reset");
        if (disabled) return;
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) onFilesRef.current(files);
      },
    }),
    [disabled, fallback],
  );

  return { isDragging: state.active, dropProps };
}
