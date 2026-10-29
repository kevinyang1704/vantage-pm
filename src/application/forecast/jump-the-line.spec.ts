import { describe, expect, it } from 'vitest';
import { evaluateScenario } from '../../domain/forecast/scenario-evaluate';
import type { ForecastScenarioBaseline } from '../../domain/forecast/scenario';
import {
  buildEveryonePauses,
  buildChosenPeople,
  buildHoldTheDate,
  compareItemFinishes,
  stakeholderSummary,
  type UrgentItem,
} from '../../domain/forecast/jump-the-line';

const PROJECT = '019ffe00-0000-7000-8000-000000000001';
const A = '019ffe00-0000-7000-8000-00000000000a';
const B = '019ffe00-0000-7000-8000-00000000000b';
const ADA = '019ffe00-0000-7000-8000-0000000000a1';
const BEN = '019ffe00-0000-7000-8000-0000000000a2';
const CARA = '019ffe00-0000-7000-8000-0000000000a3';

function fact(effortPoints: number) {
  return Object.freeze({ effortPoints, nodeType: 'Feature', projectId: PROJECT, ancestorIds: Object.freeze([]) });
}

/** An S1-like staffed baseline: two 10-point items, Ada on A, Ben on B. */
function baseline(): ForecastScenarioBaseline {
  return Object.freeze({
    projectId: PROJECT,
    baselineRevision: 3,
    policyVersion: 'staffed-capacity-v1',
    planningLevel: 'Feature',
    orderedScope: Object.freeze([A, B]),
    configuration: Object.freeze({
      pointsPerSprint: 20,
      sprintLengthDays: 14,
      cadence: 'fixed-contiguous' as const,
      startSprintOrdinal: 12,
      startDate: '2026-09-07',
    }),
    parallelGroups: Object.freeze([]),
    blockedFeatureIds: Object.freeze([]),
    factMap: Object.freeze({ [A]: fact(10), [B]: fact(10) }),
    roster: Object.freeze([
      Object.freeze({ id: ADA, name: 'Ada', weightUnits: 100 }),
      Object.freeze({ id: BEN, name: 'Ben', weightUnits: 100 }),
      Object.freeze({ id: CARA, name: 'Cara', weightUnits: 100 }),
    ]),
    assignments: Object.freeze({ [A]: Object.freeze([ADA]), [B]: Object.freeze([BEN]) }),
  });
}

const URGENT: UrgentItem = Object.freeze({ kind: 'new', draftId: '019ffe00-0000-7000-8000-0000000000ff', title: 'Export', effortPoints: 16 });

