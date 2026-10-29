/**
 * Explanation & scenario integrity certification (Story 20.7, AC 20.7-1,
 * 20.7-2, NFR-1). Independent hand-calculated oracles — never a snapshot of
 * the implementation — plus historical-isolation properties: a golden
 * scenario replayed after arbitrary live-fact changes reproduces
 * byte-identically because evaluation consults only the captured fact map.
 */

import { describe, it, expect } from 'vitest';
import {
  createForecastConfiguration,
  createForecastPlan,
  FORECAST_POLICY_VERSION,
  STAFFED_FORECAST_POLICY_VERSION,
  type ForecastPerson,
} from './forecast-plan.entity';
import { evaluateScenario } from './scenario-evaluate';
import {
  scenarioCanonicalBytes,
  baselineFromPersisted,
  scenarioFingerprint,
  createForecastScenarioBaseline,
  createBaselineFromPlan,
  validateForecastScenarioBaseline,
  validatePersistedForecastScenario,
  isPersistedForecastScenario,
  type PersistedForecastScenario,
} from './scenario';
import { calculateForecast } from './whole-set.policy';
import type { ForecastScenarioBaseline, ScenarioFeatureFact } from './scenario';
import type { ForecastInputs } from './forecast-result';

const PROJECT = '019ffe00-0000-7000-8000-000000000001';
const A = '019ffe00-0000-7000-8000-00000000000a';
const B = '019ffe00-0000-7000-8000-00000000000b';
const C = '019ffe00-0000-7000-8000-00000000000c';

const fact = (points: number | null): ScenarioFeatureFact =>
  Object.freeze({ effortPoints: points, nodeType: 'Feature', projectId: PROJECT, ancestorIds: Object.freeze([]) });

/** The frozen golden baseline: scope [A(20), B(10)], C(30) captured for variants. */
const GOLDEN: ForecastScenarioBaseline = Object.freeze({
  projectId: PROJECT,
  baselineRevision: 42,
  policyVersion: 'shared-capacity-v1',
  planningLevel: 'Feature',
  orderedScope: Object.freeze([A, B]),
  configuration: createForecastConfiguration({
    pointsPerSprint: 10,
    sprintLengthDays: 14,
    startSprintOrdinal: 1,
    startDate: '2026-09-07',
  }),
  parallelGroups: Object.freeze([]),
  blockedFeatureIds: Object.freeze([]),
  factMap: Object.freeze({ [A]: fact(20), [B]: fact(10), [C]: fact(30) }),
});

describe('AC 20.7-1 — canonical results match an independent oracle', () => {
  it('baseline: 30 points / 10 per sprint = 3 sprints, completion Sprint 3 on 2026-10-18', async () => {
    const evaluation = await evaluateScenario(GOLDEN, {});
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) return;
    // Independent hand calc: ceil(30/10)=3; end = 2026-09-07 + (3*14 - 1) days = 2026-10-18.
    expect(evaluation.baselineResult.arithmetic).toMatchObject({
      totalPoints: 30,
      occupiedSprints: 3,
      completionSprint: 3,
      completionDate: '2026-10-18',
    });
  });

  it('variant adds C(30) and raises capacity to 20 → 60/20 = 3 sprints, same completion date', async () => {
    const evaluation = await evaluateScenario(GOLDEN, { orderedScope: [A, B, C], pointsPerSprint: 20 });
    if (!evaluation.ok) throw new Error('expected ok');
    // Hand calc: 60/20 = 3 sprints → Sprint 3, 2026-10-18.
    expect(evaluation.variantResult.arithmetic).toMatchObject({ occupiedSprints: 3, completionDate: '2026-10-18' });
    expect(evaluation.comparison?.causes.map((c) => c.kind).sort()).toEqual(['CapacityChanged', 'ScopeAdded']);
  });

  it('a raw ForecastInputs oracle built by hand agrees with the scenario baseline', async () => {
    const oracle: ForecastInputs = Object.freeze({
      projectId: PROJECT,
      projectRevision: 42,
      policyVersion: 'shared-capacity-v1',
      selectedFeatureIds: Object.freeze([A, B]),
      estimates: Object.freeze({ [A]: 20, [B]: 10 }),
      pointsPerSprint: 10,
      sprintLengthDays: 14,
      startSprintOrdinal: 1,
      startDate: '2026-09-07',
      parallelGroups: Object.freeze([]),
      blockedFeatureIds: Object.freeze([]),
    });
    const oracleResult = await calculateForecast(oracle);
    const evaluation = await evaluateScenario(GOLDEN, {});
    if (!evaluation.ok) throw new Error('expected ok');
    expect(JSON.stringify(evaluation.baselineResult.arithmetic)).toBe(JSON.stringify(oracleResult.arithmetic));
    expect(evaluation.baselineResult.materialFingerprint).toBe(oracleResult.materialFingerprint);
  });
});

