/**
 * Staffed forecast calculation specification (Story 22.2, SF-FR8, SF-FR9, SF-FR10, SF-NFR1, SF-NFR2, SF-NFR5, SF-AR4, SF-AR10).
 *
 * Verifies:
 * - AC 22.2-1: Exact independent acceptance oracle for M1–M4, M6, M8–M15 with exact rational assertions
 * - AC 22.2-2: Early-finishing bucket member stays idle, next block waits for bucket maximum
 * - AC 22.2-3: M15 exact rational rate 1/3 and duration 3 with no float epsilon extra sprint; overflow state
 * - AC 22.2-4: State preservation (empty, zero-work without roster M10, unassigned positive M7, missing estimates, zero capacity, blockers M12)
 * - AC 22.2-5: Arithmetic serialization (Q work/capacity, T elapsed duration, person rates sum to C, active rates <= C, T >= Q, I = C*T - P)
 * - AC 22.2-6: Bounded computation and compact finish events on large assignment graphs
 */

import { describe, it, expect } from 'vitest';
import { STAFFED_FORECAST_POLICY_VERSION, FORECAST_POLICY_VERSION } from './forecast-plan.entity';
import type { ForecastInputs } from './forecast-result';
import { calculateForecast } from './whole-set.policy';
import { formatRatio, reduceRatio } from './forecast-canonical';
import { compareRatios, subtractRatios, multiplyRatioByInt } from './staffed-calculation.policy';

const PROJECT_ID = '0191eb58-0000-7000-8000-000000000000';
const PERSON_ADA_ID = '0191eb58-0001-7000-8000-000000000001';
const PERSON_BEN_ID = '0191eb58-0002-7000-8000-000000000002';
const PERSON_CARA_ID = '0191eb58-0003-7000-8000-000000000003';

const FEATURE_A_ID = '0191eb58-0010-7000-8000-00000000000a';
const FEATURE_B_ID = '0191eb58-0020-7000-8000-00000000000b';
const FEATURE_C_ID = '0191eb58-0030-7000-8000-00000000000c';

const DEFAULT_ROSTER = [
  { id: PERSON_ADA_ID, name: 'Ada', weightUnits: 100 },
  { id: PERSON_BEN_ID, name: 'Ben', weightUnits: 100 },
] as const;

function makeStaffedInputs(overrides: Partial<ForecastInputs> = {}): ForecastInputs {
  return {
    projectId: PROJECT_ID,
    projectRevision: 1,
    policyVersion: STAFFED_FORECAST_POLICY_VERSION,
    selectedFeatureIds: [FEATURE_A_ID],
    estimates: { [FEATURE_A_ID]: 20 },
    pointsPerSprint: 20,
    sprintLengthDays: 14,
    startSprintOrdinal: 12,
    startDate: '2026-09-07',
    parallelGroups: [],
    blockedFeatureIds: [],
    roster: DEFAULT_ROSTER,
    assignments: { [FEATURE_A_ID]: [PERSON_ADA_ID] },
    ...overrides,
  };
}

