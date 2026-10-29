/**
 * Staffing inputs, contracts, and validation specification (Story 22.1, AC 22.1-1..22.1-6).
 *
 * Covers:
 * - AC 22.1-1: Legacy shared plan compatibility and invariant shared material fingerprint
 * - AC 22.1-2: Scaled-integer decimal weight parsing and validation boundaries
 * - AC 22.1-3: Canonical material identity for staffed plans (weights, assignments, idle people material; names non-material; serialization invariant)
 * - AC 22.1-4: Assignment validation (duplicates, unknown people, wrong level, excluded work, zero work, M5 concurrency conflict, M6 sequential reuse, M7 missing assignment)
 * - AC 22.1-5: Level-scoped estimates with zero containment inheritance
 * - AC 22.1-6: Policy validation, unsupported policy rejection, immutability, and structured cloning
 */

import { describe, expect, it } from 'vitest';
import type { Node } from '../tree/node.entity';
import {
  createEmptyForecastPlan,
  createForecastPlan,
  FORECAST_POLICY_VERSION,
  STAFFED_FORECAST_POLICY_VERSION,
  type ForecastPerson,
  type ForecastPlan,
} from './forecast-plan.entity';
import {
  parseStaffingWeightToUnits,
  validateStaffingWeight,
  validateRoster,
  validateStaffingAssignments,
  validatePolicyVersion,
  assertForecastPolicyVersion,
  DEFAULT_STAFFING_WEIGHT_UNITS,
} from './forecast-validators';
import { normalizeForecastInputs } from './forecast-normalization';
import { forecastMaterialFacts } from './whole-set.policy';
import { computeForecastFingerprintSync } from './forecast-canonical';

const PROJECT_ID = '019ffe00-0000-7000-8000-000000000001';
const OTHER_PROJECT_ID = '019ffe00-0000-7000-8000-000000000002';

const PERSON_ADA_ID = '019ffe00-0000-7000-8000-0000000000a1';
const PERSON_BEN_ID = '019ffe00-0000-7000-8000-0000000000b1';
const PERSON_CARA_ID = '019ffe00-0000-7000-8000-0000000000c1';

const THEME_ID = '019ffe00-0000-7000-8000-00000000000d';
const COMPONENT_ID = '019ffe00-0000-7000-8000-00000000000e';
const FEATURE_A_ID = '019ffe00-0000-7000-8000-00000000000a';
const FEATURE_B_ID = '019ffe00-0000-7000-8000-00000000000b';
const FEATURE_C_ID = '019ffe00-0000-7000-8000-00000000000c';

function makeNode(
  id: string,
  nodeType: Node['nodeType'],
  parentId: string | null = null,
  effortPoints: number | null = 10,
): Node {
  return Object.freeze({
    id,
    projectId: PROJECT_ID,
    parentId,
    title: `Node ${id}`,
    bodyText: null,
    position: 4294967296n,
    nodeType,
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

const sampleNodes: readonly Node[] = Object.freeze([
  makeNode(THEME_ID, 'Theme', null, 50),
  makeNode(COMPONENT_ID, 'Component', THEME_ID, 30),
  makeNode(FEATURE_A_ID, 'Feature', COMPONENT_ID, 10),
  makeNode(FEATURE_B_ID, 'Feature', COMPONENT_ID, 20),
  makeNode(FEATURE_C_ID, 'Feature', COMPONENT_ID, 0), // zero-work milestone
]);

const sampleRoster: readonly ForecastPerson[] = Object.freeze([
  Object.freeze({ id: PERSON_ADA_ID, name: 'Ada Lovelace', weightUnits: 100 }),
  Object.freeze({ id: PERSON_BEN_ID, name: 'Ben Bitdiddle', weightUnits: 100 }),
]);

describe('Story 22.1 AC 22.1-1: Shared plan compatibility & invariant shared material fingerprint', () => {
  it('normalizes legacy shared plans lacking staffing fields to shared-capacity-v1 with empty staffing defaults', () => {
    const legacyPlan = createForecastPlan({
      projectId: PROJECT_ID,
      selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID],
      planningLevel: 'Feature',
    });

    const snapshot = { projectId: PROJECT_ID, projectRevision: 1, nodes: sampleNodes };
    const normalized = normalizeForecastInputs(snapshot, legacyPlan);

    expect(normalized.inputs.policyVersion).toBe('shared-capacity-v1');
    expect(normalized.inputs.roster).toEqual([]);
    expect(normalized.inputs.assignments).toEqual({});
  });

  it('preserves identical material fingerprint when inactive roster and assignments are present on a shared plan', () => {
    const plainSharedPlan = createForecastPlan({
      projectId: PROJECT_ID,
      selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID],
      planningLevel: 'Feature',
      policyVersion: 'shared-capacity-v1',
    });

    const sharedWithInactiveStaffing = createForecastPlan({
      projectId: PROJECT_ID,
      selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID],
      planningLevel: 'Feature',
      policyVersion: 'shared-capacity-v1',
      roster: sampleRoster,
      assignments: {
        [FEATURE_A_ID]: [PERSON_ADA_ID],
        [FEATURE_B_ID]: [PERSON_BEN_ID],
      },
    });

    const snapshot = { projectId: PROJECT_ID, projectRevision: 1, nodes: sampleNodes };
    const normPlain = normalizeForecastInputs(snapshot, plainSharedPlan);
    const normWithStaffing = normalizeForecastInputs(snapshot, sharedWithInactiveStaffing);

    const fpPlain = computeForecastFingerprintSync(forecastMaterialFacts(normPlain.inputs));
    const fpWithStaffing = computeForecastFingerprintSync(forecastMaterialFacts(normWithStaffing.inputs));

    expect(fpPlain).toBe(fpWithStaffing);
  });
});

