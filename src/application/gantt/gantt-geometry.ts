/**
 * Gantt date-to-unit geometry (Story 8.3 Task 1, AD-12).
 *
 * The single shared formula that governs both the on-screen Gantt preview
 * (GanttTimelineCanvas) and the exported PPTX slide. Parity holds by
 * construction because both surfaces call this one extracted function with a
 * different unit (pixels vs inches), never because two independently-written
 * formulas happen to agree.
 *
 * Behavior preserved exactly from the original private closure:
 *   - clamp date to [0, totalUnits]
 *   - diff = (date - windowStart) in days
 *   - return isEnd ? diff * unitsPerDay + unitsPerDay : diff * unitsPerDay
 *   - the `isEnd` offset-by-one-unit gives a bar its final-day width.
 */

import { Temporal } from 'temporal-polyfill';

export interface DateToUnitConfig {
  readonly windowStart: string; // ISO YYYY-MM-DD
  readonly windowEnd: string;   // ISO YYYY-MM-DD
  readonly unitsPerDay: number;
  readonly totalUnits: number;
}

/**
 * Create a `dateToX`-style unit mapper bound to a fixed window and unit scale.
 */
export function createDateToUnit(
  config: DateToUnitConfig,
): (dateStr: string, isEnd?: boolean) => number {
  const startPlain = Temporal.PlainDate.from(config.windowStart);
  const endPlain = Temporal.PlainDate.from(config.windowEnd);

  return (dateStr: string, isEnd = false): number => {
    try {
      const p = Temporal.PlainDate.from(dateStr);
      if (Temporal.PlainDate.compare(p, startPlain) < 0) return 0;
      if (Temporal.PlainDate.compare(p, endPlain) > 0) return config.totalUnits;
      const diff = startPlain.until(p, { largestUnit: 'day' }).days;
      return isEnd
        ? diff * config.unitsPerDay + config.unitsPerDay
        : diff * config.unitsPerDay;
    } catch {
      return 0;
    }
  };
}