describe('jump-the-line drafts (Story 26.7)', () => {
  it('AC 26.7-1: everyone-pauses ranks the urgent item first and keeps the rest in order', () => {
    const build = buildEveryonePauses(baseline(), URGENT);
    expect(build.patch.orderedScope).toEqual([URGENT.kind === 'new' ? URGENT.draftId : '', A, B]);
    expect(build.addedFact?.fact.effortPoints).toBe(16);
    expect(build.deferredFeatureIds).toEqual([]);
  });

  it('AC 26.7-2: chosen-people forms one parallel group and strips the chosen people from its members', () => {
    const build = buildChosenPeople(baseline(), URGENT, [CARA], 3);
    expect(build.patch.parallelGroups).toEqual([
      { featureIds: [URGENT.kind === 'new' ? URGENT.draftId : '', A, B] },
    ]);
    // Cara is put on the urgent item; A and B keep their distinct people.
    expect(build.patch.assignmentOverrides?.[URGENT.kind === 'new' ? URGENT.draftId : '']).toEqual([CARA]);
    expect(build.patch.assignmentOverrides?.[A]).toEqual([ADA]);
    expect(build.patch.assignmentOverrides?.[B]).toEqual([BEN]);
  });

  it('AC 26.7-2: hold-the-date defers the lowest-ranked item until the target is reachable', () => {
    // Only the scope without B is on time.
    const build = buildHoldTheDate(baseline(), URGENT, (patch) => !(patch.orderedScope ?? []).includes(B));
    expect(build.deferredFeatureIds).toEqual([B]);
    expect(build.unreachable).toBe(false);
    expect(build.patch.orderedScope).not.toContain(B);
  });

  it('AC 26.7-2: hold-the-date reports an unreachable target', () => {
    const build = buildHoldTheDate(baseline(), URGENT, () => false);
    expect(build.unreachable).toBe(true);
  });

  it('AC 26.7-3: everyone-pauses shifts both existing items later (real evaluation)', async () => {
    const b = baseline();
    const before = await evaluateScenario(b, {});
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const build = buildEveryonePauses(b, URGENT);
    // Merge the new draft item's fact into the baseline for evaluation.
    const withFact: ForecastScenarioBaseline = Object.freeze({
      ...b,
      factMap: Object.freeze({ ...b.factMap, ...(build.addedFact ? { [build.addedFact.id]: build.addedFact.fact } : {}) }),
    });
    const after = await evaluateScenario(withFact, build.patch);
    expect(after.ok).toBe(true);
    if (!after.ok) return;

    const diffs = compareItemFinishes(before.variantResult, after.variantResult);
    const aDiff = diffs.find((d) => d.featureId === A)!;
    const bDiff = diffs.find((d) => d.featureId === B)!;
    // The urgent 16-pt item runs first, so both existing items finish later.
    expect(aDiff.kind).toBe('moved');
    expect(aDiff.slipDays!).toBeGreaterThan(0);
    expect(bDiff.slipDays!).toBeGreaterThan(0);
    expect(diffs.find((d) => d.featureId === (URGENT.kind === 'new' ? URGENT.draftId : ''))!.kind).toBe('first');
  });

  it('AC 26.7-3: chosen-people makes the displaced items start together', async () => {
    const b = baseline();
    const build = buildChosenPeople(b, URGENT, [CARA], 3);
    const withFact: ForecastScenarioBaseline = Object.freeze({
      ...b,
      factMap: Object.freeze({ ...b.factMap, ...(build.addedFact ? { [build.addedFact.id]: build.addedFact.fact } : {}) }),
    });
    const after = await evaluateScenario(withFact, build.patch);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    const urgentId = URGENT.kind === 'new' ? URGENT.draftId : '';
    const timelines = after.variantResult.allocation!.timelines;
    const urgentStart = timelines.find((t) => t.featureId === urgentId)!.startOffset!;
    const aStart = timelines.find((t) => t.featureId === A)!.startOffset!;
    expect(urgentStart).toEqual(aStart);
  });

  it('does not label a withheld variant timeline as deferred', () => {
    const before = {
      allocation: { timelines: [{ featureId: A, completionDate: '2026-09-29' }] },
    } as never;
    // Variant result is incomplete: allocation null (timeline withheld).
    const after = { allocation: null } as never;
    const diffs = compareItemFinishes(before, after, []);
    const a = diffs.find((d) => d.featureId === A)!;
    expect(a.kind).not.toBe('deferred');
    expect(a.slipLabel).toBe('not planned');
  });

  it('AC 26.7-4: the summary names only items, dates and the completion change', () => {    const diffs = compareItemFinishes(
      {
        allocation: { timelines: [{ featureId: A, completionDate: '2026-09-29' }, { featureId: B, completionDate: '2026-10-05' }] },
      } as never,
      {
        allocation: {
          timelines: [{ featureId: A, completionDate: '2026-10-09' }, { featureId: B, completionDate: null }],
        },
      } as never,
      [B],
    );
    const summary = stakeholderSummary({
      urgentTitle: 'the export',
      diffs,
      names: (id) => (id === A ? 'Account Opening Metrics' : 'Report builder'),
      liveCompletion: 'Sprint 2 · Oct 13',
      whatIfCompletion: 'Sprint 3 · Oct 27',
    });
    expect(summary).toContain('Account Opening Metrics moves from 2026-09-29 to 2026-10-09');
    expect(summary).toContain('Report builder is deferred out of this plan');
    expect(summary).toContain('completes Sprint 3 · Oct 27 instead of Sprint 2 · Oct 13');
    expect(summary).not.toContain('because');
    expect(summary).not.toMatch(/\d+\/\d+/);
  });
});