describe('Story 22.1 AC 22.1-2: Scaled-integer decimal weight parsing and validation boundaries', () => {
  it('parses valid decimal values 1, 1.0, 1.00 to 100 units, and 0.10, 0.20 to 10 and 20 units', () => {
    expect(parseStaffingWeightToUnits('1')).toBe(100);
    expect(parseStaffingWeightToUnits('1.0')).toBe(100);
    expect(parseStaffingWeightToUnits('1.00')).toBe(100);
    expect(parseStaffingWeightToUnits('0.10')).toBe(10);
    expect(parseStaffingWeightToUnits('0.20')).toBe(20);
    expect(parseStaffingWeightToUnits('0.2')).toBe(20);
    expect(DEFAULT_STAFFING_WEIGHT_UNITS).toBe(100);
  });

  it('trims outer whitespace from weight strings', () => {
    expect(parseStaffingWeightToUnits('  1.00  ')).toBe(100);
    expect(parseStaffingWeightToUnits(' 0.10 ')).toBe(10);
  });

  it('accepts positive numeric primitives matching decimal format', () => {
    expect(parseStaffingWeightToUnits(1)).toBe(100);
    expect(parseStaffingWeightToUnits(0.2)).toBe(20);
    expect(parseStaffingWeightToUnits(2.5)).toBe(250);
  });

  it('rejects zero, negative, positive sign, and non-decimal values without rounding', () => {
    const invalidInputs = [
      '0',
      '0.0',
      '0.00',
      0,
      '-1',
      '-1.00',
      -1,
      '+1.00',
      '+1',
      '1e2',
      '1e-2',
      'NaN',
      'Infinity',
      '-Infinity',
      NaN,
      Infinity,
      '',
      '   ',
      'abc',
      null,
      undefined,
      {},
      [],
    ];

    for (const val of invalidInputs) {
      expect(() => parseStaffingWeightToUnits(val)).toThrow(/INVALID_STAFFING_WEIGHT/);
      const issue = validateStaffingWeight(val, 'weight');
      expect(issue).not.toBeNull();
      expect(issue?.code).toBe('INVALID_STAFFING_WEIGHT');
    }
  });

  it('rejects excessive precision (> 2 decimal digits) without rounding', () => {
    const excessivePrecision = ['1.001', '0.123', '0.005', '1.2345'];
    for (const val of excessivePrecision) {
      expect(() => parseStaffingWeightToUnits(val)).toThrow(/INVALID_STAFFING_WEIGHT/);
      expect(validateStaffingWeight(val, 'weight')?.code).toBe('INVALID_STAFFING_WEIGHT');
    }
  });

  it('validates a complete project roster and reports structured issues', () => {
    const validIssues = validateRoster(sampleRoster);
    expect(validIssues).toEqual([]);

    const invalidRoster = [
      { id: 'not-a-uuid', name: 'Ada', weightUnits: 100 },
      { id: PERSON_BEN_ID, name: '', weightUnits: 100 },
      { id: PERSON_BEN_ID, name: 'Duplicate Ben', weightUnits: -10 },
    ];
    const issues = validateRoster(invalidRoster);
    expect(issues.some((i) => i.code === 'INVALID_PERSON')).toBe(true);
    expect(issues.some((i) => i.code === 'DUPLICATE_PERSON')).toBe(true);
    expect(issues.some((i) => i.code === 'INVALID_STAFFING_WEIGHT')).toBe(true);
  });
});

