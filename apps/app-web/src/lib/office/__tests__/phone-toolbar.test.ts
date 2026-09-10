/** [COMP:app-web/office-document-editor] phone toolbar keyboard inset (report B row 23). */
import { describe, expect, it } from "vitest";
import { visualViewportBottomInset } from "../phone-toolbar";

describe("[COMP:app-web/office-document-editor] visualViewportBottomInset", () => {
  it("is zero while the visual viewport fills the layout viewport", () => {
    expect(visualViewportBottomInset(844, 0, 844)).toBe(0);
  });
  it("is the keyboard height when the visual viewport shrinks from the bottom", () => {
    expect(visualViewportBottomInset(544, 0, 844)).toBe(300);
  });
  it("accounts for a visual viewport scrolled down inside the layout viewport", () => {
    expect(visualViewportBottomInset(544, 100, 844)).toBe(200);
  });
  it("never goes negative and ignores unusable numbers", () => {
    expect(visualViewportBottomInset(900, 0, 844)).toBe(0);
    expect(visualViewportBottomInset(Number.NaN, 0, 844)).toBe(0);
  });
});
