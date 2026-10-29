import { describe, expect, it } from 'vitest';
import { calculateForecast } from '../../domain/forecast/whole-set.policy';
import { createForecastAssumptions } from '../../domain/forecast/forecast-result';
import type { ForecastResult, ForecastArithmetic } from '../../domain/forecast/forecast-result';
import type { ForecastInputs } from '../../domain/forecast/forecast-result';
import { explainForecast } from './forecast-explain';

const PROJECT_ID = '019ffe00-0000-7000-8000-000000000001';
const FEATURE_A = '019ffe00-0000-7000-8000-00000000000a';
const FEATURE_B = '019ffe00-0000-7000-8000-00000000000b';
const FEATURE_C = '019ffe00-0000-7000-8000-00000000000c';

function makeInputs(params: {
  selectedFeatureIds?: readonly string[];
  estimates?: Readonly<Record<string, number | null>>;
  pointsPerSprint?: number | null;
  sprintLengthDays?: number | null;
  startSprintOrdinal?: number | null;
  startDate?: string | null;
  parallelGroups?: readonly Readonly<{ featureIds: readonly string[] }>[];
  policyVersion?: string;
  roster?: readonly { id: string; name: string; weightUnits: number }[];
  assignments?: Readonly<Record<string, readonly string[]>>;
} = {}): ForecastInputs {
  const ids = params.selectedFeatureIds ?? [FEATURE_A, FEATURE_B];
  return Object.freeze({
    projectId: PROJECT_ID,
    projectRevision: 7,
    policyVersion: (params.policyVersion ?? 'shared-capacity-v1') as 'shared-capacity-v1',
    selectedFeatureIds: Object.freeze([...ids]),
    estimates: Object.freeze(params.estimates ?? { [FEATURE_A]: 15, [FEATURE_B]: 10 }),
    pointsPerSprint: params.pointsPerSprint !== undefined ? params.pointsPerSprint : 10,
    sprintLengthDays: params.sprintLengthDays !== undefined ? params.sprintLengthDays : 14,
    startSprintOrdinal: params.startSprintOrdinal !== undefined ? params.startSprintOrdinal : 12,
    startDate: params.startDate !== undefined ? params.startDate : '2026-09-07',
    parallelGroups: Object.freeze([...(params.parallelGroups ?? [])]),
    blockedFeatureIds: Object.freeze([]),
    roster: Object.freeze([...(params.roster ?? [])]),
    assignments: Object.freeze({ ...(params.assignments ?? {}) }),
  });
}

function arithmeticOf(result: ForecastResult): ForecastArithmetic {
  if (!result.arithmetic) throw new Error('expected arithmetic');
  return result.arithmetic;
}