describe('Story 22.1 AC 22.1-3: Canonical material identity for staffed plans', () => {
  const baseStaffedPlan = createForecastPlan({
    projectId: PROJECT_ID,
    selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID],
    planningLevel: 'Feature',
    policyVersion: 'staffed-capacity-v1',
    roster: sampleRoster,
    assignments: {
      [FEATURE_A_ID]: [PERSON_ADA_ID],
      [FEATURE_B_ID]: [PERSON_BEN_ID],
    },
  });

  const snapshot = { projectId: PROJECT_ID, projectRevision: 1, nodes: sampleNodes };

  it('names do NOT affect material fingerprint (cosmetic display property)', () => {
    const renamedPlan = createForecastPlan({
      projectId: PROJECT_ID,
      selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID],
      planningLevel: 'Feature',
      policyVersion: 'staffed-capacity-v1',
      roster: [
        { id: PERSON_ADA_ID, name: 'Ada L. (Staff Eng)', weightUnits: 100 },
        { id: PERSON_BEN_ID, name: 'Ben B.', weightUnits: 100 },
      ],
      assignments: {
        [FEATURE_A_ID]: [PERSON_ADA_ID],
        [FEATURE_B_ID]: [PERSON_BEN_ID],
      },
    });

    const normBase = normalizeForecastInputs(snapshot, baseStaffedPlan);
    const normRenamed = normalizeForecastInputs(snapshot, renamedPlan);

    const fpBase = computeForecastFingerprintSync(forecastMaterialFacts(normBase.inputs));
    const fpRenamed = computeForecastFingerprintSync(forecastMaterialFacts(normRenamed.inputs));

    expect(fpBase).toBe(fpRenamed);
  });

  it('unordered serialization order does NOT affect material fingerprint', () => {
    const permutedPlan = createForecastPlan({
      projectId: PROJECT_ID,
      selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID],
      planningLevel: 'Feature',
      policyVersion: 'staffed-capacity-v1',
      // Reversed roster array order
      roster: [sampleRoster[1], sampleRoster[0]],
      assignments: {
        [FEATURE_B_ID]: [PERSON_BEN_ID],
        [FEATURE_A_ID]: [PERSON_ADA_ID],
      },
    });

    const normBase = normalizeForecastInputs(snapshot, baseStaffedPlan);
    const normPermuted = normalizeForecastInputs(snapshot, permutedPlan);

    const fpBase = computeForecastFingerprintSync(forecastMaterialFacts(normBase.inputs));
    const fpPermuted = computeForecastFingerprintSync(forecastMaterialFacts(normPermuted.inputs));

    expect(fpBase).toBe(fpPermuted);
  });

  it('roster weights and assignment membership DO affect material fingerprint', () => {
    const reweightedPlan = createForecastPlan({
      projectId: PROJECT_ID,
      selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID],
      planningLevel: 'Feature',
      policyVersion: 'staffed-capacity-v1',
      roster: [
        { id: PERSON_ADA_ID, name: 'Ada Lovelace', weightUnits: 200 }, // Changed weight
        { id: PERSON_BEN_ID, name: 'Ben Bitdiddle', weightUnits: 100 },
      ],
      assignments: {
        [FEATURE_A_ID]: [PERSON_ADA_ID],
        [FEATURE_B_ID]: [PERSON_BEN_ID],
      },
    });

    const reassignedPlan = createForecastPlan({
      projectId: PROJECT_ID,
      selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID],
      planningLevel: 'Feature',
      policyVersion: 'staffed-capacity-v1',
      roster: sampleRoster,
      assignments: {
        [FEATURE_A_ID]: [PERSON_BEN_ID], // Swapped assignment
        [FEATURE_B_ID]: [PERSON_ADA_ID],
      },
    });

    const normBase = normalizeForecastInputs(snapshot, baseStaffedPlan);
    const normReweighted = normalizeForecastInputs(snapshot, reweightedPlan);
    const normReassigned = normalizeForecastInputs(snapshot, reassignedPlan);

    const fpBase = computeForecastFingerprintSync(forecastMaterialFacts(normBase.inputs));
    const fpReweighted = computeForecastFingerprintSync(forecastMaterialFacts(normReweighted.inputs));
    const fpReassigned = computeForecastFingerprintSync(forecastMaterialFacts(normReassigned.inputs));

    expect(fpBase).not.toBe(fpReweighted);
    expect(fpBase).not.toBe(fpReassigned);
    expect(fpReweighted).not.toBe(fpReassigned);
  });

  it('idle roster members remain material in the denominator', () => {
    const withIdlePersonPlan = createForecastPlan({
      projectId: PROJECT_ID,
      selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID],
      planningLevel: 'Feature',
      policyVersion: 'staffed-capacity-v1',
      roster: [
        ...sampleRoster,
        { id: PERSON_CARA_ID, name: 'Cara (Idle)', weightUnits: 50 },
      ],
      assignments: {
        [FEATURE_A_ID]: [PERSON_ADA_ID],
        [FEATURE_B_ID]: [PERSON_BEN_ID],
      },
    });

    const normBase = normalizeForecastInputs(snapshot, baseStaffedPlan);
    const normWithIdle = normalizeForecastInputs(snapshot, withIdlePersonPlan);

    const fpBase = computeForecastFingerprintSync(forecastMaterialFacts(normBase.inputs));
    const fpWithIdle = computeForecastFingerprintSync(forecastMaterialFacts(normWithIdle.inputs));

    expect(fpBase).not.toBe(fpWithIdle);
  });
});

