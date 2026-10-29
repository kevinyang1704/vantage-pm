/**
 * Gantt visible scope and header column resolution (Story 7.2, Story 7.3, AD-12, FR-44, FR-49).
 *
 * Resolves window filtering, bar clipping bounds, header columns, and exclusion counts.
 * Pure functional arithmetic using Temporal.PlainDate.
 */

import { Temporal } from 'temporal-polyfill';
import type {
  GanttProjection,
  GanttWindowScope,
  GanttVisibleScopeResult,
  GanttHeaderColumn,
  GanttGranularity,
} from '../../contracts/gantt';

export interface ResolveGanttScopeInput {
  readonly projection: GanttProjection;
  readonly window: GanttWindowScope;
  readonly collapsedNodeIds?: readonly string[] | ReadonlySet<string>;
  readonly pixelsPerDay?: number;
}

export function getPixelsPerDayForGranularity(granularity: GanttGranularity): number {
  switch (granularity) {
    case 'week':
      return 18; // ~126px per week
    case 'month':
      return 6;  // ~180px per month
    case 'quarter':
      return 2.5; // ~225px per quarter
  }
}

export interface GanttFitZoom {
  readonly pixelsPerDay: number;
  /** The scale that labels the header and snaps drags at this zoom. */
  readonly granularity: GanttGranularity;
}

/**
 * The zoom that shows the whole window in `viewportPx` without horizontal
 * scrolling (the Fit control). Unlike the three fixed scales, this zoom is
 * continuous: a multi-year project zooms out past Quarter, a short one zooms
 * in past Week. The header uses the finest scale whose fixed zoom is no
 * denser than the fit, so its labels are never more crowded than that
 * scale's own.
 */
export function fitGanttZoom(
  windowStart: string,
  windowEnd: string,
  viewportPx: number,
  granularity?: GanttGranularity,
): GanttFitZoom {
  const start = Temporal.PlainDate.from(windowStart);
  const end = Temporal.PlainDate.from(windowEnd);
  const totalDays = Math.max(1, start.until(end, { largestUnit: 'day' }).days + 1);
  const pixelsPerDay = Math.max(0.01, Math.max(1, viewportPx) / totalDays);
  const resolvedGranularity: GanttGranularity =
    granularity ??
    (pixelsPerDay >= getPixelsPerDayForGranularity('week')
      ? 'week'
      : pixelsPerDay >= getPixelsPerDayForGranularity('month')
        ? 'month'
        : 'quarter');
  return Object.freeze({ pixelsPerDay, granularity: resolvedGranularity });
}

