/**
 * Forecast Backlog panel width bounds and clamping.
 *
 * Pure — no React, no DOM required.
 */

/** Minimum width for the backlog panel — enough for grip, caret, title, points, and tag. */
export const FORECAST_BACKLOG_MIN_WIDTH = 180;

/** Default opening width (matches original fixed backlog width = 280). */
export const FORECAST_BACKLOG_DEFAULT_WIDTH = 280;

/** Maximum upper bound for the backlog panel. */
export const FORECAST_BACKLOG_MAX_WIDTH = 760;

/** Keyboard nudge step on the resize separator. */
export const FORECAST_BACKLOG_WIDTH_STEP = 16;

/** Minimum room to reserve for the planning list and rail beside the backlog panel. */
export const FORECAST_CONTENT_MIN_ROOM = 480;

/**
 * Clamp a requested backlog panel width to `[MIN, min(MAX, containerWidth - FORECAST_CONTENT_MIN_ROOM)]`.
 * `containerWidth` defaults to `window.innerWidth` when available in a browser environment.
 */
export function clampForecastBacklogWidth(px: number, containerWidth?: number): number {
  const cw =
    containerWidth ?? (typeof window !== 'undefined' ? window.innerWidth : undefined);
  const ceiling =
    typeof cw === 'number'
      ? Math.max(FORECAST_BACKLOG_MIN_WIDTH, Math.min(FORECAST_BACKLOG_MAX_WIDTH, cw - FORECAST_CONTENT_MIN_ROOM))
      : FORECAST_BACKLOG_MAX_WIDTH;
  return Math.round(Math.max(FORECAST_BACKLOG_MIN_WIDTH, Math.min(ceiling, px)));
}
