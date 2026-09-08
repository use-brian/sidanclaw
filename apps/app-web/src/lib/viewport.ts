/**
 * Viewport + pointer classification for the responsive contract
 * (docs/architecture/features/doc.md -> "Responsive contract").
 *
 * "Phone" means below Tailwind's `md` breakpoint (768px), the same line the
 * shell uses to swap the sidebar for a drawer. "Coarse" means the primary
 * pointer cannot hover (touch): the trigger for touch-reveal (M2) and for the
 * tap paths that replace hover and drag (M9).
 *
 * Every helper is SSR-safe and returns `false` where `window` or `matchMedia`
 * is missing (server render, jsdom without the shim), so a component seeded
 * from one of these never mismatches hydration: the server and the first
 * client frame agree on "not a phone" and the hook corrects after mount.
 *
 * [COMP:app-web/viewport]
 */

import { useCallback, useSyncExternalStore } from "react";

/** Tailwind `md` is 768px; everything narrower is a phone for the contract. */
export const PHONE_MAX_WIDTH_PX = 767;

export const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH_PX}px)`;

/** A pointer that cannot hover. `hover: none` is the primary signal; `pointer:
 *  coarse` catches touch-first devices that report a hover-capable mouse
 *  (some Android browsers with a paired mouse still expose a coarse primary). */
export const COARSE_POINTER_QUERY = "(hover: none), (pointer: coarse)";

function mediaMatches(query: string): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** True below `md`. Always `false` on the server. */
export function isPhoneViewport(): boolean {
  return mediaMatches(PHONE_QUERY);
}

/** True when the primary pointer cannot hover (touch). Always `false` on the server. */
export function isCoarsePointer(): boolean {
  return mediaMatches(COARSE_POINTER_QUERY);
}

/**
 * Subscribe to a media query. The server snapshot is `false`, so the first
 * client render matches SSR and the value flips after hydration.
 */
function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return () => {};
      }
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => mediaMatches(query),
    () => false,
  );
}

/** Reactive `isCoarsePointer()`. */
export function useCoarsePointer(): boolean {
  return useMediaQuery(COARSE_POINTER_QUERY);
}
