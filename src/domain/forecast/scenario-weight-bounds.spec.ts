/**
 * One approved staffing-weight range for live plans and scenario variants
 * (Story 23.9, AC 23.9-1..5; review R9).
 *
 * The live parser accepts any positive exact hundredths whose scaled integer
 * is safe (`1000.01` -> 100001 units). The scenario layers repeated a
 * narrower, unapproved `<= 100000` cap: the command creator, the persisted /
 * portable validator and the evaluator all rejected 100001 while a live
 * person could carry it. Every test here drives the production validators.
 */

import { describe, expect, it } from 'vitest';
import { createForecastConfiguration } from './forecast-plan.entity';
import {
  formatStaffingWeightUnits,
  isValidStaffingWeightUnits,
  parseStaffingWeightToUnits,
  validateRoster,
} from './forecast-validators';
import {
  createAddForecastPersonCommand,
  createCreateForecastScenarioCommand,
  createUpdateForecastPersonCommand,
} from './forecast.commands';
import { evaluateScenario } from './scenario-evaluate';
import {
  scenarioFingerprint,
  validatePersistedForecastScenario,
  type ForecastScenarioBaseline,
  type ForecastScenarioPatch,
  type PersistedForecastScenario,
  type ScenarioFeatureFact,
} from './scenario';
import { formatRatio } from './forecast-canonical';

const PROJECT = '019ffe00-0000-7000-8000-000000000001';
const A = '019ffe00-0000-7000-8000-00000000000a';
const B = '019ffe00-0000-7000-8000-00000000000b';
const ADA = '019ffe00-0000-7000-8000-0000000000a1';
const BEN = '019ffe00-0000-7000-8000-0000000000b1';
const STRANGER = '019ffe00-0000-7000-8000-0000000000f9';
const COMMAND = '019ffe00-0000-7000-8000-00000000c001';
const SCENARIO = '019ffe00-0000-7000-8000-00000000d001';
const FINGERPRINT = 'a'.repeat(64);

function fact(effortPoints: number): ScenarioFeatureFact {
  return Object.freeze({ effortPoints, nodeType: 'Feature', projectId: PROJECT, ancestorIds: Object.freeze([]) });
}

/** Example S1: C=20, Ada 3.00 on B, Ben 1.00 on A, A and B in one parallel group. */
function s1(roster = [
  { id: ADA, name: 'Ada', weightUnits: 300 },
  { id: BEN, name: 'Ben', weightUnits: 100 },
]): ForecastScenarioBaseline {
  return Object.freeze({
    projectId: PROJECT,
    baselineRevision: 10,
    policyVersion: 'staffed-capacity-v1',
    planningLevel: 'Feature',
    orderedScope: Object.freeze([A, B]),
    configuration: createForecastConfiguration({
      pointsPerSprint: 20,
      sprintLengthDays: 14,
      startSprintOrdinal: 12,
      startDate: '2026-09-07',
    }),
    parallelGroups: Object.freeze([{ featureIds: Object.freeze([A, B]) }]),
    blockedFeatureIds: Object.freeze([]),
    factMap: Object.freeze({ [A]: fact(30), [B]: fact(10) }),
    roster: Object.freeze(roster.map((p) => Object.freeze(p))),
    assignments: Object.freeze({ [A]: Object.freeze([BEN]), [B]: Object.freeze([ADA]) }),
  });
}

function persisted(patch: ForecastScenarioPatch): PersistedForecastScenario {
  const { projectId: _p, baselineRevision: _r, policyVersion: _v, ...baseline } = s1();
  return {
    scenarioId: SCENARIO,
    projectId: PROJECT,
    label: 'Weights',
    baselineRevision: 10,
    baselineFingerprint: FINGERPRINT,
    policyVersion: 'staffed-capacity-v1',
    createdAtISO: '2026-09-25T00:00:00.000Z',
    baseline,
    patch,
  };
}

function scenarioCommand(patch: ForecastScenarioPatch) {
  return createCreateForecastScenarioCommand({
    commandId: COMMAND,
    projectId: PROJECT,
    baseRevision: 10,
    scenarioId: SCENARIO,
    label: 'Weights',
    baselineRevision: 10,
    expectedMaterialFingerprint: FINGERPRINT,
    createdAtISO: '2026-09-25T00:00:00.000Z',
    patch,
  });
}

