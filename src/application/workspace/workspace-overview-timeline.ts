/**
 * Workspace overview timeline geometry (Story 24.2, DO-FR4/DO-FR5, DO-UX3).
 *
 * Pure, date-only calendar arithmetic over one shared domain per project.
 * Every theme lane is positioned against the same min/max day domain, so
 * bars compare directly instead of each stretching to its own width.
 *
 * Conventions (matching `src/domain/tree/schedule.policy.ts`):
 *   - ISO `YYYY-MM-DD` plain calendar dates via Temporal.PlainDate.
 *   - Inclusive end dates: a span's geometry ends at `endDate + 1 day`.
 *   - No JavaScript `Date`, so UTC conversion and DST cannot shift geometry.
 */

import { Temporal } from 'temporal-polyfill';
import { isValidIsoDate } from '../../domain/tree/schedule.policy';

export interface TimelineDomain {
  /** First day of the earliest span's month, ISO YYYY-MM-DD. */
  readonly start: string;
  /** First day of the month after the latest end (exclusive end), ISO YYYY-MM-DD. */
  readonly endExclusive: string;
  /** Inclusive last day = endExclusive - 1 day, ISO YYYY-MM-DD. */
  readonly endInclusive: string;
  /** Total calendar days in [start, endExclusive). */
  readonly totalDays: number;
}

export interface TimelineSpanInput {
  readonly spanStartDate: string | null;
  readonly spanEndDate: string | null;
}

export type TimelineScheduleState =
  | Readonly<{ kind: 'scheduled'; startDate: string; endDate: string }>
  | Readonly<{ kind: 'not_scheduled' }>
  | Readonly<{ kind: 'incomplete' }>
  | Readonly<{ kind: 'invalid' }>;

export interface TimelineBarGeometry {
  /** Left offset as a percentage of the domain, 0..100. */
  readonly leftPercent: number;
  /** Width as a percentage of the domain, > 0. */
  readonly widthPercent: number;
}

/**
 * Classify a theme's normalized span into a truthful schedule state
 * (AC 24.2-3). A complete, ordered pair is `scheduled`; two absent dates are
 * `not_scheduled`; exactly one side is `incomplete`; a reversed or malformed
 * pair is `invalid`. The result carries no invented bar.
 */
export function classifyTimelineSpan(span: TimelineSpanInput): TimelineScheduleState {
  const start = span.spanStartDate;
  const end = span.spanEndDate;

  const startAbsent = start === null || start === '';
  const endAbsent = end === null || end === '';

  if (startAbsent && endAbsent) {
    return Object.freeze({ kind: 'not_scheduled' });
  }
  if (startAbsent || endAbsent) {
    return Object.freeze({ kind: 'incomplete' });
  }
  if (!isValidIsoDate(start) || !isValidIsoDate(end)) {
    return Object.freeze({ kind: 'invalid' });
  }
  if (Temporal.PlainDate.compare(
    Temporal.PlainDate.from(start),
    Temporal.PlainDate.from(end),
  ) > 0) {
    return Object.freeze({ kind: 'invalid' });
  }
  return Object.freeze({ kind: 'scheduled', startDate: start, endDate: end });
}

/**
 * Build one shared project domain from every theme span. Returns `null` when
 * no theme has a complete valid span — the caller then renders no misleading
 * empty calendar axis (AC 24.2-3). The domain starts at the first day of the
 * earliest span's month and ends at the first day of the month after the
 * latest inclusive end.
 */
export function computeTimelineDomain(
  spans: readonly TimelineSpanInput[],
): TimelineDomain | null {
  let minStart: Temporal.PlainDate | null = null;
  let maxEnd: Temporal.PlainDate | null = null;

  for (const span of spans) {
    const state = classifyTimelineSpan(span);
    if (state.kind !== 'scheduled') continue;
    const start = Temporal.PlainDate.from(state.startDate);
    const end = Temporal.PlainDate.from(state.endDate);
    if (!minStart || Temporal.PlainDate.compare(start, minStart) < 0) minStart = start;
    if (!maxEnd || Temporal.PlainDate.compare(end, maxEnd) > 0) maxEnd = end;
  }

  if (!minStart || !maxEnd) return null;

  const start = minStart.with({ day: 1 });
  // First day of the month AFTER the latest end: exclusive end covers the
  // inclusive end date via the +1-day rule.
  const endExclusive = maxEnd.with({ day: 1 }).add({ months: 1 });
  const endInclusive = endExclusive.subtract({ days: 1 });
  const totalDays = start.until(endExclusive, { largestUnit: 'day' }).days;

  return Object.freeze({
    start: start.toString(),
    endExclusive: endExclusive.toString(),
    endInclusive: endInclusive.toString(),
    totalDays,
  });
}

/**
 * Map one scheduled span onto the shared domain. `endDate` is inclusive, so
 * geometry ends one day later. A subpixel interval (e.g. a one-day span on a
 * multi-year domain) is given an accessible minimum visible width without
 * changing its labeled dates (AC 24.2-2).
 */