describe('Story 22.1 AC 22.1-4: Assignment validation (M5, M6, M7)', () => {
  const estimates = {
    [FEATURE_A_ID]: 10,
    [FEATURE_B_ID]: 20,
    [FEATURE_C_ID]: 0, // zero work
  };

  it('rejects duplicate people on the same item', () => {
    const issues = validateStaffingAssignments({
      assignments: { [FEATURE_A_ID]: [PERSON_ADA_ID, PERSON_ADA_ID] },
      roster: sampleRoster,
      selectedFeatureIds: [FEATURE_A_ID],
      nodes: sampleNodes,
      planningLevel: 'Feature',
      estimates,
      parallelGroups: [],
    });
    expect(issues.some((i) => i.code === 'DUPLICATE_ASSIGNMENT')).toBe(true);
  });

  it('rejects unknown / cross-project person IDs not in roster', () => {
    const issues = validateStaffingAssignments({
      assignments: { [FEATURE_A_ID]: [PERSON_CARA_ID] }, // Cara not in sampleRoster
      roster: sampleRoster,
      selectedFeatureIds: [FEATURE_A_ID],
      nodes: sampleNodes,
      planningLevel: 'Feature',
      estimates,
      parallelGroups: [],
    });
    expect(issues.some((i) => i.code === 'UNKNOWN_PERSON')).toBe(true);
  });

  it('rejects assignments to excluded items not in selected scope', () => {
    const issues = validateStaffingAssignments({
      assignments: {
        [FEATURE_A_ID]: [PERSON_ADA_ID],
        [FEATURE_B_ID]: [PERSON_BEN_ID], // FEATURE_B_ID not in selectedFeatureIds
      },
      roster: sampleRoster,
      selectedFeatureIds: [FEATURE_A_ID],
      nodes: sampleNodes,
      planningLevel: 'Feature',
      estimates,
      parallelGroups: [],
    });
    expect(issues.some((i) => i.code === 'ASSIGNMENT_TO_EXCLUDED_ITEM')).toBe(true);
  });

  it('rejects assignments to wrong-level items', () => {
    const issues = validateStaffingAssignments({
      assignments: { [THEME_ID]: [PERSON_ADA_ID] }, // THEME_ID is Theme, planningLevel is Feature
      roster: sampleRoster,
      selectedFeatureIds: [THEME_ID],
      nodes: sampleNodes,
      planningLevel: 'Feature',
      estimates: { [THEME_ID]: 10 },
      parallelGroups: [],
    });
    expect(issues.some((i) => i.code === 'ASSIGNMENT_TO_WRONG_LEVEL')).toBe(true);
  });

  it('rejects assignments to zero-point items (A7: zero-work milestone needs no person)', () => {
    const issues = validateStaffingAssignments({
      assignments: { [FEATURE_C_ID]: [PERSON_ADA_ID] }, // FEATURE_C_ID has 0 points
      roster: sampleRoster,
      selectedFeatureIds: [FEATURE_C_ID],
      nodes: sampleNodes,
      planningLevel: 'Feature',
      estimates,
      parallelGroups: [],
    });
    expect(issues.some((i) => i.code === 'ASSIGNMENT_TO_ZERO_WORK')).toBe(true);
  });

  it('M7: positive-point work without assignments reports MISSING_ASSIGNMENT (incomplete state)', () => {
    const issues = validateStaffingAssignments({
      assignments: {}, // Feature A and B have positive points but no assignments
      roster: sampleRoster,
      selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID],
      nodes: sampleNodes,
      planningLevel: 'Feature',
      estimates,
      parallelGroups: [],
    });
    const missing = issues.filter((i) => i.code === 'MISSING_ASSIGNMENT');
    expect(missing).toHaveLength(2);
    expect(missing.map((i) => i.featureIds?.[0])).toEqual(expect.arrayContaining([FEATURE_A_ID, FEATURE_B_ID]));
  });

  it('M5: rejects parallel bucket concurrency conflict when person assigned to two positive-point bucket members', () => {
    // Both Feature A and Feature B are in the same parallel bucket, and Ada is assigned to both
    const issues = validateStaffingAssignments({
      assignments: {
        [FEATURE_A_ID]: [PERSON_ADA_ID],
        [FEATURE_B_ID]: [PERSON_ADA_ID],
      },
      roster: sampleRoster,
      selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID],
      nodes: sampleNodes,
      planningLevel: 'Feature',
      estimates,
      parallelGroups: [{ featureIds: [FEATURE_A_ID, FEATURE_B_ID] }],
    });

    const conflict = issues.find((i) => i.code === 'CONCURRENT_ASSIGNMENT_CONFLICT');
    expect(conflict).toBeDefined();
    expect(conflict?.personIds).toEqual([PERSON_ADA_ID]);
    expect(conflict?.featureIds).toEqual([FEATURE_A_ID, FEATURE_B_ID]);
  });

  it('M6: allows sequential reuse of the same person across sequential blocks', () => {
    // Feature A and Feature B are sequential (not in any parallel group)
    const issues = validateStaffingAssignments({
      assignments: {
        [FEATURE_A_ID]: [PERSON_ADA_ID],
        [FEATURE_B_ID]: [PERSON_ADA_ID],
      },
      roster: sampleRoster,
      selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID],
      nodes: sampleNodes,
      planningLevel: 'Feature',
      estimates,
      parallelGroups: [], // Sequential: no parallel groups
    });

    expect(issues.some((i) => i.code === 'CONCURRENT_ASSIGNMENT_CONFLICT')).toBe(false);
    expect(issues).toEqual([]);
  });

  it('A1: allows multiple people to work on one item (shares add linearly)', () => {
    const issues = validateStaffingAssignments({
      assignments: {
        [FEATURE_A_ID]: [PERSON_ADA_ID, PERSON_BEN_ID],
      },
      roster: sampleRoster,
      selectedFeatureIds: [FEATURE_A_ID],
      nodes: sampleNodes,
      planningLevel: 'Feature',
      estimates,
      parallelGroups: [],
    });
    expect(issues).toEqual([]);
  });
});

