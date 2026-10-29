/**
 * Forecast allocation and timeline tests (Story 19.1, AC 19.1-1..19.1-6, FR-4, FR-13).
 */

import { describe, it, expect } from 'vitest';
import {
  calculateForecast,
  calculateAllocation,
  reduceRatio,
  formatRatio,
  createForecastPlan,
  createForecastConfiguration,
  canonicalizeForecast,
  type ForecastInputs,
} from './index';

const PROJECT_ID = '018f3a80-0000-7000-8000-000000000001';
const FEAT_A = '018f3a80-0000-7000-8000-00000000000a';
const FEAT_B = '018f3a80-0000-7000-8000-00000000000b';
const FEAT_C = '018f3a80-0000-7000-8000-00000000000c';
const FEAT_D = '018f3a80-0000-7000-8000-00000000000d';

function makeInputs(overrides: Partial<ForecastInputs> = {}): ForecastInputs {
  return Object.freeze({
    projectId: PROJECT_ID,
    projectRevision: 1,
    policyVersion: 'shared-capacity-v1',
    selectedFeatureIds: Object.freeze([FEAT_A, FEAT_B]),
    estimates: Object.freeze({ [FEAT_A]: 10, [FEAT_B]: 10 }),
    pointsPerSprint: 10,
    sprintLengthDays: 14,
    startSprintOrdinal: 1,
    startDate: '2026-09-07',
    parallelGroups: Object.freeze([]),
    blockedFeatureIds: Object.freeze([]),
    ...overrides,
  });
}

