// @vitest-environment jsdom
/**
 * [COMP:app-web/feed-plan-mobile-sheet] The Plan rail's phone host
 * (responsive contract M1 / M5).
 *
 * Below `lg` the rail `aside` is hidden and mount-gated on `isLg`, so a
 * tapped chip or "Plan it" set `rail` state and rendered nothing: no slot
 * could be created or edited on a phone and the month brief was unreachable.
 * The sheet is driven by the SAME `rail` state; these pin the host's
 * contract (dialog semantics, 44px close, ESC / backdrop dismiss, hidden on
 * `lg+`) and, at the source level, that `feed-plan.tsx` mounts it off the
 * same state the aside reads and exposes a phone launcher for the brief.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { PlanMobileSheet } from "../plan-mobile-sheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dict = en as unknown as Dictionary;
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.style.overflow = "";
});

function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<I18nProvider locale="en" dict={dict}>{node}</I18nProvider>);
  });
}

describe("[COMP:app-web/feed-plan-mobile-sheet] PlanMobileSheet", () => {
  it("renders nothing while closed (no stray backdrop on SSR / the chat state)", () => {
    mount(
      <PlanMobileSheet open={false} title="Planned post" onClose={() => {}}>
        <span>body</span>
      </PlanMobileSheet>,
    );
    expect(host!.querySelector("[data-plan-mobile-sheet]")).toBeNull();
    expect(host!.textContent).not.toContain("body");
  });

  it("is a modal dialog with a 44px close, gated off lg+, dismissed by ESC and the backdrop", () => {
    const onClose = vi.fn();
    mount(
      <PlanMobileSheet open title="Planned post" onClose={onClose}>
        <span>body</span>
      </PlanMobileSheet>,
    );
    const wrapper = host!.querySelector<HTMLElement>("[data-plan-mobile-sheet]")!;
    expect(wrapper.className).toContain("lg:hidden");
    const dialog = wrapper.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("Planned post");
    expect(dialog.className).toContain("h-[88dvh]");
    expect(dialog.textContent).toContain("body");
    expect(document.body.style.overflow).toBe("hidden");

    const close = dialog.querySelector<HTMLButtonElement>(
      `button[aria-label="${en.feedPage.plan.mobileSheetClose}"]`,
    )!;
    expect(close.className).toContain("size-11");
    act(() => {
      close.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);

    const backdrop = wrapper.querySelector<HTMLButtonElement>(
      `:scope > button[aria-label="${en.feedPage.plan.mobileSheetClose}"]`,
    )!;
    act(() => {
      backdrop.click();
    });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

describe("[COMP:app-web/feed-plan-surface] the Plan board hosts the rail on phones", () => {
  // jsdom rewrites `import.meta.url` to an http origin, so resolve from the
  // package root (vitest runs with cwd = apps/app-web).
  const source = readFileSync(resolve(process.cwd(), "src/components/feed/feed-plan.tsx"), "utf8");

  it("mounts the sheet off the same `rail` state the aside reads, only below lg", () => {
    expect(source).toContain("<PlanMobileSheet");
    expect(source).toMatch(/\{!isLg && rail\.kind !== "chat" \? \(/);
    // Both hosts render the ONE prebuilt editor element per rail state.
    expect(source).toMatch(/const slotEditor =\s*rail\.kind === "slot"/);
    expect(source).toMatch(/const briefEditor =\s*rail\.kind === "brief"/);
    expect(source).toContain("{slotEditor ?? briefEditor}");
  });

  it("exposes a phone launcher for the month brief (the chat rail's header is lg+ only)", () => {
    expect(source).toContain("data-plan-brief-launcher-mobile");
    expect(source).toMatch(/data-plan-brief-launcher-mobile[\s\S]{0,400}lg:hidden/);
    expect(source).toMatch(/data-plan-brief-launcher-mobile[\s\S]{0,200}setRail\(\{ kind: "brief" \}\)/);
  });
});