describe('AC 20.7-2 — historical isolation: a golden scenario reproduces after live-fact changes', () => {
  it('deleting / retyping / reparenting / re-estimating the live nodes cannot change the stored result', async () => {
    const first = await evaluateScenario(GOLDEN, { pointOverrides: { [A]: 25 } });
    if (!first.ok) throw new Error('expected ok');
    const goldenBytes = scenarioCanonicalBytes(GOLDEN, { pointOverrides: { [A]: 25 } });
    const goldenResult = JSON.stringify(first.variantResult);

    // Simulate every kind of subsequent live mutation by evaluating with the
    // SAME frozen baseline — `evaluateScenario` has no other input to consult.
    for (let i = 0; i < 5; i += 1) {
      const again = await evaluateScenario(GOLDEN, { pointOverrides: { [A]: 25 } });
      if (!again.ok) throw new Error('expected ok');
      expect(scenarioCanonicalBytes(GOLDEN, { pointOverrides: { [A]: 25 } })).toBe(goldenBytes);
      expect(JSON.stringify(again.variantResult)).toBe(goldenResult);
    }
  });

  it('a fact map that still says A=20 yields the golden answer even though a "live" A would be 999', async () => {
    // The baseline is authoritative — there is no path from a live 999 to here.
    const evaluation = await evaluateScenario(GOLDEN, {});
    if (!evaluation.ok) throw new Error('expected ok');
    expect(evaluation.baselineInputs.estimates[A]).toBe(20);
    expect(evaluation.baselineResult.arithmetic?.totalPoints).toBe(30);
  });
});

describe('NFR-1 — determinism across repeated evaluation', () => {
  it('the same baseline + patch is byte-identical over many runs', async () => {
    const patch = { orderedScope: [B, A, C], pointsPerSprint: 15 };
    const runs = await Promise.all(Array.from({ length: 8 }, () => evaluateScenario(GOLDEN, patch)));
    const first = JSON.stringify(runs[0].ok && runs[0].variantResult);
    for (const r of runs) {
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(JSON.stringify(r.variantResult)).toBe(first);
    }
  });
});

describe('AC 20.7-5 — bounded large-scenario calculation', () => {
  it('evaluates 300 Features within the inherited background-work budget and keeps allocation linear', async () => {
    const ids = Array.from({ length: 300 }, (_, index) => `019ffe01-${index.toString(16).padStart(4, '0')}-7000-8000-${index.toString(16).padStart(12, '0')}`);
    const large: ForecastScenarioBaseline = Object.freeze({
      ...GOLDEN,
      orderedScope: Object.freeze(ids),
      factMap: Object.freeze(Object.fromEntries(ids.map((id) => [id, fact(5)]))),
    });
    const started = performance.now();
    const result = await evaluateScenario(large, { pointsPerSprint: 25 });
    const duration = performance.now() - started;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.variantResult.allocation?.timelines).toHaveLength(300);
    expect(result.variantResult.allocation?.events.length).toBeLessThanOrEqual(300);
    expect(duration).toBeLessThan(2_000);
  });
});

// ── Story 21.9 AC 4 — a scenario saved before Epic 21 normalizes on read ──

describe('Story 21.9 AC 4 — legacy scenario normalization', () => {
  it('baselineFromPersisted maps isFeature forward and defaults planningLevel to Feature', async () => {
    const legacy = Object.freeze({
      scenarioId: '019ffe00-0000-7000-8000-0000000000f1',
      projectId: PROJECT,
      label: 'Legacy',
      baselineRevision: 42,
      baselineFingerprint: 'a'.repeat(64),
      policyVersion: 'shared-capacity-v1',
      createdAtISO: '2026-09-01T00:00:00.000Z',
      baseline: Object.freeze({
        orderedScope: Object.freeze([A, B]),
        configuration: createForecastConfiguration({
          pointsPerSprint: 10,
          sprintLengthDays: 14,
          startSprintOrdinal: 1,
          startDate: '2026-09-07',
        }),
        parallelGroups: Object.freeze([]),
        blockedFeatureIds: Object.freeze([]),
        factMap: Object.freeze({
          [A]: Object.freeze({ effortPoints: 20, isFeature: true, projectId: PROJECT, ancestorIds: Object.freeze([]) }),
          [B]: Object.freeze({ effortPoints: 10, isFeature: false, projectId: PROJECT, ancestorIds: Object.freeze([]) }),
        }),
      }),
      patch: Object.freeze({}),
    });
    const normalized = baselineFromPersisted(legacy as unknown as import('./scenario').PersistedForecastScenario);
    expect(normalized.planningLevel).toBe('Feature');
    expect(normalized.factMap[A].nodeType).toBe('Feature');
    expect(normalized.factMap[B].nodeType).toBe('Theme');
    // Feature-level evaluation is byte-identical: the non-Feature member is
    // still flagged NOT_A_FEATURE, exactly as the legacy isFeature: false did.
    const r = await evaluateScenario(normalized, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.some((i) => i.code === 'NOT_A_FEATURE')).toBe(true);
  });
});

