import { describe, expect, it } from 'vitest';
import { calculateForecast } from '../../domain/forecast/whole-set.policy';
import type { ForecastInputs } from '../../domain/forecast/forecast-result';
import type { FeatureTimeline } from '../../domain/forecast/forecast-allocation';
import { itemBar, timelineAxis, readableForecastDate } from './forecast-timeline';

const PROJECT_ID = '019ffe00-0000-7000-8000-000000000001';
const FEATURE_A = '019ffe00-0000-7000-8000-00000000000a';
const FEATURE_B = '019ffe00-0000-7000-8000-00000000000b';
const FEATURE_C = '019ffe00-0000-7000-8000-00000000000c';

function makeInputs(params: {
  selectedFeatureIds?: readonly string[];
  estimates?: Readonly<Record<string, number | null>>;
  pointsPerSprint?: number;
  sprintLengthDays?: number;
  parallelGroups?: readonly Readonly<{ featureIds: readonly string[] }>[];
} = {}): ForecastInputs {
  return Object.freeze({
    projectId: PROJECT_ID,
    projectRevision: 1,
    policyVersion: 'shared-capacity-v1' as const,
    selectedFeatureIds: Object.freeze([...(params.selectedFeatureIds ?? [FEATURE_A, FEATURE_B, FEATURE_C])]),
    estimates: Object.freeze(params.estimates ?? { [FEATURE_A]: 10, [FEATURE_B]: 20, [FEATURE_C]: 5 }),
    pointsPerSprint: params.pointsPerSprint ?? 10,
    sprintLengthDays: params.sprintLengthDays ?? 14,
    startSprintOrdinal: 12,
    startDate: '2026-09-07',
    parallelGroups: Object.freeze([...(params.parallelGroups ?? [])]),
    blockedFeatureIds: Object.freeze([]),
    roster: Object.freeze([]),
    assignments: Object.freeze({}),
  });
}

function timelineOf(result: Awaited<ReturnType<typeof calculateForecast>>, id: string): FeatureTimeline {
  const t = result.allocation?.timelines.find((x) => x.featureId === id);
  if (!t) throw new Error(`no timeline for ${id}`);
  return t;
}

describe('timelineAxis', () => {
  it('AC 26.2-1: builds one equal-width column per sprint through completion', async () => {
    const result = await calculateForecast(makeInputs());
    const axis = timelineAxis(result);
    expect(axis).not.toBeNull();
    expect(axis!.startSprint).toBe(12);
    expect(axis!.completionSprint).toBe(result.arithmetic!.completionSprint);
    expect(axis!.columns).toHaveLength(axis!.spanSprints);
    // 10 + 20 + 5 = 35 pts at 10/sprint = 3.5 → Sprint 15
    expect(axis!.completionSprint).toBe(15);
    expect(axis!.columns[0].label).toBe('Sprint 12 · Sep 7');
    expect(axis!.columns.every((c) => c.label.includes('Sprint'))).toBe(true);
  });

  it('returns null when the result has no completion', async () => {
    const incomplete = await calculateForecast(makeInputs({ pointsPerSprint: undefined }));
    expect(timelineAxis(null)).toBeNull();
    expect(timelineAxis(incomplete)?.completionSprint).toBe(incomplete.arithmetic?.completionSprint ?? null);
  });
});

