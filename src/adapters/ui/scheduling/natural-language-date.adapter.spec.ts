import { describe, it, expect } from 'vitest';
import { parseNaturalLanguageSchedule } from './natural-language-date.adapter';

describe('natural-language-date.adapter', () => {
  it('parses direct ISO dates', () => {
    const res = parseNaturalLanguageSchedule('2026-09-01');
    expect(res.kind).toBe('date');
    if (res.kind === 'date') {
      expect(res.isoDate).toBe('2026-09-01');
    }
  });

  it('parses duration strings in weeks and days', () => {
    const res1 = parseNaturalLanguageSchedule('3 weeks');
    expect(res1.kind).toBe('duration');
    if (res1.kind === 'duration') {
      expect(res1.durationDays).toBe(21);
    }

    const res2 = parseNaturalLanguageSchedule('14d');
    expect(res2.kind).toBe('duration');
    if (res2.kind === 'duration') {
      expect(res2.durationDays).toBe(14);
    }
  });

  it('parses relative phrases with reference dates', () => {
    const res = parseNaturalLanguageSchedule('tomorrow', '2026-09-01');
    expect(res.kind).toBe('date');
    if (res.kind === 'date') {
      expect(res.isoDate).toBe('2026-09-02');
    }
  });

  it('returns invalid on nonsense text', () => {
    const res = parseNaturalLanguageSchedule('foobar xyz 123456');
    expect(res.kind).toBe('invalid');
  });
});
