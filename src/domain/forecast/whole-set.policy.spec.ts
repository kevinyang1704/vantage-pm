import { describe, expect, it } from 'vitest';
import { calculateForecast } from './whole-set.policy';
import { normalizeForecastInputs } from './forecast-normalization';
import { createForecastPlan, createForecastConfiguration } from './forecast-plan.entity';
import type { ForecastInputs } from './forecast-result';
import type { Node } from '../tree/node.entity';

const PROJECT_ID = '019ffe00-0000-7000-8000-000000000001';
const FEATURE_A = '019ffe00-0000-7000-8000-00000000000a';
const FEATURE_B = '019ffe00-0000-7000-8000-00000000000b';
const FEATURE_C = '019ffe00-0000-7000-8000-00000000000c';

function featureNode(id: string, effortPoints: number | null, parentId: string | null = null): Node {
  return Object.freeze({
    id,
    projectId: PROJECT_ID,
    parentId,
    title: `Feature ${id}`,
    bodyText: null,
    position: 4294967296n,
    nodeType: 'Feature',
    startDate: null,
    endDate: null,
    durationDays: null,
    scheduleSourceMode: null,
    completed: false,
    effortPoints,
    effortPointsDone: null,
    strategicWeight: null,
    phaseId: null,
    deliveryStatus: 'not_started',
  });
}

function makeInputs(params: {
  selectedFeatureIds?: readonly string[];
  estimates?: Readonly<Record<string, number | null>>;
  pointsPerSprint?: number | null;
  sprintLengthDays?: number | null;
  startSprintOrdinal?: number | null;
  startDate?: string | null;
  parallelGroups?: readonly Readonly<{ featureIds: readonly string[] }>[];
  blockedFeatureIds?: readonly string[];
  policyVersion?: string;
} = {}): ForecastInputs {
  const ids = params.selectedFeatureIds ?? [FEATURE_A, FEATURE_B];
  return Object.freeze({
    projectId: PROJECT_ID,
    projectRevision: 7,
    policyVersion: (params.policyVersion ?? 'shared-capacity-v1') as 'shared-capacity-v1',
    selectedFeatureIds: Object.freeze([...ids]),
    estimates: Object.freeze(
      params.estimates ?? {
        [FEATURE_A]: 15,
        [FEATURE_B]: 10,
      },
    ),
    pointsPerSprint: params.pointsPerSprint !== undefined ? params.pointsPerSprint : 10,
    sprintLengthDays: params.sprintLengthDays !== undefined ? params.sprintLengthDays : 14,
    startSprintOrdinal: params.startSprintOrdinal !== undefined ? params.startSprintOrdinal : 12,
    startDate: params.startDate !== undefined ? params.startDate : '2026-09-07',
    parallelGroups: Object.freeze(params.parallelGroups ?? []),
    blockedFeatureIds: Object.freeze(params.blockedFeatureIds ?? []),
  });
}

describe('Whole-set forecast golden (Story 18.3 AC1)', () => {
  it('P=25, C=10, 14-day sprints, Sprint 12 on 2026-09-07 → 5/2, 3 sprints, Sprint 14, 2026-10-18', async () => {
    const result = await calculateForecast(
      makeInputs({
        selectedFeatureIds: [FEATURE_A, FEATURE_B],
        estimates: { [FEATURE_A]: 15, [FEATURE_B]: 10 },
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
      }),
    );
    expect(result.state).toBe('ready');
    expect(result.totalKnownPoints).toBe(25);
    expect(result.arithmetic).not.toBeNull();
    expect(result.arithmetic!.requiredSprints).toEqual({ numerator: 5, denominator: 2 });
    expect(result.arithmetic!.occupiedSprints).toBe(3);
    expect(result.arithmetic!.completionSprint).toBe(14);
    expect(result.arithmetic!.completionDate).toBe('2026-10-18');
  });

  it('20 points completes in Sprint 13 on 2026-10-04', async () => {
    const result = await calculateForecast(
      makeInputs({
        selectedFeatureIds: [FEATURE_A, FEATURE_B],
        estimates: { [FEATURE_A]: 10, [FEATURE_B]: 10 },
      }),
    );
    expect(result.state).toBe('ready');
    expect(result.arithmetic!.occupiedSprints).toBe(2);
    expect(result.arithmetic!.completionSprint).toBe(13);
    expect(result.arithmetic!.completionDate).toBe('2026-10-04');
  });

  it('two 5-point Features at capacity 10 take one sprint', async () => {
    const result = await calculateForecast(
      makeInputs({
        selectedFeatureIds: [FEATURE_A, FEATURE_B],
        estimates: { [FEATURE_A]: 5, [FEATURE_B]: 5 },
      }),
    );
    expect(result.state).toBe('ready');
    expect(result.arithmetic!.occupiedSprints).toBe(1);
    expect(result.arithmetic!.completionSprint).toBe(12);
    expect(result.arithmetic!.completionDate).toBe('2026-09-20');
  });
});

