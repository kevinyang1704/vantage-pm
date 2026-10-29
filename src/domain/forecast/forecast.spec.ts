import { describe, expect, it } from 'vitest';
import {
  createEmptyForecastPlan,
  createForecastPlan,
  createForecastConfiguration,
  FORECAST_POLICY_VERSION,
  FORECAST_CADENCE,
} from './forecast-plan.entity';
import {
  validatePoints,
  validateCapacity,
  validateSprintLength,
  validateStartOrdinal,
  validateStartDate,
  validateForecastScope,
  validateForecastGroups,
  validatePolicyVersion,
  isFiniteNonNegativeSafeInteger,
  isPositiveSafeInteger,
  isValidIsoDateOnly,
} from './forecast-validators';
import {
  gcd,
  reduceRatio,
  formatRatio,
  sortIdsLexically,
  canonicalizeForecast,
  computeForecastFingerprint,
} from './forecast-canonical';
import {
  createConfigureForecastPlanCommand,
  createRemoveForecastPlanCommand,
  createSetForecastMembershipCommand,
} from './forecast.commands';
import type { Node } from '../tree/node.entity';

const PROJECT_ID = '019ffe00-0000-7000-8000-000000000001';
const FEATURE_A = '019ffe00-0000-7000-8000-00000000000a';
const FEATURE_B = '019ffe00-0000-7000-8000-00000000000b';
const FEATURE_C = '019ffe00-0000-7000-8000-00000000000c';
const THEME = '019ffe00-0000-7000-8000-00000000000d';

function featureNode(id: string, parentId: string | null = null, effortPoints: number | null = null): Node {
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

describe('ForecastPlan entity (Story 18.1 AC1)', () => {
  it('creates an empty plan with explicit nullable configuration, empty scope, empty groups, and the supported policy version', () => {
    const plan = createEmptyForecastPlan(PROJECT_ID);
    expect(plan.projectId).toBe(PROJECT_ID);
    expect(plan.selectedFeatureIds).toEqual([]);
    expect(plan.parallelGroups).toEqual([]);
    expect(plan.configuration).toEqual({
      pointsPerSprint: null,
      sprintLengthDays: null,
      cadence: FORECAST_CADENCE,
      startSprintOrdinal: null,
      startDate: null,
    });
    expect(plan.policyVersion).toBe(FORECAST_POLICY_VERSION);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.configuration)).toBe(true);
  });

  it('freezes nested collections on reconstruction', () => {
    const plan = createForecastPlan({
      projectId: PROJECT_ID,
      selectedFeatureIds: [FEATURE_A, FEATURE_B],
      parallelGroups: [{ featureIds: [FEATURE_A, FEATURE_B] }],
    });
    expect(Object.isFrozen(plan.selectedFeatureIds)).toBe(true);
    expect(Object.isFrozen(plan.parallelGroups)).toBe(true);
    expect(Object.isFrozen(plan.parallelGroups[0].featureIds)).toBe(true);
  });

  it('rejects a non-UUIDv7 project id', () => {
    expect(() => createEmptyForecastPlan('not-a-uuid')).toThrow();
  });
});

