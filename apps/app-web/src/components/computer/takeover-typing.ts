/**
 * Take-Over typing proxy - the pure half of relaying keystrokes from a hidden
 * `<input>` into the remote browser (computer-use.md §5; responsive contract
 * M9, report C row 25).
 *
 * The live view used to forward keys from `onKeyDown` on a non-editable
 * `<div>`. A phone never raises its soft keyboard for a div, so nothing could
 * be typed into the remote page (a login form, a search box): taps forwarded,
 * text did not. The standard remote-desktop fix is a visually hidden text
 * input that takes focus when the user taps into the frame, so the keyboard
 * rises; these helpers decide, per proxy event, which key texts to relay.
 *
 * One rule keeps desktop, Android and IMEs on a single path: PRINTABLE
 * characters are never relayed from `keydown`. Android's virtual keyboards
 * report `key: "Unidentified"` (keyCode 229) on keydown and deliver the
 * character through the `input` event; an IME composes several keydowns into
 * one committed string; desktop keydown carries the character but the `input`
 * event that follows carries the same one. Relaying from `input` (and from
 * `compositionend` for IMEs) therefore sends each character exactly once
 * everywhere. `keydown` relays only the keys an `<input>` never turns into
 * text (Enter, Backspace, Tab, arrows, Escape, Delete, Home / End, Page keys,
 * function keys) and, on Android, those may arrive as `inputType`s instead,
 * so `keysForProxyInput` maps the deletion / line-break input types back to
 * key names. The keydown half prevents the default for those keys so the
 * proxy never scrolls the page or moves focus; printable keys keep their
 * default so the character lands in the proxy and fires `input`.
 *
 * [COMP:app-web/sandbox-takeover]
 */

import { LOCAL_ONLY_KEYS } from "@/lib/computer-takeover";

type ProxyKeydown = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey?: boolean;
  isComposing?: boolean;
};

type ProxyInput = {
  inputType: string;
  data: string | null;
  isComposing?: boolean;
};

type ProxyKeydownDecision = {
  /** Key texts to relay, in order (`[]` = nothing). */
  relay: string[];
  /** Whether the proxy should swallow the browser default for this key. */
  preventDefault: boolean;
};

const NONE: ProxyKeydownDecision = { relay: [], preventDefault: false };

/** Input types an `<input>` reports for keys that produce no character. */
const KEY_FROM_INPUT_TYPE: Readonly<Record<string, string>> = {
  deleteContentBackward: "Backspace",
  deleteContentForward: "Delete",
  deleteWordBackward: "Backspace",
  deleteWordForward: "Delete",
  insertLineBreak: "Enter",
  insertParagraph: "Enter",
};

/**
 * Composition input types are handled by `keysForProxyComposition` on
 * `compositionend`; relaying them here too would send each character twice
 * (Chrome fires `insertCompositionText` on every keystroke of a composition,
 * Safari fires `insertFromComposition` once after the commit).
 */
const COMPOSITION_INPUT_TYPES: ReadonlySet<string> = new Set([
  "insertCompositionText",
  "insertFromComposition",
  "deleteCompositionText",
]);

/** What a `keydown` on the proxy relays, and whether it keeps the default. */
export function keysForProxyKeydown(ev: ProxyKeydown): ProxyKeydownDecision {
  // Browser shortcuts (Cmd/Ctrl+L, +T, +R ...) stay local, as before.
  if (ev.metaKey || ev.ctrlKey) return NONE;
  // Mid-composition keydowns belong to the IME; the commit relays them.
  if (ev.isComposing || ev.key === "Process") return NONE;
  const key = ev.key;
  if (!key || LOCAL_ONLY_KEYS.has(key)) return NONE;
  // A printable character (one code point, e.g. "a", " ", "é", "漢") reaches
  // the page through the `input` event that follows - never from here.
  if ([...key].length === 1) return NONE;
  return { relay: [key], preventDefault: true };
}

/** Key texts an `input` event on the proxy relays (each character separately). */
export function keysForProxyInput(ev: ProxyInput): string[] {
  if (ev.isComposing) return [];
  if (COMPOSITION_INPUT_TYPES.has(ev.inputType)) return [];
  const mapped = KEY_FROM_INPUT_TYPE[ev.inputType];
  if (mapped) return [mapped];
  // insertText, insertFromPaste, insertReplacementText (autocorrect),
  // insertFromDrop: relay whatever text landed, one key per code point.
  if (ev.inputType.startsWith("insert")) return ev.data ? [...ev.data] : [];
  // Selection / history / formatting input types carry no key for the page.
  return [];
}

/** Key texts a committed IME composition relays. */
export function keysForProxyComposition(data: string | null | undefined): string[] {
  return data ? [...data] : [];
}
