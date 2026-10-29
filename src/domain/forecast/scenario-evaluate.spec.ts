/**
 * Historical scenario evaluation goldens (Story 20.3, AC 20.3-1..20.3-6,
 * AD-22, §6). Independent hand-reasoned expectations. Evaluation is pure:
 * no receipt, revision bump, persisted result, or live-fact read.
 */

import { describe, it, expect } from 'vitest';
import { createForecastConfiguration } from './forecast-plan.entity';
import { evaluateScenario } from './scenario-evaluate';
import { scenarioFingerprint, scenarioCanonicalBytes } from './scenario';
import type { ForecastScenarioBaseline, ForecastScenarioPatch, ScenarioFeatureFact } from './scenario';

const PROJECT = '019ffe00-0000-7000-8000-000000000001';
const A = '019ffe00-0000-7000-8000-00000000000a';
const B = '019ffe00-0000-7000-8000-00000000000b';
const C = '019ffe00-0000-7000-8000-00000000000c';
const D = '019ffe00-0000-7000-8000-00000000000d';

function fact(over: Partial<ScenarioFeatureFact> = {}): ScenarioFeatureFact {
  return Object.freeze({ effortPoints: 10, nodeType: 'Feature', projectId: PROJECT, ancestorIds: Object.freeze([]), ...over });
}

function baseline(over: Partial<ForecastScenarioBaseline> = {}): ForecastScenarioBaseline {
  return Object.freeze({
    projectId: PROJECT,
    baselineRevision: 7,
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
    factMap: Object.freeze({ [A]: fact(), [B]: fact(), [C]: fact(), [D]: fact() }),
    ...over,
  });
}

describe('AC 20.3-1 — baseline and variant use one captured union fact map and the frozen calculator', () => {
  it('a capacity patch re-evaluates both from historical facts only', async () => {
    const evalResult = await evaluateScenario(baseline(), { pointsPerSprint: 20 });
    expect(evalResult.ok).toBe(true);
    if (!evalResult.ok) return;
    // Baseline: 20 pts / 10 = 2 sprints. Variant: 20 / 20 = 1 sprint.
    expect(evalResult.baselineResult.arithmetic?.occupiedSprints).toBe(2);
    expect(evalResult.variantResult.arithmetic?.occupiedSprints).toBe(1);
    expect(evalResult.comparison?.causes.map((c) => c.kind)).toEqual(['CapacityChanged']);
  });
});

