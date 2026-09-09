/**
 * [COMP:app-web/sandbox-takeover] Take-Over typing proxy - the pure relay
 * decisions behind the hidden `<input>` that raises a phone's keyboard.
 *
 * The invariant these pin: every character the user types reaches the remote
 * page EXACTLY ONCE on desktop (keydown + input both fire), on Android
 * (keydown reports "Unidentified", input carries the text) and through an IME
 * (many keydowns, one committed string) - and the keys an input never turns
 * into text (Enter, Backspace, arrows) still relay from keydown, with the
 * browser default swallowed so the proxy never scrolls or loses focus.
 */

import { describe, expect, it } from "vitest";
import {
  keysForProxyComposition,
  keysForProxyInput,
  keysForProxyKeydown,
} from "../takeover-typing";

const keydown = (key: string, extra: Partial<Parameters<typeof keysForProxyKeydown>[0]> = {}) =>
  keysForProxyKeydown({ key, metaKey: false, ctrlKey: false, ...extra });

describe("[COMP:app-web/sandbox-takeover] typing proxy relay", () => {
  it("relays a printable character from the input event, never from keydown (once per character)", () => {
    // Desktop: keydown("a") then input(insertText "a") - only the second sends.
    expect(keydown("a")).toEqual({ relay: [], preventDefault: false });
    expect(keysForProxyInput({ inputType: "insertText", data: "a" })).toEqual(["a"]);
    // Space, shifted and non-Latin characters are printable too.
    expect(keydown(" ").relay).toEqual([]);
    expect(keydown("É").relay).toEqual([]);
    expect(keydown("漢").relay).toEqual([]);
  });

  it("relays Android's keydown-less typing through the input event", () => {
    // Android virtual keyboards: keydown is "Unidentified" (keyCode 229).
    expect(keydown("Unidentified")).toEqual({ relay: [], preventDefault: false });
    expect(keysForProxyInput({ inputType: "insertText", data: "hi" })).toEqual(["h", "i"]);
    // Backspace and Enter can arrive as input types instead of keys.
    expect(keysForProxyInput({ inputType: "deleteContentBackward", data: null })).toEqual(["Backspace"]);
    expect(keysForProxyInput({ inputType: "insertLineBreak", data: null })).toEqual(["Enter"]);
  });

  it("relays non-character keys from keydown and swallows their default", () => {
    for (const key of ["Enter", "Backspace", "Tab", "ArrowDown", "Escape", "Delete", "Home", "PageDown", "F5"]) {
      expect(keydown(key)).toEqual({ relay: [key], preventDefault: true });
    }
  });

  it("keeps browser shortcuts and bare modifiers local", () => {
    expect(keydown("l", { metaKey: true })).toEqual({ relay: [], preventDefault: false });
    expect(keydown("r", { ctrlKey: true })).toEqual({ relay: [], preventDefault: false });
    for (const key of ["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead", ""]) {
      expect(keydown(key).relay).toEqual([]);
    }
  });

  it("relays an IME composition once, on commit", () => {
    // During composition: keydowns are "Process" / composing, and the input
    // events are composition types - none of them relay.
    expect(keydown("Process", { isComposing: true }).relay).toEqual([]);
    expect(keydown("n", { isComposing: true }).relay).toEqual([]);
    expect(keysForProxyInput({ inputType: "insertCompositionText", data: "に", isComposing: true })).toEqual([]);
    // Safari reports the commit as its own input type after compositionend.
    expect(keysForProxyInput({ inputType: "insertFromComposition", data: "日本" })).toEqual([]);
    // The commit relays each character.
    expect(keysForProxyComposition("日本")).toEqual(["日", "本"]);
    expect(keysForProxyComposition(null)).toEqual([]);
  });

  it("relays pasted and autocorrected text, and ignores selection / history input types", () => {
    expect(keysForProxyInput({ inputType: "insertFromPaste", data: "ab" })).toEqual(["a", "b"]);
    expect(keysForProxyInput({ inputType: "insertReplacementText", data: "the" })).toEqual(["t", "h", "e"]);
    expect(keysForProxyInput({ inputType: "historyUndo", data: null })).toEqual([]);
    expect(keysForProxyInput({ inputType: "formatBold", data: null })).toEqual([]);
    expect(keysForProxyInput({ inputType: "insertText", data: null })).toEqual([]);
  });
});
