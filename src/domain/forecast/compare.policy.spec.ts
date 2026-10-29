/**
 * Forecast change attribution goldens (Story 20.2, AC 20.2-1..20.2-6,
 * AD-23, AR-24, FR-14, FR-15).
 *
 * Independent hand-reasoned expectations — not snapshots of the
 * implementation. Every cause is derived from the actual changed input; no
 * additive per-cause day attribution is ever produced.
 */

import { describe, it, expect } from 'vitest';
import { calculateForecast } from './whole-set.policy';
import { compareForecasts } from './compare.policy';
import type { ForecastInputs } from './forecast-result';

const P = '019ffe00-0000-7000-8000-000000000001';
const A = '019ffe00-0000-7000-8000-00000000000a';
const B = '019ffe00-0000-7000-8000-00000000000b';
const C = '019ffe00-0000-7000-8000-00000000000c';

function inp(over: Partial<ForecastInputs> = {}): ForecastInputs {
  return Object.freeze({
    projectId: P,
    projectRevision: 1,
    policyVersion: 'shared-capacity-v1',
    selectedFeatureIds: Object.freeze([A, B]),
    estimates: Object.freeze({ [A]: 10, [B]: 10 }),
    pointsPerSprint: 10,
    sprintLengthDays: 14,
    startSprintOrdinal: 1,
    startDate: '2026-09-07',
    parallelGroups: Object.freeze([]),
    blockedFeatureIds: Object.freeze([]),
    ...over,
  });
}

async function compare(before: ForecastInputs, after: ForecastInputs) {
  const br = await calculateForecast(before);
  const ar = await calculateForecast(after);
  return compareForecasts(before, after, br, ar);
}

describe('AC 20.2-1 — an estimate change is an estimate cause, never a scope change', () => {
  it('5→8 on an unchanged set is EstimateIncreased even when rounded completion is unchanged', async () => {
    const before = inp({ estimates: { [A]: 5, [B]: 10 } });
    const after = inp({ estimates: { [A]: 8, [B]: 10 } });
    const cmp = await compare(before, after);
    expect(cmp?.causes).toEqual([
      { kind: 'EstimateIncreased', field: 'estimate', featureId: A, before: 5, after: 8 },
    ]);
    // 15 and 18 points at C=10 both round up to 2 sprints.
    expect(cmp?.changedDimensions.date).toBe(false);
  });
});

describe('AC 20.2-2 — a newly-selected Feature is ScopeAdded, not an estimate increase from zero', () => {
  it('adding C with an estimate reports ScopeAdded only', async () => {
    const before = inp();
    const after = inp({ selectedFeatureIds: [A, B, C], estimates: { [A]: 10, [B]: 10, [C]: 10 } });
    const cmp = await compare(before, after);
    expect(cmp?.causes).toEqual([{ kind: 'ScopeAdded', field: 'scope', featureIds: [C] }]);
  });
});

describe('AC 20.2-3 — order-only change: "Same completion", names affected timing', () => {
  it('reordering A/B does not move the whole-set date but flags sequence + sameCompletion', async () => {
    const before = inp();
    const after = inp({ selectedFeatureIds: [B, A] });
    const cmp = await compare(before, after);
    expect(cmp?.causes.map((c) => c.kind)).toEqual(['OrderChanged']);
    expect(cmp?.changedDimensions.date).toBe(false);
    expect(cmp?.changedDimensions.sequence).toBe(true);
    expect(cmp?.sameCompletion).toBe(true);
  });
});

describe('AC 20.2-4 — compound changes: all distinct causes, no additive day claims', () => {
  it('scope + estimate + capacity + start each appear once, in field order', async () => {
    const before = inp();
    const after = inp({
      selectedFeatureIds: [A, B, C],
      estimates: { [A]: 20, [B]: 10, [C]: 10 },
      pointsPerSprint: 20,
      startSprintOrdinal: 5,
      startDate: '2026-10-05',
    });
    const cmp = await compare(before, after);
    expect(cmp?.causes.map((c) => c.kind)).toEqual([
      'ScopeAdded',
      'EstimateIncreased',
      'CapacityChanged',
      'StartChanged',
    ]);
    // No cause carries a "days" field.
    for (const c of cmp!.causes) expect(Object.keys(c)).not.toContain('days');
  });
});

