import { describe, expect, it } from 'vitest';
import {
  clampGanttHierarchyWidth,
  GANTT_CANVAS_MIN_ROOM,
  GANTT_HIERARCHY_DEFAULT_WIDTH,
  GANTT_HIERARCHY_MAX_WIDTH,
  GANTT_HIERARCHY_MIN_WIDTH,
} from './gantt-hierarchy-width';

describe('clampGanttHierarchyWidth', () => {
  it('clamps to the fixed [min, max] band when no container width is known', () => {
    expect(clampGanttHierarchyWidth(100)).toBe(GANTT_HIERARCHY_MIN_WIDTH);
    expect(clampGanttHierarchyWidth(9999)).toBe(GANTT_HIERARCHY_MAX_WIDTH);
    expect(clampGanttHierarchyWidth(400)).toBe(400);
  });

  it('rounds sub-pixel drags to whole pixels', () => {
    expect(clampGanttHierarchyWidth(350.6)).toBe(351);
    expect(clampGanttHierarchyWidth(350.2)).toBe(350);
  });

  it('caps the ceiling at containerWidth - GANTT_CANVAS_MIN_ROOM so canvas keeps room', () => {
    // 800 - 320 = 480, which is below the 800 hard cap
    expect(clampGanttHierarchyWidth(600, 800)).toBe(480);
    // 1600 - 320 = 1280, so the 800 hard cap wins
    expect(clampGanttHierarchyWidth(900, 1600)).toBe(GANTT_HIERARCHY_MAX_WIDTH);
  });

  it('never returns below the minimum even on a tiny viewport', () => {
    expect(clampGanttHierarchyWidth(300, 400)).toBe(GANTT_HIERARCHY_MIN_WIDTH);
  });

  it('leaves the default width untouched', () => {
    expect(clampGanttHierarchyWidth(GANTT_HIERARCHY_DEFAULT_WIDTH, 1440)).toBe(GANTT_HIERARCHY_DEFAULT_WIDTH);
  });
});