describe('explainForecast', () => {
  it('returns an empty explanation for a null or non-ready result', async () => {
    expect(explainForecast(null).answer).toBeNull();

    const incomplete = await calculateForecast(makeInputs({ pointsPerSprint: null }));
    const explanation = explainForecast(incomplete);
    expect(explanation.answer).toBeNull();
    expect(explanation.reasons).toHaveLength(0);
    expect(explanation.exactFinish).toBeNull();
  });

  it('AC 26.1-1/-2: leads with the sprint and full readable date for a ready shared plan', async () => {
    const result = await calculateForecast(makeInputs());
    const explanation = explainForecast(result);
    expect(explanation.answer).not.toBeNull();
    expect(explanation.answer!.sprint).toBe(arithmeticOf(result).completionSprint);
    expect(explanation.answer!.isoDate).toBe(arithmeticOf(result).completionDate);
    // A full readable date, never an ISO string in the lead card.
    expect(explanation.answer!.date).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it('AC 26.1-2: states rank order and whole-team pacing for a sequential shared plan', async () => {
    const result = await calculateForecast(makeInputs());
    const explanation = explainForecast(result);
    const text = explanation.reasons.map((r) => r.text).join(' ');
    expect(text).toContain('rank order');
    expect(text).toContain('10 pts/sprint');
    expect(text).not.toContain('shared-capacity-v1');
  });

  it('AC 26.1-2: names parallel groups when a plan has them', async () => {
    const result = await calculateForecast(
      makeInputs({ parallelGroups: [{ featureIds: [FEATURE_A, FEATURE_B] }] }),
    );
    const text = explainForecast(result).reasons.map((r) => r.text).join(' ');
    expect(text).toContain('parallel group');
    expect(text).toContain('side by side');
  });

  it('AC 26.1-2: paces by the assigned share in staffed mode and never prints a policy id', async () => {
    const result = await calculateForecast(
      makeInputs({
        policyVersion: 'staffed-capacity-v1',
        roster: [
          { id: '019ffe00-0000-7000-8000-0000000000a1', name: 'Ada', weightUnits: 100 },
          { id: '019ffe00-0000-7000-8000-0000000000a2', name: 'Ben', weightUnits: 100 },
        ],
        assignments: {
          [FEATURE_A]: ['019ffe00-0000-7000-8000-0000000000a1'],
          [FEATURE_B]: ['019ffe00-0000-7000-8000-0000000000a2'],
        },
      }),
    );
    const explanation = explainForecast(result);
    const text = explanation.reasons.map((r) => r.text).join(' ');
    expect(text).toContain("assigned people's share");
    expect(text).not.toContain('staffed-capacity-v1');
    expect(explanation.answer).not.toBeNull();
  });

  it('AC 26.1-2: gives the exact work-done date when the sprint rounds past it', async () => {
    // 15 points at 10/sprint = 1.5 sprints → exact finish mid-sprint, rounded
    // to the end of Sprint 2. The two dates differ, so the exact date shows.
    const result = await calculateForecast(
      makeInputs({ selectedFeatureIds: [FEATURE_A], estimates: { [FEATURE_A]: 15 } }),
    );
    const explanation = explainForecast(result);
    expect(explanation.exactFinish).not.toBeNull();
    expect(explanation.exactFinish!.isoDate).not.toBe(arithmeticOf(result).completionDate);
    const text = explanation.reasons.map((r) => r.text).join(' ');
    expect(text).toContain('Work is done');
    expect(text).toContain(`end of Sprint ${arithmeticOf(result).completionSprint}`);
  });

  it('AC 26.1-2: omits the exact date when work lands exactly on the sprint boundary', async () => {
    const result = await calculateForecast(
      makeInputs({ selectedFeatureIds: [FEATURE_A], estimates: { [FEATURE_A]: 20 } }),
    );
    const explanation = explainForecast(result);
    expect(explanation.exactFinish).toBeNull();
    expect(explanation.reasons.map((r) => r.key)).not.toContain('exact-finish');
  });

  it('AC 26.1-2: explains a conditional (blocked) plan without inventing a delay', () => {
    const result: ForecastResult = Object.freeze({
      state: 'conditional',
      projectId: PROJECT_ID,
      projectRevision: 7,
      policyVersion: 'shared-capacity-v1',
      materialFingerprint: 'a'.repeat(64),
      coverage: Object.freeze({ selectedCount: 1, estimatedCount: 1, ratio: Object.freeze({ numerator: 1, denominator: 1 }) }),
      totalKnownPoints: 10,
      arithmetic: Object.freeze({
        totalPoints: 10,
        pointsPerSprint: 10,
        requiredSprints: Object.freeze({ numerator: 1, denominator: 1 }),
        occupiedSprints: 1,
        completionSprint: 12,
        completionDate: '2026-09-20',
        sprintLengthDays: 14,
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
      }),
      assumptions: createForecastAssumptions('sequential-only', 'shared-capacity-v1'),
      issues: Object.freeze([]),
      allocation: Object.freeze({
        timelines: Object.freeze([
          Object.freeze({
            featureId: FEATURE_A,
            estimate: 10,
            isMilestone: false,
            startOffset: Object.freeze({ numerator: 0, denominator: 1 }),
            finishOffset: Object.freeze({ numerator: 1, denominator: 1 }),
            startSprintOrdinal: 12,
            completionSprintOrdinal: 12,
            startDate: '2026-09-07',
            completionDate: '2026-09-20',
            parallelGroupIndex: null,
          }),
        ]),
        events: Object.freeze([]),
      }),
    });
    const explanation = explainForecast(result);
    expect(explanation.answer).not.toBeNull();
    const text = explanation.reasons.map((r) => r.text).join(' ');
    expect(text).toContain('blocked item');
    expect(text).toContain('no delay assumed');
  });

  it('is deterministic and free of policy IDs and ratio strings', async () => {
    const result = await calculateForecast(makeInputs({ parallelGroups: [] }));
    const a = explainForecast(result);
    const b = explainForecast(result);
    expect(a).toEqual(b);
    const all = [a.answer?.date, ...a.reasons.map((r) => r.text)].join(' ');
    expect(all).not.toMatch(/\d+\/\d+/);
    expect(all).not.toContain('-v1');
  });
});