describe('Story 22.1 AC 22.1-5: Level-scoped estimates with zero containment inheritance', () => {
  it('extracts only own estimates and no containment inheritance at Theme, Component and Feature levels', () => {
    const snapshot = { projectId: PROJECT_ID, projectRevision: 1, nodes: sampleNodes };

    // Theme level: Theme has 50 points, Component 30, Features 10+20.
    const themePlan = createForecastPlan({
      projectId: PROJECT_ID,
      selectedFeatureIds: [THEME_ID],
      planningLevel: 'Theme',
      policyVersion: 'staffed-capacity-v1',
      roster: sampleRoster,
      assignments: { [THEME_ID]: [PERSON_ADA_ID] },
    });
    const themeNorm = normalizeForecastInputs(snapshot, themePlan);
    expect(themeNorm.inputs.estimates).toEqual({ [THEME_ID]: 50 });
    expect(themeNorm.inputs.assignments).toEqual({ [THEME_ID]: [PERSON_ADA_ID] });

    // Component level: Component has 30 points
    const compPlan = createForecastPlan({
      projectId: PROJECT_ID,
      selectedFeatureIds: [COMPONENT_ID],
      planningLevel: 'Component',
      policyVersion: 'staffed-capacity-v1',
      roster: sampleRoster,
      assignments: { [COMPONENT_ID]: [PERSON_ADA_ID] },
    });
    const compNorm = normalizeForecastInputs(snapshot, compPlan);
    expect(compNorm.inputs.estimates).toEqual({ [COMPONENT_ID]: 30 });
    expect(compNorm.inputs.assignments).toEqual({ [COMPONENT_ID]: [PERSON_ADA_ID] });

    // Feature level
    const featurePlan = createForecastPlan({
      projectId: PROJECT_ID,
      selectedFeatureIds: [FEATURE_A_ID, FEATURE_B_ID],
      planningLevel: 'Feature',
      policyVersion: 'staffed-capacity-v1',
      roster: sampleRoster,
      assignments: {
        [FEATURE_A_ID]: [PERSON_ADA_ID],
        [FEATURE_B_ID]: [PERSON_BEN_ID],
      },
    });
    const featNorm = normalizeForecastInputs(snapshot, featurePlan);
    expect(featNorm.inputs.estimates).toEqual({
      [FEATURE_A_ID]: 10,
      [FEATURE_B_ID]: 20,
    });
    expect(featNorm.inputs.assignments).toEqual({
      [FEATURE_A_ID]: [PERSON_ADA_ID],
      [FEATURE_B_ID]: [PERSON_BEN_ID],
    });
  });
});

