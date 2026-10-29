/**
 * Pure viewport transform policy specs (Epic 10, E10-AR8, E10-FR9..FR12,
 * E10-NFR7, E10-UX8, E10-UX10).
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_SCALE,
  MIN_SCALE,
  centerWorld,
  clampScale,
  fitAll,
  panBy,
  resetTransform,
  screenToWorld,
  wheelDeltaScale,
  worldToScreen,
  zoomTowardPointer,
  type ViewportTransform,
} from './viewport-transform';

const T100: ViewportTransform = Object.freeze({ panX: 0, panY: 0, scale: 1 });

describe('viewport transform (E10-AR8)', () => {
  it('worldToScreen/screenToWorld are inverse under identity', () => {
    const world = { x: 120, y: 80 };
    const screen = worldToScreen(world, T100);
    expect(screen).toEqual({ x: 120, y: 80 });
    expect(screenToWorld(screen, T100)).toEqual(world);
  });

  it('worldToScreen/screenToWorld are inverse under pan and scale', () => {
    const viewport: ViewportTransform = Object.freeze({ panX: 50, panY: -30, scale: 1.5 });
    const world = { x: 200, y: 100 };
    const screen = worldToScreen(world, viewport);
    expect(screen.x).toBeCloseTo(200 * 1.5 + 50, 6);
    expect(screen.y).toBeCloseTo(100 * 1.5 - 30, 6);
    const roundTrip = screenToWorld(screen, viewport);
    expect(roundTrip.x).toBeCloseTo(world.x, 6);
    expect(roundTrip.y).toBeCloseTo(world.y, 6);
  });

  it('panBy adds the screen delta to pan offset only', () => {
    const next = panBy({ x: 12, y: -7 }, Object.freeze({ panX: 5, panY: 5, scale: 2 }));
    expect(next).toEqual({ panX: 17, panY: -2, scale: 2 });
  });

  it('clampScale keeps scale within 25%–200% and rejects non-finite', () => {
    expect(clampScale(0.1)).toBe(MIN_SCALE);
    expect(clampScale(5)).toBe(MAX_SCALE);
    expect(clampScale(1.5)).toBe(1.5);
    expect(clampScale(Number.NaN)).toBe(1);
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('zoomTowardPointer keeps the world point under the anchor stationary', () => {
    const viewport: ViewportTransform = Object.freeze({ panX: 100, panY: 200, scale: 1 });
    const anchor = { x: 300, y: 150 };
    const before = screenToWorld(anchor, viewport);
    const next = zoomTowardPointer(anchor, 1.5, viewport);
    expect(next.scale).toBeCloseTo(1.5, 6);
    const after = screenToWorld(anchor, next);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('zoomTowardPointer clamps at the bounds and returns the same viewport when clamped', () => {
    const viewport: ViewportTransform = Object.freeze({ panX: 0, panY: 0, scale: MAX_SCALE });
    const next = zoomTowardPointer({ x: 10, y: 10 }, 2, viewport);
    expect(next).toBe(viewport); // no change beyond clamp
  });

  it('wheelDeltaScale zooms in for negative delta and out for positive, bounded', () => {
    expect(wheelDeltaScale(-120)).toBeGreaterThan(1);
    expect(wheelDeltaScale(120)).toBeLessThan(1);
    expect(wheelDeltaScale(0)).toBe(1);
    expect(wheelDeltaScale(Number.NaN)).toBe(1);
    // Large trackpad deltas normalize.
    expect(wheelDeltaScale(-1000)).toBeGreaterThan(0);
  });

  it('fitAll centers the world at a scale between 25% and 100%', () => {
    const world = { width: 800, height: 600 };
    const viewport = { width: 400, height: 300 };
    const fit = fitAll(world, viewport)!;
    expect(fit.scale).toBeCloseTo(0.5, 6);
    expect(fit.scale).toBeGreaterThanOrEqual(MIN_SCALE);
    expect(fit.scale).toBeLessThanOrEqual(1);
    // Centered: world corners map into the viewport.
    const topLeft = worldToScreen({ x: 0, y: 0 }, fit);
    const bottomRight = worldToScreen({ x: 800, y: 600 }, fit);
    expect(topLeft.x).toBeCloseTo(0, 6);
    expect(topLeft.y).toBeCloseTo(0, 6);
    expect(bottomRight.x).toBeCloseTo(400, 6);
    expect(bottomRight.y).toBeCloseTo(300, 6);
  });

  it('fitAll clamps to 100% when the world is smaller than the viewport', () => {
    const fit = fitAll({ width: 100, height: 100 }, { width: 400, height: 300 })!;
    expect(fit.scale).toBe(1);
    expect(fit.panX).toBeCloseTo(150, 6);
    expect(fit.panY).toBeCloseTo(100, 6);
  });

  it('fitAll returns null for empty or non-finite bounds', () => {
    expect(fitAll({ width: 0, height: 100 }, { width: 400, height: 300 })).toBeNull();
    expect(fitAll({ width: 100, height: 0 }, { width: 400, height: 300 })).toBeNull();
    expect(fitAll({ width: Number.NaN, height: 100 }, { width: 400, height: 300 })).toBeNull();
  });

  it('resetTransform centers the world origin at 100%', () => {
    const reset = resetTransform({ width: 800, height: 600 });
    expect(reset).toEqual({ panX: 400, panY: 300, scale: 1 });
    expect(worldToScreen({ x: 0, y: 0 }, reset)).toEqual({ x: 400, y: 300 });
  });

  it('centerWorld centers at a given clamped scale', () => {
    const centered = centerWorld({ width: 400, height: 200 }, { width: 800, height: 600 }, 2);
    expect(centered.scale).toBe(MAX_SCALE); // clamped from 2 (== MAX)
    const centered2 = centerWorld({ width: 400, height: 200 }, { width: 800, height: 600 }, 0.5);
    expect(centered2.scale).toBe(0.5);
    expect(centered2.panX).toBeCloseTo((800 - 400 * 0.5) / 2, 6);
    expect(centered2.panY).toBeCloseTo((600 - 200 * 0.5) / 2, 6);
  });
});