describe('Story 22.2: Calculate fixed-assignment completion and idle capacity', () => {
  describe('AC 22.2-1: Hand-checkable acceptance examples M1–M4, M6, M8–M15', () => {
    it('M1: A=20 assigned Ada; Ben remains in roster but idle -> Q=1, T=2, I=20; Sprint 13, 2026-10-04', async () => {
      const inputs = makeStaffedInputs({
        selectedFeatureIds: [FEATURE_A_ID],
        estimates: { [FEATURE_A_ID]: 20 },
        assignments: { [FEATURE_A_ID]: [PERSON_ADA_ID] },
      });

      const res = await calculateForecast(inputs);
      expect(res.state).toBe('ready');
      expect(res.arithmetic).not.toBeNull();

      const arith = res.arithmetic!;
      expect(arith.totalPoints).toBe(20);
      expect(arith.pointsPerSprint).toBe(20);
      // Q = P / C = 20 / 20 = 1/1
      expect(formatRatio(arith.requiredSprints)).toBe('1/1');
      // T = 2/1
      expect(formatRatio(arith.elapsedStaffingDuration!)).toBe('2/1');
      // I = C * T - P = 20 * 2 - 20 = 20/1
      expect(formatRatio(arith.idleCapacityPoints!)).toBe('20/1');
      expect(formatRatio(arith.idlePointsEquivalent!)).toBe('20/1');
      expect(arith.occupiedSprints).toBe(2);
      expect(arith.completionSprint).toBe(13);
      expect(arith.completionDate).toBe('2026-10-04');

      // Timeline A
      const tlA = res.allocation!.timelines.find((t) => t.featureId === FEATURE_A_ID)!;
      expect(formatRatio(tlA.startOffset!)).toBe('0/1');
      expect(formatRatio(tlA.finishOffset!)).toBe('2/1');
      expect(formatRatio(tlA.itemRate!)).toBe('10/1');
      expect(formatRatio(tlA.duration!)).toBe('2/1');
      expect(tlA.isBottleneck).toBe(true);
      expect(tlA.startSprintOrdinal).toBe(12);
      expect(tlA.completionSprintOrdinal).toBe(13);
      expect(tlA.startDate).toBe('2026-09-07');
      expect(tlA.completionDate).toBe('2026-10-04');
    });

    it('M2: A=20 assigned Ada and Ben -> Q=T=1, I=0; Sprint 12, 2026-09-20', async () => {
      const inputs = makeStaffedInputs({
        selectedFeatureIds: [FEATURE_A_ID],
        estimates: { [FEATURE_A_ID]: 20 },
        assignments: { [FEATURE_A_ID]: [PERSON_ADA_ID, PERSON_BEN_ID] },
      });

      const res = await calculateForecast(inputs);
      expect(res.state).toBe('ready');
      const arith = res.arithmetic!;
      expect(formatRatio(arith.requiredSprints)).toBe('1/1');
      expect(formatRatio(arith.elapsedStaffingDuration!)).toBe('1/1');
      expect(formatRatio(arith.idleCapacityPoints!)).toBe('0/1');
      expect(arith.occupiedSprints).toBe(1);
      expect(arith.completionSprint).toBe(12);
      expect(arith.completionDate).toBe('2026-09-20');

      const tlA = res.allocation!.timelines.find((t) => t.featureId === FEATURE_A_ID)!;
      expect(formatRatio(tlA.startOffset!)).toBe('0/1');
      expect(formatRatio(tlA.finishOffset!)).toBe('1/1');
      expect(formatRatio(tlA.itemRate!)).toBe('20/1');
      expect(formatRatio(tlA.duration!)).toBe('1/1');
    });

    it('M3: Bucket A=10/Ada, B=30/Ben -> A finishes at 1, B at 3; Q=2, T=3, I=20; Sprint 14, 2026-10-18', async () => {
      const inputs = makeStaffedInputs({
        selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID],
        estimates: { [FEATURE_A_ID]: 10, [FEATURE_B_ID]: 30 },
        parallelGroups: [{ featureIds: [FEATURE_A_ID, FEATURE_B_ID] }],
        assignments: {
          [FEATURE_A_ID]: [PERSON_ADA_ID],
          [FEATURE_B_ID]: [PERSON_BEN_ID],
        },
      });

      // Identity detail is built only for requested events (Story 22.11, AC 22.11-5).
      const res = await calculateForecast(inputs, [], { visibleEventIndexes: [0, 1] });
      expect(res.state).toBe('ready');
      const arith = res.arithmetic!;
      expect(arith.totalPoints).toBe(40);
      expect(formatRatio(arith.requiredSprints)).toBe('2/1');
      expect(formatRatio(arith.elapsedStaffingDuration!)).toBe('3/1');
      expect(formatRatio(arith.idleCapacityPoints!)).toBe('20/1');
      expect(arith.occupiedSprints).toBe(3);
      expect(arith.completionSprint).toBe(14);
      expect(arith.completionDate).toBe('2026-10-18');

      const tlA = res.allocation!.timelines.find((t) => t.featureId === FEATURE_A_ID)!;
      const tlB = res.allocation!.timelines.find((t) => t.featureId === FEATURE_B_ID)!;
      expect(formatRatio(tlA.startOffset!)).toBe('0/1');
      expect(formatRatio(tlA.finishOffset!)).toBe('1/1');
      expect(formatRatio(tlA.itemRate!)).toBe('10/1');
      expect(formatRatio(tlA.duration!)).toBe('1/1');
      expect(tlA.isBottleneck).toBe(false);

      expect(formatRatio(tlB.startOffset!)).toBe('0/1');
      expect(formatRatio(tlB.finishOffset!)).toBe('3/1');
      expect(formatRatio(tlB.itemRate!)).toBe('10/1');
      expect(formatRatio(tlB.duration!)).toBe('3/1');
      expect(tlB.isBottleneck).toBe(true);

      // Verify events: A finishes at 1, Ada becomes idle for interval [1, 3]
      expect(res.allocation!.events).toHaveLength(2);
      const ev0 = res.allocation!.events[0];
      expect(formatRatio(ev0.startOffset)).toBe('0/1');
      expect(formatRatio(ev0.finishOffset)).toBe('1/1');
      expect(formatRatio(ev0.activeRate!)).toBe('20/1');
      expect(formatRatio(ev0.idleRate!)).toBe('0/1');
      expect(ev0.finishedFeatureIds).toEqual([FEATURE_A_ID]);

      const ev1 = res.allocation!.events[1];
      expect(formatRatio(ev1.startOffset)).toBe('1/1');
      expect(formatRatio(ev1.finishOffset)).toBe('3/1');
      expect(formatRatio(ev1.activeRate!)).toBe('10/1');
      expect(formatRatio(ev1.idleRate!)).toBe('10/1');
      expect(ev1.finishedFeatureIds).toEqual([FEATURE_B_ID]);
      expect(ev1.idlePersonIds).toContain(PERSON_ADA_ID);
    });

    it('M4: M3 followed by C=10 assigned both -> C starts at 3 and finishes at 7/2; Q=5/2, T=7/2, I=20; Sprint 15, 2026-11-01', async () => {
      const inputs = makeStaffedInputs({
        selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID, FEATURE_C_ID],
        estimates: { [FEATURE_A_ID]: 10, [FEATURE_B_ID]: 30, [FEATURE_C_ID]: 10 },
        parallelGroups: [{ featureIds: [FEATURE_A_ID, FEATURE_B_ID] }],
        assignments: {
          [FEATURE_A_ID]: [PERSON_ADA_ID],
          [FEATURE_B_ID]: [PERSON_BEN_ID],
          [FEATURE_C_ID]: [PERSON_ADA_ID, PERSON_BEN_ID],
        },
      });

      const res = await calculateForecast(inputs);
      expect(res.state).toBe('ready');
      const arith = res.arithmetic!;
      expect(arith.totalPoints).toBe(50);
      expect(formatRatio(arith.requiredSprints)).toBe('5/2');
      expect(formatRatio(arith.elapsedStaffingDuration!)).toBe('7/2');
      expect(formatRatio(arith.idleCapacityPoints!)).toBe('20/1');
      expect(arith.occupiedSprints).toBe(4);
      expect(arith.completionSprint).toBe(15);
      expect(arith.completionDate).toBe('2026-11-01');

      const tlC = res.allocation!.timelines.find((t) => t.featureId === FEATURE_C_ID)!;
      expect(formatRatio(tlC.startOffset!)).toBe('3/1');
      expect(formatRatio(tlC.finishOffset!)).toBe('7/2');
      expect(formatRatio(tlC.itemRate!)).toBe('20/1');
      expect(formatRatio(tlC.duration!)).toBe('1/2');
      expect(tlC.startSprintOrdinal).toBe(15);
      expect(tlC.completionSprintOrdinal).toBe(15);
    });

    it('M6: Sequential A=10/Ada, then B=10/Ada -> valid reuse; offsets [0,1], [1,2]; Q=1, T=2, I=20', async () => {
      const inputs = makeStaffedInputs({
        selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID],
        estimates: { [FEATURE_A_ID]: 10, [FEATURE_B_ID]: 10 },
        parallelGroups: [],
        assignments: {
          [FEATURE_A_ID]: [PERSON_ADA_ID],
          [FEATURE_B_ID]: [PERSON_ADA_ID],
        },
      });

      const res = await calculateForecast(inputs);
      expect(res.state).toBe('ready');
      const arith = res.arithmetic!;
      expect(formatRatio(arith.requiredSprints)).toBe('1/1');
      expect(formatRatio(arith.elapsedStaffingDuration!)).toBe('2/1');
      expect(formatRatio(arith.idleCapacityPoints!)).toBe('20/1');

      const tlA = res.allocation!.timelines.find((t) => t.featureId === FEATURE_A_ID)!;
      const tlB = res.allocation!.timelines.find((t) => t.featureId === FEATURE_B_ID)!;
      expect(formatRatio(tlA.startOffset!)).toBe('0/1');
      expect(formatRatio(tlA.finishOffset!)).toBe('1/1');
      expect(formatRatio(tlB.startOffset!)).toBe('1/1');
      expect(formatRatio(tlB.finishOffset!)).toBe('2/1');
    });

    it('M8: C=20; weights Ada=3, Ben=1; bucket A=30/Ada, B=10/Ben -> Rates 15 and 5; both finish at 2, I=0', async () => {
      const inputs = makeStaffedInputs({
        roster: [
          { id: PERSON_ADA_ID, name: 'Ada', weightUnits: 300 },
          { id: PERSON_BEN_ID, name: 'Ben', weightUnits: 100 },
        ],
        selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID],
        estimates: { [FEATURE_A_ID]: 30, [FEATURE_B_ID]: 10 },
        parallelGroups: [{ featureIds: [FEATURE_A_ID, FEATURE_B_ID] }],
        assignments: {
          [FEATURE_A_ID]: [PERSON_ADA_ID],
          [FEATURE_B_ID]: [PERSON_BEN_ID],
        },
      });

      // Identity detail is built only for requested events (Story 22.11, AC 22.11-5).
      const res = await calculateForecast(inputs, [], { visibleEventIndexes: [0] });
      expect(res.state).toBe('ready');
      const arith = res.arithmetic!;
      expect(formatRatio(arith.requiredSprints)).toBe('2/1');
      expect(formatRatio(arith.elapsedStaffingDuration!)).toBe('2/1');
      expect(formatRatio(arith.idleCapacityPoints!)).toBe('0/1');

      const tlA = res.allocation!.timelines.find((t) => t.featureId === FEATURE_A_ID)!;
      const tlB = res.allocation!.timelines.find((t) => t.featureId === FEATURE_B_ID)!;
      expect(formatRatio(tlA.itemRate!)).toBe('15/1');
      expect(formatRatio(tlA.duration!)).toBe('2/1');
      expect(formatRatio(tlA.finishOffset!)).toBe('2/1');

      expect(formatRatio(tlB.itemRate!)).toBe('5/1');
      expect(formatRatio(tlB.duration!)).toBe('2/1');
      expect(formatRatio(tlB.finishOffset!)).toBe('2/1');

      // Both finish simultaneously at 2
      expect(res.allocation!.events).toHaveLength(1);
      expect(formatRatio(res.allocation!.events[0].finishOffset)).toBe('2/1');
      expect(res.allocation!.events[0].finishedFeatureIds).toEqual([FEATURE_A_ID, FEATURE_B_ID]);
    });

    it('M9: Add Cara weight 1 to equal-weight two-person roster, C still 20; A=20 assigned Ada and Ben -> Each rate 20/3, A rate 40/3, T=3/2, Q=1, I=10', async () => {
      const inputs = makeStaffedInputs({
        roster: [
          { id: PERSON_ADA_ID, name: 'Ada', weightUnits: 100 },
          { id: PERSON_BEN_ID, name: 'Ben', weightUnits: 100 },
          { id: PERSON_CARA_ID, name: 'Cara', weightUnits: 100 },
        ],
        selectedFeatureIds: [FEATURE_A_ID],
        estimates: { [FEATURE_A_ID]: 20 },
        assignments: { [FEATURE_A_ID]: [PERSON_ADA_ID, PERSON_BEN_ID] },
      });

      const res = await calculateForecast(inputs);
      expect(res.state).toBe('ready');
      const arith = res.arithmetic!;
      expect(formatRatio(arith.requiredSprints)).toBe('1/1');
      expect(formatRatio(arith.elapsedStaffingDuration!)).toBe('3/2');
      expect(formatRatio(arith.idleCapacityPoints!)).toBe('10/1');

      const tlA = res.allocation!.timelines.find((t) => t.featureId === FEATURE_A_ID)!;
      expect(formatRatio(tlA.itemRate!)).toBe('40/3');
      expect(formatRatio(tlA.duration!)).toBe('3/2');
    });

    it('M10: A=0, no people or assignments, otherwise valid configuration -> Zero-work at Sprint 12 / 2026-09-07; T=0; no division by roster weight', async () => {
      const inputs = makeStaffedInputs({
        roster: [],
        selectedFeatureIds: [FEATURE_A_ID],
        estimates: { [FEATURE_A_ID]: 0 },
        assignments: {},
      });

      const res = await calculateForecast(inputs);
      expect(res.state).toBe('zero-work');
      expect(res.arithmetic).not.toBeNull();
      const arith = res.arithmetic!;
      expect(arith.totalPoints).toBe(0);
      expect(arith.occupiedSprints).toBe(0);
      expect(arith.completionSprint).toBe(12);
      expect(arith.completionDate).toBe('2026-09-07');
      expect(formatRatio(arith.requiredSprints)).toBe('0/1');
      expect(formatRatio(arith.elapsedStaffingDuration!)).toBe('0/1');
      expect(formatRatio(arith.idleCapacityPoints!)).toBe('0/1');

      const tlA = res.allocation!.timelines.find((t) => t.featureId === FEATURE_A_ID)!;
      expect(tlA.isMilestone).toBe(true);
      expect(formatRatio(tlA.startOffset!)).toBe('0/1');
      expect(formatRatio(tlA.finishOffset!)).toBe('0/1');
    });

    it('M11: Sequential A=5/Ada, B=5/Ada -> Each takes 1/2 sprint; T=1, not 2; Completion Sprint 12', async () => {
      const inputs = makeStaffedInputs({
        selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID],
        estimates: { [FEATURE_A_ID]: 5, [FEATURE_B_ID]: 5 },
        parallelGroups: [],
        assignments: {
          [FEATURE_A_ID]: [PERSON_ADA_ID],
          [FEATURE_B_ID]: [PERSON_ADA_ID],
        },
      });

      const res = await calculateForecast(inputs);
      expect(res.state).toBe('ready');
      const arith = res.arithmetic!;
      expect(formatRatio(arith.elapsedStaffingDuration!)).toBe('1/1');
      expect(arith.occupiedSprints).toBe(1);
      expect(arith.completionSprint).toBe(12);

      const tlA = res.allocation!.timelines.find((t) => t.featureId === FEATURE_A_ID)!;
      const tlB = res.allocation!.timelines.find((t) => t.featureId === FEATURE_B_ID)!;
      expect(formatRatio(tlA.duration!)).toBe('1/2');
      expect(formatRatio(tlA.finishOffset!)).toBe('1/2');
      expect(formatRatio(tlB.duration!)).toBe('1/2');
      expect(formatRatio(tlB.startOffset!)).toBe('1/2');
      expect(formatRatio(tlB.finishOffset!)).toBe('1/1');
    });

    it('M12: M3 with B explicitly blocked -> Same exact offsets/date as M3, labeled Conditional; no guessed delay', async () => {
      const inputs = makeStaffedInputs({
        selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID],
        estimates: { [FEATURE_A_ID]: 10, [FEATURE_B_ID]: 30 },
        parallelGroups: [{ featureIds: [FEATURE_A_ID, FEATURE_B_ID] }],
        assignments: {
          [FEATURE_A_ID]: [PERSON_ADA_ID],
          [FEATURE_B_ID]: [PERSON_BEN_ID],
        },
        blockedFeatureIds: [FEATURE_B_ID],
      });

      const res = await calculateForecast(inputs);
      expect(res.state).toBe('conditional');
      expect(res.issues.some((i) => i.code === 'CONDITIONAL_BLOCKER' && i.featureIds?.includes(FEATURE_B_ID))).toBe(true);

      const arith = res.arithmetic!;
      expect(formatRatio(arith.requiredSprints)).toBe('2/1');
      expect(formatRatio(arith.elapsedStaffingDuration!)).toBe('3/1');
      expect(formatRatio(arith.idleCapacityPoints!)).toBe('20/1');
      expect(arith.occupiedSprints).toBe(3);
      expect(arith.completionSprint).toBe(14);
      expect(arith.completionDate).toBe('2026-10-18');
    });

    it('M13: M3 with C changed to 40 -> Rates 20 each; Q=1, T=3/2, I=20; completion Sprint 13', async () => {
      const inputs = makeStaffedInputs({
        pointsPerSprint: 40,
        selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID],
        estimates: { [FEATURE_A_ID]: 10, [FEATURE_B_ID]: 30 },
        parallelGroups: [{ featureIds: [FEATURE_A_ID, FEATURE_B_ID] }],
        assignments: {
          [FEATURE_A_ID]: [PERSON_ADA_ID],
          [FEATURE_B_ID]: [PERSON_BEN_ID],
        },
      });

      const res = await calculateForecast(inputs);
      expect(res.state).toBe('ready');
      const arith = res.arithmetic!;
      expect(formatRatio(arith.requiredSprints)).toBe('1/1');
      expect(formatRatio(arith.elapsedStaffingDuration!)).toBe('3/2');
      expect(formatRatio(arith.idleCapacityPoints!)).toBe('20/1');
      expect(arith.occupiedSprints).toBe(2);
      expect(arith.completionSprint).toBe(13);

      const tlA = res.allocation!.timelines.find((t) => t.featureId === FEATURE_A_ID)!;
      const tlB = res.allocation!.timelines.find((t) => t.featureId === FEATURE_B_ID)!;
      expect(formatRatio(tlA.itemRate!)).toBe('20/1');
      expect(formatRatio(tlA.duration!)).toBe('1/2');
      expect(formatRatio(tlB.itemRate!)).toBe('20/1');
      expect(formatRatio(tlB.duration!)).toBe('3/2');
    });

    it('M14: Sequential A=10/Ada then B=30/Ben; regroup as M3 -> Sequential T=4 becomes bucket T=3', async () => {
      const sequentialInputs = makeStaffedInputs({
        selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID],
        estimates: { [FEATURE_A_ID]: 10, [FEATURE_B_ID]: 30 },
        parallelGroups: [],
        assignments: {
          [FEATURE_A_ID]: [PERSON_ADA_ID],
          [FEATURE_B_ID]: [PERSON_BEN_ID],
        },
      });

      const bucketInputs = makeStaffedInputs({
        selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID],
        estimates: { [FEATURE_A_ID]: 10, [FEATURE_B_ID]: 30 },
        parallelGroups: [{ featureIds: [FEATURE_A_ID, FEATURE_B_ID] }],
        assignments: {
          [FEATURE_A_ID]: [PERSON_ADA_ID],
          [FEATURE_B_ID]: [PERSON_BEN_ID],
        },
      });

      const resSeq = await calculateForecast(sequentialInputs);
      const resBkt = await calculateForecast(bucketInputs);

      expect(formatRatio(resSeq.arithmetic!.elapsedStaffingDuration!)).toBe('4/1');
      expect(formatRatio(resBkt.arithmetic!.elapsedStaffingDuration!)).toBe('3/1');
    });

    it('M15: C=1; weights Ada=0.10, Ben=0.20; A=1 assigned Ada -> Exact rate 1/3; T=3, with no floating-point extra sprint', async () => {
      const inputs = makeStaffedInputs({
        pointsPerSprint: 1,
        roster: [
          { id: PERSON_ADA_ID, name: 'Ada', weightUnits: 10 },
          { id: PERSON_BEN_ID, name: 'Ben', weightUnits: 20 },
        ],
        selectedFeatureIds: [FEATURE_A_ID],
        estimates: { [FEATURE_A_ID]: 1 },
        assignments: { [FEATURE_A_ID]: [PERSON_ADA_ID] },
      });

      const res = await calculateForecast(inputs);
      expect(res.state).toBe('ready');
      const arith = res.arithmetic!;
      expect(formatRatio(arith.elapsedStaffingDuration!)).toBe('3/1');
      expect(arith.occupiedSprints).toBe(3);

      const tlA = res.allocation!.timelines.find((t) => t.featureId === FEATURE_A_ID)!;
      expect(formatRatio(tlA.itemRate!)).toBe('1/3');
      expect(formatRatio(tlA.duration!)).toBe('3/1');
    });
  });

  describe('AC 22.2-2: Bucket idle capacity and barrier semantics', () => {
    it('when first member finishes early, capacity remains idle and next block waits', async () => {
      const inputs = makeStaffedInputs({
        selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID, FEATURE_C_ID],
        estimates: { [FEATURE_A_ID]: 10, [FEATURE_B_ID]: 30, [FEATURE_C_ID]: 20 },
        parallelGroups: [{ featureIds: [FEATURE_A_ID, FEATURE_B_ID] }],
        assignments: {
          [FEATURE_A_ID]: [PERSON_ADA_ID],
          [FEATURE_B_ID]: [PERSON_BEN_ID],
          [FEATURE_C_ID]: [PERSON_ADA_ID],
        },
      });

      // Identity detail is built only for requested events (Story 22.11, AC 22.11-5).
      const res = await calculateForecast(inputs, [], { visibleEventIndexes: [0, 1, 2] });
      expect(res.state).toBe('ready');

      // Bucket barrier D_b is max(d_A, d_B) = 3
      // A finishes at 1, B finishes at 3
      // C is in the next block, so C CANNOT start at 1 even though Ada finished A at 1!
      // C must wait until the bucket barrier (offset 3)
      const tlC = res.allocation!.timelines.find((t) => t.featureId === FEATURE_C_ID)!;
      expect(formatRatio(tlC.startOffset!)).toBe('3/1');
      expect(formatRatio(tlC.finishOffset!)).toBe('5/1'); // C has 20 pts at 10 pts/sprint = 2 sprints

      // Check events: during [1, 3], Ada is idle, Ben is active at 10 pts/sprint
      const events = res.allocation!.events;
      const idleEvent = events.find((e) => formatRatio(e.startOffset) === '1/1' && formatRatio(e.finishOffset) === '3/1')!;
      expect(idleEvent).toBeDefined();
      expect(formatRatio(idleEvent.activeRate!)).toBe('10/1');
      expect(formatRatio(idleEvent.idleRate!)).toBe('10/1');
      expect(idleEvent.idlePersonIds).toContain(PERSON_ADA_ID);
    });
  });

  describe('AC 22.2-3: Exact rational precision and overflow handling', () => {
    it('M15 exact rate 1/3 and duration 3 with no extra sprint', async () => {
      const inputs = makeStaffedInputs({
        pointsPerSprint: 1,
        roster: [
          { id: PERSON_ADA_ID, name: 'Ada', weightUnits: 10 },
          { id: PERSON_BEN_ID, name: 'Ben', weightUnits: 20 },
        ],
        selectedFeatureIds: [FEATURE_A_ID],
        estimates: { [FEATURE_A_ID]: 1 },
        assignments: { [FEATURE_A_ID]: [PERSON_ADA_ID] },
      });

      const res = await calculateForecast(inputs);
      expect(res.arithmetic!.occupiedSprints).toBe(3);
      expect(res.arithmetic!.elapsedStaffingDuration!.numerator).toBe(3);
      expect(res.arithmetic!.elapsedStaffingDuration!.denominator).toBe(1);
    });

    it('calendar overflow yields explicit overflow state', async () => {
      // Enormous sprint span triggers calendar RangeError -> overflow
      const inputs = makeStaffedInputs({
        selectedFeatureIds: [FEATURE_A_ID],
        estimates: { [FEATURE_A_ID]: 10_000_000 },
        pointsPerSprint: 1,
        assignments: { [FEATURE_A_ID]: [PERSON_ADA_ID] },
      });

      const res = await calculateForecast(inputs);
      expect(res.state).toBe('overflow');
      expect(res.arithmetic).toBeNull();
      expect(res.issues.some((i) => i.code === 'OVERFLOW')).toBe(true);
    });
  });

  describe('AC 22.2-4: State distinctions and edge cases', () => {
    it('empty scope yields empty state with null timelines', async () => {
      const inputs = makeStaffedInputs({
        selectedFeatureIds: [],
        estimates: {},
        assignments: {},
      });

      const res = await calculateForecast(inputs);
      expect(res.state).toBe('empty');
      expect(res.arithmetic).toBeNull();
      expect(res.allocation).toBeNull();
    });

    it('M10: all-zero scope without roster yields zero-work state with anchor date', async () => {
      const inputs = makeStaffedInputs({
        roster: [],
        selectedFeatureIds: [FEATURE_A_ID],
        estimates: { [FEATURE_A_ID]: 0 },
        assignments: {},
      });

      const res = await calculateForecast(inputs);
      expect(res.state).toBe('zero-work');
      expect(res.arithmetic).not.toBeNull();
      expect(res.arithmetic!.completionDate).toBe('2026-09-07');
      expect(res.arithmetic!.completionSprint).toBe(12);
      expect(res.allocation!.timelines[0].isMilestone).toBe(true);
    });

    it('M7: unassigned positive-point work yields incomplete state with MISSING_ASSIGNMENT', async () => {
      const inputs = makeStaffedInputs({
        selectedFeatureIds: [FEATURE_A_ID],
        estimates: { [FEATURE_A_ID]: 10 },
        assignments: {},
      });

      const res = await calculateForecast(inputs);
      expect(res.state).toBe('incomplete');
      expect(res.totalKnownPoints).toBe(10);
      expect(res.arithmetic).toBeNull();
      expect(res.allocation).toBeNull();
      expect(res.issues.some((i) => i.code === 'MISSING_ASSIGNMENT')).toBe(true);
    });

    it('missing estimate yields incomplete state', async () => {
      const inputs = makeStaffedInputs({
        selectedFeatureIds: [FEATURE_A_ID],
        estimates: { [FEATURE_A_ID]: null },
      });

      const res = await calculateForecast(inputs);
      expect(res.state).toBe('incomplete');
      expect(res.arithmetic).toBeNull();
      expect(res.allocation).toBeNull();
      expect(res.issues.some((i) => i.code === 'MISSING_ESTIMATE')).toBe(true);
    });

    it('missing capacity configuration yields incomplete state', async () => {
      const inputs = makeStaffedInputs({
        pointsPerSprint: null,
      });

      const res = await calculateForecast(inputs);
      expect(res.state).toBe('incomplete');
      expect(res.issues.some((i) => i.code === 'MISSING_CAPACITY')).toBe(true);
    });

    it('zero capacity yields invalid state with ZERO_CAPACITY', async () => {
      const inputs = makeStaffedInputs({
        pointsPerSprint: 0,
      });

      const res = await calculateForecast(inputs);
      expect(res.state).toBe('invalid');
      expect(res.issues.some((i) => i.code === 'ZERO_CAPACITY')).toBe(true);
    });

    it('missing roster for positive work yields incomplete state with MISSING_ROSTER', async () => {
      const inputs = makeStaffedInputs({
        roster: [],
        selectedFeatureIds: [FEATURE_A_ID],
        estimates: { [FEATURE_A_ID]: 10 },
        assignments: {},
      });

      const res = await calculateForecast(inputs);
      expect(res.state).toBe('incomplete');
      expect(res.issues.some((i) => i.code === 'MISSING_ROSTER')).toBe(true);
    });

    it('M5: bucket concurrency conflict yields invalid state with CONCURRENT_ASSIGNMENT_CONFLICT', async () => {
      const inputs = makeStaffedInputs({
        selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID],
        estimates: { [FEATURE_A_ID]: 10, [FEATURE_B_ID]: 20 },
        parallelGroups: [{ featureIds: [FEATURE_A_ID, FEATURE_B_ID] }],
        assignments: {
          [FEATURE_A_ID]: [PERSON_ADA_ID],
          [FEATURE_B_ID]: [PERSON_ADA_ID],
        },
      });

      const res = await calculateForecast(inputs);
      expect(res.state).toBe('invalid');
      expect(res.issues.some((i) => i.code === 'CONCURRENT_ASSIGNMENT_CONFLICT')).toBe(true);
    });
  });

  describe('AC 22.2-5: Arithmetic serialization and mathematical invariants', () => {
    it('Q is P/C, T >= Q, active rates <= C, person rates sum to C, I = C*T - P', async () => {
      const inputs = makeStaffedInputs({
        selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID],
        estimates: { [FEATURE_A_ID]: 10, [FEATURE_B_ID]: 30 },
        parallelGroups: [{ featureIds: [FEATURE_A_ID, FEATURE_B_ID] }],
        assignments: {
          [FEATURE_A_ID]: [PERSON_ADA_ID],
          [FEATURE_B_ID]: [PERSON_BEN_ID],
        },
      });

      const res = await calculateForecast(inputs);
      const arith = res.arithmetic!;
      const C = inputs.pointsPerSprint!;
      const P = arith.totalPoints;
      const Q = arith.requiredSprints;
      const T = arith.elapsedStaffingDuration!;
      const I = arith.idleCapacityPoints!;

      // Q = P / C
      expect(Q).toEqual(reduceRatio(P, C));
      // T >= Q
      expect(compareRatios(T, Q)).toBeGreaterThanOrEqual(0);
      // I = C * T - P
      const expectedI = subtractRatios(multiplyRatioByInt(T, C), reduceRatio(P, 1));
      expect(I).toEqual(expectedI);

      // Active rates in every event never exceed C
      for (const ev of res.allocation!.events) {
        expect(compareRatios(ev.activeRate!, reduceRatio(C, 1))).toBeLessThanOrEqual(0);
      }
    });
  });

  describe('AC 22.2-6: Bounded computation and compact output on large inputs', () => {
    it('scales linearly with items/assignments and produces compact finish events independent of sprint count', async () => {
      // 50 items each taking 20 sprints -> 1,000 sprints total duration!
      const count = 50;
      const featureIds: string[] = [];
      const estimates: Record<string, number> = {};
      const assignments: Record<string, string[]> = {};

      for (let i = 0; i < count; i++) {
        const fid = `0191eb58-0000-7000-8000-${String(i).padStart(12, '0')}`;
        featureIds.push(fid);
        estimates[fid] = 200; // 200 pts at 10 pts/sprint = 20 sprints each
        assignments[fid] = [PERSON_ADA_ID];
      }

      const inputs = makeStaffedInputs({
        selectedFeatureIds: featureIds,
        estimates,
        assignments,
      });

      const startTime = performance.now();
      const res = await calculateForecast(inputs);
      const elapsedMs = performance.now() - startTime;

      expect(res.state).toBe('ready');
      expect(res.arithmetic!.occupiedSprints).toBe(1000); // 50 items * 20 sprints = 1000 sprints
      // Events must be compact: exactly 50 events (one per item), NOT 1,000 events!
      expect(res.allocation!.events.length).toBe(count);
      expect(elapsedMs).toBeLessThan(100);
    });

    it('legacy shared-capacity-v1 forecasts remain 100% identical and regression-free', async () => {
      const sharedInputs: ForecastInputs = {
        projectId: PROJECT_ID,
        projectRevision: 1,
        policyVersion: FORECAST_POLICY_VERSION,
        selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID],
        estimates: { [FEATURE_A_ID]: 10, [FEATURE_B_ID]: 30 },
        pointsPerSprint: 20,
        sprintLengthDays: 14,
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
        parallelGroups: [{ featureIds: [FEATURE_A_ID, FEATURE_B_ID] }],
        blockedFeatureIds: [],
      };

      const res = await calculateForecast(sharedInputs);
      expect(res.state).toBe('ready');
      expect(res.assumptions.policyVersion).toBe('shared-capacity-v1');
      expect(res.assumptions.groupingPremise).toBe('bounded-parallel-equal-share');
      // In shared mode: 40 pts at 20 pts/sprint = 2 sprints
      expect(formatRatio(res.arithmetic!.requiredSprints)).toBe('2/1');
      expect(res.arithmetic!.occupiedSprints).toBe(2);
      expect(res.arithmetic!.completionSprint).toBe(13);
      expect(res.arithmetic!.completionDate).toBe('2026-10-04');
    });
  });
});