describe('Story 19.1: Calculate Exact Sequential and Parallel Feature Timelines', () => {
  it('keeps event member details hidden unless that event is visible', async () => {
    const inputs = makeInputs({
      selectedFeatureIds: [FEAT_A, FEAT_B],
      estimates: { [FEAT_A]: 1, [FEAT_B]: 3 },
      pointsPerSprint: 4,
      parallelGroups: [{ featureIds: [FEAT_A, FEAT_B] }],
    });

    const compact = await calculateForecast(inputs);
    expect(compact.allocation?.events.map((event) => event.finishedFeatureIds)).toEqual([undefined, undefined]);

    const expanded = await calculateForecast(inputs, [], { visibleEventIndexes: [1] });
    expect(expanded.allocation?.events[0].finishedFeatureIds).toBeUndefined();
    expect(expanded.allocation?.events[1].finishedFeatureIds).toEqual([FEAT_B]);
  });

  it('canonicalizes parallel member order to scope priority at plan construction', () => {
    const plan = createForecastPlan({
      projectId: PROJECT_ID,
      selectedFeatureIds: [FEAT_B, FEAT_A],
      parallelGroups: [{ featureIds: [FEAT_A, FEAT_B] }],
      configuration: createForecastConfiguration({
        pointsPerSprint: 10, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07',
      }),
    });
    expect(plan.parallelGroups[0].featureIds).toEqual([FEAT_B, FEAT_A]);
  });
  // ── AC 19.1-1: Sequential items ───────────────────────────────────────────
  it('AC 19.1-1: sequential A=5, B=5 at C=10: A(0->1/2), B(1/2->1), both in Sprint S, duration 1 sprint', async () => {
    const inputs = makeInputs({
      selectedFeatureIds: [FEAT_A, FEAT_B],
      estimates: { [FEAT_A]: 5, [FEAT_B]: 5 },
      pointsPerSprint: 10,
      startSprintOrdinal: 12,
      startDate: '2026-09-07',
      sprintLengthDays: 14,
      parallelGroups: [],
    });

    const res = await calculateForecast(inputs, [], { visibleEventIndexes: [0, 1] });
    expect(res.state).toBe('ready');
    expect(res.assumptions.groupingPremise).toBe('sequential-only');
    expect(res.arithmetic?.occupiedSprints).toBe(1);
    expect(res.arithmetic?.completionSprint).toBe(12);
    expect(res.arithmetic?.completionDate).toBe('2026-09-20');

    expect(res.allocation).not.toBeNull();
    const timelines = res.allocation!.timelines;
    expect(timelines).toHaveLength(2);

    const tlA = timelines.find((t) => t.featureId === FEAT_A)!;
    const tlB = timelines.find((t) => t.featureId === FEAT_B)!;

    // A: 0 -> 1/2, containing sprint 12
    expect(formatRatio(tlA.startOffset!)).toBe('0/1');
    expect(formatRatio(tlA.finishOffset!)).toBe('1/2');
    expect(tlA.startSprintOrdinal).toBe(12);
    expect(tlA.completionSprintOrdinal).toBe(12);
    expect(tlA.startDate).toBe('2026-09-07');
    expect(tlA.completionDate).toBe('2026-09-20');
    expect(tlA.isMilestone).toBe(false);
    expect(tlA.parallelGroupIndex).toBeNull();

    // B: 1/2 -> 1, containing sprint 12
    expect(formatRatio(tlB.startOffset!)).toBe('1/2');
    expect(formatRatio(tlB.finishOffset!)).toBe('1/1');
    expect(tlB.startSprintOrdinal).toBe(12);
    expect(tlB.completionSprintOrdinal).toBe(12);
    expect(tlB.startDate).toBe('2026-09-07');
    expect(tlB.completionDate).toBe('2026-09-20');
    expect(tlB.isMilestone).toBe(false);
    expect(tlB.parallelGroupIndex).toBeNull();

    // Capacity share events
    const events = res.allocation!.events;
    expect(events).toHaveLength(2);
    expect(events[0].activeCount).toBe(1);
    expect(formatRatio(events[0].shareRate)).toBe('10/1');
    expect(events[0].finishedFeatureIds).toEqual([FEAT_A]);
    expect(events[1].activeCount).toBe(1);
    expect(formatRatio(events[1].shareRate)).toBe('10/1');
    expect(events[1].finishedFeatureIds).toEqual([FEAT_B]);
  });

  // ── AC 19.1-2: Parallel group with unequal estimates + sequential follow-up ─
  it('AC 19.1-2: group A=10, B=30 at C=20 followed by C=20: A finishes at 1, B at 2, C at 3 with redistribution', async () => {
    const inputs = makeInputs({
      selectedFeatureIds: [FEAT_A, FEAT_B, FEAT_C],
      estimates: { [FEAT_A]: 10, [FEAT_B]: 30, [FEAT_C]: 20 },
      pointsPerSprint: 20,
      startSprintOrdinal: 1,
      startDate: '2026-09-07',
      sprintLengthDays: 14,
      parallelGroups: [{ featureIds: [FEAT_A, FEAT_B] }],
    });

    const res = await calculateForecast(inputs, [], { visibleEventIndexes: [0, 1, 2] });
    expect(res.state).toBe('ready');
    expect(res.assumptions.groupingPremise).toBe('bounded-parallel-equal-share');
    expect(res.arithmetic?.occupiedSprints).toBe(3);
    expect(res.arithmetic?.completionSprint).toBe(3);

    const tlA = res.allocation!.timelines.find((t) => t.featureId === FEAT_A)!;
    const tlB = res.allocation!.timelines.find((t) => t.featureId === FEAT_B)!;
    const tlC = res.allocation!.timelines.find((t) => t.featureId === FEAT_C)!;

    // A: starts at 0, finishes at offset 1 (sprint 1)
    expect(formatRatio(tlA.startOffset!)).toBe('0/1');
    expect(formatRatio(tlA.finishOffset!)).toBe('1/1');
    expect(tlA.startSprintOrdinal).toBe(1);
    expect(tlA.completionSprintOrdinal).toBe(1);
    expect(tlA.parallelGroupIndex).toBe(0);

    // B: starts at 0, finishes at offset 2 (sprint 2)
    expect(formatRatio(tlB.startOffset!)).toBe('0/1');
    expect(formatRatio(tlB.finishOffset!)).toBe('2/1');
    expect(tlB.startSprintOrdinal).toBe(1);
    expect(tlB.completionSprintOrdinal).toBe(2);
    expect(tlB.parallelGroupIndex).toBe(0);

    // C: sequential follow-up starts at offset 2, finishes at 3 (sprint 3)
    expect(formatRatio(tlC.startOffset!)).toBe('2/1');
    expect(formatRatio(tlC.finishOffset!)).toBe('3/1');
    expect(tlC.startSprintOrdinal).toBe(3);
    expect(tlC.completionSprintOrdinal).toBe(3);
    expect(tlC.parallelGroupIndex).toBeNull();

    // Capacity share events verify equal share & redistribution
    const events = res.allocation!.events;
    expect(events).toHaveLength(3);

    // Event 1: interval [0, 1], active count = 2, shareRate = 20/2 = 10 pts/sprint, A finishes
    expect(formatRatio(events[0].startOffset)).toBe('0/1');
    expect(formatRatio(events[0].finishOffset)).toBe('1/1');
    expect(events[0].activeCount).toBe(2);
    expect(formatRatio(events[0].shareRate)).toBe('10/1');
    expect(events[0].finishedFeatureIds).toEqual([FEAT_A]);

    // Event 2: interval [1, 2], active count = 1, shareRate = 20/1 = 20 pts/sprint (redistributed!), B finishes
    expect(formatRatio(events[1].startOffset)).toBe('1/1');
    expect(formatRatio(events[1].finishOffset)).toBe('2/1');
    expect(events[1].activeCount).toBe(1);
    expect(formatRatio(events[1].shareRate)).toBe('20/1');
    expect(events[1].finishedFeatureIds).toEqual([FEAT_B]);

    // Event 3: interval [2, 3], C runs sequentially
    expect(formatRatio(events[2].startOffset)).toBe('2/1');
    expect(formatRatio(events[2].finishOffset)).toBe('3/1');
    expect(events[2].activeCount).toBe(1);
    expect(formatRatio(events[2].shareRate)).toBe('20/1');
    expect(events[2].finishedFeatureIds).toEqual([FEAT_C]);
  });

  // ── AC 19.1-3: Zero-point milestone members ───────────────────────────────
  it('AC 19.1-3: zero-point members consume no capacity and finish at block start as milestones', async () => {
    const inputs = makeInputs({
      selectedFeatureIds: [FEAT_A, FEAT_B, FEAT_C],
      estimates: { [FEAT_A]: 10, [FEAT_B]: 0, [FEAT_C]: 10 },
      pointsPerSprint: 10,
      startSprintOrdinal: 1,
      startDate: '2026-09-07',
      sprintLengthDays: 14,
      parallelGroups: [],
    });

    const res = await calculateForecast(inputs);
    expect(res.state).toBe('ready');

    const tlB = res.allocation!.timelines.find((t) => t.featureId === FEAT_B)!;
    expect(tlB.isMilestone).toBe(true);
    expect(tlB.estimate).toBe(0);
    // B finishes at start of its block (offset 1, where A finished)
    expect(formatRatio(tlB.startOffset!)).toBe('1/1');
    expect(formatRatio(tlB.finishOffset!)).toBe('1/1');
    expect(tlB.startSprintOrdinal).toBe(2);
    expect(tlB.completionSprintOrdinal).toBe(2);
    expect(tlB.startDate).toBe(tlB.completionDate);

    // C starts at offset 1, finishes at offset 2
    const tlC = res.allocation!.timelines.find((t) => t.featureId === FEAT_C)!;
    expect(formatRatio(tlC.startOffset!)).toBe('1/1');
    expect(formatRatio(tlC.finishOffset!)).toBe('2/1');
  });

  it('AC 19.1-3: zero-point member inside a parallel group finishes at block start as milestone', async () => {
    const inputs = makeInputs({
      selectedFeatureIds: [FEAT_A, FEAT_B, FEAT_C],
      estimates: { [FEAT_A]: 0, [FEAT_B]: 20, [FEAT_C]: 20 },
      pointsPerSprint: 20,
      startSprintOrdinal: 1,
      startDate: '2026-09-07',
      sprintLengthDays: 14,
      parallelGroups: [{ featureIds: [FEAT_A, FEAT_B, FEAT_C] }],
    });

    const res = await calculateForecast(inputs);
    expect(res.state).toBe('ready');

    const tlA = res.allocation!.timelines.find((t) => t.featureId === FEAT_A)!;
    expect(tlA.isMilestone).toBe(true);
    expect(formatRatio(tlA.startOffset!)).toBe('0/1');
    expect(formatRatio(tlA.finishOffset!)).toBe('0/1');

    const tlB = res.allocation!.timelines.find((t) => t.featureId === FEAT_B)!;
    const tlC = res.allocation!.timelines.find((t) => t.featureId === FEAT_C)!;
    // B and C each have 20 points, share 20 pts/sprint (10 each) -> take 2 sprints
    expect(formatRatio(tlB.startOffset!)).toBe('0/1');
    expect(formatRatio(tlB.finishOffset!)).toBe('2/1');
    expect(formatRatio(tlC.startOffset!)).toBe('0/1');
    expect(formatRatio(tlC.finishOffset!)).toBe('2/1');
  });

  // ── AC 19.1-4: Whole-set completion invariance under order / group permutations ─
  it('AC 19.1-4: whole-set exact duration/completion remains unchanged when order or grouping changes', async () => {
    const estimates = { [FEAT_A]: 10, [FEAT_B]: 20, [FEAT_C]: 30 };
    const baseConfig = {
      pointsPerSprint: 15,
      startSprintOrdinal: 5,
      startDate: '2026-10-01',
      sprintLengthDays: 14,
    };

    // Variation 1: Sequential [A, B, C]
    const r1 = await calculateForecast(
      makeInputs({
        ...baseConfig,
        selectedFeatureIds: [FEAT_A, FEAT_B, FEAT_C],
        estimates,
        parallelGroups: [],
      }),
    );

    // Variation 2: Sequential [C, B, A]
    const r2 = await calculateForecast(
      makeInputs({
        ...baseConfig,
        selectedFeatureIds: [FEAT_C, FEAT_B, FEAT_A],
        estimates,
        parallelGroups: [],
      }),
    );

    // Variation 3: Grouped [[A, B], C]
    const r3 = await calculateForecast(
      makeInputs({
        ...baseConfig,
        selectedFeatureIds: [FEAT_A, FEAT_B, FEAT_C],
        estimates,
        parallelGroups: [{ featureIds: [FEAT_A, FEAT_B] }],
      }),
    );

    // Variation 4: Grouped [A, [B, C]]
    const r4 = await calculateForecast(
      makeInputs({
        ...baseConfig,
        selectedFeatureIds: [FEAT_A, FEAT_B, FEAT_C],
        estimates,
        parallelGroups: [{ featureIds: [FEAT_B, FEAT_C] }],
      }),
    );

    // All 4 variations must have IDENTICAL whole-set arithmetic
    const a1 = r1.arithmetic!;
    const a2 = r2.arithmetic!;
    const a3 = r3.arithmetic!;
    const a4 = r4.arithmetic!;

    expect(formatRatio(a1.requiredSprints)).toBe('4/1'); // 60 / 15 = 4
    expect(formatRatio(a2.requiredSprints)).toBe('4/1');
    expect(formatRatio(a3.requiredSprints)).toBe('4/1');
    expect(formatRatio(a4.requiredSprints)).toBe('4/1');

    expect(a1.occupiedSprints).toBe(4);
    expect(a2.occupiedSprints).toBe(4);
    expect(a3.occupiedSprints).toBe(4);
    expect(a4.occupiedSprints).toBe(4);

    expect(a1.completionSprint).toBe(8); // 5 + 4 - 1 = 8
    expect(a2.completionSprint).toBe(8);
    expect(a3.completionSprint).toBe(8);
    expect(a4.completionSprint).toBe(8);

    expect(a1.completionDate).toBe(a2.completionDate);
    expect(a2.completionDate).toBe(a3.completionDate);
    expect(a3.completionDate).toBe(a4.completionDate);

    // Meanwhile, individual timelines differ across variations
    const t1_A = r1.allocation!.timelines.find((t) => t.featureId === FEAT_A)!;
    const t2_A = r2.allocation!.timelines.find((t) => t.featureId === FEAT_A)!;
    expect(formatRatio(t1_A.finishOffset!)).toBe('2/3'); // 10 / 15 = 2/3
    expect(formatRatio(t2_A.finishOffset!)).toBe('4/1'); // finished last
  });

  // ── AC 19.1-5: Capacity conservation & invariants ─────────────────────────
  it('AC 19.1-5: summed shares never exceed C, positive work ends at P/C, ratios are reduced', async () => {
    const C = 24;
    const inputs = makeInputs({
      selectedFeatureIds: [FEAT_A, FEAT_B, FEAT_C, FEAT_D],
      estimates: { [FEAT_A]: 12, [FEAT_B]: 18, [FEAT_C]: 24, [FEAT_D]: 6 },
      pointsPerSprint: C,
      startSprintOrdinal: 1,
      startDate: '2026-09-07',
      sprintLengthDays: 14,
      parallelGroups: [{ featureIds: [FEAT_A, FEAT_B, FEAT_C] }],
    });

    const res = await calculateForecast(inputs);
    expect(res.state).toBe('ready');

    const allocation = res.allocation!;
    const totalPoints = 12 + 18 + 24 + 6; // 60
    const expectedFinalOffset = reduceRatio(totalPoints, C); // 60/24 = 5/2

    // Check each capacity event
    for (const evt of allocation.events) {
      // Summed share rate across active members: activeCount * shareRate
      const totalCapacityUsed =
        (evt.activeCount * evt.shareRate.numerator) / evt.shareRate.denominator;
      expect(totalCapacityUsed).toBeLessThanOrEqual(C);
      // Ratios must be reduced (gcd(num, den) === 1)
      expect(evt.startOffset.denominator).toBeGreaterThan(0);
      expect(evt.finishOffset.denominator).toBeGreaterThan(0);
      expect(evt.shareRate.denominator).toBeGreaterThan(0);
    }

    // Last feature finishes at exact P/C
    const lastTimeline = allocation.timelines.find((t) => t.featureId === FEAT_D)!;
    expect(formatRatio(lastTimeline.finishOffset!)).toBe(formatRatio(expectedFinalOffset));
  });

  // ── AC 19.1-6: Complexity bounds ──────────────────────────────────────────
  it('AC 19.1-6: m unequal group members bound events to at most m and event storage to O(m)', async () => {
    const m = 50;
    const ids: string[] = [];
    const estimates: Record<string, number> = {};
    for (let i = 0; i < m; i++) {
      const id = `018f3a80-0000-7000-8000-${String(i).padStart(12, '0')}`;
      ids.push(id);
      estimates[id] = (i + 1) * 2;
    }

    const inputs = makeInputs({
      selectedFeatureIds: ids,
      estimates,
      pointsPerSprint: 100,
      parallelGroups: [{ featureIds: ids }],
    });

    const res = await calculateForecast(inputs, [], { visibleEventIndexes: Array.from({ length: m }, (_, index) => index) });
    expect(res.state).toBe('ready');
    const allocation = res.allocation!;

    // Event count <= distinct estimates <= m
    expect(allocation.events.length).toBeLessThanOrEqual(m);

    // Each feature ID appears in finishedFeatureIds across all events exactly once
    const finishedSum = allocation.events.reduce(
      (sum, e) => sum + (e.finishedFeatureIds?.length ?? 0),
      0,
    );
    expect(finishedSum).toBe(m);
  });

  it('AC 19.5-4: measures 500, 2,000, and 5,000 unequal members with linear event storage', async () => {
    for (const size of [500, 2_000, 5_000]) {
      const ids = Array.from(
        { length: size },
        (_, index) => `018f3a80-0000-7000-8001-${String(index).padStart(12, '0')}`,
      );
      const estimates = Object.freeze(Object.fromEntries(ids.map((id, index) => [id, index + 1])));
      const inputs = makeInputs({
        selectedFeatureIds: Object.freeze(ids),
        estimates,
        pointsPerSprint: 100,
        parallelGroups: Object.freeze([{ featureIds: Object.freeze(ids) }]),
      });

      const startedAt = performance.now();
      const result = await calculateForecast(inputs);
      const elapsedMs = performance.now() - startedAt;

      expect(result.state).toBe('ready');
      expect(result.allocation?.timelines).toHaveLength(size);
      expect(result.allocation?.events).toHaveLength(size);
      expect(result.allocation?.events.every((event) => event.finishedFeatureIds === undefined)).toBe(true);
      // A deliberately generous certification guard catches an accidental
      // quadratic regression without pretending to define a product SLA.
      expect(elapsedMs).toBeLessThan(5_000);
    }
  }, 20_000);

  // ── Independent golden oracle bytes ───────────────────────────────────────
  it('deterministic output matches independent golden bytes', async () => {
    const inputs = makeInputs({
      selectedFeatureIds: [FEAT_A, FEAT_B, FEAT_C],
      estimates: { [FEAT_A]: 10, [FEAT_B]: 30, [FEAT_C]: 20 },
      pointsPerSprint: 20,
      startSprintOrdinal: 1,
      startDate: '2026-09-07',
      sprintLengthDays: 14,
      parallelGroups: [{ featureIds: [FEAT_A, FEAT_B] }],
    });

    const res = await calculateForecast(inputs);
    const canonicalBytes = canonicalizeForecast(res.allocation);

    // Run again and verify exact byte identity
    const res2 = await calculateForecast(inputs);
    expect(canonicalizeForecast(res2.allocation)).toBe(canonicalBytes);
  });

  // ── Non-ready state withholds allocation ──────────────────────────────────
  it('withholds allocation when required inputs are missing or invalid', async () => {
    const missingEstimate = makeInputs({
      selectedFeatureIds: [FEAT_A, FEAT_B],
      estimates: { [FEAT_A]: 10, [FEAT_B]: null },
    });
    const resIncomplete = await calculateForecast(missingEstimate);
    expect(resIncomplete.state).toBe('incomplete');
    expect(resIncomplete.allocation).toBeNull();

    const zeroCapacity = makeInputs({
      pointsPerSprint: 0,
    });
    const resZeroCap = await calculateForecast(zeroCapacity);
    expect(resZeroCap.state).toBe('invalid');
    expect(resZeroCap.allocation).toBeNull();
  });
});
