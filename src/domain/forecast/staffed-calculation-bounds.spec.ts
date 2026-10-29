/**
 * Exact staffed arithmetic at the safe-integer boundary and bounded compact
 * event generation (Story 22.11, AC 22.11-1..6; review R5, R6).
 *
 * Everything here drives the production domain functions: `calculateForecast`
 * for whole results and `calculateStaffedAllocation` for event construction.
 *
 * R5 (reproduced at 0522d6e):
 * 1. C=10^14, one person of weight 100, one point: the item rate was formed as
 *    `C * assignedWeight` in floating point (10^16, unsafe) BEFORE reduction,
 *    so a representable rate 10^14/1 and duration 1/10^14 became `overflow`.
 * 2. C=10^10, weights [1, 9999999999], 10^6 points on the first person, one-day
 *    cadence: the idle-capacity product C*T = 10^16 was computed outside the
 *    overflow guard and rejected the whole calculation with INVALID_RATIO.
 *
 * R6: each distinct finish in a parallel block rescanned every member (dedupe,
 * active set, finishing set) and the whole roster, and person detail was built
 * for every event even when nobody asked for it.
 */

import { describe, expect, it } from 'vitest';
import { STAFFED_FORECAST_POLICY_VERSION } from './forecast-plan.entity';
import type { ForecastInputs } from './forecast-result';
import { calculateForecast } from './whole-set.policy';
import { calculateStaffedAllocation } from './staffed-calculation.policy';
import { formatRatio } from './forecast-canonical';

const PROJECT_ID = '0191eb58-0000-7000-8000-000000000000';

function personId(n: number): string {
  return `0191eb58-0001-7000-8000-${n.toString(16).padStart(12, '0')}`;
}
function itemId(n: number): string {
  return `0191eb58-0010-7000-8000-${n.toString(16).padStart(12, '0')}`;
}

function staffed(overrides: Partial<ForecastInputs>): ForecastInputs {
  return {
    projectId: PROJECT_ID,
    projectRevision: 1,
    policyVersion: STAFFED_FORECAST_POLICY_VERSION,
    selectedFeatureIds: [itemId(1)],
    estimates: { [itemId(1)]: 1 },
    pointsPerSprint: 10,
    sprintLengthDays: 14,
    startSprintOrdinal: 1,
    startDate: '2026-09-07',
    parallelGroups: [],
    blockedFeatureIds: [],
    roster: [{ id: personId(1), name: 'Ada', weightUnits: 100 }],
    assignments: { [itemId(1)]: [personId(1)] },
    ...overrides,
  };
}

// ── R5: exact arithmetic ────────────────────────────────────────────────

describe('AC 22.11-1: a representable reduced result is not a false overflow', () => {
  it('C=10^14, weight 100, one point -> rate 10^14/1, duration 1/10^14, ready', async () => {
    const result = await calculateForecast(staffed({ pointsPerSprint: 100_000_000_000_000 }));
    expect(result.state).toBe('ready');
    const timeline = result.allocation!.timelines[0];
    expect(formatRatio(timeline.itemRate!)).toBe('100000000000000/1');
    expect(formatRatio(timeline.duration!)).toBe('1/100000000000000');
    expect(formatRatio(result.arithmetic!.elapsedStaffingDuration!)).toBe('1/100000000000000');
    expect(formatRatio(result.arithmetic!.idleCapacityPoints!)).toBe('0/1');
    expect(result.arithmetic!.occupiedSprints).toBe(1);
    expect(result.arithmetic!.completionSprint).toBe(1);
    expect(result.arithmetic!.completionDate).toBe('2026-09-20');
  });
});