describe('Whole-set typed states (Story 18.3 AC2, AC4, AR-10, AR-11)', () => {
  it('withholds every timeline when any selected estimate is missing, retaining known totals and issues', async () => {
    const result = await calculateForecast(
      makeInputs({
        selectedFeatureIds: [FEATURE_A, FEATURE_B],
        estimates: { [FEATURE_A]: 15, [FEATURE_B]: null },
      }),
    );
    expect(result.state).toBe('incomplete');
    expect(result.totalKnownPoints).toBe(15);
    expect(result.arithmetic).toBeNull();
    expect(result.coverage.estimatedCount).toBe(1);
    expect(result.issues.some((i) => i.code === 'MISSING_ESTIMATE')).toBe(true);
  });

  it('empty scope is a distinct terminal state with explicit empty coverage', async () => {
    const result = await calculateForecast(makeInputs({ selectedFeatureIds: [], estimates: {} }));
    expect(result.state).toBe('empty');
    expect(result.totalKnownPoints).toBe(0);
    expect(result.arithmetic).toBeNull();
    expect(result.coverage.ratio).toEqual({ numerator: 0, denominator: 1 });
  });

  it('nonempty all-zero work is a distinct zero-work state with no sprint consumed', async () => {
    const result = await calculateForecast(
      makeInputs({
        selectedFeatureIds: [FEATURE_A, FEATURE_B],
        estimates: { [FEATURE_A]: 0, [FEATURE_B]: 0 },
      }),
    );
    expect(result.state).toBe('zero-work');
    expect(result.arithmetic!.requiredSprints).toEqual({ numerator: 0, denominator: 1 });
    expect(result.arithmetic!.occupiedSprints).toBe(0);
    expect(result.arithmetic!.completionSprint).toBe(12);
    expect(result.arithmetic!.completionDate).toBe('2026-09-07');
  });

  it('absent capacity is incomplete, never a fallback velocity', async () => {
    const result = await calculateForecast(makeInputs({ pointsPerSprint: null }));
    expect(result.state).toBe('incomplete');
    expect(result.arithmetic).toBeNull();
    expect(result.issues.some((i) => i.code === 'MISSING_CAPACITY')).toBe(true);
  });

  it('zero capacity is invalid, never infinity', async () => {
    const result = await calculateForecast(makeInputs({ pointsPerSprint: 0 }));
    expect(result.state).toBe('invalid');
    expect(result.arithmetic).toBeNull();
    expect(result.issues.some((i) => i.code === 'ZERO_CAPACITY')).toBe(true);
  });

  it('unsupported policy fails closed', async () => {
    const result = await calculateForecast(makeInputs({ policyVersion: 'shared-capacity-v2' }));
    expect(result.state).toBe('invalid');
    expect(result.issues.some((i) => i.code === 'UNSUPPORTED_POLICY')).toBe(true);
  });

  it('invalid configuration values produce typed invalid state', async () => {
    const result = await calculateForecast(makeInputs({ sprintLengthDays: 0 }));
    expect(result.state).toBe('invalid');
    expect(result.issues.some((i) => i.code === 'INVALID_SPRINT_LENGTH')).toBe(true);
  });

  it('noncontiguous parallel groups are invalid (allocation unsupported until Epic 19)', async () => {
    const result = await calculateForecast(
      makeInputs({
        selectedFeatureIds: [FEATURE_A, FEATURE_B, FEATURE_C],
        estimates: { [FEATURE_A]: 5, [FEATURE_B]: 5, [FEATURE_C]: 5 },
        parallelGroups: [{ featureIds: [FEATURE_A, FEATURE_C] }],
      }),
    );
    expect(result.state).toBe('invalid');
    expect(result.issues.some((i) => i.code === 'INVALID_GROUP')).toBe(true);
  });
});

