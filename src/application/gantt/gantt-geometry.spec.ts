import { describe, it, expect } from 'vitest';
import { createDateToUnit } from './gantt-geometry';

describe('createDateToUnit (Story 8.3 Task 1)', () => {
  // Window: 2026-01-01 .. 2026-01-31, 6 units/day, 180 total units
  const dateToUnit = createDateToUnit({
    windowStart: '2026-01-01',
    windowEnd: '2026-01-31',
    unitsPerDay: 6,
    totalUnits: 180,
  });

  it('maps the window start to 0 and window end to totalUnits (isEnd offset)', () => {
    expect(dateToUnit('2026-01-01', false)).toBe(0);
    // End of the window as an end-date: 30 days * 6 + 6 = 186 (preserves the
    // original isEnd offset-by-one-unit convention)
    expect(dateToUnit('2026-01-31', true)).toBe(186);
  });

  it('maps a mid-window date linearly', () => {
    // Jan 1 -> Jan 10 = 9 days * 6 = 54
    expect(dateToUnit('2026-01-10', false)).toBe(54);
    // Jan 10 as an end date = 9 days * 6 + 6 = 60
    expect(dateToUnit('2026-01-10', true)).toBe(60);
  });

  it('clamps before-window dates to 0', () => {
    expect(dateToUnit('2025-12-01', false)).toBe(0);
    expect(dateToUnit('2025-12-01', true)).toBe(0);
  });

  it('clamps after-window dates to totalUnits', () => {
    expect(dateToUnit('2026-03-01', false)).toBe(180);
    expect(dateToUnit('2026-03-01', true)).toBe(180);
  });

  it('returns 0 for an invalid date string', () => {
    expect(dateToUnit('not-a-date', false)).toBe(0);
    expect(dateToUnit('not-a-date', true)).toBe(0);
  });
});
