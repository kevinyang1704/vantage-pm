import { describe, expect, it } from 'vitest';
import { calculateForecast } from '../../domain/forecast/whole-set.policy';
import type { ForecastInputs } from '../../domain/forecast/forecast-result';
import { personLanes, LANE_PAGE_SIZE } from './forecast-lanes';

const PROJECT_ID = '019ffe00-0000-7000-8000-000000000001';
const FEATURE_A = '019ffe00-0000-7000-8000-00000000000a';
const FEATURE_B = '019ffe00-0000-7000-8000-00000000000b';
const ADA = '019ffe00-0000-7000-8000-0000000000a1';
const BEN = '019ffe00-0000-7000-8000-0000000000a2';

function makeInputs(params: {
  estimates?: Readonly<Record<string, number | null>>;
  parallelGroups?: readonly Readonly<{ featureIds: readonly string[] }>[];
  roster?: readonly { id: string; name: string; weightUnits: number }[];
  assignments?: Readonly<Record<string, readonly string[]>>;
  policyVersion?: string;
} = {}): ForecastInputs {
  return Object.freeze({
    projectId: PROJECT_ID,
    projectRevision: 1,
    policyVersion: (params.policyVersion ?? 'staffed-capacity-v1') as 'staffed-capacity-v1',
    selectedFeatureIds: Object.freeze([FEATURE_A, FEATURE_B]),
    estimates: Object.freeze(params.estimates ?? { [FEATURE_A]: 10, [FEATURE_B]: 10 }),
    pointsPerSprint: 20,
    sprintLengthDays: 14,
    startSprintOrdinal: 12,
    startDate: '2026-09-07',
    parallelGroups: Object.freeze([...(params.parallelGroups ?? [])]),
    blockedFeatureIds: Object.freeze([]),
    roster: Object.freeze(
      params.roster ?? [
        { id: ADA, name: 'Ada', weightUnits: 100 },
        { id: BEN, name: 'Ben', weightUnits: 100 },
      ],
    ),
    assignments: Object.freeze(
      params.assignments ?? { [FEATURE_A]: [ADA], [FEATURE_B]: [BEN] },
    ),
  });
}

const ROSTER = [
  { id: ADA, name: 'Ada', weightUnits: 100 },
  { id: BEN, name: 'Ben', weightUnits: 100 },
];

describe('personLanes', () => {
  it('AC 26.3-2: per-person idle point-equivalents sum to the reported idle capacity (sequential)', async () => {
    const result = await calculateForecast(makeInputs());
    const view = personLanes(result, ROSTER);
    const reported = result.arithmetic!.idleCapacityPoints!;
    expect(view.lanes).toHaveLength(2);
    // Exact rational equality with the result's own idle capacity.
    expect(view.totalIdlePoints.numerator * reported.denominator).toBe(
      reported.numerator * view.totalIdlePoints.denominator,
    );
  });

  it('AC 26.3-2: the idle sum still matches for a parallel-group plan', async () => {
    const result = await calculateForecast(
      makeInputs({ parallelGroups: [{ featureIds: [FEATURE_A, FEATURE_B] }] }),
    );
    const view = personLanes(result, ROSTER);
    const reported = result.arithmetic!.idleCapacityPoints!;
    expect(view.totalIdlePoints.numerator * reported.denominator).toBe(
      reported.numerator * view.totalIdlePoints.denominator,
    );
  });

  it('AC 26.3-1: a lane has busy segments from its items and an idle gap', async () => {
    const result = await calculateForecast(makeInputs());
    const view = personLanes(result, ROSTER);
    const ada = view.lanes.find((l) => l.personId === ADA)!;
    expect(ada.segments.some((s) => s.kind === 'busy' && s.featureId === FEATURE_A)).toBe(true);
    expect(ada.text).toContain('Ada: busy on');
  });

  it('AC 26.3-3: shared mode shows one whole-team lane through the exact finish', async () => {
    const result = await calculateForecast(
      makeInputs({ policyVersion: 'shared-capacity-v1', roster: [], assignments: {} }),
    );
    const view = personLanes(result, []);
    expect(view.mode).toBe('whole-team');
    expect(view.lanes).toHaveLength(1);
    expect(view.lanes[0].name).toBe('Whole team');
    expect(view.lanes[0].segments[0].kind).toBe('busy');
  });

  it('AC 26.3-4: exposes a 12-lane page size', () => {
    expect(LANE_PAGE_SIZE).toBe(12);
  });

  it('treats a person with no work as an entirely idle lane', async () => {
    const result = await calculateForecast(makeInputs());
    const view = personLanes(result, [...ROSTER, { id: '019ffe00-0000-7000-8000-0000000000a3', name: 'Cara', weightUnits: 100 }]);
    const cara = view.lanes.find((l) => l.name === 'Cara')!;
    expect(cara.entirelyIdle).toBe(true);
    expect(cara.segments[0].kind).toBe('idle');
  });

  it('returns an empty view for a null result', () => {
    expect(personLanes(null, ROSTER).lanes).toHaveLength(0);
  });
});
