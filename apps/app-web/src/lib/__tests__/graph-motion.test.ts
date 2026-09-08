/**
 * Canvas motion lease (docs/architecture/brain/graph-view.md -> "Motion
 * lease"). The decision that replaced the graph's always-on redraw: a frame
 * is owed only while something is in flight that no input event will drive.
 */

import { describe, expect, it, vi } from "vitest";
import {
  applyCanvasMotion,
  easeRateFor,
  resolveCanvasMotion,
  type CanvasMotionInput,
} from "../graph-motion";

const resting: CanvasMotionInput = {
  documentVisible: true,
  intersecting: true,
  easePending: false,
  tweenActive: false,
  pointerInside: false,
  engineSettled: true,
};

describe("[COMP:app-web/graph-motion] resolveCanvasMotion", () => {
  it("pauses an idle, pointer-less, settled canvas", () => {
    expect(resolveCanvasMotion(resting)).toBe("paused");
  });

  it("pauses regardless of activity when hidden or off-screen", () => {
    expect(resolveCanvasMotion({ ...resting, documentVisible: false, easePending: true, pointerInside: true })).toBe(
      "paused",
    );
    expect(resolveCanvasMotion({ ...resting, intersecting: false, tweenActive: true })).toBe("paused");
  });

  it("paints continuously only while an ease or camera tween is in flight", () => {
    expect(resolveCanvasMotion({ ...resting, easePending: true })).toBe("continuous");
    expect(resolveCanvasMotion({ ...resting, tweenActive: true })).toBe("continuous");
    expect(resolveCanvasMotion({ ...resting, easePending: true, pointerInside: true })).toBe("continuous");
  });

  it("leaves the library's dirty tracking in charge while hovering or settling", () => {
    expect(resolveCanvasMotion({ ...resting, pointerInside: true })).toBe("on-demand");
    expect(resolveCanvasMotion({ ...resting, engineSettled: false })).toBe("on-demand");
  });
});

describe("[COMP:app-web/graph-motion] applyCanvasMotion", () => {
  it("drives the continuous flag + the loop per mode", () => {
    const driver = {
      setContinuous: vi.fn(),
      pauseAnimation: vi.fn(),
      resumeAnimation: vi.fn(),
    };
    applyCanvasMotion(driver, "continuous");
    expect(driver.setContinuous).toHaveBeenLastCalledWith(true);
    expect(driver.resumeAnimation).toHaveBeenCalledTimes(1);

    applyCanvasMotion(driver, "on-demand");
    expect(driver.setContinuous).toHaveBeenLastCalledWith(false);
    expect(driver.resumeAnimation).toHaveBeenCalledTimes(2);
    expect(driver.pauseAnimation).not.toHaveBeenCalled();

    applyCanvasMotion(driver, "paused");
    expect(driver.pauseAnimation).toHaveBeenCalledTimes(1);
    expect(driver.setContinuous).toHaveBeenLastCalledWith(false);
  });

  it("snaps eases under reduced motion", () => {
    expect(easeRateFor(false)).toBe(0.25);
    expect(easeRateFor(true)).toBe(1);
  });
});