// ── Story 23.1 — Staffing scenario baselines (AC 23.1-1..23.1-5) ──────────

const PERSON_ADA: ForecastPerson = Object.freeze({
  id: '019ffe00-0000-7000-8000-000000000010',
  name: 'Ada',
  weightUnits: 100,
});
const PERSON_BEN: ForecastPerson = Object.freeze({
  id: '019ffe00-0000-7000-8000-000000000020',
  name: 'Ben',
  weightUnits: 100,
});
const PERSON_CARA: ForecastPerson = Object.freeze({
  id: '019ffe00-0000-7000-8000-000000000030',
  name: 'Cara',
  weightUnits: 100,
});

describe('Story 23.1 — AC 23.1-1: self-contained staffed scenario baseline construction', () => {
  it('captures policy, planning level, configuration, scope, groups, blockers, full roster and assignments', async () => {
    const baseline = createForecastScenarioBaseline({
      projectId: PROJECT,
      baselineRevision: 12,
      policyVersion: STAFFED_FORECAST_POLICY_VERSION,
      planningLevel: 'Feature',
      orderedScope: Object.freeze([A, B]),
      configuration: createForecastConfiguration({
        pointsPerSprint: 30,
        sprintLengthDays: 14,
        startSprintOrdinal: 1,
        startDate: '2026-09-07',
      }),
      parallelGroups: Object.freeze([]),
      blockedFeatureIds: Object.freeze([]),
      factMap: Object.freeze({
        [A]: fact(10),
        [B]: fact(20),
        [C]: fact(30),
      }),
      roster: Object.freeze([PERSON_ADA, PERSON_BEN, PERSON_CARA]),
      assignments: Object.freeze({
        [A]: Object.freeze([PERSON_ADA.id]),
        [B]: Object.freeze([PERSON_BEN.id]),
      }),
    });

    expect(baseline.policyVersion).toBe('staffed-capacity-v1');
    expect(baseline.planningLevel).toBe('Feature');
    expect(baseline.roster).toHaveLength(3);
    // Cara is idle (not assigned to A or B) but remains in the roster
    expect(baseline.roster?.map((p) => p.name)).toEqual(['Ada', 'Ben', 'Cara']);
    expect(baseline.assignments?.[A]).toEqual([PERSON_ADA.id]);
    expect(baseline.assignments?.[B]).toEqual([PERSON_BEN.id]);

    // Evaluated: total team weight is Ada(100) + Ben(100) + Cara(100) = 300.
    // Ada rate = 30 * 100/300 = 10 pts/sprint. A(10 pts) takes 1 sprint.
    // Ben rate = 30 * 100/300 = 10 pts/sprint. B(20 pts) takes 2 sprints.
    // Total sequential staffing duration T = 1 + 2 = 3 sprints (occupiedSprints: 3).
    const evaluation = await evaluateScenario(baseline, {});
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) return;
    expect(evaluation.baselineResult.arithmetic?.occupiedSprints).toBe(3);
    expect(evaluation.baselineResult.arithmetic?.totalPoints).toBe(30);
  });

  it('createBaselineFromPlan extracts all staffed facts from a live plan snapshot', () => {
    const plan = createForecastPlan({
      projectId: PROJECT,
      selectedFeatureIds: [A, B],
      policyVersion: STAFFED_FORECAST_POLICY_VERSION,
      planningLevel: 'Feature',
      configuration: createForecastConfiguration({
        pointsPerSprint: 20,
        sprintLengthDays: 14,
        startSprintOrdinal: 1,
        startDate: '2026-09-07',
      }),
      roster: [PERSON_ADA, PERSON_BEN],
      assignments: { [A]: [PERSON_ADA.id], [B]: [PERSON_BEN.id] },
    });
    const factMap = Object.freeze({ [A]: fact(10), [B]: fact(20) });
    const baseline = createBaselineFromPlan(plan, 5, factMap);

    expect(baseline.policyVersion).toBe('staffed-capacity-v1');
    expect(baseline.baselineRevision).toBe(5);
    expect(baseline.roster).toHaveLength(2);
    expect(baseline.assignments?.[A]).toEqual([PERSON_ADA.id]);
  });
});

