import { describe, expect, it } from 'vitest';
import { formatInspectorDateRange } from './node-inspector-drawer';

describe('formatInspectorDateRange', () => {
  it('shares the year when both dates fall in the same year', () => {
    expect(formatInspectorDateRange('2026-11-02', '2026-11-06')).toBe('Nov 2 – Nov 6, 2026');
  });

  it('shows both years when the range crosses a year boundary', () => {
    expect(formatInspectorDateRange('2026-12-28', '2027-01-08')).toBe('Dec 28, 2026 – Jan 8, 2027');
  });

  it('describes open-ended ranges', () => {
    expect(formatInspectorDateRange('2026-09-01', null)).toBe('From Sep 1, 2026');
    expect(formatInspectorDateRange(null, '2026-09-15')).toBe('Until Sep 15, 2026');
  });

  it('returns null when there are no usable dates', () => {
    expect(formatInspectorDateRange(null, null)).toBeNull();
    expect(formatInspectorDateRange('not-a-date', '2026/09/15')).toBeNull();
  });
});
