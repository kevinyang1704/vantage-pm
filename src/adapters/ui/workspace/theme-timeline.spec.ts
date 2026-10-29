import { describe, expect, it } from 'vitest';
import { todayLabelEdgeModifier } from './theme-timeline';

describe('todayLabelEdgeModifier', () => {
  it('centres the label away from the edges', () => {
    expect(todayLabelEdgeModifier(8)).toBe('');
    expect(todayLabelEdgeModifier(50)).toBe('');
    expect(todayLabelEdgeModifier(92)).toBe('');
  });

  it('anchors to the start near the left edge', () => {
    expect(todayLabelEdgeModifier(0)).toBe(' pm-theme-timeline-axis__today-label--start');
    expect(todayLabelEdgeModifier(7.9)).toBe(' pm-theme-timeline-axis__today-label--start');
  });

  it('anchors to the end near the right edge', () => {
    expect(todayLabelEdgeModifier(92.1)).toBe(' pm-theme-timeline-axis__today-label--end');
    expect(todayLabelEdgeModifier(100)).toBe(' pm-theme-timeline-axis__today-label--end');
  });
});