describe('AC 22.11-2: unrepresentable idle arithmetic is a typed overflow', () => {
  it('C=10^10, weights [1, 9999999999], 10^6 points on the first person, one-day cadence', async () => {
    const inputs = staffed({
      pointsPerSprint: 10_000_000_000,
      sprintLengthDays: 1,
      roster: [
        { id: personId(1), name: 'Ada', weightUnits: 1 },
        { id: personId(2), name: 'Ben', weightUnits: 9_999_999_999 },
      ],
      estimates: { [itemId(1)]: 1_000_000 },
    });
    // Must resolve — a rejection here is what reached analysis at 0522d6e.
    const result = await calculateForecast(inputs);
    expect(result.state).toBe('overflow');
    expect(result.arithmetic).toBeNull();
    expect(result.allocation).toBeNull();
    expect(result.issues.map((i) => i.code)).toContain('OVERFLOW');
  });

  // Review L6 (reproduced against production): the exact expression C*T - P can
  // be representable even when the intermediate C*T is not. With C=P=2^52, two
  // equal-weight people and one item assigned to the first, T = 2 and the exact
  // idle is C*T - P = 2^52, safely representable; but C*T = 2^53 was range-
  // checked first and wrongly rejected the whole result.
  it('C=P=2^52 with one assigned person resolves, not overflow', async () => {
    const C = 4_503_599_627_370_496; // 2^52
    const inputs = staffed({
      pointsPerSprint: C,
      sprintLengthDays: 1,
      estimates: { [itemId(1)]: C },
      roster: [
        { id: personId(1), name: 'Ada', weightUnits: 100 },
        { id: personId(2), name: 'Ben', weightUnits: 100 },
      ],
      assignments: { [itemId(1)]: [personId(1)] },
    });
    const result = await calculateForecast(inputs);
    expect(result.state).toBe('ready');
    expect(formatRatio(result.arithmetic!.elapsedStaffingDuration!)).toBe('2/1');
    expect(formatRatio(result.arithmetic!.idleCapacityPoints!)).toBe(`${C}/1`);
    expect(result.arithmetic!.completionSprint).toBe(2);
  });
});

describe('AC 22.11-3: every unsupported bound resolves to the same typed overflow', () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  const cases: readonly [string, Partial<ForecastInputs>][] = [
    [
      // 2C/3 with C = 2^53 - 1 (not divisible by 3): the reduced numerator is unsafe.
      'item rate whose reduced numerator is unsafe',
      {
        pointsPerSprint: MAX,
        roster: [
          { id: personId(1), name: 'Ada', weightUnits: 1 },
          { id: personId(2), name: 'Ben', weightUnits: 2 },
        ],
        assignments: { [itemId(1)]: [personId(2)] },
      },
    ],
    [
      'completion sprint ordinal beyond the safe range',
      { startSprintOrdinal: MAX, estimates: { [itemId(1)]: 20 } },
    ],
    [
      'completion date beyond the calendar range',
      { pointsPerSprint: 1, sprintLengthDays: 1_000_000, estimates: { [itemId(1)]: 1_000_000 } },
    ],
  ];

  it.each(cases)('%s', async (_label, overrides) => {
    const result = await calculateForecast(staffed(overrides));
    expect(result.state).toBe('overflow');
    expect(result.arithmetic).toBeNull();
    expect(result.allocation).toBeNull();
    // No NaN / Infinity / rounded substitute leaks into the serialized result.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/NaN|Infinity|null\/|e\+/);
  });
});

// ── R6: bounded compact events ──────────────────────────────────────────

/**
 * N parallel items, item k staffed by its own person k with k points, so every
 * item finishes at a distinct offset (finish_k = k * W / (C * w)).
 */
function distinctFinishInputs(n: number): ForecastInputs {
  const ids = Array.from({ length: n }, (_, i) => itemId(i + 1));
  const estimates: Record<string, number> = {};
  const assignments: Record<string, readonly string[]> = {};
  ids.forEach((id, i) => {
    estimates[id] = i + 1;
    assignments[id] = [personId(i + 1)];
  });
  return staffed({
    pointsPerSprint: n,
    selectedFeatureIds: ids,
    estimates,
    parallelGroups: [{ featureIds: ids }],
    roster: ids.map((_, i) => ({ id: personId(i + 1), name: `P${i + 1}`, weightUnits: 100 })),
    assignments,
  });
}

