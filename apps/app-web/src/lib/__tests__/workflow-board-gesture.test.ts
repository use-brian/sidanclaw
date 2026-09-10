/**
 * [COMP:app-web/workflow-board-gesture] The board's touch policy (responsive
 * contract M9). A finger that lands on a node must be able to scroll the
 * board; a node move on touch is opt-in through "Edit layout".
 */

import { describe, expect, it } from "vitest";
import {
  NODE_DRAG_THRESHOLD_PX,
  nodeBlocksPanning,
  nodeDragThreshold,
  nodePointerIntent,
} from "@/lib/workflow-board-gesture";

describe("[COMP:app-web/workflow-board-gesture] node pointer intent", () => {
  it("a mouse press on an editable board arms a drag", () => {
    expect(
      nodePointerIntent({
        canEdit: true,
        pointerType: "mouse",
        coarsePointer: false,
        layoutEditing: false,
      }),
    ).toBe("drag");
  });

  it("a touch press selects and leaves the drag to the browser (scroll)", () => {
    expect(
      nodePointerIntent({
        canEdit: true,
        pointerType: "touch",
        coarsePointer: true,
        layoutEditing: false,
      }),
    ).toBe("select");
    // A coarse device reporting a generic pointer type is still a finger.
    expect(
      nodePointerIntent({
        canEdit: true,
        pointerType: "",
        coarsePointer: true,
        layoutEditing: false,
      }),
    ).toBe("select");
  });

  it("Edit layout turns a touch press back into a drag", () => {
    expect(
      nodePointerIntent({
        canEdit: true,
        pointerType: "touch",
        coarsePointer: true,
        layoutEditing: true,
      }),
    ).toBe("drag");
  });

  it("a read-only board never drags, whatever the pointer", () => {
    for (const pointerType of ["mouse", "touch", "pen"]) {
      expect(
        nodePointerIntent({
          canEdit: false,
          pointerType,
          coarsePointer: false,
          layoutEditing: true,
        }),
      ).toBe("select");
    }
  });
});

describe("[COMP:app-web/workflow-board-gesture] panning and thresholds", () => {
  it("blocks panning only where a drag can start", () => {
    expect(nodeBlocksPanning({ canEdit: true, coarsePointer: false, layoutEditing: false })).toBe(true);
    expect(nodeBlocksPanning({ canEdit: true, coarsePointer: true, layoutEditing: false })).toBe(false);
    expect(nodeBlocksPanning({ canEdit: true, coarsePointer: true, layoutEditing: true })).toBe(true);
    expect(nodeBlocksPanning({ canEdit: false, coarsePointer: false, layoutEditing: true })).toBe(false);
  });

  it("raises the drag threshold for a finger so a wobble is still a tap", () => {
    expect(nodeDragThreshold("mouse")).toBe(NODE_DRAG_THRESHOLD_PX.fine);
    expect(nodeDragThreshold("pen")).toBe(NODE_DRAG_THRESHOLD_PX.fine);
    expect(nodeDragThreshold("touch")).toBe(NODE_DRAG_THRESHOLD_PX.coarse);
    expect(NODE_DRAG_THRESHOLD_PX.coarse).toBeGreaterThanOrEqual(10);
  });
});
