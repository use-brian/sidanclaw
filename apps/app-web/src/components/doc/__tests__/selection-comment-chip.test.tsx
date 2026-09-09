// @vitest-environment jsdom
/**
 * [COMP:app-web/floating-toolbar] Coarse-pointer "Comment" chip.
 *
 * On a phone the tippy bubble sits exactly where iOS / Android draw the native
 * selection callout, and its 28px buttons do not `preventDefault` mousedown, so
 * whether a tap survives with the selection intact is browser-dependent
 * (report B row 29). The chip is the reliable path: it renders only on a
 * coarse pointer, shows after the selection gesture ends (`pointerup`), hides
 * when the selection collapses, holds the selection through the tap
 * (mousedown / pointerdown default cancelled), and is a 44px target.
 *
 * Driven in jsdom (`createRoot` + `act`, no testing-library). `useCoarsePointer`
 * is mocked to `true`; the editor is a read-only fake (selection + coords).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";

vi.mock("@/lib/viewport", async (orig) => ({
  ...(await orig<typeof import("@/lib/viewport")>()),
  useCoarsePointer: () => true,
  isPhoneViewport: () => true,
}));

import { SelectionCommentChip } from "../floating-toolbar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dict = en as unknown as Dictionary;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  host?.remove();
  host = null;
});

function fakeEditor(sel: { from: number; to: number }) {
  const selection = { ...sel, empty: sel.from === sel.to };
  return {
    state: { selection },
    isActive: () => false,
    view: {
      coordsAtPos: (pos: number) => ({
        top: 100 + pos,
        bottom: 120 + pos,
        left: 20 + pos,
        right: 21 + pos,
      }),
    },
  } as unknown as Editor & { state: { selection: typeof selection } };
}

async function mount(editor: Editor, onComment: () => void) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={dict}>
        <SelectionCommentChip editor={editor} onComment={onComment} />
      </I18nProvider>,
    );
  });
}

async function frame() {
  await act(async () => {
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
  });
}

const chip = () => document.querySelector<HTMLButtonElement>("[data-selection-comment-chip]");

describe("[COMP:app-web/floating-toolbar] SelectionCommentChip", () => {
  it("shows after pointerup over a real selection, as a 44px target below it", async () => {
    const editor = fakeEditor({ from: 2, to: 8 });
    await mount(editor, () => {});
    expect(chip()).toBeNull();

    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
    });
    await frame();

    const el = chip();
    expect(el).not.toBeNull();
    expect(el!.className).toContain("h-11");
    expect(el!.getAttribute("aria-label")).toBe(en.comments.toolbarButtonAria);
    // Below the selection (its bottom is 120 + 8 = 128), never over the OS callout.
    expect(parseFloat(el!.style.top)).toBeGreaterThanOrEqual(128);
  });

  it("keeps the selection through the tap and fires onComment on click", async () => {
    const editor = fakeEditor({ from: 2, to: 8 });
    const onComment = vi.fn();
    await mount(editor, onComment);
    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
    });
    await frame();

    const el = chip()!;
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    await act(async () => {
      el.dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(true);

    await act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onComment).toHaveBeenCalledTimes(1);
    expect(chip()).toBeNull();
  });

  it("hides the instant the selection collapses, and never shows for a collapsed one", async () => {
    const editor = fakeEditor({ from: 2, to: 8 });
    await mount(editor, () => {});
    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
    });
    await frame();
    expect(chip()).not.toBeNull();

    editor.state.selection.from = 5;
    editor.state.selection.to = 5;
    editor.state.selection.empty = true;
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(chip()).toBeNull();

    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
    });
    await frame();
    expect(chip()).toBeNull();
  });
});
