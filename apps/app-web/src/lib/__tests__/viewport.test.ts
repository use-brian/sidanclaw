/**
 * [COMP:app-web/viewport] Viewport + pointer classification.
 *
 * The whole point of the module is that every helper is SSR-safe: a component
 * seeded from `isPhoneViewport()` must render identically on the server and
 * on the first client frame, and only then correct itself. So the contract
 * pinned here is (1) `false` whenever `window` / `matchMedia` is missing, and
 * (2) the exact queries the shell's breakpoints key on.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  COARSE_POINTER_QUERY,
  PHONE_MAX_WIDTH_PX,
  PHONE_QUERY,
  isCoarsePointer,
  isPhoneViewport,
} from "@/lib/viewport";

type MatchMedia = (query: string) => { matches: boolean };
const g = globalThis as { window?: { matchMedia?: MatchMedia } };

afterEach(() => {
  delete g.window;
});

describe("[COMP:app-web/viewport] SSR-safe viewport classification", () => {
  it("reports not-a-phone and a fine pointer without a window (server render)", () => {
    expect(isPhoneViewport()).toBe(false);
    expect(isCoarsePointer()).toBe(false);
  });

  it("reports false when the window has no matchMedia (jsdom without the shim)", () => {
    g.window = {};
    expect(isPhoneViewport()).toBe(false);
    expect(isCoarsePointer()).toBe(false);
  });

  it("keys the phone query on Tailwind's md breakpoint and the coarse query on hover: none", () => {
    // The shell swaps the sidebar for a drawer below `md` (768px); the
    // contract's "phone" must be the same line.
    expect(PHONE_MAX_WIDTH_PX).toBe(767);
    expect(PHONE_QUERY).toBe("(max-width: 767px)");
    expect(COARSE_POINTER_QUERY).toContain("hover: none");
    expect(COARSE_POINTER_QUERY).toContain("pointer: coarse");
  });

  it("answers from matchMedia when it exists", () => {
    const seen: string[] = [];
    g.window = {
      matchMedia: (query) => {
        seen.push(query);
        return { matches: query === PHONE_QUERY };
      },
    };
    expect(isPhoneViewport()).toBe(true);
    expect(isCoarsePointer()).toBe(false);
    expect(seen).toEqual([PHONE_QUERY, COARSE_POINTER_QUERY]);
  });

  it("treats a throwing matchMedia as not matching rather than crashing a render", () => {
    g.window = {
      matchMedia: () => {
        throw new Error("unsupported");
      },
    };
    expect(isPhoneViewport()).toBe(false);
  });
});
