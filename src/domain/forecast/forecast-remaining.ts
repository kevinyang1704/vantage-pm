/**
 * Forecast-from-today normalization (Epic 26, Story 26.6, FC-FR6, FC-NFR2).
 *
 * Pure helpers that turn a `today` date and items' delivery state into the two
 * inputs the calculation needs:
 *
 * - **remaining points** per item: delivered drops out entirely, an in-progress
 *   item counts `effortPoints − effortPointsDone`, an in-progress item with no
 *   recorded done counts its full points, and a not-started item counts its
 *   full points (AC 26.6-1).
 * - **as-of offset** in sprints: the exact offset of `today` from the start
 *   date, or 0 when `today` is before the start date (AC 26.6-2).
 *
 * Both are exact and deterministic; the date is injected, never read from the
 * clock (AC 26.6-4).
 */

import { Temporal } from 'temporal-polyfill';
import type { ReducedRatio } from './forecast-canonical';
import { reduceRatio } from './forecast-canonical';

export type RemainingPointsItem = Readonly<{
  id: string;
  status: 'not_started' | 'in_progress' | 'delivered';
  effortPoints: number | null;
  effortPointsDone: number | null;
}>;

/**
 * Remaining points per item. Delivered items are omitted. Returns a record
 * keyed by item ID for the included (non-delivered) items.
 */
export function remainingPoints(
  items: readonly RemainingPointsItem[],
): Readonly<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  for (const item of items) {
    if (item.status === 'delivered') continue;
    if (item.effortPoints === null) {
      out[item.id] = null;
    } else if (item.status === 'in_progress' && item.effortPointsDone !== null) {
      // 0 ≤ done ≤ points is enforced by the command; the remaining is never
      // negative here, but guard anyway so a corrupt value cannot underflow.
      out[item.id] = Math.max(item.effortPoints - item.effortPointsDone, 0);
    } else {
      out[item.id] = item.effortPoints;
    }
  }
  return Object.freeze(out);
}

/** Whole days between two ISO dates (b − a). */
function daysBetween(a: string, b: string): number {
  return Number(Temporal.PlainDate.from(a).until(Temporal.PlainDate.from(b)).total({ unit: 'days' }));
}

/**
 * True when `today` is on or after the start date, so the forecast should be
 * presented as "as of today" (a today strictly before the start date leaves
 * the forecast unchanged from the pre-26.6 behaviour, AC 26.6-2).
 */
export function isOnOrAfterStart(today: string | null | undefined, startDate: string | null): boolean {
  if (!today || !startDate) return false;
  try {
    return daysBetween(startDate, today) >= 0;
  } catch {
    return false;
  }
}

/**
 * The exact as-of offset in sprints of `today` from `startDate`, or 0 when
 * `today` is before the start date. `sprintLengthDays` must be positive.
 */
export function asOfOffset(
  today: string | null | undefined,
  startDate: string | null,
  sprintLengthDays: number | null,
): ReducedRatio {
  if (!today || !startDate || sprintLengthDays === null || sprintLengthDays <= 0) return reduceRatio(0, 1);
  try {
    const days = daysBetween(startDate, today);
    if (days <= 0) return reduceRatio(0, 1);
    return reduceRatio(days, sprintLengthDays);
  } catch {
    // A malformed injected date degrades to no offset rather than throwing.
    return reduceRatio(0, 1);
  }
}
