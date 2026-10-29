import { describe, expect, it } from 'vitest';
import { calculateForecast } from '../../domain/forecast/whole-set.policy';
import { normalizeForecastInputs } from '../../domain/forecast/forecast-normalization';
import { createForecastPlan, createForecastConfiguration } from '../../domain/forecast/forecast-plan.entity';
import type { Node } from '../../domain/tree/node.entity';
import type { ForecastInputs } from '../../domain/forecast/forecast-result';
import { remainingPoints, asOfOffset } from '../../domain/forecast/forecast-remaining';

const PROJECT_ID = '019ffe00-0000-7000-8000-000000000001';
const FEATURE_A = '019ffe00-0000-7000-8000-00000000000a';
const FEATURE_B = '019ffe00-0000-7000-8000-00000000000b';
const ADA = '019ffe00-0000-7000-8000-0000000000a1';

function node(overrides: Partial<Node> & { id: string }): Node {
  return Object.freeze({
    projectId: PROJECT_ID,
    parentId: null,
    title: `Feature ${overrides.id}`,
    bodyText: null,
    position: 4294967296n,
    nodeType: 'Feature',
    startDate: null,
    endDate: null,
    durationDays: null,
    scheduleSourceMode: null,
    completed: false,
    effortPoints: null,
    effortPointsDone: null,
    strategicWeight: null,
    phaseId: null,
    deliveryStatus: 'not_started',
    ...overrides,
  });
}

function makeInputs(params: {
  estimates?: Readonly<Record<string, number | null>>;
  today?: string;
  asOfOffset?: { numerator: number; denominator: number };
  pointsPerSprint?: number;
  policyVersion?: string;
  roster?: readonly { id: string; name: string; weightUnits: number }[];
  assignments?: Readonly<Record<string, readonly string[]>>;
  selectedFeatureIds?: readonly string[];
} = {}): ForecastInputs {
  return Object.freeze({
    projectId: PROJECT_ID,
    projectRevision: 1,
    policyVersion: (params.policyVersion ?? 'shared-capacity-v1') as 'shared-capacity-v1',
    selectedFeatureIds: Object.freeze([...(params.selectedFeatureIds ?? [FEATURE_A])]),
    estimates: Object.freeze(params.estimates ?? { [FEATURE_A]: 10 }),
    pointsPerSprint: params.pointsPerSprint ?? 10,
    sprintLengthDays: 14,
    startSprintOrdinal: 12,
    startDate: '2026-09-07',
    parallelGroups: Object.freeze([]),
    blockedFeatureIds: Object.freeze([]),
    roster: Object.freeze([...(params.roster ?? [])]),
    assignments: Object.freeze({ ...(params.assignments ?? {}) }),
    ...(params.today !== undefined ? { today: params.today } : {}),
    ...(params.asOfOffset !== undefined ? { asOfOffset: params.asOfOffset } : {}),
  });
}

describe('remainingPoints (AC 26.6-1)', () => {
  it('counts delivered as omitted, in-progress as remaining, not-started as full', () => {
    const out = remainingPoints([
      { id: 'd', status: 'delivered', effortPoints: 20, effortPointsDone: 20 },
      { id: 'ip', status: 'in_progress', effortPoints: 20, effortPointsDone: 11 },
      { id: 'ip0', status: 'in_progress', effortPoints: 20, effortPointsDone: null },
      { id: 'ns', status: 'not_started', effortPoints: 20, effortPointsDone: 5 },
      { id: 'unknown', status: 'in_progress', effortPoints: null, effortPointsDone: 3 },
    ]);
    expect(out.d).toBeUndefined();
    expect(out.ip).toBe(9);
    expect(out.ip0).toBe(20);
    expect(out.ns).toBe(20);
    expect(out.unknown).toBeNull();
  });
});

describe('asOfOffset (AC 26.6-2)', () => {
  it('is the exact fraction of a sprint from the start date', () => {
    expect(asOfOffset('2026-09-14', '2026-09-07', 14)).toEqual({ numerator: 1, denominator: 2 });
  });
  it('is zero at or before the start date', () => {
    expect(asOfOffset('2026-09-07', '2026-09-07', 14)).toEqual({ numerator: 0, denominator: 1 });
    expect(asOfOffset('2026-09-01', '2026-09-07', 14)).toEqual({ numerator: 0, denominator: 1 });
  });
});

describe('forecast from today (AC 26.6-2/-4)', () => {
  it('shifts completion by the as-of offset and is deterministic', async () => {
    const base = makeInputs({ estimates: { [FEATURE_A]: 20 } });
    const asOf = makeInputs({
      estimates: { [FEATURE_A]: 20 },
      today: '2026-09-14',
      asOfOffset: { numerator: 1, denominator: 2 },
    });
    const without = await calculateForecast(base);
    const withToday = await calculateForecast(asOf);
    // 20 pts at 10/sprint = 2 sprints → Sprint 13. With 0.5 as-of: ceil(2.5)=3 → Sprint 14.
    expect(without.arithmetic!.completionSprint).toBe(13);
    expect(withToday.arithmetic!.completionSprint).toBe(14);
    const again = await calculateForecast(asOf);
    expect(again.arithmetic!.completionSprint).toBe(14);
    expect(again.materialFingerprint).toBe(withToday.materialFingerprint);
  });

  it('leaves the forecast unchanged when today is before the start date', async () => {
    const before = makeInputs({
      estimates: { [FEATURE_A]: 20 },
      today: '2026-09-01',
      asOfOffset: { numerator: 0, denominator: 1 },
    });
    const result = await calculateForecast(before);
    expect(result.arithmetic!.completionSprint).toBe(13);
  });
});

describe('normalizeForecastInputs with today (AC 26.6-1)', () => {
  it('drops delivered items, subtracts points done, and computes the as-of offset', () => {
    const nodes = [
      node({ id: FEATURE_A, effortPoints: 20, effortPointsDone: 11, deliveryStatus: 'in_progress' }),
      node({ id: FEATURE_B, effortPoints: 30, effortPointsDone: 30, deliveryStatus: 'delivered' }),
    ];
    const plan = createForecastPlan({
      projectId: PROJECT_ID,
      selectedFeatureIds: [FEATURE_A, FEATURE_B],
      configuration: createForecastConfiguration({
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
      }),
    });
    const { inputs } = normalizeForecastInputs(
      { projectId: PROJECT_ID, projectRevision: 1, nodes },
      plan,
      { today: '2026-09-14', nodes },
    );
    // In-progress keeps only its remaining points and is planned.
    expect(inputs.estimates[FEATURE_A]).toBe(9);
    expect(inputs.selectedFeatureIds).toEqual([FEATURE_A]);
    // The delivered item drops out of the plan and the estimates map entirely.
    expect(inputs.deliveredFeatureIds).toContain(FEATURE_B);
    expect(inputs.selectedFeatureIds).not.toContain(FEATURE_B);
    expect(inputs.estimates[FEATURE_B]).toBeUndefined();
    expect(inputs.asOfOffset).toEqual({ numerator: 1, denominator: 2 });
    expect(inputs.today).toBe('2026-09-14');
  });
});