describe('Whole-set determinism (Story 18.3 AC5, NFR-1)', () => {
  it('identical normalized inputs produce identical canonical result bytes', async () => {
    const a = await calculateForecast(makeInputs());
    const b = await calculateForecast(makeInputs());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('material fingerprint is stable and revision-independent for unchanged facts', async () => {
    const a = await calculateForecast(makeInputs());
    const b = await calculateForecast(makeInputs());
    expect(a.materialFingerprint).toBe(b.materialFingerprint);
    expect(a.materialFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ratios have positive reduced denominators', async () => {
    const result = await calculateForecast(makeInputs());
    expect(result.arithmetic!.requiredSprints.denominator).toBeGreaterThan(0);
  });
});

describe('Whole-set properties (Story 18.3 Task 3)', () => {
  it('increasing P cannot shorten the completion', async () => {
    const small = await calculateForecast(makeInputs({ estimates: { [FEATURE_A]: 5, [FEATURE_B]: 5 } }));
    const large = await calculateForecast(makeInputs({ estimates: { [FEATURE_A]: 15, [FEATURE_B]: 15 } }));
    expect(large.arithmetic!.occupiedSprints).toBeGreaterThanOrEqual(small.arithmetic!.occupiedSprints);
  });

  it('increasing positive C cannot lengthen the completion', async () => {
    const low = await calculateForecast(makeInputs({ pointsPerSprint: 5 }));
    const high = await calculateForecast(makeInputs({ pointsPerSprint: 25 }));
    expect(high.arithmetic!.occupiedSprints).toBeLessThanOrEqual(low.arithmetic!.occupiedSprints);
  });

  it('crosses a leap-year boundary correctly', async () => {
    const result = await calculateForecast(
      makeInputs({
        startDate: '2028-02-20',
        startSprintOrdinal: 1,
        sprintLengthDays: 14,
        pointsPerSprint: 10,
        estimates: { [FEATURE_A]: 30, [FEATURE_B]: 0 },
      }),
    );
    expect(result.state).toBe('ready');
    // 30/10 = 3 sprints; 3*14 - 1 = 41 days after 2028-02-20 → 2028-04-01
    expect(result.arithmetic!.completionDate).toBe('2028-04-01');
  });

  it('exact-boundary division does not round up', async () => {
    const result = await calculateForecast(
      makeInputs({
        estimates: { [FEATURE_A]: 20, [FEATURE_B]: 0 },
        pointsPerSprint: 10,
      }),
    );
    expect(result.arithmetic!.requiredSprints).toEqual({ numerator: 2, denominator: 1 });
    expect(result.arithmetic!.occupiedSprints).toBe(2);
  });
});

describe('Normalization (Story 18.3 Task 1)', () => {
  it('extracts only relevant facts from a snapshot and plan', () => {
    const nodes = [featureNode(FEATURE_A, 15), featureNode(FEATURE_B, 10)];
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
    const result = normalizeForecastInputs(
      { projectId: PROJECT_ID, projectRevision: 7, nodes },
      plan,
    );
    expect(result.ok).toBe(true);
    expect(result.inputs.estimates[FEATURE_A]).toBe(15);
    expect(result.inputs.estimates[FEATURE_B]).toBe(10);
    expect(result.inputs.projectRevision).toBe(7);
  });

  it('collects scope issues without mutation', () => {
    const nodes = [featureNode(FEATURE_A, 15)];
    const plan = createForecastPlan({
      projectId: PROJECT_ID,
      selectedFeatureIds: [FEATURE_A, '019ffe00-0000-7000-8000-0000000000ff'],
    });
    const result = normalizeForecastInputs(
      { projectId: PROJECT_ID, projectRevision: 7, nodes },
      plan,
    );
    expect(result.ok).toBe(true);
    expect(result.issues.some((i) => i.code === 'FOREIGN_FEATURE')).toBe(true);
  });
});
