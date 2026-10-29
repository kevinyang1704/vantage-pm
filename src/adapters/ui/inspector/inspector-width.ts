/**
 * Docked inspector-drawer width bounds and clamping (Story 16.3, E16-UX1).
 *
 * Pure — no React, no DOM required. The drag separator and the composition
 * root both clamp through this so a persisted width can never render the
 * canvas unusable.
 */

/** Never narrower than this — below it the brief toolbar wraps badly. */
export const INSPECTOR_MIN_WIDTH = 320;
/** Opening width, and the double-click / Home reset target. */
export const INSPECTOR_DEFAULT_WIDTH = 360;
/** Hard upper bound regardless of viewport. */
export const INSPECTOR_MAX_WIDTH = 760;
/** Keyboard nudge step on the resize separator. */
export const INSPECTOR_WIDTH_STEP = 16;

/** Minimum room to leave for the view beside the drawer. */
const CANVAS_RESERVE = 480;

/**
 * Clamp a requested drawer width to `[MIN, min(MAX, viewport - CANVAS_RESERVE)]`.
 * `viewportWidth` defaults to `window.innerWidth`; when neither is available
 * (SSR / tests) only the fixed `[MIN, MAX]` band applies.
 */
export function clampInspectorWidth(px: number, viewportWidth?: number): number {
  const vw =
    viewportWidth ?? (typeof window !== 'undefined' ? window.innerWidth : undefined);
  const ceiling =
    typeof vw === 'number'
      ? Math.max(INSPECTOR_MIN_WIDTH, Math.min(INSPECTOR_MAX_WIDTH, vw - CANVAS_RESERVE))
      : INSPECTOR_MAX_WIDTH;
  return Math.round(Math.max(INSPECTOR_MIN_WIDTH, Math.min(ceiling, px)));
}
