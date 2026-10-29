import { describe, expect, it } from 'vitest';
import {
  classifyTimelineSpan,
  computeTimelineBar,
  computeTimelineDomain,
  computeTimelineTicks,
  MIN_BAR_WIDTH_PERCENT,
  todayPositionPercent,
} from './workspace-overview-timeline';

describe('workspace-overview timeline geometry (Story 24.2)', () => {
  describe('classifyTimelineSpan (AC 24.2-3)', () => {
    it('classifies both absent dates as not_scheduled', () => {
      expect(classifyTimelineSpan({ spanStartDate: null, spanEndDate: null }).kind).toBe('not_scheduled');
    });

    it('classifies exactly one side as incomplete', () => {
      expect(classifyTimelineSpan({ spanStartDate: '2026-05-01', spanEndDate: null }).kind).toBe('incomplete');
      expect(classifyTimelineSpan({ spanStartDate: null, spanEndDate: '2026-05-01' }).kind).toBe('incomplete');
    });

    it('classifies a reversed pair as invalid', () => {
      expect(classifyTimelineSpan({ spanStartDate: '2026-05-10', spanEndDate: '2026-05-01' }).kind).toBe('invalid');
    });

    it('classifies a malformed date as invalid', () => {
      expect(classifyTimelineSpan({ spanStartDate: '2026-13-40', spanEndDate: '2026-05-01' }).kind).toBe('invalid');
      expect(classifyTimelineSpan({ spanStartDate: 'not-a-date', spanEndDate: '2026-05-01' }).kind).toBe('invalid');
    });

    it('classifies a complete ordered pair as scheduled', () => {
      const state = classifyTimelineSpan({ spanStartDate: '2026-05-01', spanEndDate: '2026-12-01' });
      expect(state).toEqual({ kind: 'scheduled', startDate: '2026-05-01', endDate: '2026-12-01' });
    });

    it('accepts a one-day span (start == end)', () => {
      expect(classifyTimelineSpan({ spanStartDate: '2026-05-01', spanEndDate: '2026-05-01' }).kind).toBe('scheduled');
    });
  });

  describe('computeTimelineDomain (AC 24.2-1)', () => {
    it('starts at the first day of the earliest month and ends after the latest month', () => {
      const domain = computeTimelineDomain([
        { spanStartDate: '2026-05-01', spanEndDate: '2026-12-01' },
        { spanStartDate: '2026-09-05', spanEndDate: '2026-09-30' },
      ]);
      expect(domain).not.toBeNull();
      expect(domain!.start).toBe('2026-05-01');
      expect(domain!.endExclusive).toBe('2027-01-01');
      expect(domain!.endInclusive).toBe('2026-12-31');
    });

    it('returns null when no theme has a complete valid span', () => {
      expect(computeTimelineDomain([])).toBeNull();
      expect(computeTimelineDomain([{ spanStartDate: null, spanEndDate: null }])).toBeNull();
      expect(computeTimelineDomain([{ spanStartDate: '2026-05-01', spanEndDate: null }])).toBeNull();
      expect(computeTimelineDomain([{ spanStartDate: '2026-05-10', spanEndDate: '2026-05-01' }])).toBeNull();
    });

    it('ignores invalid lanes while a valid lane still establishes the domain', () => {
      const domain = computeTimelineDomain([
        { spanStartDate: '2026-05-01', spanEndDate: null },
        { spanStartDate: '2026-06-01', spanEndDate: '2026-06-30' },
      ]);
      expect(domain!.start).toBe('2026-06-01');
      expect(domain!.endExclusive).toBe('2026-07-01');
    });

    it('is deterministic across a leap-year February boundary', () => {
      const domain = computeTimelineDomain([
        { spanStartDate: '2024-02-28', spanEndDate: '2024-02-29' },
      ]);
      expect(domain!.start).toBe('2024-02-01');
      expect(domain!.endExclusive).toBe('2024-03-01');
      expect(domain!.totalDays).toBe(29);
    });

    it('handles a multi-year schedule', () => {
      const domain = computeTimelineDomain([
        { spanStartDate: '2024-11-15', spanEndDate: '2026-02-10' },
      ]);
      expect(domain!.start).toBe('2024-11-01');
      expect(domain!.endExclusive).toBe('2026-03-01');
    });
  });

  describe('computeTimelineBar (AC 24.2-1/2/7)', () => {
    const domain = computeTimelineDomain([
      { spanStartDate: '2026-05-01', spanEndDate: '2026-12-01' },
    ])!;

    it('starts the May–Dec lane at 0 and ends before 100 (exclusive end)', () => {
      const state = classifyTimelineSpan({ spanStartDate: '2026-05-01', spanEndDate: '2026-12-01' });
      const bar = computeTimelineBar(state, domain)!;
      // First of May aligns to day 0; the exclusive end is Jan 1, so an
      // inclusive Dec 1 end occupies days 0..214 of 245 total days.
      expect(bar.leftPercent).toBe(0);
      expect(bar.widthPercent).toBeCloseTo(((215 / 245) * 100), 1);
      expect(bar.widthPercent).toBeLessThan(100);
    });

    it('places the Sep 5–30 lane later and shorter than the May–Dec lane', () => {
      const longState = classifyTimelineSpan({ spanStartDate: '2026-05-01', spanEndDate: '2026-12-01' });
      const shortState = classifyTimelineSpan({ spanStartDate: '2026-09-05', spanEndDate: '2026-09-30' });
      const longBar = computeTimelineBar(longState, domain)!;
      const shortBar = computeTimelineBar(shortState, domain)!;

      expect(shortBar.leftPercent).toBeGreaterThan(longBar.leftPercent);
      expect(shortBar.widthPercent).toBeLessThan(longBar.widthPercent);
    });

    it('aligns equal spans exactly', () => {
      const a = classifyTimelineSpan({ spanStartDate: '2026-06-01', spanEndDate: '2026-06-30' });
      const b = classifyTimelineSpan({ spanStartDate: '2026-06-01', spanEndDate: '2026-06-30' });
      expect(computeTimelineBar(a, domain)).toEqual(computeTimelineBar(b, domain));
    });

    it('gives a subpixel one-day span an accessible minimum visible width without changing dates', () => {
      const multiYear = computeTimelineDomain([
        { spanStartDate: '2020-01-01', spanEndDate: '2030-12-31' },
      ])!;
      const oneDay = classifyTimelineSpan({ spanStartDate: '2025-06-15', spanEndDate: '2025-06-15' });
      const bar = computeTimelineBar(oneDay, multiYear)!;
      expect(bar.widthPercent).toBeGreaterThanOrEqual(MIN_BAR_WIDTH_PERCENT - 0.01);
      // The labeled dates are untouched by the visible-width floor.
      expect(oneDay).toEqual({ kind: 'scheduled', startDate: '2025-06-15', endDate: '2025-06-15' });
    });

    it('returns null for any non-scheduled state', () => {
      expect(computeTimelineBar({ kind: 'not_scheduled' }, domain)).toBeNull();
      expect(computeTimelineBar({ kind: 'incomplete' }, domain)).toBeNull();
      expect(computeTimelineBar({ kind: 'invalid' }, domain)).toBeNull();
    });
  });

  describe('todayPositionPercent (AC 24.2-4)', () => {
    const domain = computeTimelineDomain([
      { spanStartDate: '2026-05-01', spanEndDate: '2026-12-01' },
    ])!;

    it('omits Today when the injected date is outside the domain', () => {
      expect(todayPositionPercent(domain, '2026-01-01')).toBeNull();
      expect(todayPositionPercent(domain, '2027-01-01')).toBeNull();
    });

    it('places an in-domain date proportionally', () => {
      const percent = todayPositionPercent(domain, '2026-09-26')!;
      expect(percent).toBeGreaterThan(0);
      expect(percent).toBeLessThan(100);
    });

    it('is null for a malformed date', () => {
      expect(todayPositionPercent(domain, 'nonsense')).toBeNull();
    });
  });

  describe('computeTimelineTicks (AC 24.2-2/6)', () => {
    it('labels every month when the domain is short', () => {
      const domain = computeTimelineDomain([
        { spanStartDate: '2026-05-01', spanEndDate: '2026-12-01' },
      ])!;
      const ticks = computeTimelineTicks(domain);
      expect(ticks.map((t) => t.label)).toEqual([
        'May 2026', 'Jun 2026', 'Jul 2026', 'Aug 2026',
        'Sep 2026', 'Oct 2026', 'Nov 2026', 'Dec 2026',
      ]);
    });

    it('never returns an empty tick set for a non-empty domain', () => {
      // 9–11 months inside a single year have no interior January 1: the old
      // year-only fallback returned [] and rendered a blank axis.
      for (const [start, end] of [
        ['2026-02-15', '2026-11-15'],
        ['2026-03-01', '2026-11-30'],
        ['2026-04-01', '2026-12-01'],
        ['2026-05-01', '2027-01-15'],
      ]) {
        const domain = computeTimelineDomain([{ spanStartDate: start, spanEndDate: end }])!;
        const ticks = computeTimelineTicks(domain);
        expect(ticks.length, `${start}..${end}`).toBeGreaterThan(0);
      }
    });

    it('falls back to year ticks when months would collide', () => {
      const domain = computeTimelineDomain([
        { spanStartDate: '2024-01-01', spanEndDate: '2030-12-31' },
      ])!;
      const ticks = computeTimelineTicks(domain);
      // 7 interior years fit within the 8-tick budget, so all ticks are years.
      expect(ticks.every((t) => t.kind === 'year')).toBe(true);
      expect(ticks.map((t) => t.label)).toContain('2026');
    });

    it('thins year ticks so a century-long domain does not exceed the tick budget', () => {
      const domain = computeTimelineDomain([
        { spanStartDate: '1900-01-01', spanEndDate: '2100-12-31' },
      ])!;
      const ticks = computeTimelineTicks(domain, 8);
      expect(ticks.length).toBeLessThanOrEqual(8);
      expect(ticks.every((t) => t.kind === 'year')).toBe(true);
    });

    it('steps month ticks when a multi-month domain has no interior January 1', () => {
      // 2026-02-15 -> 2026-11-15 is a 9-month domain inside one year with no
      // interior Jan 1: the year branch is empty, so the stepped-month
      // fallback must emit month ticks (not an empty axis).
      const domain = computeTimelineDomain([
        { spanStartDate: '2026-02-15', spanEndDate: '2026-11-15' },
      ])!;
      const ticks = computeTimelineTicks(domain);
      expect(ticks.length).toBeGreaterThan(0);
      expect(ticks.length).toBeLessThanOrEqual(8);
      expect(ticks.some((t) => t.kind === 'month')).toBe(true);
    });

    it('never throws for a year under 1000', () => {
      const domain = computeTimelineDomain([
        { spanStartDate: '0001-01-01', spanEndDate: '0002-02-02' },
      ])!;
      expect(() => computeTimelineTicks(domain)).not.toThrow();
      expect(computeTimelineTicks(domain).length).toBeGreaterThan(0);
    });
  });

  describe('computeTimelineBar edge clamping (AC 24.2-2)', () => {
    it('keeps the minimum visible width when a one-day span sits at the domain end', () => {
      const domain = computeTimelineDomain([
        { spanStartDate: '2020-01-01', spanEndDate: '2030-12-31' },
      ])!;
      const lastDay = classifyTimelineSpan({ spanStartDate: '2030-12-31', spanEndDate: '2030-12-31' });
      const bar = computeTimelineBar(lastDay, domain)!;
      expect(bar.widthPercent).toBeGreaterThanOrEqual(MIN_BAR_WIDTH_PERCENT - 0.01);
      expect(bar.leftPercent + bar.widthPercent).toBeLessThanOrEqual(100.01);
    });
  });
});