/** Counts every indexed read of an array, including iteration and filter. */
function countingArray<T>(items: readonly T[]): { array: readonly T[]; reads: () => number } {
  let reads = 0;
  const array = new Proxy([...items], {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  return { array, reads: () => reads };
}

function allocate(inputs: ForecastInputs, visibleEventIndexes?: readonly number[]) {
  return calculateStaffedAllocation(
    inputs,
    inputs.pointsPerSprint!,
    inputs.sprintLengthDays!,
    inputs.startSprintOrdinal!,
    inputs.startDate!,
    visibleEventIndexes ? { visibleEventIndexes } : {},
  );
}

describe('AC 22.11-4: event construction does not rescan the roster per event', () => {
  it('reads each roster entry a bounded number of times, independent of the event count', () => {
    const n = 400;
    const base = distinctFinishInputs(n);
    const roster = countingArray(base.roster!);
    const result = allocate({ ...base, roster: roster.array });

    expect(result.events).toHaveLength(n);
    // Linear in R: a per-event roster scan would read ~n * n = 160,000 entries.
    expect(roster.reads()).toBeLessThanOrEqual(2 * n);
  });

  it('a sequence of singletons also avoids per-event roster scans', () => {
    const n = 400;
    const base = distinctFinishInputs(n);
    const roster = countingArray(base.roster!);
    const result = allocate({ ...base, parallelGroups: [], roster: roster.array });

    expect(result.events).toHaveLength(n);
    expect(roster.reads()).toBeLessThanOrEqual(2 * n);
  });
});

describe('AC 22.11-5: person detail only for requested events', () => {
  it('default visibility materializes no identity arrays on any event', () => {
    const result = allocate(distinctFinishInputs(50));
    for (const event of result.events) {
      expect(event.finishedFeatureIds).toBeUndefined();
      expect(event.finishedPersonIds).toBeUndefined();
      expect(event.idlePersonIds).toBeUndefined();
    }
  });

  it('requested events carry exactly the identities a brute-force oracle derives', () => {
    const n = 50;
    const inputs = distinctFinishInputs(n);
    const requested = [0, 17, n - 1];
    const result = allocate(inputs, requested);

    result.events.forEach((event, index) => {
      if (!requested.includes(index)) {
        expect(event.idlePersonIds).toBeUndefined();
        return;
      }
      // Event k ends when item k+1 finishes; items 1..k finished earlier, so
      // their people are idle for this whole interval.
      const finishing = index + 1;
      expect(event.finishedFeatureIds).toEqual([itemId(finishing)]);
      expect(event.finishedPersonIds).toEqual([personId(finishing)]);
      expect(event.idlePersonIds).toEqual(Array.from({ length: index }, (_, i) => personId(i + 1)).sort());
    });
  });

  it('requesting detail never changes an aggregate', () => {
    const inputs = distinctFinishInputs(50);
    const compact = allocate(inputs);
    const detailed = allocate(inputs, Array.from({ length: 50 }, (_, i) => i));
    const aggregate = (r: ReturnType<typeof allocate>) =>
      r.events.map(({ eventIndex, startOffset, finishOffset, activeCount, shareRate, activeRate, idleRate, parallelGroupIndex }) => ({
        eventIndex, startOffset, finishOffset, activeCount, shareRate, activeRate, idleRate, parallelGroupIndex,
      }));
    expect(aggregate(detailed)).toEqual(aggregate(compact));
    expect(detailed.timelines).toEqual(compact.timelines);
    expect(detailed.totalStaffingDuration).toEqual(compact.totalStaffingDuration);
  });

  it('simultaneous finishes share one event, in scope priority order', () => {
    const a = itemId(1);
    const b = itemId(2);
    const c = itemId(3);
    const inputs = staffed({
      pointsPerSprint: 30,
      selectedFeatureIds: [c, a, b],
      estimates: { [a]: 10, [b]: 10, [c]: 20 },
      parallelGroups: [{ featureIds: [c, a, b] }],
      roster: [1, 2, 3].map((n) => ({ id: personId(n), name: `P${n}`, weightUnits: 100 })),
      assignments: { [a]: [personId(1)], [b]: [personId(2)], [c]: [personId(3)] },
    });
    const result = allocate(inputs, [0, 1]);
    expect(result.events).toHaveLength(2);
    expect(result.events[0].finishedFeatureIds).toEqual([a, b]);
    expect(result.events[0].activeCount).toBe(3);
    expect(formatRatio(result.events[0].activeRate!)).toBe('30/1');
    expect(result.events[1].finishedFeatureIds).toEqual([c]);
    expect(result.events[1].activeCount).toBe(1);
    expect(formatRatio(result.events[1].idleRate!)).toBe('20/1');
    expect(result.events[1].idlePersonIds).toEqual([personId(1), personId(2)]);
  });
});
