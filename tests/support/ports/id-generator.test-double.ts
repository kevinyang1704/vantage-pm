/**
 * Deterministic, sequential UUIDv7 generator test double.
 *
 * Produces time-ordered UUIDv7 values in a deterministic sequence for tests
 * that need repeatable, valid IDs. Reuses the spike's existing `assertUuidV7()`
 * validator for shape checking.
 *
 * Usage:
 *   const gen = createDeterministicIdGenerator('0198a000-0000-7000-8000-000000000001');
 *   gen.next(); // '0198a000-0000-7000-8000-000000000001'
 *   gen.next(); // '0198a000-0000-7000-8000-000000000002'
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export type IdGeneratorTestDouble = Readonly<{
  /** Return the next deterministic UUIDv7 in the sequence. */
  next(): string;
  /** Return the current counter value without advancing. */
  peek(): string;
  /** Reset the counter to its seed value. */
  reset(): void;
}>;

/**
 * Create a deterministic ID generator seeded from a UUIDv7.
 *
 * The seed UUID must be a valid UUIDv7. The generator extracts the timestamp
 * portion and increments the counter portion to produce sequential, valid
 * UUIDv7 values.
 */
export function createDeterministicIdGenerator(seed: string): IdGeneratorTestDouble {
  assertUuidV7(seed, 'seed');

  // Parse the seed UUID into its components
  const parts = seed.split('-');
  // UUIDv7 layout: tttttttt-tttt-7ttt-vttt-tttttttttttt
  // We increment the last 12 hex digits (the random/node portion)
  const prefix = parts.slice(0, 4).join('-'); // tttttttt-tttt-7ttt-vttt
  let counter = Number.parseInt(parts[4]!, 16);

  const initialCounter = counter;

  function formatCounter(value: number): string {
    return value.toString(16).padStart(12, '0');
  }

  return Object.freeze({
    next(): string {
      const result = `${prefix}-${formatCounter(counter)}`;
      counter += 1;
      return result;
    },
    peek(): string {
      return `${prefix}-${formatCounter(counter)}`;
    },
    reset(): void {
      counter = initialCounter;
    },
  });
}