/** Does each layer accept `units` as a weight? Live first, then every scenario layer. */
async function acceptance(units: number) {
  const live = {
    add: (() => {
      try {
        createAddForecastPersonCommand({ commandId: COMMAND, projectId: PROJECT, baseRevision: 1, personId: ADA, name: 'Ada', weightUnits: units });
        return true;
      } catch {
        return false;
      }
    })(),
    update: (() => {
      try {
        createUpdateForecastPersonCommand({ commandId: COMMAND, projectId: PROJECT, baseRevision: 1, personId: ADA, name: 'Ada', weightUnits: units });
        return true;
      } catch {
        return false;
      }
    })(),
    roster: validateRoster([{ id: ADA, name: 'Ada', weightUnits: units }]).length === 0,
  };
  const patch = { weightOverrides: { [BEN]: units } };
  const evaluation = await evaluateScenario(s1(), patch);
  const scenario = {
    command: (() => {
      try {
        scenarioCommand(patch);
        return true;
      } catch {
        return false;
      }
    })(),
    persisted: validatePersistedForecastScenario(persisted(patch), PROJECT).length === 0,
    evaluator: evaluation.ok,
  };
  return { live, scenario, evaluation };
}

describe('AC 23.9-1 — 1000.01 (100001 units) is valid in every scenario layer', () => {
  it('parses exactly and is accepted by the command, persisted/portable validator and evaluator', async () => {
    expect(parseStaffingWeightToUnits('1000.01')).toBe(100001);
    expect(formatStaffingWeightUnits(100001)).toBe('1000.01');
    const { live, scenario } = await acceptance(100001);
    expect(live).toEqual({ add: true, update: true, roster: true });
    expect(scenario).toEqual({ command: true, persisted: true, evaluator: true });
  });

  it('evaluates the override exactly as the same weight on the live roster would', async () => {
    const overridden = await evaluateScenario(s1(), { weightOverrides: { [BEN]: 100001 } });
    const live = await evaluateScenario(
      s1([
        { id: ADA, name: 'Ada', weightUnits: 300 },
        { id: BEN, name: 'Ben', weightUnits: 100001 },
      ]),
      {},
    );
    expect(overridden.ok && live.ok).toBe(true);
    if (!overridden.ok || !live.ok) return;
    // Total weight 100301. Ada (3.00) on B=10: 10 / (20*300/100301) = 100301/600 sprints.
    expect(formatRatio(overridden.variantResult.arithmetic!.elapsedStaffingDuration!)).toBe('100301/600');
    expect(overridden.variantResult.arithmetic).toEqual(live.baselineResult.arithmetic);
    expect(overridden.variantResult.allocation).toEqual(live.baselineResult.allocation);
    expect(overridden.variantInputs.roster?.find((p) => p.id === BEN)?.weightUnits).toBe(100001);
  });
});