describe('AC 20.2-5 — field order for "first differing input" without proven history', () => {
  it('scope precedes estimate precedes capacity precedes start precedes cadence precedes constraints', async () => {
    const before = inp();
    const after = inp({
      selectedFeatureIds: [A, B, C],
      estimates: { [A]: 10, [B]: 10, [C]: 10 },
      pointsPerSprint: 20,
      sprintLengthDays: 7,
      startSprintOrdinal: 2,
      blockedFeatureIds: [A],
    });
    const cmp = await compare(before, after);
    expect(cmp?.causes.map((c) => c.field)).toEqual([
      'scope',
      'capacity',
      'start',
      'cadence',
      'constraints',
    ]);
  });
});

describe('AC 20.2-6 — no retained baseline: attribution unavailable, never invented', () => {
  it('returns null when there is no before-inputs baseline', async () => {
    const after = inp();
    const ar = await calculateForecast(after);
    expect(compareForecasts(null, after, null, ar)).toBeNull();
  });
});

describe('blocker-only change: validity may move without a date delta', () => {
  it('marking A blocked yields BlockerChanged and a validity change, no date change', async () => {
    const before = inp();
    const after = inp({ blockedFeatureIds: [A] });
    const cmp = await compare(before, after);
    expect(cmp?.causes).toEqual([
      { kind: 'BlockerChanged', field: 'constraints', added: [A], removed: [] },
    ]);
    expect(cmp?.changedDimensions.date).toBe(false);
    expect(cmp?.changedDimensions.validity).toBe(true);
  });
});

describe('a title-only edit produces no cause', () => {
  it('identical material inputs → empty causes', async () => {
    const cmp = await compare(inp(), inp());
    expect(cmp?.causes).toEqual([]);
    expect(cmp?.sameCompletion).toBe(false);
  });
});

describe('estimate cleared / set are their own directions', () => {
  it('10→null is EstimateCleared; null→10 is EstimateSet', async () => {
    const cleared = await compare(inp(), inp({ estimates: { [A]: null, [B]: 10 } }));
    expect(cleared?.causes[0]).toMatchObject({ kind: 'EstimateCleared', featureId: A });
    const set = await compare(inp({ estimates: { [A]: null, [B]: 10 } }), inp());
    expect(set?.causes[0]).toMatchObject({ kind: 'EstimateSet', featureId: A, after: 10 });
  });
});

describe('AC 20.2-5 — proven ChangeSet chronology', () => {
  it('orders the first cause by revision chronology before architectural fallback order', async () => {
    const before = inp();
    const after = inp({ selectedFeatureIds: [A], estimates: { [A]: 15 }, pointsPerSprint: 20 });
    const br = await calculateForecast(before);
    const ar = await calculateForecast(after);
    const comparison = compareForecasts(before, after, br, ar, ['capacity', 'estimate', 'scope']);
    expect(comparison?.causes.map((cause) => cause.field)).toEqual(['capacity', 'estimate', 'scope']);
  });
});

