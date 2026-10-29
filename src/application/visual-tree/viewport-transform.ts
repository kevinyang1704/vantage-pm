/**
 * Pure viewport transform policy (Epic 10, E10-AR8, E10-FR9..FR12).
 *
 * One shared world transform `{ panX, panY, scale }` is applied to the
 * visual-tree world layer; `NodeGeometry` and connector paths are never
 * mutated or rescaled during gestures (E10-AR7). All pointer-to-world
 * conversion, pointer-anchored zoom, fit-all, and reset math lives here as
 * pure functions — no DOM, no React (AD-1).
 *
 * Convention: `screen` coordinates are relative to the canvas viewport
 * origin (clientX - viewportRect.left). `world` coordinates are the
 * canvas-absolute `NodeGeometry` space. The world layer is rendered with
 * `transform: translate(panX, panY) scale(scale)` so a world point `w`
 * appears on screen at `screen = w * scale + pan`.
 */

/** Zoom clamp (E10-NFR7): 25%–200%. */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 2.0;

export interface ViewportTransform {
  readonly panX: number;
  readonly panY: number;
  readonly scale: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly width: number;
  readonly height: number;
}

/** The identity viewport: no pan, 100% scale. */
export const IDENTITY_VIEWPORT: ViewportTransform = Object.freeze({
  panX: 0,
  panY: 0,
  scale: 1,
});

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Converts a world point to screen coordinates. */
export function worldToScreen(world: Point, viewport: ViewportTransform): Point {
  return Object.freeze({
    x: world.x * viewport.scale + viewport.panX,
    y: world.y * viewport.scale + viewport.panY,
  });
}

/** Converts a screen point to world coordinates. */
export function screenToWorld(screen: Point, viewport: ViewportTransform): Point {
  const scale = viewport.scale === 0 ? 1 : viewport.scale;
  return Object.freeze({
    x: (screen.x - viewport.panX) / scale,
    y: (screen.y - viewport.panY) / scale,
  });
}

/** Applies a screen-space pan delta to the viewport. */
export function panBy(delta: Point, viewport: ViewportTransform): ViewportTransform {
  return Object.freeze({
    panX: viewport.panX + delta.x,
    panY: viewport.panY + delta.y,
    scale: viewport.scale,
  });
}

/**
 * Zooms toward a screen anchor point (e.g. the pointer), keeping the world
 * point beneath the anchor stationary (E10-FR10). `deltaScale` is the
 * multiplicative factor (>1 zooms in, <1 zooms out).
 */
export function zoomTowardPointer(
  anchor: Point,
  deltaScale: number,
  viewport: ViewportTransform,
): ViewportTransform {
  const nextScale = clampScale(viewport.scale * deltaScale);
  if (nextScale === viewport.scale) {
    return viewport;
  }
  // Keep `anchor` pinned: the world point under the anchor before equals
  // the world point under the anchor after.
  const worldAtAnchor = screenToWorld(anchor, viewport);
  const screenAfter = worldToScreen(worldAtAnchor, { panX: 0, panY: 0, scale: nextScale });
  return Object.freeze({
    panX: anchor.x - screenAfter.x,
    panY: anchor.y - screenAfter.y,
    scale: nextScale,
  });
}

/** Standard wheel-zoom factor for a single wheel tick (E10-UX8). */
export function wheelDeltaScale(deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  // Trackpad deltas can be large; normalize toward a bounded step.
  const normalized = Math.sign(deltaY) * Math.min(Math.abs(deltaY), 120);
  return Math.exp(-normalized / 480);
}

/**
 * Computes a transform that fits `worldBounds` into the viewport at a scale
 * within [MIN_SCALE, 1] and centered (E10-UX10). Returns `null` when the
 * bounds are empty or non-finite (caller keeps the current viewport).
 */
export function fitAll(
  worldBounds: Rect,
  viewportSize: Rect,
): ViewportTransform | null {
  if (
    worldBounds.width <= 0 ||
    worldBounds.height <= 0 ||
    !Number.isFinite(worldBounds.width) ||
    !Number.isFinite(worldBounds.height) ||
    viewportSize.width <= 0 ||
    viewportSize.height <= 0
  ) {
    return null;
  }
  const scaleX = viewportSize.width / worldBounds.width;
  const scaleY = viewportSize.height / worldBounds.height;
  const scale = clampScale(Math.min(scaleX, scaleY, 1));
  const panX = (viewportSize.width - worldBounds.width * scale) / 2;
  const panY = (viewportSize.height - worldBounds.height * scale) / 2;
  return Object.freeze({ panX, panY, scale });
}

/** 100% scale, centered on the world origin (E10-FR11 reset). */
export function resetTransform(viewportSize: Rect): ViewportTransform {
  return Object.freeze({
    panX: viewportSize.width / 2,
    panY: viewportSize.height / 2,
    scale: 1,
  });
}

/** Centers a world rectangle in the viewport at the given scale. */
export function centerWorld(
  worldBounds: Rect,
  viewportSize: Rect,
  scale: number,
): ViewportTransform {
  const clamped = clampScale(scale);
  return Object.freeze({
    panX: (viewportSize.width - worldBounds.width * clamped) / 2,
    panY: (viewportSize.height - worldBounds.height * clamped) / 2,
    scale: clamped,
  });
}

/** True when a screen point lies inside a screen-space rect. */
export function pointInRect(point: Point, rect: Rect): boolean {
  return point.x >= 0 && point.x <= rect.width && point.y >= 0 && point.y <= rect.height;
}