describe('Story 22.1 AC 22.1-6: Policy validation, immutability, and structured clone', () => {
  it('accepts only explicit shared-capacity-v1 and staffed-capacity-v1 policies', () => {
    expect(validatePolicyVersion('shared-capacity-v1')).toBeNull();
    expect(validatePolicyVersion('staffed-capacity-v1')).toBeNull();

    expect(() => assertForecastPolicyVersion('shared-capacity-v1')).not.toThrow();
    expect(() => assertForecastPolicyVersion('staffed-capacity-v1')).not.toThrow();

    const invalidPolicies = ['unsupported-policy', 'future-v2', 'staffed-v2', '', null, undefined, 123];
    for (const p of invalidPolicies) {
      const issue = validatePolicyVersion(p);
      expect(issue).not.toBeNull();
      expect(issue?.code).toBe('UNSUPPORTED_POLICY');
      expect(() => assertForecastPolicyVersion(p)).toThrow(/Unsupported forecast policy version/);
    }
  });

  it('guarantees deep immutability on created plans and normalized inputs', () => {
    const plan = createForecastPlan({
      projectId: PROJECT_ID,
      selectedFeatureIds: [FEATURE_A_ID],
      planningLevel: 'Feature',
      policyVersion: 'staffed-capacity-v1',
      roster: sampleRoster,
      assignments: { [FEATURE_A_ID]: [PERSON_ADA_ID] },
    });

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.roster)).toBe(true);
    expect(Object.isFrozen(plan.roster[0])).toBe(true);
    expect(Object.isFrozen(plan.assignments)).toBe(true);
    expect(Object.isFrozen(plan.assignments[FEATURE_A_ID])).toBe(true);

    const snapshot = { projectId: PROJECT_ID, projectRevision: 1, nodes: sampleNodes };
    const normalized = normalizeForecastInputs(snapshot, plan);

    expect(Object.isFrozen(normalized.inputs)).toBe(true);
    expect(Object.isFrozen(normalized.inputs.roster)).toBe(true);
    expect(Object.isFrozen(normalized.inputs.assignments)).toBe(true);
    expect(Object.isFrozen(normalized.issues)).toBe(true);
  });

  it('re-validates cleanly after structured cloning (worker / postMessage boundary)', () => {
    const plan = createForecastPlan({
      projectId: PROJECT_ID,
      selectedFeatureIds: [FEATURE_A_ID],
      planningLevel: 'Feature',
      policyVersion: 'staffed-capacity-v1',
      roster: sampleRoster,
      assignments: { [FEATURE_A_ID]: [PERSON_ADA_ID] },
    });

    const snapshot = { projectId: PROJECT_ID, projectRevision: 1, nodes: sampleNodes };
    const normalized = normalizeForecastInputs(snapshot, plan);

    const clonedInputs = structuredClone(normalized.inputs);
    expect(clonedInputs.projectId).toBe(PROJECT_ID);
    expect(clonedInputs.policyVersion).toBe('staffed-capacity-v1');
    expect(clonedInputs.roster).toHaveLength(2);
    expect(clonedInputs.assignments?.[FEATURE_A_ID]).toEqual([PERSON_ADA_ID]);

    // Material facts computation succeeds and matches on cloned inputs
    const fpOrig = computeForecastFingerprintSync(forecastMaterialFacts(normalized.inputs));
    const fpCloned = computeForecastFingerprintSync(forecastMaterialFacts(clonedInputs));
    expect(fpOrig).toBe(fpCloned);
  });
});