export function generateHeaderColumns(
  windowStart: string,
  windowEnd: string,
  granularity: GanttGranularity,
  pixelsPerDay: number,
): readonly GanttHeaderColumn[] {
  const start = Temporal.PlainDate.from(windowStart);
  const end = Temporal.PlainDate.from(windowEnd);
  const columns: GanttHeaderColumn[] = [];

  if (granularity === 'month') {
    let current = start.with({ day: 1 });
    while (Temporal.PlainDate.compare(current, end) <= 0) {
      const nextMonth = current.add({ months: 1 });
      const monthEnd = nextMonth.subtract({ days: 1 });

      const visibleStart = Temporal.PlainDate.compare(current, start) < 0 ? start : current;
      const visibleEnd = Temporal.PlainDate.compare(monthEnd, end) > 0 ? end : monthEnd;
      const days = visibleStart.until(visibleEnd, { largestUnit: 'day' }).days + 1;

      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const label = `${monthNames[current.month - 1]} ${current.year}`;

      columns.push({
        id: `month-${current.year}-${current.month}`,
        label,
        startDate: visibleStart.toString(),
        endDate: visibleEnd.toString(),
        pixelWidth: days * pixelsPerDay,
        level: 'major',
      });

      // Minor week-start guides within the month (E14-FR2, E14-AR3): faint
      // sub-interval boundaries that help scanning without forming walls.
      let weekStart = visibleStart;
      while (Temporal.PlainDate.compare(weekStart.add({ days: 7 }), visibleEnd) < 0) {
        const nextWeek = weekStart.add({ days: 7 });
        columns.push({
          id: `month-${current.year}-${current.month}-week-${nextWeek.toString()}`,
          label: '',
          startDate: nextWeek.toString(),
          endDate: nextWeek.toString(),
          pixelWidth: 0,
          level: 'minor',
        });
        weekStart = nextWeek;
      }

      current = nextMonth;
    }
  } else if (granularity === 'quarter') {
    // Quarter starts at month 1, 4, 7, 10
    const startQuarterMonth = Math.floor((start.month - 1) / 3) * 3 + 1;
    let current = start.with({ month: startQuarterMonth, day: 1 });

    while (Temporal.PlainDate.compare(current, end) <= 0) {
      const nextQuarter = current.add({ months: 3 });
      const quarterEnd = nextQuarter.subtract({ days: 1 });

      const visibleStart = Temporal.PlainDate.compare(current, start) < 0 ? start : current;
      const visibleEnd = Temporal.PlainDate.compare(quarterEnd, end) > 0 ? end : quarterEnd;
      const days = visibleStart.until(visibleEnd, { largestUnit: 'day' }).days + 1;

      const qNum = Math.floor((current.month - 1) / 3) + 1;
      const label = `Q${qNum} ${current.year}`;

      columns.push({
        id: `quarter-${current.year}-Q${qNum}`,
        label,
        startDate: visibleStart.toString(),
        endDate: visibleEnd.toString(),
        pixelWidth: days * pixelsPerDay,
        level: 'major',
      });

      // Minor month-start guides within the quarter.
      let monthStart = visibleStart.with({ day: 1 });
      while (Temporal.PlainDate.compare(monthStart.add({ months: 1 }), visibleEnd) < 0) {
        const nextMonth = monthStart.add({ months: 1 });
        columns.push({
          id: `quarter-${current.year}-Q${qNum}-month-${nextMonth.toString()}`,
          label: '',
          startDate: nextMonth.toString(),
          endDate: nextMonth.toString(),
          pixelWidth: 0,
          level: 'minor',
        });
        monthStart = nextMonth;
      }

      current = nextQuarter;
    }
  } else {
    // Week granularity (7-day intervals) — the finest tier; no minor guides.
    let current = start;
    let weekIndex = 1;
    while (Temporal.PlainDate.compare(current, end) <= 0) {
      const nextWeek = current.add({ days: 7 });
      const weekEnd = nextWeek.subtract({ days: 1 });

      const visibleEnd = Temporal.PlainDate.compare(weekEnd, end) > 0 ? end : weekEnd;
      const days = current.until(visibleEnd, { largestUnit: 'day' }).days + 1;

      const label = `W${weekIndex} (${current.month}/${current.day})`;

      columns.push({
        id: `week-${current.toString()}`,
        label,
        startDate: current.toString(),
        endDate: visibleEnd.toString(),
        pixelWidth: days * pixelsPerDay,
        level: 'major',
      });

      current = nextWeek;
      weekIndex++;
    }
  }

  return Object.freeze(columns);
}

export function resolveGanttVisibleScope(input: ResolveGanttScopeInput): GanttVisibleScopeResult {
  const { projection, window, collapsedNodeIds } = input;
  const collapsedSet = new Set(collapsedNodeIds ?? []);
  const pixelsPerDay = input.pixelsPerDay ?? getPixelsPerDayForGranularity(window.granularity);

  // 1. Compute collapse exclusion set
  // When a parent is collapsed, its descendants are excluded from visible rows
  const hiddenNodeIds = new Set<string>();
  const parentIdMap = new Map<string, string | null>();

  for (const row of projection.rows) {
    parentIdMap.set(row.nodeId, row.parentId);
  }

  for (const row of projection.rows) {
    let curr = row.parentId;
    while (curr !== null) {
      if (collapsedSet.has(curr)) {
        hiddenNodeIds.add(row.nodeId);
        break;
      }
      curr = parentIdMap.get(curr) ?? null;
    }
  }

  let collapsedCount = 0;
  let outOfWindowCount = 0;

  const visibleRows = projection.rows.filter((row) => {
    // Check collapse exclusion
    if (hiddenNodeIds.has(row.nodeId)) {
      collapsedCount++;
      return false;
    }

    // Check window intersection: row interval [startDate, endDate] overlaps [dateWindowStart, dateWindowEnd]
    const intersects = row.startDate <= window.dateWindowEnd && row.endDate >= window.dateWindowStart;
    if (!intersects) {
      outOfWindowCount++;
      return false;
    }

    return true;
  });

  const headerColumns = generateHeaderColumns(
    window.dateWindowStart,
    window.dateWindowEnd,
    window.granularity,
    pixelsPerDay,
  );

  return Object.freeze({
    visibleRows: Object.freeze(visibleRows),
    totalProjectNodes: projection.totalProjectNodes,
    datedNodeCount: projection.datedNodeCount,
    undatedCount: projection.undatedCount,
    outOfWindowCount,
    collapsedCount,
    window,
    headerColumns,
  });
}
