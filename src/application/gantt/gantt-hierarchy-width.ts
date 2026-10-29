/**
 * Gantt hierarchy column width bounds and clamping.
 *
 * Pure — no React, no DOM required.
 */

/** Minimum width for the hierarchy column — enough for indent, caret, badge, and title start. */
export const GANTT_HIERARCHY_MIN_WIDTH = 180;

/** Default width (matches original fixed GANTT_HIERARCHY_COL_WIDTH_PX = 268). */
export const GANTT_HIERARCHY_DEFAULT_WIDTH = 268;

/** Maximum upper bound for the hierarchy column. */
export const GANTT_HIERARCHY_MAX_WIDTH = 800;

/** Keyboard nudge step on the resize separator. */
export const GANTT_HIERARCHY_WIDTH_STEP = 16;

/** Minimum room to reserve for the timeline canvas beside the hierarchy column. */
export const GANTT_CANVAS_MIN_ROOM = 320;

/**
 * Clamp a requested hierarchy column width to `[MIN, min(MAX, containerWidth - GANTT_CANVAS_MIN_ROOM)]`.
 * `containerWidth` defaults to `window.innerWidth` when available in a browser environment.
 */
export function clampGanttHierarchyWidth(px: number, containerWidth?: number): number {
  const cw =
    containerWidth ?? (typeof window !== 'undefined' ? window.innerWidth : undefined);
  const ceiling =
    typeof cw === 'number'
      ? Math.max(GANTT_HIERARCHY_MIN_WIDTH, Math.min(GANTT_HIERARCHY_MAX_WIDTH, cw - GANTT_CANVAS_MIN_ROOM))
      : GANTT_HIERARCHY_MAX_WIDTH;
  return Math.round(Math.max(GANTT_HIERARCHY_MIN_WIDTH, Math.min(ceiling, px)));
}
