/**
 * Graph canvas motion lease - when the Brain graph is allowed to spend
 * frames (`components/brain/graph-view.tsx`).
 *
 * The canvas used to render continuously (`autoPauseRedraw={false}`): one
 * full node/edge pass per animation frame for as long as the Brain was on
 * screen, idle or not, because the eased dim transitions and the fit-relative
 * label tiers change how a frame LOOKS without changing any prop, and the
 * library's own auto-pause froze exactly those frames mid-transition. The
 * fix is not to paint forever; it is to say precisely when a frame is owed.
 *
 * Three modes, decided per frame from what is actually in flight:
 *
 *   - `continuous` - something is animating that no input event will drive:
 *     an eased alpha/width has not reached its target (`easePending`), or a
 *     programmatic camera tween is running (`tweenActive`). The library is
 *     told to paint every frame until this clears.
 *   - `on-demand` - the library's own dirty tracking suffices: it repaints on
 *     pointer moves, zoom/pan, engine ticks and prop changes, and skips the
 *     frame otherwise. This is the resting state while the pointer is over
 *     the canvas or the layout is still settling.
 *   - `paused` - the animation loop itself is stopped: the tab is hidden, the
 *     canvas is scrolled out of view, or the pointer has left and nothing is
 *     in flight. Zero work. Any input, data or prop change wakes it.
 *
 * `prefers-reduced-motion` collapses the eases to a snap (rate 1), so the
 * continuous mode is never entered on their account.
 *
 * Spec: docs/architecture/brain/graph-view.md -> "Motion lease".
 * [COMP:app-web/graph-motion]
 */

export type CanvasMotionMode = "continuous" | "on-demand" | "paused";

export type CanvasMotionInput = {
  /** `document.visibilityState === 'visible'`. */
  documentVisible: boolean;
  /** The canvas intersects the viewport (IntersectionObserver). */
  intersecting: boolean;
  /** A `stepToward` in the last painted frame did not reach its target. */
  easePending: boolean;
  /** A programmatic camera tween (fit / zoom button) is still running. */
  tweenActive: boolean;
  /** The pointer is over the canvas (hover detection needs the loop). */
  pointerInside: boolean;
  /** The force engine has stopped ticking (`onEngineStop` fired after the
   *  last data change). While false the loop must run so the layout can
   *  settle; the library paints those frames on its own. */
  engineSettled: boolean;
};

export function resolveCanvasMotion(input: CanvasMotionInput): CanvasMotionMode {
  if (!input.documentVisible || !input.intersecting) return "paused";
  if (input.easePending || input.tweenActive) return "continuous";
  if (input.pointerInside || !input.engineSettled) return "on-demand";
  return "paused";
}

/** How long after the last activity an idle, pointer-less canvas waits
 *  before the loop is stopped - long enough that a quick re-entry or the
 *  tail of a hover-out ease never thrashes the loop. */
export const MOTION_IDLE_GRACE_MS = 1200;

/** Duration of the library's camera tweens plus a frame of slack. */
export const CAMERA_TWEEN_MS = 360;
export const CAMERA_TWEEN_GRACE_MS = CAMERA_TWEEN_MS + 80;

/**
 * What the lease drives. `pauseAnimation` / `resumeAnimation` are real
 * methods on the react-force-graph ref; `autoPauseRedraw` is NOT - the ref
 * exposes methods only, never prop setters - so continuous painting is a
 * React prop (`autoPauseRedraw={!continuous}`) and the driver's
 * `setContinuous` flips the state behind it (guarded, so a repeated decision
 * never re-renders).
 */
export type MotionDriver = {
  setContinuous(on: boolean): void;
  pauseAnimation(): unknown;
  resumeAnimation(): unknown;
};

/**
 * Apply a mode. Idempotent by construction - the library's
 * `resumeAnimation` is a no-op while the loop runs and `pauseAnimation` a
 * no-op while it is stopped, and `setContinuous` is guarded - so callers may
 * apply on every decision.
 */
export function applyCanvasMotion(driver: MotionDriver, mode: CanvasMotionMode): void {
  switch (mode) {
    case "continuous":
      driver.setContinuous(true);
      driver.resumeAnimation();
      return;
    case "on-demand":
      driver.setContinuous(false);
      driver.resumeAnimation();
      return;
    case "paused":
      driver.setContinuous(false);
      driver.pauseAnimation();
      return;
  }
}

/** Ease rate under the user's motion preference: normal 0.25, reduced = snap. */
export function easeRateFor(reducedMotion: boolean): number {
  return reducedMotion ? 1 : 0.25;
}