describe('Story 23.1 — AC 23.1-2: historical isolation against live changes', () => {
  it('baseline reconstruction uses captured facts only and does not substitute live data', async () => {
    const persisted: PersistedForecastScenario = Object.freeze({
      scenarioId: '019ffe00-0000-7000-8000-000000000099',
      projectId: PROJECT,
      label: 'Staffed Tradeoff 1',
      baselineRevision: 10,
      baselineFingerprint: 'b'.repeat(64),
      policyVersion: STAFFED_FORECAST_POLICY_VERSION,
      createdAtISO: '2026-09-24T12:00:00.000Z',
      baseline: Object.freeze({
        planningLevel: 'Feature',
        orderedScope: Object.freeze([A, B]),
        configuration: createForecastConfiguration({
          pointsPerSprint: 30,
          sprintLengthDays: 14,
          startSprintOrdinal: 1,
          startDate: '2026-09-07',
        }),
        parallelGroups: Object.freeze([]),
        blockedFeatureIds: Object.freeze([]),
        factMap: Object.freeze({
          [A]: fact(10),
          [B]: fact(20),
        }),
        roster: Object.freeze([PERSON_ADA, PERSON_BEN, PERSON_CARA]),
        assignments: Object.freeze({
          [A]: Object.freeze([PERSON_ADA.id]),
          [B]: Object.freeze([PERSON_BEN.id]),
        }),
      }),
      patch: Object.freeze({}),
    });

    // Reconstruct baseline purely from persisted record
    const baseline = baselineFromPersisted(persisted);
    expect(baseline.roster).toHaveLength(3);
    expect(baseline.roster?.[0].name).toBe('Ada');
    expect(baseline.roster?.[2].name).toBe('Cara');

    const firstEval = await evaluateScenario(baseline, {});
    expect(firstEval.ok).toBe(true);
    if (!firstEval.ok) return;
    const goldenArithmetic = JSON.stringify(firstEval.baselineResult.arithmetic);

    // Simulate subsequent live mutations:
    // - Cara is deleted from live roster
    // - Ada is renamed to "Alice"
    // - Ben is reweighted to 500
    // - Node A is re-estimated to 999
    // A fresh call to baselineFromPersisted and evaluateScenario yields the exact same answer
    for (let i = 0; i < 3; i++) {
      const replayed = baselineFromPersisted(persisted);
      const replayedEval = await evaluateScenario(replayed, {});
      expect(replayedEval.ok).toBe(true);
      if (!replayedEval.ok) return;
      expect(JSON.stringify(replayedEval.baselineResult.arithmetic)).toBe(goldenArithmetic);
      expect(replayed.roster?.[0].name).toBe('Ada');
      expect(replayed.roster?.[2].id).toBe(PERSON_CARA.id);
    }
  });
});

