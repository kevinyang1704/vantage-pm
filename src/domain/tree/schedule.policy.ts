/**
 * Schedule policy (Story 3.4, AD-8).
 *
 * Deterministic schedule calculations using Temporal.PlainDate.
 * Zero JavaScript `Date` instances.
 * Uses inclusive calendar days: duration = (endDate - startDate in days) + 1.
 */

import { Temporal } from 'temporal-polyfill';
import type { ScheduleSourceMode } from './node.entity';

export interface DerivedSchedule {
  readonly startDate: string | null; // ISO YYYY-MM-DD
  readonly endDate: string | null;   // ISO YYYY-MM-DD
  readonly durationDays: number | null;
  readonly isValid: boolean;
  readonly errorMessage: string | null;
}

/**
 * Validates ISO date string YYYY-MM-DD using Temporal.PlainDate.
 */
export function isValidIsoDate(dateStr: string | null | undefined): boolean {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  try {
    Temporal.PlainDate.from(dateStr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derives the complete schedule triple (start, end, duration) from any two values.
 */
export function deriveNodeSchedule(params: {
  startDate: string | null;
  endDate: string | null;
  durationDays: number | null;
  sourceMode?: ScheduleSourceMode | null;
}): DerivedSchedule {
  const { startDate, endDate, durationDays, sourceMode } = params;

  if (!startDate && !endDate && (!durationDays || durationDays <= 0)) {
    return Object.freeze({
      startDate: null,
      endDate: null,
      durationDays: null,
      isValid: true,
      errorMessage: null,
    });
  }

  // 1. Start and End mode
  if (startDate && endDate && (sourceMode === 'start_end' || (!durationDays && sourceMode !== 'start_duration' && sourceMode !== 'end_duration'))) {
    if (!isValidIsoDate(startDate)) {
      return Object.freeze({ startDate, endDate, durationDays, isValid: false, errorMessage: 'Invalid start date format (expected YYYY-MM-DD)' });
    }
    if (!isValidIsoDate(endDate)) {
      return Object.freeze({ startDate, endDate, durationDays, isValid: false, errorMessage: 'Invalid end date format (expected YYYY-MM-DD)' });
    }

    const start = Temporal.PlainDate.from(startDate);
    const end = Temporal.PlainDate.from(endDate);

    if (Temporal.PlainDate.compare(start, end) > 0) {
      return Object.freeze({ startDate, endDate, durationDays, isValid: false, errorMessage: 'Start date cannot be after end date' });
    }

    const diffDays = start.until(end, { largestUnit: 'day' }).days;
    const computedDuration = diffDays + 1; // Inclusive

    return Object.freeze({
      startDate,
      endDate,
      durationDays: computedDuration,
      isValid: true,
      errorMessage: null,
    });
  }

  // 2. Start and Duration mode
  if (startDate && durationDays && durationDays > 0 && (sourceMode === 'start_duration' || !endDate)) {
    if (!isValidIsoDate(startDate)) {
      return Object.freeze({ startDate, endDate, durationDays, isValid: false, errorMessage: 'Invalid start date format' });
    }

    const start = Temporal.PlainDate.from(startDate);
    const end = start.add({ days: durationDays - 1 });
    const computedEnd = end.toString();

    return Object.freeze({
      startDate,
      endDate: computedEnd,
      durationDays,
      isValid: true,
      errorMessage: null,
    });
  }

  // 3. End and Duration mode
  if (endDate && durationDays && durationDays > 0 && (sourceMode === 'end_duration' || !startDate)) {
    if (!isValidIsoDate(endDate)) {
      return Object.freeze({ startDate, endDate, durationDays, isValid: false, errorMessage: 'Invalid end date format' });
    }

    const end = Temporal.PlainDate.from(endDate);
    const start = end.subtract({ days: durationDays - 1 });
    const computedStart = start.toString();

    return Object.freeze({
      startDate: computedStart,
      endDate,
      durationDays,
      isValid: true,
      errorMessage: null,
    });
  }

  // Partial cases (only start or only end)
  if (startDate && !endDate && !durationDays) {
    if (!isValidIsoDate(startDate)) {
      return Object.freeze({ startDate, endDate, durationDays, isValid: false, errorMessage: 'Invalid start date format' });
    }
    return Object.freeze({ startDate, endDate: null, durationDays: null, isValid: true, errorMessage: null });
  }

  if (endDate && !startDate && !durationDays) {
    if (!isValidIsoDate(endDate)) {
      return Object.freeze({ startDate, endDate, durationDays, isValid: false, errorMessage: 'Invalid end date format' });
    }
    return Object.freeze({ startDate: null, endDate, durationDays: null, isValid: true, errorMessage: null });
  }

  return Object.freeze({
    startDate,
    endDate,
    durationDays,
    isValid: true,
    errorMessage: null,
  });
}

/**
 * Derives parent ancestor span from all dated descendants.
 */
export function deriveAncestorSpan(
  descendants: readonly { startDate: string | null; endDate: string | null }[],
): { startDate: string | null; endDate: string | null; durationDays: number | null } {
  let minStart: Temporal.PlainDate | null = null;
  let maxEnd: Temporal.PlainDate | null = null;

  for (const d of descendants) {
    if (d.startDate && isValidIsoDate(d.startDate)) {
      const p = Temporal.PlainDate.from(d.startDate);
      if (!minStart || Temporal.PlainDate.compare(p, minStart) < 0) {
        minStart = p;
      }
    }
    if (d.endDate && isValidIsoDate(d.endDate)) {
      const p = Temporal.PlainDate.from(d.endDate);
      if (!maxEnd || Temporal.PlainDate.compare(p, maxEnd) > 0) {
        maxEnd = p;
      }
    }
  }

  if (!minStart || !maxEnd) {
    return Object.freeze({
      startDate: minStart ? minStart.toString() : null,
      endDate: maxEnd ? maxEnd.toString() : null,
      durationDays: null,
    });
  }

  if (Temporal.PlainDate.compare(minStart, maxEnd) > 0) {
    return Object.freeze({
      startDate: minStart.toString(),
      endDate: maxEnd.toString(),
      durationDays: null,
    });
  }

  const durationDays = minStart.until(maxEnd, { largestUnit: 'day' }).days + 1;

  return Object.freeze({
    startDate: minStart.toString(),
    endDate: maxEnd.toString(),
    durationDays,
  });
}
