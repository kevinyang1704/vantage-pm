import { describe, it, expect } from 'vitest';
import { computeDragDates, snapDateToGranularity } from './gantt-drag.policy';

describe('Gantt Drag Policy (Story 7.5)', () => {
  const initialStartDate = '2026-06-01';
  const initialEndDate = '2026-06-15';

  it('shifts both bounds on body drag preserving exact duration', () => {
    const result = computeDragDates({
      handle: 'body',
      initialStartDate,
      initialEndDate,
      deltaDays: 10,
      granularity: 'week',
    });

    expect(result.startDate).toBe('2026-06-11');
    expect(result.endDate).toBe('2026-06-25');
    expect(result.durationDays).toBe(15);
  });

  it('resizes start handle and maintains minimum 1-day duration', () => {
    const result = computeDragDates({
      handle: 'start',
      initialStartDate,
      initialEndDate,
      deltaDays: 5,
      granularity: 'week',
    });

    expect(result.startDate).toBe('2026-06-06');
    expect(result.endDate).toBe('2026-06-15');
    expect(result.durationDays).toBe(10);

    // Extreme drag past end date
    const extreme = computeDragDates({
      handle: 'start',
      initialStartDate,
      initialEndDate,
      deltaDays: 30,
      granularity: 'week',
    });

    expect(extreme.startDate).toBe('2026-06-15');
    expect(extreme.endDate).toBe('2026-06-15');
    expect(extreme.durationDays).toBe(1);
  });

  it('resizes end handle and maintains minimum 1-day duration', () => {
    const result = computeDragDates({
      handle: 'end',
      initialStartDate,
      initialEndDate,
      deltaDays: 10,
      granularity: 'week',
    });

    expect(result.startDate).toBe('2026-06-01');
    expect(result.endDate).toBe('2026-06-25');
    expect(result.durationDays).toBe(25);

    // Extreme drag before start date
    const extreme = computeDragDates({
      handle: 'end',
      initialStartDate,
      initialEndDate,
      deltaDays: -20,
      granularity: 'week',
    });

    expect(extreme.startDate).toBe('2026-06-01');
    expect(extreme.endDate).toBe('2026-06-01');
    expect(extreme.durationDays).toBe(1);
  });

  it('snaps dates to month boundaries correctly', () => {
    expect(snapDateToGranularity('2026-06-08', 'month')).toBe('2026-06-01');
    expect(snapDateToGranularity('2026-06-20', 'month')).toBe('2026-07-01');
  });

  it('snaps dates to quarter boundaries correctly', () => {
    expect(snapDateToGranularity('2026-02-15', 'quarter')).toBe('2026-01-01');
    expect(snapDateToGranularity('2026-05-20', 'quarter')).toBe('2026-04-01');
    expect(snapDateToGranularity('2026-08-10', 'quarter')).toBe('2026-07-01');
  });
});
