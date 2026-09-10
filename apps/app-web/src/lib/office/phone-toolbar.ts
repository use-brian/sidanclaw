/**
 * Pure geometry for the Document phone toolbar (report B row 23, responsive
 * contract M6). The bar is `position: fixed` against the LAYOUT viewport, so
 * with the soft keyboard up (the moment a user has text selected to format)
 * it sat behind the keyboard. `window.visualViewport` reports the visible
 * region; the difference to the layout viewport is the inset the bar must
 * add to its `bottom`. [COMP:app-web/office-document-editor]
 */

/** Pixels hidden below the visual viewport (0 when nothing is covered or the numbers are unusable). */
export function visualViewportBottomInset(visualHeight: number, visualOffsetTop: number, layoutHeight: number): number {
  if (![visualHeight, visualOffsetTop, layoutHeight].every(Number.isFinite)) return 0;
  return Math.max(0, Math.round(layoutHeight - (visualHeight + visualOffsetTop)));
}
