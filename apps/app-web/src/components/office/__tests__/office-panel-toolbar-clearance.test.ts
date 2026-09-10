/**
 * [COMP:app-web/office-editor-shell] Phone toolbar vs the stacked assistant
 * panel (responsive contract M1 / M6).
 *
 * Below `sm` the document toolbar is a `fixed inset-x-2 bottom-2` bar, and
 * below `lg` the assistant panel stacks LAST in the shell column - so its
 * collapsed 40px strip (the only way to reopen Brian / Comments / History /
 * Sharing / File actions after Collapse) sat entirely under the toolbar. The
 * panel column now reserves the toolbar's height on phones. The two classes
 * are the contract between two files; this pins both halves so one cannot
 * move without the other.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const shell = readFileSync(new URL("../office-editor-shell.tsx", import.meta.url), "utf8");
const toolbar = readFileSync(
  new URL("../document/document-toolbar.tsx", import.meta.url),
  "utf8",
);

describe("[COMP:app-web/office-editor-shell] phone toolbar clearance", () => {
  it("the phone toolbar is a fixed bottom bar only below sm", () => {
    expect(toolbar).toMatch(
      /data-document-toolbar-surface="phone"[\s\S]{0,40}$|fixed inset-x-2 bottom-2[^"]*sm:hidden/,
    );
    expect(toolbar).toContain('data-document-toolbar-surface="phone"');
  });

  it("the stacked panel column reserves the toolbar height plus the safe area below sm", () => {
    const aside = /<aside className=\{cn\("([^"]+)"/.exec(shell)?.[1] ?? "";
    expect(aside).toContain("max-sm:pb-[calc(4rem+env(safe-area-inset-bottom))]");
    expect(shell).toContain('data-office-panel={panelOpen ? "open" : "collapsed"}');
  });
});