describe('AC 20.3-2 — a variant-only Feature never enters baseline scope', () => {
  it('adding C to the variant order leaves the baseline at [A, B]', async () => {
    const r = await evaluateScenario(baseline(), { orderedScope: [A, B, C] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.baselineInputs.selectedFeatureIds).toEqual([A, B]);
    expect(r.variantInputs.selectedFeatureIds).toEqual([A, B, C]);
    expect(r.comparison?.causes).toEqual([{ kind: 'ScopeAdded', field: 'scope', featureIds: [C] }]);
  });
});

describe('AC 20.3-3 — invalid scope / override / order relationships are typed rejections without writes', () => {
  it('rejects a duplicate scope member', async () => {
    const r = await evaluateScenario(baseline(), { orderedScope: [A, A, B] });
    expect(r).toMatchObject({ ok: false });
    if (r.ok) return;
    expect(r.issues.some((i) => i.code === 'DUPLICATE_SCOPE_MEMBER')).toBe(true);
  });

  it('rejects a point override for an excluded member', async () => {
    const r = await evaluateScenario(baseline(), { orderedScope: [A], pointOverrides: { [B]: 5 } });
    expect(r).toMatchObject({ ok: false });
    if (r.ok) return;
    expect(r.issues).toContainEqual({ code: 'OVERRIDE_FOR_EXCLUDED_MEMBER', featureId: B });
  });

  it('rejects a cross-project member from the captured facts', async () => {
    const bx = baseline({ factMap: { [A]: fact(), [B]: fact({ projectId: 'other-project' }) } });
    const r = await evaluateScenario(bx, {});
    expect(r).toMatchObject({ ok: false });
    if (r.ok) return;
    expect(r.issues).toContainEqual({ code: 'CROSS_PROJECT_MEMBER', featureId: B });
  });

  it('rejects a parent/descendant overlap using captured ancestor chains', async () => {
    const bx = baseline({
      orderedScope: [A, B],
      factMap: { [A]: fact(), [B]: fact({ ancestorIds: [A] }) },
    });
    const r = await evaluateScenario(bx, {});
    expect(r).toMatchObject({ ok: false });
    if (r.ok) return;
    expect(r.issues.some((i) => i.code === 'OVERLAPPING_SCOPE')).toBe(true);
  });

  it('rejects a variant order that splits a retained parallel group', async () => {
    const bx = baseline({
      orderedScope: [A, B, C],
      parallelGroups: [{ featureIds: [A, B] }],
      factMap: { [A]: fact(), [B]: fact(), [C]: fact() },
    });
    // Put C between A and B → splits the retained {A,B} group.
    const r = await evaluateScenario(bx, { orderedScope: [A, C, B] });
    expect(r).toMatchObject({ ok: false });
    if (r.ok) return;
    expect(r.issues.some((i) => i.code === 'ORDER_SPLITS_RETAINED_GROUP')).toBe(true);
  });

  it('rejects a reference to an uncaptured Feature (requires whole-baseline refresh)', async () => {
    const bx = baseline({ factMap: { [A]: fact(), [B]: fact() } });
    const r = await evaluateScenario(bx, { orderedScope: [A, B, C] });
    expect(r).toMatchObject({ ok: false });
    if (r.ok) return;
    expect(r.issues).toContainEqual({ code: 'UNCAPTURED_FEATURE', featureId: C });
  });
});

describe('AC 20.3-4 — removing a member from a two-item group dissolves the singleton and reports cleanup', () => {
  it('a variant scope without B dissolves the {A,B} group', async () => {
    const bx = baseline({
      orderedScope: [A, B],
      parallelGroups: [{ featureIds: [A, B] }],
    });
    const r = await evaluateScenario(bx, { orderedScope: [A] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.variantInputs.parallelGroups).toEqual([]);
    expect(r.groupCleanups).toEqual([
      { keptFeatureIds: [A], removedFeatureIds: [B], dissolved: true },
    ]);
  });
});

describe('AC 20.3-5 — captured facts stay authoritative after live changes', () => {
  it('the same baseline+patch evaluates byte-identically regardless of surrounding calls', async () => {
    const b = baseline();
    const p: ForecastScenarioPatch = { pointOverrides: { [A]: 25 } };
    const first = await evaluateScenario(b, p);
    const second = await evaluateScenario(b, p);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(JSON.stringify(first.variantResult)).toBe(JSON.stringify(second.variantResult));
  });
});

describe('AC 20.3-6 — evaluation performs no writes and is deterministic', () => {
  it('the fingerprint is independent of fact-map key order and override key order', async () => {
    const b1 = baseline({ factMap: { [A]: fact(), [B]: fact(), [C]: fact() } });
    const b2 = baseline({ factMap: { [C]: fact(), [B]: fact(), [A]: fact() } });
    const fp1 = await scenarioFingerprint(b1, { pointOverrides: { [A]: 5, [B]: 6 } });
    const fp2 = await scenarioFingerprint(b2, { pointOverrides: { [B]: 6, [A]: 5 } });
    expect(fp1).toBe(fp2);
  });

  it('canonical bytes are stable across repeated serialization', () => {
    const b = baseline();
    expect(scenarioCanonicalBytes(b, {})).toBe(scenarioCanonicalBytes(b, {}));
  });
});

describe('unsupported policy fails closed', () => {
  it('a non-v1 baseline policy returns UNSUPPORTED_FORECAST_POLICY, not an older algorithm', async () => {
    const bx = { ...baseline(), policyVersion: 'shared-capacity-v0' as unknown as 'shared-capacity-v1' };
    const r = await evaluateScenario(bx, {});
    expect(r).toMatchObject({ ok: false });
    if (r.ok) return;
    expect(r.issues[0]).toMatchObject({ code: 'UNSUPPORTED_FORECAST_POLICY' });
  });
});

// ── Story 21.9 — scenario level awareness (AC 21.9-3) ─────────────────────

describe('Story 21.9 AC 3 — Theme/Component scenarios evaluate at their captured level', () => {
  const THEME = '019ffe00-0000-7000-8000-00000000000e';
  const themeFact = (points: number | null): ScenarioFeatureFact =>
    Object.freeze({ effortPoints: points, nodeType: 'Theme', projectId: PROJECT, ancestorIds: Object.freeze([]) });

  it('accepts members whose captured type equals the captured level', async () => {
    const b = baseline({
      planningLevel: 'Theme',
      orderedScope: Object.freeze([THEME]),
      factMap: Object.freeze({ [THEME]: themeFact(20) }),
    });
    const r = await evaluateScenario(b, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.baselineInputs.estimates[THEME]).toBe(20);
  });

  it('raises NOT_A_FEATURE only for a genuine level mismatch', async () => {
    // A Feature node captured in a Theme-level scenario is a real mismatch.
    const b = baseline({
      planningLevel: 'Theme',
      orderedScope: Object.freeze([A]),
      factMap: Object.freeze({ [A]: fact({ effortPoints: 10 }) }),
    });
    const r = await evaluateScenario(b, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.some((i) => i.code === 'NOT_A_FEATURE')).toBe(true);
  });

  it('carries captured estimates into the evaluation instead of dropping them', async () => {
    const b = baseline({
      planningLevel: 'Theme',
      orderedScope: Object.freeze([THEME]),
      factMap: Object.freeze({ [THEME]: themeFact(30) }),
    });
    const r = await evaluateScenario(b, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.baselineResult.arithmetic?.totalPoints).toBe(30);
  });
});

// ── Story 23.2 — evaluate assignment and weight scenario variants ──────────

describe('Story 23.2 — Staffing scenario variants (AC 23.2-1..23.2-6)', () => {
  const ADA = '019ffe00-0000-7000-8000-0000000000a1';
  const BEN = '019ffe00-0000-7000-8000-0000000000b2';
  const UNKNOWN_PERSON = '019ffe00-0000-7000-8000-000000000099';

  function staffedBaseline(over: Partial<ForecastScenarioBaseline> = {}): ForecastScenarioBaseline {
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
      factMap: Object.freeze({
        [A]: fact({ effortPoints: 30 }),
        [B]: fact({ effortPoints: 10 }),
        [C]: fact({ effortPoints: 20 }),
        [D]: fact({ effortPoints: 15 }),
      }),
      roster: Object.freeze([
        { id: ADA, name: 'Ada', weightUnits: 300 },
        { id: BEN, name: 'Ben', weightUnits: 100 },
      ]),
      assignments: Object.freeze({
        [A]: Object.freeze([BEN]),
        [B]: Object.freeze([ADA]),
      }),
      ...over,
    });
  }

  describe('AC 23.2-1 — inheritance, clearing, and override validation', () => {
    it('absent fields inherit baseline assignments and weights', async () => {
      const b = staffedBaseline();
      const r = await evaluateScenario(b, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.variantInputs.roster).toEqual(b.roster);
      expect(r.variantInputs.assignments).toEqual(b.assignments);
    });

    it('explicit empty assignment set clears item assignments', async () => {
      const b = staffedBaseline();
      const r = await evaluateScenario(b, {
        assignmentOverrides: { [A]: [] },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.variantInputs.assignments?.[A]).toBeUndefined();
      // B remains inherited
      expect(r.variantInputs.assignments?.[B]).toEqual([ADA]);
    });

    it('rejects duplicate person IDs on an item assignment override', async () => {
      const b = staffedBaseline();
      const r = await evaluateScenario(b, {
        assignmentOverrides: { [A]: [ADA, ADA] },
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.issues).toContainEqual(
        expect.objectContaining({ code: 'DUPLICATE_ITEM_ASSIGNMENT', featureId: A }),
      );
    });

    it('rejects assignment referencing person not in captured roster', async () => {
      const b = staffedBaseline();
      const r = await evaluateScenario(b, {
        assignmentOverrides: { [A]: [UNKNOWN_PERSON] },
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.issues).toContainEqual(
        expect.objectContaining({
          code: 'ASSIGNMENT_PERSON_NOT_IN_ROSTER',
          personId: UNKNOWN_PERSON,
          featureId: A,
        }),
      );
    });

    it('rejects assignment override for excluded item', async () => {
      const b = staffedBaseline();
      const r = await evaluateScenario(b, {
        orderedScope: [A],
        assignmentOverrides: { [B]: [ADA] },
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.issues).toContainEqual(
        expect.objectContaining({ code: 'OVERRIDE_FOR_EXCLUDED_MEMBER', featureId: B }),
      );
    });

    it('rejects weight override for unknown person', async () => {
      const b = staffedBaseline();
      const r = await evaluateScenario(b, {
        weightOverrides: { [UNKNOWN_PERSON]: 200 },
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.issues).toContainEqual(
        expect.objectContaining({
          code: 'WEIGHT_OVERRIDE_FOR_UNKNOWN_PERSON',
          personId: UNKNOWN_PERSON,
        }),
      );
    });

    it('rejects invalid weight override (<= 0 or non-integer; no scenario-only maximum, Story 23.9)', async () => {
      const b = staffedBaseline();
      const r1 = await evaluateScenario(b, { weightOverrides: { [ADA]: 0 } });
      expect(r1.ok).toBe(false);
      if (!r1.ok) {
        expect(r1.issues).toContainEqual(
          expect.objectContaining({ code: 'INVALID_WEIGHT_OVERRIDE', personId: ADA }),
        );
      }

      const r2 = await evaluateScenario(b, { weightOverrides: { [ADA]: 1.5 } });
      expect(r2.ok).toBe(false);
      if (!r2.ok) {
        expect(r2.issues).toContainEqual(
          expect.objectContaining({ code: 'INVALID_WEIGHT_OVERRIDE', personId: ADA }),
        );
      }
    });
  });

  describe('AC 23.2-2 — Example S1 exact oracle and atomic swap', () => {
    it('Example S1: swapping Ada and Ben yields T=2 instead of baseline T=6 atomically', async () => {
      // Baseline: C=20, Ada=300 (rate 15), Ben=100 (rate 5). Bucket [A=30, B=10].
      // A assigned Ben -> 30/5 = 6 sprints. B assigned Ada -> 10/15 = 2/3 sprint.
      // D = max(6, 2/3) = 6 sprints -> completion Sprint 17, 2026-11-29.
      const b = staffedBaseline();

      // Swap variant: A assigned Ada, B assigned Ben.
      // In sequential application, A=Ada would temporarily double-book Ada on A and B.
      // Atomic application validates only final state -> A=30/15 = 2, B=10/5 = 2 -> D = 2.
      // Completion Sprint 13, 2026-10-04.
      const r = await evaluateScenario(b, {
        assignmentOverrides: {
          [A]: [ADA],
          [B]: [BEN],
        },
      });

      expect(r.ok).toBe(true);
      if (!r.ok) return;

      // Baseline expectations (Example S1)
      expect(r.baselineResult.arithmetic?.occupiedSprints).toBe(6);
      expect(r.baselineResult.arithmetic?.completionSprint).toBe(17);
      expect(r.baselineResult.arithmetic?.completionDate).toBe('2026-11-29');

      // Variant expectations (Example S1)
      expect(r.variantResult.arithmetic?.occupiedSprints).toBe(2);
      expect(r.variantResult.arithmetic?.completionSprint).toBe(13);
      expect(r.variantResult.arithmetic?.completionDate).toBe('2026-10-04');

      // Comparison causes
      expect(r.comparison?.causes).toContainEqual(
        expect.objectContaining({
          kind: 'AssignmentChanged',
          featureId: A,
          before: ['Ben'],
          after: ['Ada'],
        }),
      );
      expect(r.comparison?.causes).toContainEqual(
        expect.objectContaining({
          kind: 'AssignmentChanged',
          featureId: B,
          before: ['Ada'],
          after: ['Ben'],
        }),
      );
      expect(r.comparison?.changedDimensions.date).toBe(true);
    });
  });

  describe('AC 23.2-3 — Scope removal and zero-work cleanups', () => {
    it('scope removal removes affected inherited assignments and discloses cleanup', async () => {
      const b = staffedBaseline();
      // Remove B from variant scope
      const r = await evaluateScenario(b, {
        orderedScope: [A],
      });

      expect(r.ok).toBe(true);
      if (!r.ok) return;

      expect(r.variantInputs.assignments?.[B]).toBeUndefined();
      expect(r.variantInputs.assignments?.[A]).toEqual([BEN]);
      expect(r.assignmentCleanups).toContainEqual({
        featureId: B,
        removedPersonIds: [ADA],
        reason: 'scope-removed',
      });

      // Baseline facts remain intact
      expect(b.assignments?.[B]).toEqual([ADA]);
      expect(r.baselineInputs.assignments?.[B]).toEqual([ADA]);
    });

    it('point override to zero removes inherited assignments and discloses cleanup', async () => {
      const b = staffedBaseline();
      // Override A's points to 0 (milestone)
      const r = await evaluateScenario(b, {
        pointOverrides: { [A]: 0 },
      });

      expect(r.ok).toBe(true);
      if (!r.ok) return;

      expect(r.variantInputs.assignments?.[A]).toBeUndefined();
      expect(r.assignmentCleanups).toContainEqual({
        featureId: A,
        removedPersonIds: [BEN],
        reason: 'zero-work',
      });

      // Baseline facts remain intact
      expect(b.assignments?.[A]).toEqual([BEN]);
    });

    it('rejects explicit nonempty assignment override on zero-work items', async () => {
      const b = staffedBaseline();
      const r = await evaluateScenario(b, {
        pointOverrides: { [A]: 0 },
        assignmentOverrides: { [A]: [ADA] },
      });

      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.issues).toContainEqual(
        expect.objectContaining({ code: 'ASSIGNMENT_TO_ZERO_WORK', featureId: A }),
      );
    });
  });

  describe('AC 23.2-4 — Missing assignments and incomplete variant', () => {
    it('clearing assignment on positive-point work leaves variant visibly incomplete', async () => {
      const b = staffedBaseline();
      const r = await evaluateScenario(b, {
        assignmentOverrides: { [A]: [] },
      });

      expect(r.ok).toBe(true);
      if (!r.ok) return;

      expect(r.variantResult.state).toBe('incomplete');
      expect(r.variantResult.arithmetic).toBeNull();
      expect(r.variantResult.allocation).toBeNull();
      expect(r.variantResult.issues).toContainEqual(
        expect.objectContaining({ code: 'MISSING_ASSIGNMENT' }),
      );
    });

    it('adding unassigned positive-point scope leaves variant incomplete with no implicit assignments', async () => {
      const b = staffedBaseline();
      // Add C (20 points, unassigned)
      const r = await evaluateScenario(b, {
        orderedScope: [A, B, C],
      });

      expect(r.ok).toBe(true);
      if (!r.ok) return;

      expect(r.variantResult.state).toBe('incomplete');
      expect(r.variantResult.arithmetic).toBeNull();
      expect(r.variantResult.issues).toContainEqual(
        expect.objectContaining({ code: 'MISSING_ASSIGNMENT', featureIds: [C] }),
      );
    });
  });

  describe('AC 23.2-5 — Lever attribution and invariant-preserving edits', () => {
    it('reports weight, assignment, capacity, and estimate changes separately', async () => {
      const b = staffedBaseline();
      const r = await evaluateScenario(b, {
        pointsPerSprint: 40,
        weightOverrides: { [ADA]: 100 },
        assignmentOverrides: { [A]: [ADA] },
        pointOverrides: { [B]: 20 },
      });

      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const kinds = r.comparison?.causes.map((c) => c.kind);
      expect(kinds).toContain('CapacityChanged');
      expect(kinds).toContain('PersonWeightChanged');
      expect(kinds).toContain('AssignmentChanged');
      expect(kinds).toContain('EstimateIncreased');
    });

    it('invariant-preserving edits report sameCompletion: true', async () => {
      // Sequential A=10/Ada (1 sprint), B=30/Ben (3 sprints) -> total 4 sprints.
      const b = staffedBaseline({
        parallelGroups: [],
        factMap: Object.freeze({
          [A]: fact({ effortPoints: 10 }),
          [B]: fact({ effortPoints: 30 }),
        }),
        roster: Object.freeze([
          { id: ADA, name: 'Ada', weightUnits: 100 },
          { id: BEN, name: 'Ben', weightUnits: 100 },
        ]),
        assignments: Object.freeze({
          [A]: Object.freeze([ADA]),
          [B]: Object.freeze([BEN]),
        }),
      });

      // Swapping sequence to B then A: B takes 3 sprints, A takes 1 sprint -> total 4 sprints.
      const r = await evaluateScenario(b, {
        orderedScope: [B, A],
      });

      expect(r.ok).toBe(true);
      if (!r.ok) return;

      expect(r.comparison?.changedDimensions.date).toBe(false);
      expect(r.comparison?.changedDimensions.sequence).toBe(true);
      expect(r.comparison?.sameCompletion).toBe(true);
    });
  });

  describe('AC 23.2-6 — Unsupported levers rejection and shared-policy preservation', () => {
    it('rejects attempts to vary roster membership in patch', async () => {
      const b = staffedBaseline();
      const patchWithRoster = {
        roster: [{ id: ADA, name: 'Ada', weightUnits: 100 }],
      } as unknown as ForecastScenarioPatch;

      const r = await evaluateScenario(b, patchWithRoster);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.issues).toContainEqual(
        expect.objectContaining({ code: 'UNSUPPORTED_SCENARIO_LEVER' }),
      );
    });

    it('rejects attempts to vary planningLevel, startDate, or cadence in patch', async () => {
      const b = staffedBaseline();
      const r = await evaluateScenario(b, {
        planningLevel: 'Component',
        startDate: '2026-10-01',
      } as unknown as ForecastScenarioPatch);

      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.issues).toContainEqual(
        expect.objectContaining({ code: 'UNSUPPORTED_SCENARIO_LEVER' }),
      );
    });

    it('rejects staffing levers on shared-capacity-v1 baseline', async () => {
      const b = baseline(); // shared-capacity-v1
      const r = await evaluateScenario(b, {
        weightOverrides: { [ADA]: 200 },
      });

      expect(r.ok).toBe(false);
      if (r.ok) return;
      // Story 26.4: a more specific code names the reason staffing levers
      // require assigned-people mode; the rejection is unchanged.
      expect(r.issues).toContainEqual(
        expect.objectContaining({ code: 'STAFFING_DATA_IN_SHARED_POLICY' }),
      );
    });
  });
});

