/**
 * [COMP:app-web/file-drop] Drag-and-drop file logic.
 *
 * app-web vitest has no jsdom, so we test the pure pieces the hook is built
 * from: the enter/leave depth machine (which keeps the overlay from flickering
 * as the pointer crosses child elements) and the files-only guard.
 */

import { describe, expect, it } from "vitest";
import {
  dragReducer,
  carriesFiles,
  isFileDropOwnedByDescendant,
  type DragState,
} from "../use-file-drop";

const IDLE: DragState = { depth: 0, active: false };

describe("[COMP:app-web/file-drop] dragReducer", () => {
  it("activates on the first enter", () => {
    expect(dragReducer(IDLE, "enter")).toEqual({ depth: 1, active: true });
  });

  it("stays active while nested children fire enter before the parent's leave", () => {
    // enter (container) → enter (child): depth 2, still active.
    let s = dragReducer(IDLE, "enter");
    s = dragReducer(s, "enter");
    expect(s).toEqual({ depth: 2, active: true });
    // leave (child): depth 1, STILL active (pointer hasn't left the container).
    s = dragReducer(s, "leave");
    expect(s).toEqual({ depth: 1, active: true });
    // leave (container): depth 0, now inactive.
    s = dragReducer(s, "leave");
    expect(s).toEqual({ depth: 0, active: false });
  });

  it("never goes negative on an unbalanced leave", () => {
    expect(dragReducer(IDLE, "leave")).toEqual({ depth: 0, active: false });
  });

  it("reset clears to idle (drop / safety)", () => {
    const active = dragReducer(dragReducer(IDLE, "enter"), "enter");
    expect(dragReducer(active, "reset")).toEqual(IDLE);
  });
});

describe("[COMP:app-web/file-drop] carriesFiles", () => {
  it("is true only when the drag carries files", () => {
    expect(carriesFiles(["Files"])).toBe(true);
    expect(carriesFiles(["text/plain", "Files"])).toBe(true);
    expect(carriesFiles(["text/plain"])).toBe(false);
    expect(carriesFiles([])).toBe(false);
    expect(carriesFiles(undefined)).toBe(false);
  });
});

describe("[COMP:app-web/workspace-file-drop] descendant ownership", () => {
  it("lets a marked descendant override the workspace fallback", () => {
    const workspace = {} as EventTarget;
    const localOwner = {};
    const target = {
      closest: (selector: string) =>
        selector === "[data-file-drop-owner]" ? localOwner : null,
    } as unknown as EventTarget;

    expect(isFileDropOwnedByDescendant(target, workspace)).toBe(true);
  });

  it("does not treat the fallback element itself as a descendant owner", () => {
    const workspace = {
      closest: () => workspace,
    } as unknown as EventTarget;

    expect(isFileDropOwnedByDescendant(workspace, workspace)).toBe(false);
    expect(isFileDropOwnedByDescendant(null, workspace)).toBe(false);
  });
});