describe('Forecast numeric validators (Story 18.1 AC2)', () => {
  it('accepts finite non-negative safe integers for points and capacity', () => {
    expect(isFiniteNonNegativeSafeInteger(0)).toBe(true);
    expect(isFiniteNonNegativeSafeInteger(25)).toBe(true);
    expect(isFiniteNonNegativeSafeInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(validatePoints(25, 'points')).toBeNull();
    expect(validateCapacity(10, 'capacity')).toBeNull();
    expect(validatePoints(null, 'points')).toBeNull();
  });

  it('rejects NaN, infinity, negatives, fractions, and unsafe integers without coercion', () => {
    for (const bad of [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '25', '']) {
      expect(validatePoints(bad, 'points')).not.toBeNull();
      expect(validateCapacity(bad, 'capacity')).not.toBeNull();
    }
  });

  it('accepts only positive safe integers for sprint length and start ordinal', () => {
    expect(isPositiveSafeInteger(14)).toBe(true);
    expect(validateSprintLength(14, 'sprintLengthDays')).toBeNull();
    expect(validateStartOrdinal(12, 'startSprintOrdinal')).toBeNull();
    expect(validateSprintLength(0, 'sprintLengthDays')).not.toBeNull();
    expect(validateStartOrdinal(0, 'startSprintOrdinal')).not.toBeNull();
    expect(validateSprintLength(-7, 'sprintLengthDays')).not.toBeNull();
    expect(validateStartOrdinal(1.5, 'startSprintOrdinal')).not.toBeNull();
  });

  it('accepts strict ISO date-only values and rejects anything else', () => {
    expect(isValidIsoDateOnly('2026-09-07')).toBe(true);
    expect(validateStartDate('2026-09-07', 'startDate')).toBeNull();
    expect(validateStartDate(null, 'startDate')).toBeNull();
    for (const bad of ['2026-9-7', '2026-13-01', '2026-02-30', '2026-09-07T00:00:00Z', 'tomorrow', 20260907]) {
      expect(validateStartDate(bad, 'startDate')).not.toBeNull();
    }
  });
});

describe('Forecast scope validation (Story 18.1 AC3, AC4)', () => {
  const nodes = [
    featureNode(FEATURE_A, null, 5),
    featureNode(FEATURE_B, null, 10),
    featureNode(FEATURE_C, FEATURE_A, 3),
    Object.freeze({ ...featureNode(THEME, null, null), nodeType: 'Theme' }),
  ];

  it('accepts a valid same-project Feature scope', () => {
    expect(validateForecastScope([FEATURE_A, FEATURE_B], nodes, PROJECT_ID)).toEqual([]);
  });

  it('names foreign and non-Feature members without mutation', () => {
    const issues = validateForecastScope([FEATURE_A, '019ffe00-0000-7000-8000-0000000000ff', THEME], nodes, PROJECT_ID);
    expect(issues.some((i) => i.code === 'FOREIGN_FEATURE')).toBe(true);
    expect(issues.some((i) => i.code === 'NOT_A_FEATURE')).toBe(true);
  });

  it('rejects duplicate members', () => {
    const issues = validateForecastScope([FEATURE_A, FEATURE_A], nodes, PROJECT_ID);
    expect(issues.some((i) => i.code === 'DUPLICATE_MEMBER')).toBe(true);
  });

  it('rejects parent/descendant overlap by name without automatic exclusion', () => {
    const issues = validateForecastScope([FEATURE_A, FEATURE_C], nodes, PROJECT_ID);
    expect(issues.some((i) => i.code === 'OVERLAPPING_SCOPE')).toBe(true);
    expect(issues[0].featureIds).toContain(FEATURE_A);
    expect(issues[0].featureIds).toContain(FEATURE_C);
  });

  it('keeps a deleted/retyped selected node visible as an invalid reference', () => {
    const issues = validateForecastScope([FEATURE_A, '019ffe00-0000-7000-8000-0000000000ff'], nodes, PROJECT_ID);
    expect(issues.some((i) => i.code === 'FOREIGN_FEATURE' && i.featureIds?.[0] === '019ffe00-0000-7000-8000-0000000000ff')).toBe(true);
  });
});

describe('Forecast group validation (Story 18.1, AR-5, AR-18)', () => {
  it('accepts disjoint contiguous groups', () => {
    expect(
      validateForecastGroups([FEATURE_A, FEATURE_B, FEATURE_C], [{ featureIds: [FEATURE_A, FEATURE_B] }]),
    ).toEqual([]);
  });

  it('rejects singleton, overlapping, and noncontiguous groups', () => {
    expect(validateForecastGroups([FEATURE_A, FEATURE_B], [{ featureIds: [FEATURE_A] }]).length).toBeGreaterThan(0);
    expect(
      validateForecastGroups(
        [FEATURE_A, FEATURE_B, FEATURE_C],
        [
          { featureIds: [FEATURE_A, FEATURE_B] },
          { featureIds: [FEATURE_B, FEATURE_C] },
        ],
      ).length,
    ).toBeGreaterThan(0);
    expect(
      validateForecastGroups([FEATURE_A, FEATURE_B, FEATURE_C], [{ featureIds: [FEATURE_A, FEATURE_C] }]).length,
    ).toBeGreaterThan(0);
  });

  it('rejects members outside scope', () => {
    expect(
      validateForecastGroups([FEATURE_A, FEATURE_B], [{ featureIds: [FEATURE_A, FEATURE_C] }]).length,
    ).toBeGreaterThan(0);
  });
});

describe('Forecast policy validation', () => {
  it('accepts the supported policy and rejects unknown versions', () => {
    expect(validatePolicyVersion('shared-capacity-v1')).toBeNull();
    expect(validatePolicyVersion('shared-capacity-v2')).not.toBeNull();
    expect(validatePolicyVersion(undefined)).not.toBeNull();
  });
});

describe('Forecast canonical serialization (Story 18.1 AC5, AR-16)', () => {
  it('reduces ratios by GCD with a positive denominator', () => {
    expect(reduceRatio(25, 10)).toEqual({ numerator: 5, denominator: 2 });
    expect(reduceRatio(0, 10)).toEqual({ numerator: 0, denominator: 1 });
    expect(reduceRatio(20, 20)).toEqual({ numerator: 1, denominator: 1 });
    expect(formatRatio(reduceRatio(25, 10))).toBe('5/2');
  });

  it('computes GCD correctly', () => {
    expect(gcd(25, 10)).toBe(5);
    expect(gcd(0, 10)).toBe(10);
    expect(gcd(7, 3)).toBe(1);
  });

  it('sorts unordered ID arrays lexically', () => {
    expect(sortIdsLexically([FEATURE_C, FEATURE_A, FEATURE_B])).toEqual([FEATURE_A, FEATURE_B, FEATURE_C]);
  });

  it('produces identical canonical bytes regardless of object-key insertion order', () => {
    const a = canonicalizeForecast({ b: 1, a: [FEATURE_B, FEATURE_A] });
    const b = canonicalizeForecast({ a: [FEATURE_B, FEATURE_A], b: 1 });
    expect(a).toBe(b);
  });

  it('serializes explicit nulls, never omits them', () => {
    const withNull = canonicalizeForecast({ pointsPerSprint: null });
    expect(withNull).toContain('null');
  });

  it('computes a stable lowercase-hex SHA-256 fingerprint', async () => {
    const fp1 = await computeForecastFingerprint({ scope: [FEATURE_A], capacity: 10 });
    const fp2 = await computeForecastFingerprint({ scope: [FEATURE_A], capacity: 10 });
    const fp3 = await computeForecastFingerprint({ scope: [FEATURE_A], capacity: 11 });
    expect(fp1).toBe(fp2);
    expect(fp1).not.toBe(fp3);
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Forecast domain commands (Story 18.1 Task 3)', () => {
  it('builds one atomic ConfigureForecastPlan command covering the complete configuration group', () => {
    const cmd = createConfigureForecastPlanCommand({
      commandId: '019ffe00-0000-7000-8000-0000000000e1',
      projectId: PROJECT_ID,
      baseRevision: 4,
      pointsPerSprint: 10,
      sprintLengthDays: 14,
      startSprintOrdinal: 12,
      startDate: '2026-09-07',
    });
    expect(cmd.type).toBe('ConfigureForecastPlan');
    expect(cmd.pointsPerSprint).toBe(10);
    expect(cmd.sprintLengthDays).toBe(14);
    expect(cmd.startSprintOrdinal).toBe(12);
    expect(cmd.startDate).toBe('2026-09-07');
    expect(Object.isFrozen(cmd)).toBe(true);
  });

  it('rejects invalid configuration values at construction', () => {
    expect(() =>
      createConfigureForecastPlanCommand({
        commandId: '019ffe00-0000-7000-8000-0000000000e1',
        projectId: PROJECT_ID,
        baseRevision: 0,
        pointsPerSprint: -1,
        sprintLengthDays: 14,
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
      }),
    ).toThrow('INVALID_CAPACITY');
    expect(() =>
      createConfigureForecastPlanCommand({
        commandId: '019ffe00-0000-7000-8000-0000000000e1',
        projectId: PROJECT_ID,
        baseRevision: 0,
        pointsPerSprint: 10,
        sprintLengthDays: 0,
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
      }),
    ).toThrow('INVALID_SPRINT_LENGTH');
  });

  it('carries an optional planning level for atomic creation and defaults to null (Story 21.13 D5)', () => {
    const withLevel = createConfigureForecastPlanCommand({
      commandId: '019ffe00-0000-7000-8000-0000000000e1',
      projectId: PROJECT_ID,
      baseRevision: 4,
      pointsPerSprint: 10,
      sprintLengthDays: 14,
      startSprintOrdinal: 12,
      startDate: '2026-09-07',
      planningLevel: 'Theme',
    });
    expect(withLevel.planningLevel).toBe('Theme');
    const withoutLevel = createConfigureForecastPlanCommand({
      commandId: '019ffe00-0000-7000-8000-0000000000e1',
      projectId: PROJECT_ID,
      baseRevision: 4,
      pointsPerSprint: 10,
      sprintLengthDays: 14,
      startSprintOrdinal: 12,
      startDate: '2026-09-07',
    });
    expect(withoutLevel.planningLevel).toBeNull();
    expect(() =>
      createConfigureForecastPlanCommand({
        commandId: '019ffe00-0000-7000-8000-0000000000e1',
        projectId: PROJECT_ID,
        baseRevision: 4,
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
        // Deliberately invalid runtime value — the constructor must reject it
        // even though the static type excludes it (INVALID_PLANNING_LEVEL).
        planningLevel: 'Epic' as unknown as import('./forecast-plan.entity').ForecastNodeLevel,
      }),
    ).toThrow('INVALID_PLANNING_LEVEL');
  });

  it('builds the RemoveForecastPlan creation inverse (Story 21.13 D5)', () => {
    const cmd = createRemoveForecastPlanCommand({
      commandId: '019ffe00-0000-7000-8000-0000000000e3',
      projectId: PROJECT_ID,
      baseRevision: 2,
    });
    expect(cmd.type).toBe('RemoveForecastPlan');
    expect(cmd.baseRevision).toBe(2);
    expect(Object.isFrozen(cmd)).toBe(true);
    expect(() =>
      createRemoveForecastPlanCommand({
        commandId: '019ffe00-0000-7000-8000-0000000000e3',
        projectId: PROJECT_ID,
        baseRevision: -1,
      }),
    ).toThrow('INVALID_BASE_REVISION');
  });

  it('builds a SetForecastMembership command with append-by-default semantics', () => {
    const cmd = createSetForecastMembershipCommand({
      commandId: '019ffe00-0000-7000-8000-0000000000e2',
      projectId: PROJECT_ID,
      baseRevision: 5,
      featureId: FEATURE_A,
      included: true,
    });
    expect(cmd.type).toBe('SetForecastMembership');
    expect(cmd.featureId).toBe(FEATURE_A);
    expect(cmd.included).toBe(true);
  });

  it('rejects a non-UUIDv7 feature id', () => {
    expect(() =>
      createSetForecastMembershipCommand({
        commandId: '019ffe00-0000-7000-8000-0000000000e2',
        projectId: PROJECT_ID,
        baseRevision: 0,
        featureId: 'nope',
        included: true,
      }),
    ).toThrow();
  });
});

describe('Forecast configuration factory', () => {
  it('preserves explicit nulls and the fixed cadence', () => {
    const config = createForecastConfiguration({
      pointsPerSprint: null,
      sprintLengthDays: 14,
      startSprintOrdinal: null,
      startDate: null,
    });
    expect(config.pointsPerSprint).toBeNull();
    expect(config.sprintLengthDays).toBe(14);
    expect(config.cadence).toBe(FORECAST_CADENCE);
  });
});