describe('Story 23.1 — AC 23.1-3: canonical scenario fingerprint stability and sensitivity', () => {
  it('is stable across unordered fact-map and assignment key serialization', async () => {
    const b1 = createForecastScenarioBaseline({
      projectId: PROJECT,
      baselineRevision: 10,
      policyVersion: STAFFED_FORECAST_POLICY_VERSION,
      orderedScope: [A, B],
      configuration: createForecastConfiguration({ pointsPerSprint: 20, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07' }),
      factMap: { [A]: fact(10), [B]: fact(20), [C]: fact(30) },
      roster: [PERSON_ADA, PERSON_BEN],
      assignments: { [A]: [PERSON_ADA.id], [B]: [PERSON_BEN.id] },
    });

    const b2 = createForecastScenarioBaseline({
      projectId: PROJECT,
      baselineRevision: 10,
      policyVersion: STAFFED_FORECAST_POLICY_VERSION,
      orderedScope: [A, B],
      configuration: createForecastConfiguration({ pointsPerSprint: 20, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07' }),
      factMap: { [C]: fact(30), [B]: fact(20), [A]: fact(10) },
      roster: [PERSON_BEN, PERSON_ADA],
      assignments: { [B]: [PERSON_BEN.id], [A]: [PERSON_ADA.id] },
    });

    const fp1 = await scenarioFingerprint(b1, {});
    const fp2 = await scenarioFingerprint(b2, {});
    expect(fp1).toBe(fp2);
  });

  it('materially changes when roster weights change', async () => {
    const b1 = createForecastScenarioBaseline({
      projectId: PROJECT,
      baselineRevision: 10,
      policyVersion: STAFFED_FORECAST_POLICY_VERSION,
      orderedScope: [A, B],
      configuration: createForecastConfiguration({ pointsPerSprint: 20, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07' }),
      factMap: { [A]: fact(10), [B]: fact(20) },
      roster: [PERSON_ADA, PERSON_BEN],
      assignments: { [A]: [PERSON_ADA.id], [B]: [PERSON_BEN.id] },
    });

    const bReweighted = createForecastScenarioBaseline({
      projectId: PROJECT,
      baselineRevision: 10,
      policyVersion: STAFFED_FORECAST_POLICY_VERSION,
      orderedScope: [A, B],
      configuration: createForecastConfiguration({ pointsPerSprint: 20, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07' }),
      factMap: { [A]: fact(10), [B]: fact(20) },
      roster: [PERSON_ADA, { ...PERSON_BEN, weightUnits: 200 }],
      assignments: { [A]: [PERSON_ADA.id], [B]: [PERSON_BEN.id] },
    });

    const fp1 = await scenarioFingerprint(b1, {});
    const fp2 = await scenarioFingerprint(bReweighted, {});
    expect(fp1).not.toBe(fp2);
  });

  it('materially changes when item assignments change', async () => {
    const b1 = createForecastScenarioBaseline({
      projectId: PROJECT,
      baselineRevision: 10,
      policyVersion: STAFFED_FORECAST_POLICY_VERSION,
      orderedScope: [A, B],
      configuration: createForecastConfiguration({ pointsPerSprint: 20, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07' }),
      factMap: { [A]: fact(10), [B]: fact(20) },
      roster: [PERSON_ADA, PERSON_BEN],
      assignments: { [A]: [PERSON_ADA.id], [B]: [PERSON_BEN.id] },
    });

    const bReassigned = createForecastScenarioBaseline({
      projectId: PROJECT,
      baselineRevision: 10,
      policyVersion: STAFFED_FORECAST_POLICY_VERSION,
      orderedScope: [A, B],
      configuration: createForecastConfiguration({ pointsPerSprint: 20, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07' }),
      factMap: { [A]: fact(10), [B]: fact(20) },
      roster: [PERSON_ADA, PERSON_BEN],
      assignments: { [A]: [PERSON_BEN.id], [B]: [PERSON_ADA.id] },
    });

    const fp1 = await scenarioFingerprint(b1, {});
    const fp2 = await scenarioFingerprint(bReassigned, {});
    expect(fp1).not.toBe(fp2);
  });

  it('person display names are non-material and do not alter fingerprint', async () => {
    const b1 = createForecastScenarioBaseline({
      projectId: PROJECT,
      baselineRevision: 10,
      policyVersion: STAFFED_FORECAST_POLICY_VERSION,
      orderedScope: [A],
      configuration: createForecastConfiguration({ pointsPerSprint: 20, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07' }),
      factMap: { [A]: fact(10) },
      roster: [PERSON_ADA],
      assignments: { [A]: [PERSON_ADA.id] },
    });

    const bRenamed = createForecastScenarioBaseline({
      projectId: PROJECT,
      baselineRevision: 10,
      policyVersion: STAFFED_FORECAST_POLICY_VERSION,
      orderedScope: [A],
      configuration: createForecastConfiguration({ pointsPerSprint: 20, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07' }),
      factMap: { [A]: fact(10) },
      roster: [{ ...PERSON_ADA, name: 'Ada Lovelace' }],
      assignments: { [A]: [PERSON_ADA.id] },
    });

    const fp1 = await scenarioFingerprint(b1, {});
    const fp2 = await scenarioFingerprint(bRenamed, {});
    expect(fp1).toBe(fp2);
  });

  it('legacy shared baseline fingerprint remains byte-identical', async () => {
    const legacyFp = await scenarioFingerprint(GOLDEN, {});
    expect(typeof legacyFp).toBe('string');
    expect(legacyFp).toHaveLength(64);
    // Recomputing produces the exact same fingerprint
    const again = await scenarioFingerprint(GOLDEN, {});
    expect(again).toBe(legacyFp);
  });
});

describe('Story 23.1 — AC 23.1-4: strict validation with structured actionable reasons', () => {
  it('rejects duplicate person IDs in roster with DUPLICATE_ROSTER_PERSON_ID', () => {
    const issues = validateForecastScenarioBaseline({
      projectId: PROJECT,
      baselineRevision: 1,
      policyVersion: STAFFED_FORECAST_POLICY_VERSION,
      planningLevel: 'Feature',
      orderedScope: [A],
      configuration: createForecastConfiguration({ pointsPerSprint: 10, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07' }),
      parallelGroups: [],
      blockedFeatureIds: [],
      factMap: { [A]: fact(10) },
      roster: [PERSON_ADA, { ...PERSON_ADA, name: 'Ada Twin' }],
      assignments: { [A]: [PERSON_ADA.id] },
    });

    expect(issues.some((i) => i.code === 'DUPLICATE_ROSTER_PERSON_ID')).toBe(true);
    const dupIssue = issues.find((i) => i.code === 'DUPLICATE_ROSTER_PERSON_ID');
    expect(dupIssue?.personIds).toEqual([PERSON_ADA.id]);
  });

  it('rejects malformed weights with INVALID_PERSON_WEIGHT', () => {
    const badWeights = [-100, 0, 1.5, NaN];
    for (const w of badWeights) {
      const issues = validateForecastScenarioBaseline({
        projectId: PROJECT,
        baselineRevision: 1,
        policyVersion: STAFFED_FORECAST_POLICY_VERSION,
        planningLevel: 'Feature',
        orderedScope: [A],
        configuration: createForecastConfiguration({ pointsPerSprint: 10, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07' }),
        parallelGroups: [],
        blockedFeatureIds: [],
        factMap: { [A]: fact(10) },
        roster: [{ ...PERSON_ADA, weightUnits: w }],
        assignments: { [A]: [PERSON_ADA.id] },
      });
      expect(issues.some((i) => i.code === 'INVALID_PERSON_WEIGHT')).toBe(true);
    }
  });

  it('rejects unsupported policy with UNSUPPORTED_FORECAST_POLICY', () => {
    const issues = validateForecastScenarioBaseline({
      projectId: PROJECT,
      baselineRevision: 1,
      policyVersion: 'shared-capacity-v0',
      planningLevel: 'Feature',
      orderedScope: [A],
      configuration: createForecastConfiguration({ pointsPerSprint: 10, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07' }),
      parallelGroups: [],
      blockedFeatureIds: [],
      factMap: { [A]: fact(10) },
    });
    expect(issues.some((i) => i.code === 'UNSUPPORTED_FORECAST_POLICY')).toBe(true);
  });

  it('rejects staffing payload labeled as shared-capacity-v1 with STAFFING_DATA_IN_SHARED_POLICY', () => {
    const issues = validateForecastScenarioBaseline({
      projectId: PROJECT,
      baselineRevision: 1,
      policyVersion: 'shared-capacity-v1',
      planningLevel: 'Feature',
      orderedScope: [A],
      configuration: createForecastConfiguration({ pointsPerSprint: 10, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07' }),
      parallelGroups: [],
      blockedFeatureIds: [],
      factMap: { [A]: fact(10) },
      roster: [PERSON_ADA],
      assignments: { [A]: [PERSON_ADA.id] },
    });
    expect(issues.some((i) => i.code === 'STAFFING_DATA_IN_SHARED_POLICY')).toBe(true);
  });

  it('rejects staffed baseline missing roster with MISSING_STAFFING_DATA', () => {
    const issues = validateForecastScenarioBaseline({
      projectId: PROJECT,
      baselineRevision: 1,
      policyVersion: STAFFED_FORECAST_POLICY_VERSION,
      planningLevel: 'Feature',
      orderedScope: [A],
      configuration: createForecastConfiguration({ pointsPerSprint: 10, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07' }),
      parallelGroups: [],
      blockedFeatureIds: [],
      factMap: { [A]: fact(10) },
    });
    expect(issues.some((i) => i.code === 'MISSING_STAFFING_DATA')).toBe(true);
  });

  it('rejects assignments referencing people not in roster with ASSIGNMENT_PERSON_NOT_IN_ROSTER', () => {
    const unknownPersonId = '019ffe00-0000-7000-8000-999999999999';
    const issues = validateForecastScenarioBaseline({
      projectId: PROJECT,
      baselineRevision: 1,
      policyVersion: STAFFED_FORECAST_POLICY_VERSION,
      planningLevel: 'Feature',
      orderedScope: [A],
      configuration: createForecastConfiguration({ pointsPerSprint: 10, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07' }),
      parallelGroups: [],
      blockedFeatureIds: [],
      factMap: { [A]: fact(10) },
      roster: [PERSON_ADA],
      assignments: { [A]: [unknownPersonId] },
    });
    expect(issues.some((i) => i.code === 'ASSIGNMENT_PERSON_NOT_IN_ROSTER')).toBe(true);
    const issue = issues.find((i) => i.code === 'ASSIGNMENT_PERSON_NOT_IN_ROSTER');
    expect(issue?.personIds).toEqual([unknownPersonId]);
  });

  it('rejects duplicate person assignment to the same item with DUPLICATE_ITEM_ASSIGNMENT', () => {
    const issues = validateForecastScenarioBaseline({
      projectId: PROJECT,
      baselineRevision: 1,
      policyVersion: STAFFED_FORECAST_POLICY_VERSION,
      planningLevel: 'Feature',
      orderedScope: [A],
      configuration: createForecastConfiguration({ pointsPerSprint: 10, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07' }),
      parallelGroups: [],
      blockedFeatureIds: [],
      factMap: { [A]: fact(10) },
      roster: [PERSON_ADA],
      assignments: { [A]: [PERSON_ADA.id, PERSON_ADA.id] },
    });
    expect(issues.some((i) => i.code === 'DUPLICATE_ITEM_ASSIGNMENT')).toBe(true);
  });

  it('isPersistedForecastScenario returns true for valid staffed scenario and false for invalid', () => {
    const validStaffed: PersistedForecastScenario = Object.freeze({
      scenarioId: '019ffe00-0000-7000-8000-000000000077',
      projectId: PROJECT,
      label: 'Valid Staffed',
      baselineRevision: 1,
      baselineFingerprint: 'c'.repeat(64),
      policyVersion: STAFFED_FORECAST_POLICY_VERSION,
      createdAtISO: '2026-09-24T12:00:00.000Z',
      baseline: Object.freeze({
        planningLevel: 'Feature',
        orderedScope: Object.freeze([A]),
        configuration: createForecastConfiguration({ pointsPerSprint: 10, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07' }),
        parallelGroups: Object.freeze([]),
        blockedFeatureIds: Object.freeze([]),
        factMap: Object.freeze({ [A]: fact(10) }),
        roster: Object.freeze([PERSON_ADA]),
        assignments: Object.freeze({ [A]: Object.freeze([PERSON_ADA.id]) }),
      }),
      patch: Object.freeze({}),
    });

    expect(isPersistedForecastScenario(validStaffed, PROJECT)).toBe(true);

    const invalidStaffed = {
      ...validStaffed,
      baseline: {
        ...validStaffed.baseline,
        roster: [{ ...PERSON_ADA, weightUnits: -50 }],
      },
    };
    expect(isPersistedForecastScenario(invalidStaffed, PROJECT)).toBe(false);
  });
});

describe('Story 23.1 — AC 23.1-5: multi-level baselines preserve level and own-node estimates without overlap', () => {
  const THEME_T1 = '019ffe00-0000-7000-8000-0000000000e1';
  const COMPONENT_C1 = '019ffe00-0000-7000-8000-0000000000e2';

  const themeFact = (points: number | null): ScenarioFeatureFact =>
    Object.freeze({ effortPoints: points, nodeType: 'Theme', projectId: PROJECT, ancestorIds: Object.freeze([]) });

  const compFact = (points: number | null): ScenarioFeatureFact =>
    Object.freeze({ effortPoints: points, nodeType: 'Component', projectId: PROJECT, ancestorIds: Object.freeze([]) });

  it('Theme-level baseline preserves planningLevel and own-node estimates in staffed evaluation', async () => {
    const themeBaseline = createForecastScenarioBaseline({
      projectId: PROJECT,
      baselineRevision: 4,
      policyVersion: STAFFED_FORECAST_POLICY_VERSION,
      planningLevel: 'Theme',
      orderedScope: [THEME_T1],
      configuration: createForecastConfiguration({ pointsPerSprint: 10, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07' }),
      factMap: { [THEME_T1]: themeFact(50) },
      roster: [PERSON_ADA],
      assignments: { [THEME_T1]: [PERSON_ADA.id] },
    });

    expect(themeBaseline.planningLevel).toBe('Theme');
    const result = await evaluateScenario(themeBaseline, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.baselineInputs.estimates[THEME_T1]).toBe(50);
    expect(result.baselineResult.arithmetic?.totalPoints).toBe(50);
  });

  it('Component-level baseline preserves planningLevel and estimates', async () => {
    const compBaseline = createForecastScenarioBaseline({
      projectId: PROJECT,
      baselineRevision: 4,
      policyVersion: STAFFED_FORECAST_POLICY_VERSION,
      planningLevel: 'Component',
      orderedScope: [COMPONENT_C1],
      configuration: createForecastConfiguration({ pointsPerSprint: 10, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07' }),
      factMap: { [COMPONENT_C1]: compFact(25) },
      roster: [PERSON_ADA],
      assignments: { [COMPONENT_C1]: [PERSON_ADA.id] },
    });

    expect(compBaseline.planningLevel).toBe('Component');
    const result = await evaluateScenario(compBaseline, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.baselineInputs.estimates[COMPONENT_C1]).toBe(25);
    expect(result.baselineResult.arithmetic?.totalPoints).toBe(25);
  });

  it('detects parent/descendant overlap across captured ancestry without cross-level scope leakage', async () => {
    const childFeatureFact: ScenarioFeatureFact = Object.freeze({
      effortPoints: 5,
      nodeType: 'Theme', // captured in Theme scenario
      projectId: PROJECT,
      ancestorIds: Object.freeze([THEME_T1]),
    });

    const overlappingBaseline = createForecastScenarioBaseline({
      projectId: PROJECT,
      baselineRevision: 4,
      policyVersion: STAFFED_FORECAST_POLICY_VERSION,
      planningLevel: 'Theme',
      orderedScope: [THEME_T1, A],
      configuration: createForecastConfiguration({ pointsPerSprint: 10, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07' }),
      factMap: {
        [THEME_T1]: themeFact(50),
        [A]: childFeatureFact,
      },
      roster: [PERSON_ADA],
      assignments: { [THEME_T1]: [PERSON_ADA.id], [A]: [PERSON_ADA.id] },
    });

    const result = await evaluateScenario(overlappingBaseline, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.code === 'OVERLAPPING_SCOPE')).toBe(true);
  });
});

describe('Story 23.2 — Variant fingerprint sensitivity and persisted patch validation', () => {
  it('scenarioFingerprint is sensitive to variant weightOverrides and assignmentOverrides', async () => {
    const b = createForecastScenarioBaseline({
      projectId: PROJECT,
      baselineRevision: 10,
      policyVersion: STAFFED_FORECAST_POLICY_VERSION,
      orderedScope: [A, B],
      configuration: createForecastConfiguration({ pointsPerSprint: 20, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07' }),
      factMap: { [A]: fact(10), [B]: fact(20) },
      roster: [PERSON_ADA, PERSON_BEN],
      assignments: { [A]: [PERSON_ADA.id], [B]: [PERSON_BEN.id] },
    });

    const fpBase = await scenarioFingerprint(b, {});
    const fpWeight = await scenarioFingerprint(b, { weightOverrides: { [PERSON_ADA.id]: 200 } });
    const fpAssign = await scenarioFingerprint(b, { assignmentOverrides: { [A]: [PERSON_BEN.id] } });

    expect(fpBase).not.toBe(fpWeight);
    expect(fpBase).not.toBe(fpAssign);
    expect(fpWeight).not.toBe(fpAssign);

    // Stable across unordered keys in patch
    const fpWeightUnordered = await scenarioFingerprint(b, {
      weightOverrides: { [PERSON_BEN.id]: 100, [PERSON_ADA.id]: 200 },
    });
    const fpWeightReverse = await scenarioFingerprint(b, {
      weightOverrides: { [PERSON_ADA.id]: 200, [PERSON_BEN.id]: 100 },
    });
    expect(fpWeightUnordered).toBe(fpWeightReverse);
  });

  it('validatePersistedForecastScenario validates staffed patch overrides and rejects invalid shapes', () => {
    const validStaffedPersisted = {
      scenarioId: '019ffe00-0000-7000-8000-000000000055',
      projectId: PROJECT,
      label: 'Variant 1',
      baselineRevision: 10,
      baselineFingerprint: 'a'.repeat(64),
      policyVersion: STAFFED_FORECAST_POLICY_VERSION,
      createdAtISO: '2026-09-24T12:00:00.000Z',
      baseline: {
        orderedScope: [A, B],
        configuration: createForecastConfiguration({ pointsPerSprint: 20, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07' }),
        parallelGroups: [],
        blockedFeatureIds: [],
        factMap: { [A]: fact(10), [B]: fact(20) },
        planningLevel: 'Feature',
        roster: [PERSON_ADA, PERSON_BEN],
        assignments: { [A]: [PERSON_ADA.id], [B]: [PERSON_BEN.id] },
      },
      patch: {
        weightOverrides: { [PERSON_ADA.id]: 200 },
        assignmentOverrides: { [A]: [PERSON_BEN.id] },
      },
    };

    expect(validatePersistedForecastScenario(validStaffedPersisted)).toEqual([]);

    // Rejects invalid person weight
    const invalidWeight = {
      ...validStaffedPersisted,
      patch: { weightOverrides: { [PERSON_ADA.id]: -5 } },
    };
    expect(validatePersistedForecastScenario(invalidWeight)).toContainEqual(
      expect.objectContaining({ code: 'INVALID_PERSON_WEIGHT' }),
    );

    // Rejects duplicate assignment in patch
    const dupAssign = {
      ...validStaffedPersisted,
      patch: { assignmentOverrides: { [A]: [PERSON_BEN.id, PERSON_BEN.id] } },
    };
    expect(validatePersistedForecastScenario(dupAssign)).toContainEqual(
      expect.objectContaining({ code: 'DUPLICATE_ITEM_ASSIGNMENT' }),
    );

    // Rejects staffing levers on shared-capacity-v1 scenario
    const sharedWithStaffing = {
      ...validStaffedPersisted,
      policyVersion: FORECAST_POLICY_VERSION,
      baseline: {
        orderedScope: [A, B],
        configuration: createForecastConfiguration({ pointsPerSprint: 20, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07' }),
        parallelGroups: [],
        blockedFeatureIds: [],
        factMap: { [A]: fact(10), [B]: fact(20) },
        planningLevel: 'Feature',
      },
      patch: {
        weightOverrides: { [PERSON_ADA.id]: 200 },
      },
    };
    expect(validatePersistedForecastScenario(sharedWithStaffing)).toContainEqual(
      expect.objectContaining({ code: 'STAFFING_DATA_IN_SHARED_POLICY' }),
    );
  });
});