describe('AC 22.7-3 — staffing changes: policy, assignment, roster, and individual capacity levers', () => {
  const adaId = '019ffe00-0000-7000-8000-000000000001';
  const benId = '019ffe00-0000-7000-8000-000000000002';
  const charlieId = '019ffe00-0000-7000-8000-000000000003';

  it('policy mode switch produces PolicyChanged with before/after policy versions', async () => {
    const before = inp({ policyVersion: 'shared-capacity-v1' });
    const after = inp({ policyVersion: 'staffed-capacity-v1' });
    const cmp = await compare(before, after);
    expect(cmp?.causes).toContainEqual({
      kind: 'PolicyChanged',
      field: 'policy',
      before: 'shared-capacity-v1',
      after: 'staffed-capacity-v1',
    });
  });

  it('assignment edit produces AssignmentChanged with person names', async () => {
    const roster = [
      { id: adaId, name: 'Ada', weightUnits: 10 },
      { id: benId, name: 'Ben', weightUnits: 10 },
    ];
    const before = inp({
      policyVersion: 'staffed-capacity-v1',
      roster,
      assignments: { [A]: [adaId], [B]: [benId] },
    });
    const after = inp({
      policyVersion: 'staffed-capacity-v1',
      roster,
      assignments: { [A]: [benId], [B]: [benId] },
    });
    const cmp = await compare(before, after);
    expect(cmp?.causes).toContainEqual({
      kind: 'AssignmentChanged',
      field: 'assignment',
      featureId: A,
      before: ['Ada'],
      after: ['Ben'],
    });
  });

  it('roster and weight edits produce RosterChanged and PersonWeightChanged without day attribution', async () => {
    const beforeRoster = [
      { id: adaId, name: 'Ada', weightUnits: 10 },
      { id: benId, name: 'Ben', weightUnits: 10 },
    ];
    const afterRoster = [
      { id: adaId, name: 'Ada', weightUnits: 15 },
      { id: charlieId, name: 'Charlie', weightUnits: 10 },
    ];
    const before = inp({
      policyVersion: 'staffed-capacity-v1',
      roster: beforeRoster,
      assignments: { [A]: [adaId] },
    });
    const after = inp({
      policyVersion: 'staffed-capacity-v1',
      roster: afterRoster,
      assignments: { [A]: [adaId] },
    });
    const cmp = await compare(before, after);
    expect(cmp?.causes).toContainEqual({
      kind: 'RosterChanged',
      field: 'roster',
      added: ['Charlie'],
      removed: ['Ben'],
    });
    expect(cmp?.causes).toContainEqual({
      kind: 'PersonWeightChanged',
      field: 'roster',
      personId: adaId,
      personName: 'Ada',
      before: 10,
      after: 15,
    });
    // No cause contains a "days" field (no additive day attribution).
    for (const c of cmp!.causes) expect(Object.keys(c)).not.toContain('days');
  });
});

describe('AC 22.7-4 — M14 regrouping vs duration-preserving block permutation', () => {
  const adaId = '019ffe00-0000-7000-8000-000000000001';
  const benId = '019ffe00-0000-7000-8000-000000000002';
  const roster = [
    { id: adaId, name: 'Ada', weightUnits: 10 },
    { id: benId, name: 'Ben', weightUnits: 10 },
  ];

  it('M14 regrouping from sequential to parallel bucket changes duration and reports ParallelChanged', async () => {
    // Sequential A=10/Ada (1 sprint) then B=30/Ben (3 sprints) -> total 4 sprints.
    const before = inp({
      policyVersion: 'staffed-capacity-v1',
      roster,
      selectedFeatureIds: [A, B],
      estimates: { [A]: 10, [B]: 30 },
      assignments: { [A]: [adaId], [B]: [benId] },
      parallelGroups: [],
    });
    // Regroup as M3 bucket -> max(1, 3) = 3 sprints.
    const after = inp({
      policyVersion: 'staffed-capacity-v1',
      roster,
      selectedFeatureIds: [A, B],
      estimates: { [A]: 10, [B]: 30 },
      assignments: { [A]: [adaId], [B]: [benId] },
      parallelGroups: [{ featureIds: [A, B] }],
    });
    const cmp = await compare(before, after);
    expect(cmp?.changedDimensions.date).toBe(true);
    expect(cmp?.causes.map((c) => c.kind)).toContain('ParallelChanged');
    expect(cmp?.sameCompletion).toBe(false);
  });

  it('duration-preserving permutation reports same completion and changed item timing', async () => {
    // Sequential A=10/Ada (1 sprint) then B=30/Ben (3 sprints) -> total 4 sprints.
    const before = inp({
      policyVersion: 'staffed-capacity-v1',
      roster,
      selectedFeatureIds: [A, B],
      estimates: { [A]: 10, [B]: 30 },
      assignments: { [A]: [adaId], [B]: [benId] },
      parallelGroups: [],
    });
    // Swapping order to B then A -> 3 + 1 = 4 sprints. Total duration is identical.
    const after = inp({
      policyVersion: 'staffed-capacity-v1',
      roster,
      selectedFeatureIds: [B, A],
      estimates: { [A]: 10, [B]: 30 },
      assignments: { [A]: [adaId], [B]: [benId] },
      parallelGroups: [],
    });
    const cmp = await compare(before, after);
    expect(cmp?.changedDimensions.date).toBe(false);
    expect(cmp?.changedDimensions.sequence).toBe(true);
    expect(cmp?.sameCompletion).toBe(true);
    expect(cmp?.causes.map((c) => c.kind)).toContain('OrderChanged');
  });
});