export function computeTimelineBar(
  state: TimelineScheduleState,
  domain: TimelineDomain,
  minVisiblePercent = MIN_BAR_WIDTH_PERCENT,
): TimelineBarGeometry | null {
  if (state.kind !== 'scheduled') return null;

  const minVisible = Math.min(100, Math.max(0, minVisiblePercent));
  const start = Temporal.PlainDate.from(domain.start);
  const endExclusive = Temporal.PlainDate.from(domain.endExclusive);
  const spanStart = Temporal.PlainDate.from(state.startDate);
  const spanEndExclusive = Temporal.PlainDate.from(state.endDate).add({ days: 1 });

  // Clamp to the domain so a span sharing the domain bounds lands at 0..100.
  const clampedStart = Temporal.PlainDate.compare(spanStart, start) < 0 ? start : spanStart;
  const clampedEnd =
    Temporal.PlainDate.compare(spanEndExclusive, endExclusive) > 0 ? endExclusive : spanEndExclusive;

  const totalDays = domain.totalDays > 0 ? domain.totalDays : 1;
  const startOffsetDays = Math.max(0, start.until(clampedStart, { largestUnit: 'day' }).days);
  const endOffsetDays = Math.max(
    startOffsetDays,
    start.until(clampedEnd, { largestUnit: 'day' }).days,
  );

  const rawLeftPercent = clampPercent((startOffsetDays / totalDays) * 100);
  const rawWidth = ((endOffsetDays - startOffsetDays) / totalDays) * 100;
  // A subpixel interval (e.g. a one-day span on a multi-year domain) keeps an
  // accessible minimum visible width. When the span sits against the domain's
  // right edge, nudge the left edge so the floor still fits on the track —
  // this moves the marker, never its labeled dates (AC 24.2-2).
  const leftPercent = Math.min(rawLeftPercent, 100 - minVisible);
  const widthPercent = Math.min(
    100 - leftPercent,
    Math.max(minVisible, rawWidth),
  );

  return Object.freeze({
    leftPercent: round2(leftPercent),
    widthPercent: round2(widthPercent),
  });
}

/**
 * Whether the injected local calendar date falls inside the domain
 * (AC 24.2-4). Never expands the domain — an out-of-range date yields null.
 */
export function todayPositionPercent(
  domain: TimelineDomain,
  todayIso: string,
): number | null {
  if (!isValidIsoDate(todayIso)) return null;
  const start = Temporal.PlainDate.from(domain.start);
  const endExclusive = Temporal.PlainDate.from(domain.endExclusive);
  const today = Temporal.PlainDate.from(todayIso);
  if (Temporal.PlainDate.compare(today, start) < 0) return null;
  if (Temporal.PlainDate.compare(today, endExclusive) >= 0) return null;
  const totalDays = domain.totalDays > 0 ? domain.totalDays : 1;
  const offsetDays = start.until(today, { largestUnit: 'day' }).days;
  return round2(clampPercent((offsetDays / totalDays) * 100));
}

export interface TimelineTick {
  readonly label: string;
  readonly leftPercent: number;
  readonly kind: 'month' | 'year';
}

/**
 * Adaptive axis ticks across the domain. Labels every month when they fit;
 * otherwise labels year boundaries, stepping to every Nth month when a domain
 * has no interior January 1 (e.g. Feb–Nov 2026). Never returns an empty set
 * for a non-empty domain (AC 24.2-2, AC 24.2-6).
 */
export function computeTimelineTicks(
  domain: TimelineDomain,
  maxTicks = 8,
): readonly TimelineTick[] {
  const start = Temporal.PlainDate.from(domain.start);
  const endExclusive = Temporal.PlainDate.from(domain.endExclusive);
  const totalDays = domain.totalDays > 0 ? domain.totalDays : 1;
  const months =
    (endExclusive.year - start.year) * 12 + (endExclusive.month - start.month);
  const monthCount = Math.max(1, months);

  const monthTick = (date: Temporal.PlainDate): TimelineTick =>
    Object.freeze({
      label: `${MONTH_ABBR[date.month - 1]} ${date.year}`,
      leftPercent: round2(clampPercent((start.until(date, { largestUnit: 'day' }).days / totalDays) * 100)),
      kind: date.month === 1 ? 'year' : 'month',
    });

  if (monthCount <= maxTicks) {
    const ticks: TimelineTick[] = [];
    for (let i = 0; i < monthCount; i += 1) {
      ticks.push(monthTick(start.add({ months: i })));
    }
    return Object.freeze(ticks);
  }

  // Too many months to label individually. Prefer interior year boundaries;
  // thin them to `maxTicks` when a multi-year domain would otherwise emit one
  // label per year. If the domain has no interior January 1 (a single-year
  // span of 9–12 months), step through the months so the axis is never blank
  // (AC 24.2-2).
  const yearTicks: TimelineTick[] = [];
  for (let year = start.year; year <= endExclusive.year; year += 1) {
    const date = Temporal.PlainDate.from({ year, month: 1, day: 1 });
    if (Temporal.PlainDate.compare(date, start) < 0) continue;
    if (Temporal.PlainDate.compare(date, endExclusive) >= 0) continue;
    yearTicks.push(
      Object.freeze({
        label: String(year),
        leftPercent: round2(clampPercent((start.until(date, { largestUnit: 'day' }).days / totalDays) * 100)),
        kind: 'year',
      }),
    );
  }

  if (yearTicks.length > 0) {
    if (yearTicks.length <= maxTicks) return Object.freeze(yearTicks);
    const yearStep = Math.ceil(yearTicks.length / maxTicks);
    return Object.freeze(yearTicks.filter((_, i) => i % yearStep === 0));
  }

  const step = Math.max(1, Math.ceil(monthCount / maxTicks));
  const stepped: TimelineTick[] = [];
  for (let i = 0; i < monthCount; i += step) {
    stepped.push(monthTick(start.add({ months: i })));
  }
  return Object.freeze(stepped);
}

export const MIN_BAR_WIDTH_PERCENT = 1.5;

const MONTH_ABBR = Object.freeze([
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]);

function clampPercent(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
