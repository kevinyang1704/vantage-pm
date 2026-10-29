/**
 * Deterministic, injectable clock test double.
 *
 * Provides a fixed or steppable Temporal-compatible clock for tests that need
 * repeatable time values. Conforms to the port shape AD-8 defines for the
 * clock injection point (Consistency Conventions — Determinism row).
 *
 * Two modes:
 * - `fixed(instant)`: always returns the same instant
 * - `steppable(startInstant, stepMs)`: advances by `stepMs` on each call
 *
 * Usage:
 *   const clock = createFixedClock('2026-01-01T00:00:00Z');
 *   clock.now(); // always the same instant
 *
 *   const clock = createSteppableClock('2026-01-01T00:00:00Z', 1000);
 *   clock.now(); // 2026-01-01T00:00:00Z
 *   clock.now(); // 2026-01-01T00:00:01Z
 */

import { Temporal } from 'temporal-polyfill';

export type ClockTestDouble = Readonly<{
  /** Return the current instant according to this clock. */
  now(): Temporal.Instant;
  /** Return the current instant as an ISO 8601 string. */
  nowISO(): string;
  /** Reset a steppable clock to its start instant. */
  reset(): void;
}>;

/**
 * Create a fixed clock that always returns the same instant.
 */
export function createFixedClock(isoInstant: string): ClockTestDouble {
  const instant = Temporal.Instant.from(isoInstant);
  return Object.freeze({
    now(): Temporal.Instant {
      return instant;
    },
    nowISO(): string {
      return instant.toString();
    },
    reset(): void {
      // Fixed clock — no-op
    },
  });
}

/**
 * Create a steppable clock that advances by `stepMs` milliseconds on each call.
 */
export function createSteppableClock(
  isoStart: string,
  stepMs: number,
): ClockTestDouble {
  let current = Temporal.Instant.from(isoStart);
  const start = current;

  return Object.freeze({
    now(): Temporal.Instant {
      const result = current;
      current = current.add({ milliseconds: stepMs });
      return result;
    },
    nowISO(): string {
      const result = current.toString();
      current = current.add({ milliseconds: stepMs });
      return result;
    },
    reset(): void {
      current = start;
    },
  });
}
