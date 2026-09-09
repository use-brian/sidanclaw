/**
 * Workflow board gesture policy (responsive contract M9: a drag-only gesture
 * gets a tap path).
 *
 * The board's nodes are 210x84 with 80px gaps, so a 390px phone shows one
 * node and part of the next, and the only way to see the rest is to pan. On a
 * touch screen a finger that lands on a node has to choose: is this a scroll
 * or a node move? The board used to answer "move" for every editable node
 * (`touch-action: none` + pointer capture + a 3px threshold), so a scroll
 * that started on a node relocated the node, dirtied the draft, and the
 * editor did not even open. Read-only boards were fine, which is the tell:
 * the trouble is not the board, it is the gesture policy.
 *
 * The policy, pure so it is unit-tested without a pointer:
 *
 *  - A fine pointer (mouse) keeps the direct-manipulation board: press-drag
 *    moves the node, a 3px wobble is still a click.
 *  - A coarse pointer (touch, or a `(hover: none)` device) defaults to
 *    "tap selects, drag scrolls": the node does not capture the pointer or
 *    block panning, and the browser's own scroll takes the drag. Node moves
 *    need the explicit "Edit layout" toggle, which flips `touch-action` to
 *    `none` and raises the drag threshold to 10px so a wobble on a finger
 *    is still a tap.
 *
 * Spec: docs/architecture/features/workflow.md -> "Web builder UI";
 * docs/architecture/features/doc.md -> "Responsive contract" (M9).
 * [COMP:app-web/workflow-board-gesture]
 */

/** What a pointerdown on a node means. */
export type NodePointerIntent = "drag" | "select";

/**
 * Movement past which a press becomes a drag. A finger cannot hold still the
 * way a mouse can: 3px on touch turns most taps into accidental moves.
 */
export const NODE_DRAG_THRESHOLD_PX = { fine: 3, coarse: 10 } as const;

/** True for a pointer that cannot hover (touch); pens count as fine. */
function isTouchPointer(pointerType: string): boolean {
  return pointerType === "touch";
}

/** The drag threshold for a pointer type. */
export function nodeDragThreshold(pointerType: string): number {
  return isTouchPointer(pointerType)
    ? NODE_DRAG_THRESHOLD_PX.coarse
    : NODE_DRAG_THRESHOLD_PX.fine;
}

export type NodeGestureInput = {
  /** The board accepts canvas edits at all (managed workflows do not). */
  canEdit: boolean;
  /** `PointerEvent.pointerType` of the press: `"mouse"`, `"pen"`, `"touch"`. */
  pointerType: string;
  /** The device's primary pointer cannot hover (`useCoarsePointer()`). */
  coarsePointer: boolean;
  /** The user switched the board into "Edit layout" (node moves allowed). */
  layoutEditing: boolean;
};

/**
 * Decide what a pointerdown on a node starts. `"drag"` captures the pointer
 * and arms a node move (a sub-threshold release is still a select);
 * `"select"` does nothing on press and lets the tap's click select, so the
 * browser owns any drag as a scroll.
 */
export function nodePointerIntent(input: NodeGestureInput): NodePointerIntent {
  if (!input.canEdit) return "select";
  const touchLike = isTouchPointer(input.pointerType) || input.coarsePointer;
  if (touchLike && !input.layoutEditing) return "select";
  return "drag";
}

/**
 * Whether a node should opt out of browser panning (`touch-action: none`).
 * Only while a drag can actually start: an editable board on a fine pointer,
 * or a coarse pointer with "Edit layout" on. Otherwise the finger scrolls.
 */
export function nodeBlocksPanning(
  input: Omit<NodeGestureInput, "pointerType">,
): boolean {
  if (!input.canEdit) return false;
  return !input.coarsePointer || input.layoutEditing;
}
