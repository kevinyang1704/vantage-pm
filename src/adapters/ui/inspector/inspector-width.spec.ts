import { describe, expect, it } from 'vitest';
import {
  clampInspectorWidth,
  INSPECTOR_DEFAULT_WIDTH,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
} from './inspector-width';

describe('clampInspectorWidth', () => {
  it('clamps to the fixed [min, max] band when no viewport is known', () => {
    expect(clampInspectorWidth(200)).toBe(INSPECTOR_MIN_WIDTH);
    expect(clampInspectorWidth(9999)).toBe(INSPECTOR_MAX_WIDTH);
    expect(clampInspectorWidth(500)).toBe(500);
  });

  it('rounds sub-pixel drags to whole pixels', () => {
    expect(clampInspectorWidth(452.6)).toBe(453);
    expect(clampInspectorWidth(452.2)).toBe(452);
  });

  it('caps the ceiling at viewport - 480 so the canvas keeps room', () => {
    // 1200 - 480 = 720, below the 760 hard cap
    expect(clampInspectorWidth(760, 1200)).toBe(720);
    // 1400 - 480 = 920, so the 760 hard cap wins
    expect(clampInspectorWidth(900, 1400)).toBe(INSPECTOR_MAX_WIDTH);
  });

  it('never returns below the minimum even on a tiny viewport', () => {
    expect(clampInspectorWidth(400, 600)).toBe(INSPECTOR_MIN_WIDTH);
  });

  it('leaves the default width untouched', () => {
    expect(clampInspectorWidth(INSPECTOR_DEFAULT_WIDTH, 1440)).toBe(INSPECTOR_DEFAULT_WIDTH);
  });
});