describe('itemBar', () => {
  it('AC 26.2-2: positions a bar from the exact start/finish offsets', async () => {
    const result = await calculateForecast(makeInputs());
    const axis = timelineAxis(result)!;
    const bar = itemBar(timelineOf(result, FEATURE_A), {
      axis,
      rank: 1,
      previousRank: null,
      title: 'Alpha',
      isStaffed: false,
      pointsPerSprint: 10,
    })!;
    // 10 points at 10/sprint = 1 sprint of a 4-sprint axis (12..15).
    expect(bar.left).toBeCloseTo(0, 5);
    expect(bar.width).toBeCloseTo(0.25, 5);
    expect(bar.isMilestone).toBe(false);
    expect(bar.waits).toBe(false);
    expect(bar.paceLabel).toBe('whole team');
    expect(bar.label).toContain('Starts Sprint 12');
    expect(bar.label).toContain('takes 1.0 sprint');
  });

  it('AC 26.2-3: marks a later sequential item as waiting', async () => {
    const result = await calculateForecast(makeInputs());
    const axis = timelineAxis(result)!;
    const bar = itemBar(timelineOf(result, FEATURE_B), {
      axis,
      rank: 2,
      previousRank: 1,
      title: 'Beta',
      isStaffed: false,
      pointsPerSprint: 10,
    })!;
    expect(bar.left).toBeCloseTo(0.25, 5);
    expect(bar.waits).toBe(true);
  });

  it('AC 26.2-3: parallel members start together at the block start', async () => {
    const result = await calculateForecast(
      makeInputs({ parallelGroups: [{ featureIds: [FEATURE_A, FEATURE_B] }] }),
    );
    const axis = timelineAxis(result)!;
    const a = itemBar(timelineOf(result, FEATURE_A), { axis, rank: 1, previousRank: null, title: 'A', isStaffed: false, pointsPerSprint: 10 })!;
    const b = itemBar(timelineOf(result, FEATURE_B), { axis, rank: 2, previousRank: 1, title: 'B', isStaffed: false, pointsPerSprint: 10 })!;
    expect(a.left).toBeCloseTo(0, 5);
    expect(b.left).toBeCloseTo(0, 5);
    expect(b.waits).toBe(false);
  });

  it('AC 26.2-2: a zero-point item is a milestone marker, not a bar', async () => {
    const result = await calculateForecast(makeInputs({ estimates: { [FEATURE_A]: 0, [FEATURE_B]: 10, [FEATURE_C]: 5 } }));
    const axis = timelineAxis(result)!;
    const bar = itemBar(timelineOf(result, FEATURE_A), { axis, rank: 1, previousRank: null, title: 'M', isStaffed: false, pointsPerSprint: 10 })!;
    expect(bar.isMilestone).toBe(true);
    expect(bar.width).toBe(0);
    expect(bar.label).toContain('Milestone');
  });

  it('AC 26.2-2: withholds a bar with the row reason when the timeline is withheld', () => {
    const withheld: FeatureTimeline = Object.freeze({
      featureId: FEATURE_A,
      estimate: null,
      isMilestone: false,
      startOffset: null,
      finishOffset: null,
      startSprintOrdinal: null,
      completionSprintOrdinal: null,
      startDate: null,
      completionDate: null,
      parallelGroupIndex: null,
    });
    const axis = timelineAxis({
      arithmetic: { startSprintOrdinal: 12, completionSprint: 12, startDate: '2026-09-07', sprintLengthDays: 14 },
    } as never)!;
    const bar = itemBar(withheld, { axis, rank: 1, previousRank: null, title: 'X', isStaffed: false, pointsPerSprint: 10 })!;
    expect(bar.withheldReason).toContain('withheld');
  });

  it('returns null when there is no timeline', () => {
    const axis = timelineAxis({
      arithmetic: { startSprintOrdinal: 12, completionSprint: 12, startDate: '2026-09-07', sprintLengthDays: 14 },
    } as never)!;
    expect(itemBar(undefined, { axis, rank: 1, previousRank: null, title: '', isStaffed: false, pointsPerSprint: 10 })).toBeNull();
  });
});

describe('readableForecastDate', () => {
  it('formats an ISO date as "Mon D" in UTC', () => {
    expect(readableForecastDate('2026-09-07')).toBe('Sep 7');
    expect(readableForecastDate('2026-10-13')).toBe('Oct 13');
    expect(readableForecastDate('not-a-date')).toBe('not-a-date');
  });
});
