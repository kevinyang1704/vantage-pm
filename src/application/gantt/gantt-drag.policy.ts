/**
 * Gantt drag-and-drop & resize policy (Story 7.5, FR-48, AD-5, AD-8, AD-15, EXPERIENCE.md).
 *
 * Implements granular date snapping, duration preservation on body drag,
 * edge resizing with 1-day minimum duration, and cancellation rules.
 * Pure date calculations using Temporal.PlainDate.
 */

import { Temporal } from 'temporal-polyfill';
import type { GanttGranularity } from '../../contracts/gantt';

export type GanttDragHandle = 'body' | 'start' | 'end';

export interface GanttDragState {
  readonly active: boolean;
  readonly nodeId: string;
  readonly handle: GanttDragHandle;
  readonly initialStartDate: string;
  readonly initialEndDate: string;
  readonly initialDurationDays: number;
  readonly currentStartDate: string;
  readonly currentEndDate: string;
  readonly currentDurationDays: number;
  readonly initialPointerX: number;
  readonly currentPointerX: number;
}

export function snapDateToGranularity(dateStr: string, granularity: GanttGranularity): string {
  const p = Temporal.PlainDate.from(dateStr);
  if (granularity === 'month') {
    // Snap to 1st of current month if in first half, or 1st of next month if in second half
    if (p.day <= 15) {
      return p.with({ day: 1 }).toString();
    } else {
      return p.with({ day: 1 }).add({ months: 1 }).toString();
    }
  } else if (granularity === 'quarter') {
    // Snap to quarter start (Jan 1, Apr 1, Jul 1, Oct 1)
    const qMonth = Math.floor((p.month - 1) / 3) * 3 + 1;
    return p.with({ month: qMonth, day: 1 }).toString();
  }
  // Week granularity: snap to nearest day
  return p.toString();
}

export function computeDragDates(params: {
  handle: GanttDragHandle;
  initialStartDate: string;
  initialEndDate: string;
  deltaDays: number;
  granularity: GanttGranularity;
}): { startDate: string; endDate: string; durationDays: number } {
  const { handle, initialStartDate, initialEndDate, deltaDays, granularity } = params;

  const startPlain = Temporal.PlainDate.from(initialStartDate);
  const endPlain = Temporal.PlainDate.from(initialEndDate);
  const initialDuration = startPlain.until(endPlain, { largestUnit: 'day' }).days + 1;

  if (handle === 'body') {
    // Shift both bounds preserving duration
    const newStart = startPlain.add({ days: deltaDays });
    const newEnd = newStart.add({ days: initialDuration - 1 });

    return {
      startDate: newStart.toString(),
      endDate: newEnd.toString(),
      durationDays: initialDuration,
    };
  } else if (handle === 'start') {
    // Resize start bound
    let newStart = startPlain.add({ days: deltaDays });
    // Prevent start from exceeding end (min 1 day)
    if (Temporal.PlainDate.compare(newStart, endPlain) > 0) {
      newStart = endPlain;
    }
    const newDuration = newStart.until(endPlain, { largestUnit: 'day' }).days + 1;

    return {
      startDate: newStart.toString(),
      endDate: endPlain.toString(),
      durationDays: newDuration,
    };
  } else {
    // Resize end bound
    let newEnd = endPlain.add({ days: deltaDays });
    // Prevent end from preceding start (min 1 day)
    if (Temporal.PlainDate.compare(newEnd, startPlain) < 0) {
      newEnd = startPlain;
    }
    const newDuration = startPlain.until(newEnd, { largestUnit: 'day' }).days + 1;

    return {
      startDate: startPlain.toString(),
      endDate: newEnd.toString(),
      durationDays: newDuration,
    };
  }
}