describe('AC 23.9-2 — live and scenario validators agree at 100000, 100001 and the safe bound', () => {
  it.each([100000, 100001, 9_999_999_999, Number.MAX_SAFE_INTEGER])('%i units: every layer accepts', async (units) => {
    const { live, scenario } = await acceptance(units);
    expect(isValidStaffingWeightUnits(units)).toBe(true);
    expect(live).toEqual({ add: true, update: true, roster: true });
    expect(scenario).toEqual({ command: true, persisted: true, evaluator: true });
  });

  it.each([0, -100, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    '%s units: every layer rejects',
    async (units) => {
      const { live, scenario, evaluation } = await acceptance(units);
      expect(isValidStaffingWeightUnits(units)).toBe(false);
      expect(live).toEqual({ add: false, update: false, roster: false });
      expect(scenario).toEqual({ command: false, persisted: false, evaluator: false });
      if (!evaluation.ok) {
        expect(evaluation.issues).toContainEqual({ code: 'INVALID_WEIGHT_OVERRIDE', personId: BEN });
      }
    },
  );

  it('an accepted weight whose aggregate arithmetic is unrepresentable gets the typed OVERFLOW result', async () => {
    // Each weight is valid on its own. Ben's share is 20 * 1 / 2^53 = 5/2^51
    // points per sprint, so his 30-point item takes 6 * 2^51 sprints: beyond
    // the safe range, reported as OVERFLOW rather than an input rejection.
    const r = await evaluateScenario(s1(), { weightOverrides: { [ADA]: Number.MAX_SAFE_INTEGER, [BEN]: 1 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.variantResult.state).toBe('overflow');
    expect(r.variantResult.issues.map((i) => i.code)).toContain('OVERFLOW');
    expect(r.variantResult.arithmetic).toBeNull();
    expect(r.baselineResult.state).toBe('ready');
  });
});

describe('AC 23.9-3 — malformed decimal drafts are rejected by the one canonical parser', () => {
  it.each(['1.001', '1e2', '0', '0.00', '-1', 'Infinity', 'NaN', '1.5x', ' ', '', '9007199254740992'])(
    '%j is rejected without rounding',
    (draft) => {
      expect(() => parseStaffingWeightToUnits(draft)).toThrow('INVALID_STAFFING_WEIGHT');
    },
  );

  it('formatting is exact at the safe bound and round-trips through the parser', () => {
    for (const units of [1, 10, 100, 150, 100000, 100001, Number.MAX_SAFE_INTEGER]) {
      expect(parseStaffingWeightToUnits(formatStaffingWeightUnits(units))).toBe(units);
    }
    expect(formatStaffingWeightUnits(Number.MAX_SAFE_INTEGER)).toBe('90071992547409.91');
  });
});

describe('AC 23.9-4 — omission inherits; an explicit value affects only that captured person', () => {
  it('an override for Ben leaves Ada at her captured weight', async () => {
    const r = await evaluateScenario(s1(), { weightOverrides: { [BEN]: 100001 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.variantInputs.roster).toEqual([
      { id: ADA, name: 'Ada', weightUnits: 300 },
      { id: BEN, name: 'Ben', weightUnits: 100001 },
    ]);
    expect(r.baselineInputs.roster).toEqual(s1().roster);
  });

  it('an unknown person still fails at the evaluator and the persisted validator', async () => {
    const patch = { weightOverrides: { [STRANGER]: 100001 } };
    const r = await evaluateScenario(s1(), patch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues).toContainEqual({ code: 'WEIGHT_OVERRIDE_FOR_UNKNOWN_PERSON', personId: STRANGER });
    expect(validatePersistedForecastScenario(persisted(patch), PROJECT).map((i) => i.code)).toContain(
      'WEIGHT_OVERRIDE_FOR_UNKNOWN_PERSON',
    );
  });
});

describe('AC 23.9-5 — behaviour outside the repaired range is unchanged', () => {
  it('ordinary staffed fingerprints are byte-identical to the pre-repair values', async () => {
    // Pinned at 6b0d92e, before the validator change.
    expect(await scenarioFingerprint(s1(), { weightOverrides: { [ADA]: 150 } })).toBe(S1_WEIGHT_150_FINGERPRINT);
    expect(await scenarioFingerprint(s1(), {})).toBe(S1_EMPTY_FINGERPRINT);
  });

  it('S1 still swaps from Sprint 17 to Sprint 13', async () => {
    const r = await evaluateScenario(s1(), { assignmentOverrides: { [A]: [ADA], [B]: [BEN] } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.baselineResult.arithmetic?.completionSprint).toBe(17);
    expect(r.baselineResult.arithmetic?.completionDate).toBe('2026-11-29');
    expect(r.variantResult.arithmetic?.completionSprint).toBe(13);
    expect(r.variantResult.arithmetic?.completionDate).toBe('2026-10-04');
  });
});

const S1_WEIGHT_150_FINGERPRINT = '4d8803d5844659abe238479d69977520ade869cfffe25f977e12569f72ae2924';
const S1_EMPTY_FINGERPRINT = 'fcfa80d589fb447702f4138fa1d6d31793d6f71c6b4bc65f2439e5f6c2e7960f';
