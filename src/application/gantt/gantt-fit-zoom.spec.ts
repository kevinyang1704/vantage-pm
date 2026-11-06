import { describe, expect, it } from 'vitest';
import { fitGanttZoom, generateHeaderColumns, horizonGanttZoom } from './gantt-scope';

describe('fitGanttZoom (Gantt Fit control)', () => {
  it('fits a multi-year window into the viewport, zooming out past Quarter', () => {
    // 2025-05-01..2027-12-01 is 945 days: Quarter alone draws it 2,362 px wide.
    const zoom = fitGanttZoom('2025-05-01', '2027-12-01', 896);
    expect(zoom.pixelsPerDay).toBeCloseTo(896 / 945, 6);
    expect(zoom.granularity).toBe('quarter');
  });

  it('zooms in past Week for a short window', () => {
    const zoom = fitGanttZoom('2026-06-01', '2026-06-30', 900);
    expect(zoom.pixelsPerDay).toBe(30);
    expect(zoom.granularity).toBe('week');
  });

  it('labels with the finest scale no denser than the fit', () => {
    expect(fitGanttZoom('2026-01-01', '2026-06-29', 1080).granularity).toBe('month'); // 180 days at 6 px/day
    expect(fitGanttZoom('2026-01-01', '2026-06-29', 1079).granularity).toBe('quarter');
    expect(fitGanttZoom('2026-01-01', '2026-01-10', 180).granularity).toBe('week'); // 18 px/day
  });

  it('makes the header exactly as wide as the viewport, so nothing scrolls', () => {
    const zoom = fitGanttZoom('2025-05-01', '2027-12-01', 896);
    const width = generateHeaderColumns('2025-05-01', '2027-12-01', zoom.granularity, zoom.pixelsPerDay)
      .filter((column) => column.level === 'major')
      .reduce((sum, column) => sum + column.pixelWidth, 0);
    expect(width).toBeCloseTo(896, 6);
  });

  it('stays finite and positive for a one-day window or a zero-width viewport', () => {
    expect(fitGanttZoom('2026-03-03', '2026-03-03', 640).pixelsPerDay).toBe(640);
    expect(fitGanttZoom('2026-01-01', '2026-12-31', 0).pixelsPerDay).toBeGreaterThan(0);
  });

  it('preserves the active time horizon granularity when provided (e.g. week, month)', () => {
    // Multi-year window that would auto-calculate to 'quarter', but user is on 'month' or 'week':
    expect(fitGanttZoom('2025-05-01', '2027-12-01', 896, 'month').granularity).toBe('month');
    expect(fitGanttZoom('2025-05-01', '2027-12-01', 896, 'week').granularity).toBe('week');
    expect(fitGanttZoom('2025-05-01', '2027-12-01', 896, 'quarter').granularity).toBe('quarter');
  });

  it('makes the header exactly as wide as the viewport for any preserved granularity', () => {
    for (const g of ['week', 'month', 'quarter'] as const) {
      const zoom = fitGanttZoom('2025-05-01', '2027-12-01', 896, g);
      const width = generateHeaderColumns('2025-05-01', '2027-12-01', zoom.granularity, zoom.pixelsPerDay)
        .filter((column) => column.level === 'major')
        .reduce((sum, column) => sum + column.pixelWidth, 0);
      expect(width).toBeCloseTo(896, 6);
    }
  });
});


describe('fixed calendar horizons', () => {
  it.each([
    ['week', '2028-02-17', '2028-02-14', '2028-05-07', 84, 12],
    ['month', '2028-02-17', '2028-02-01', '2028-07-31', 182, 6],
    ['quarter', '2027-11-17', '2027-10-01', '2028-09-30', 366, 4],
  ] as const)('%s aligns a partial origin and pads a short project', (granularity, origin, start, end, days, count) => {
    const zoom = horizonGanttZoom(origin, origin, 840, granularity);
    expect(zoom.dateWindowStart).toBe(start);
    expect(zoom.dateWindowEnd).toBe(end);
    expect(zoom.horizonDays).toBe(days);
    expect(zoom.pixelsPerDay).toBe(840 / days);
    const columns = generateHeaderColumns(start, end, granularity, zoom.pixelsPerDay).filter(c => c.level === 'major');
    expect(columns).toHaveLength(count);
    expect(columns.reduce((sum, c) => sum + c.pixelWidth, 0)).toBeCloseTo(840, 8);
  });

  it('keeps the same ruler for a long project, independently of scroll position', () => {
    const short = horizonGanttZoom('2026-05-15', '2026-05-16', 900, 'month');
    const long = horizonGanttZoom('2026-05-15', '2030-12-31', 900, 'month');
    expect(long.pixelsPerDay).toBe(short.pixelsPerDay);
    expect(long.dateWindowEnd).toBe('2030-12-31');
    expect(long.dateWindowStart).toBe('2026-05-01');
  });

  it.each([0, -20, Number.NaN, Number.POSITIVE_INFINITY])('handles unavailable viewport width %s', width => {
    expect(horizonGanttZoom('2026-01-01', '2026-01-01', width, 'quarter').pixelsPerDay).toBe(1 / 365);
  });
});
