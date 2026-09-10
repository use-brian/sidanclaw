// @vitest-environment jsdom
/**
 * [COMP:app-web/goals-board] + [COMP:app-web/triage-panel] - phone single-pane.
 *
 * Both panels were `w-[340px] shrink-0` list + `flex-1` detail with no
 * breakpoint prefix, so at 390px the detail pane (and the ONLY Confirm / Work
 * / Discard controls in the product) was ~50px wide. Below `md` the two are
 * now two screens: the list until a row is tapped, then the detail with a
 * Back row (responsive contract M1 / M5). The classes are the contract - the
 * breakpoint itself is CSS, so the test asserts the class toggling that the
 * `max-md:` prefix keys on.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { GoalRow } from "@/lib/api/goals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaces: () => ({ activeId: "w1", workspaces: [], active: null }),
}));

const row = (id: string, confirmed: boolean): GoalRow => ({
  id,
  outcome: `Outcome ${id}`,
  status: "active",
  host: null,
  hostTitle: null,
  parentGoalId: null,
  recipeId: null,
  blockerReason: null,
  contextGroupId: null,
  contextProjectId: null,
  confirmedAt: confirmed ? "2026-09-01T00:00:00.000Z" : null,
  hasWorkflow: false,
  originSessionId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});

vi.mock("@/lib/api/goals", () => ({
  listGoals: vi.fn(async (_wid: string, opts?: { confirmed?: boolean }) =>
    opts?.confirmed === false ? [row("d1", false), row("d2", false)] : [row("g1", true), row("g2", true)],
  ),
  // The detail pane's own fetch: never resolves here, so the pane stays on
  // its loading line and the test stays on the layout contract.
  getGoalDetail: vi.fn(() => new Promise(() => {})),
  confirmGoal: vi.fn(),
  workGoal: vi.fn(),
  abandonGoal: vi.fn(),
}));

import { AutopilotPanel } from "../autopilot-panel";
import { TriagePanel } from "../triage-panel";

const dict = en as unknown as Dictionary;
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<I18nProvider locale="en" dict={dict}>{node}</I18nProvider>);
    await settle();
    await settle();
  });
}

function panes() {
  const outer = host!.firstElementChild as HTMLElement;
  const list = outer.children[0] as HTMLElement;
  const detail = outer.children[1] as HTMLElement;
  return { outer, list, detail };
}

for (const [name, node, backLabel] of [
  ["Autopilot", <AutopilotPanel key="a" />, en.goalsPage.backToList],
  ["Triage", <TriagePanel key="t" />, en.triagePage.backToList],
] as const) {
  describe(`[COMP:app-web/goals-board] ${name} panel single-pane below md`, () => {
    it("stacks the columns, keeps the list on screen until a row is tapped, then Back returns", async () => {
      await mount(node);
      const { outer, list, detail } = panes();
      // Stacked on a phone, side by side from `md` (M5); the list has no
      // fixed basis on a phone.
      expect(outer.className).toContain("flex-col");
      expect(outer.className).toContain("md:flex-row");
      expect(list.className).toContain("w-full");
      expect(list.className).toContain("md:w-[340px]");
      expect(list.className).not.toContain("max-md:hidden");
      // The first row is auto-selected, but the detail must NOT take the pane
      // until the user taps - on a phone that would hide the list on entry.
      expect(detail.className).toContain("max-md:hidden");

      const firstRow = list.querySelector<HTMLButtonElement>('button[aria-pressed]');
      expect(firstRow).not.toBeNull();
      await act(async () => {
        firstRow!.click();
        await settle();
      });
      expect(panes().list.className).toContain("max-md:hidden");
      expect(panes().detail.className).not.toContain("max-md:hidden");

      const back = Array.from(panes().detail.querySelectorAll("button")).find(
        (b) => (b.textContent ?? "").includes(backLabel),
      );
      expect(back).not.toBeUndefined();
      // The Back row lives only on the phone screen and is a 44px target (M3).
      expect(back!.closest("div")!.className).toContain("md:hidden");
      expect(back!.className).toContain("min-h-11");
      await act(async () => {
        back!.click();
        await settle();
      });
      expect(panes().list.className).not.toContain("max-md:hidden");
      expect(panes().detail.className).toContain("max-md:hidden");
    });
  });
}
