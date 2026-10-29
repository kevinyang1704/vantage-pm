import { describe, it, expect } from 'vitest';
import {
  deriveNodeSchedule,
  deriveAncestorSpan,
  isValidIsoDate,
} from './schedule.policy';

describe('schedule.policy', () => {
  it('validates ISO date format', () => {
    expect(isValidIsoDate('2026-09-01')).toBe(true);
    expect(isValidIsoDate('2026-02-29')).toBe(false); // 2026 is not a leap year
    expect(isValidIsoDate('2024-02-29')).toBe(true);  // 2024 is a leap year
    expect(isValidIsoDate('invalid')).toBe(false);
  });

  it('derives duration from startDate and endDate (inclusive days)', () => {
    const res = deriveNodeSchedule({
      startDate: '2026-09-01',
      endDate: '2026-09-01',
      durationDays: null,
      sourceMode: 'start_end',
    });
    expect(res.isValid).toBe(true);
    expect(res.durationDays).toBe(1);

    const weekRes = deriveNodeSchedule({
      startDate: '2026-09-01',
      endDate: '2026-09-07',
      durationDays: null,
      sourceMode: 'start_end',
    });
    expect(weekRes.durationDays).toBe(7);
  });

  it('derives endDate from startDate and durationDays', () => {
    const res = deriveNodeSchedule({
      startDate: '2026-09-01',
      endDate: null,
      durationDays: 14,
      sourceMode: 'start_duration',
    });
    expect(res.isValid).toBe(true);
    expect(res.endDate).toBe('2026-09-14');
  });

  it('derives startDate from endDate and durationDays', () => {
    const res = deriveNodeSchedule({
      startDate: null,
      endDate: '2026-09-14',
      durationDays: 14,
      sourceMode: 'end_duration',
    });
    expect(res.isValid).toBe(true);
    expect(res.startDate).toBe('2026-09-01');
  });

  it('handles cleared / undated nodes cleanly', () => {
    const res = deriveNodeSchedule({
      startDate: null,
      endDate: null,
      durationDays: null,
      sourceMode: 'none',
    });
    expect(res.isValid).toBe(true);
    expect(res.startDate).toBe(null);
    expect(res.endDate).toBe(null);
    expect(res.durationDays).toBe(null);
  });

  it('derives ancestor span from multiple descendants', () => {
    const descendants = [
      { startDate: '2026-09-05', endDate: '2026-09-20' },
      { startDate: '2026-09-01', endDate: '2026-09-10' },
      { startDate: null, endDate: null },
      { startDate: '2026-09-15', endDate: '2026-09-30' },
    ];

    const span = deriveAncestorSpan(descendants);
    expect(span.startDate).toBe('2026-09-01');
    expect(span.endDate).toBe('2026-09-30');
    expect(span.durationDays).toBe(30);
  });
});
