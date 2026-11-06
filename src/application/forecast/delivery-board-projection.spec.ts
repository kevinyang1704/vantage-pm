import { describe, expect, it } from 'vitest';
import { createForecastConfiguration, createForecastPlan } from '../../domain/forecast/forecast-plan.entity';
import type { ForecastResult } from '../../domain/forecast/forecast-result';
import {
  buildDeliveryBoard,
  type DeliverySourceRow,
} from './delivery-board-projection';

const PROJECT_ID = '019ffe00-0000-7000-8000-000000000001';
const A = '019ffe00-0000-7000-8000-000000000002';
const B = '019ffe00-0000-7000-8000-000000000003';
const C = '019ffe00-0000-7000-8000-000000000004';

const rows: readonly DeliverySourceRow[] = [
  { id: A, title: 'Social login', effortPoints: 10 },
  { id: B, title: 'Email and password', effortPoints: 10 },
  { id: C, title: 'Document scan', effortPoints: 30 },
];

function resultWith(input: Readonly<{
  state?: ForecastResult['state'];
  timelines: ForecastResult['allocation'] extends infer T ? T extends { timelines: infer U } ? U : never : never;
  blocked?: readonly string[];
  totalPoints?: number;
}>): ForecastResult {
  return {
    state: input.state ?? 'ready',
    projectId: PROJECT_ID,
    projectRevision: 1,
    policyVersion: 'shared-capacity-v1',
    materialFingerprint: 'fp',
    coverage: {
      selectedCount: input.timelines.length,
      estimatedCount: input.timelines.length,
      ratio: { numerator: 1, denominator: 1 },
    },
    totalKnownPoints: input.totalPoints ?? 50,
    arithmetic: {
      totalPoints: input.totalPoints ?? 50,
      pointsPerSprint: 10,
      requiredSprints: { numerator: 5, denominator: 1 },
      occupiedSprints: 3,
      completionSprint: 12,
      completionDate: '2026-10-18',
      sprintLengthDays: 14,
      startSprintOrdinal: 10,
      startDate: '2026-09-07',
    },
    assumptions: {
      policyVersion: 'shared-capacity-v1',
      cadence: 'fixed-contiguous',
      groupingPremise: 'sequential-only',
      rounding: 'ceil-once',
    },
    issues: [],
    allocation: {
      timelines: input.timelines,
      events: [],
    },
  };
}

function timeline(
  featureId: string,
  startSprint: number,
  finishSprint: number,
  startOffset: number,
  finishOffset: number,
  extra?: Partial<NonNullable<ForecastResult['allocation']>['timelines'][number]>,
) {
  return {
    featureId,
    estimate: 10,
    isMilestone: false,
    startOffset: { numerator: startOffset, denominator: 1 },
    finishOffset: { numerator: finishOffset, denominator: 1 },
    startSprintOrdinal: startSprint,
    completionSprintOrdinal: finishSprint,
    startDate: `2026-09-${String(7 + startOffset * 14).padStart(2, '0')}`,
    completionDate: `2026-09-${String(20 + finishOffset * 14).padStart(2, '0')}`,
    parallelGroupIndex: null,
    ...extra,
  };
}

function plan(selectedFeatureIds: readonly string[], groups: readonly { featureIds: readonly string[] }[] = []) {
  return createForecastPlan({
    projectId: PROJECT_ID,
    selectedFeatureIds,
    parallelGroups: groups,
    configuration: createForecastConfiguration({
      pointsPerSprint: 10,
      sprintLengthDays: 14,
      startSprintOrdinal: 10,
      startDate: '2026-09-07',
    }),
  });
}

describe('buildDeliveryBoard', () => {
  it('places sequential features in their completion sprints and ranks them', () => {
    const board = buildDeliveryBoard({
      result: resultWith({
        timelines: [
          timeline(A, 10, 10, 0, 1),
          timeline(B, 11, 11, 1, 2),
        ],
      }),
      plan: plan([A, B]),
      rows,
    });

    expect(board.columns.map((column) => column.sprint)).toEqual([10, 11, 12]);
    expect(board.columns[0].milestone.ships).toBe(true);
    expect(board.columns[0].blocks[0].cards[0].rank).toBe(1);
    expect(board.columns[1].blocks[0].cards[0].rank).toBe(2);
    expect(board.columns[2].milestone.ships).toBe(false);
    expect(board.columns[2].milestone.label).toBe('No delivery');
  });

  it('keeps a parallel group together in the latest member sprint', () => {
    const board = buildDeliveryBoard({
      result: resultWith({
        timelines: [
          timeline(A, 10, 10, 0, 1, { parallelGroupIndex: 0 }),
          timeline(B, 10, 11, 0, 2, { parallelGroupIndex: 0 }),
        ],
      }),
      plan: plan([A, B], [{ featureIds: [A, B] }]),
      rows,
    });

    const delivered = board.blocks[0];
    expect(delivered.kind).toBe('parallel');
    expect(delivered.deliverySprint).toBe(11);
    expect(board.columns[0].blocks).toHaveLength(0);
    expect(board.columns[1].blocks).toHaveLength(1);
    expect(board.columns[1].blocks[0].cards.map((card) => card.featureId)).toEqual([A, B]);
    expect(board.columns[0].inProgress.map((card) => card.featureId)).toEqual([A, B]);
  });

  it('marks blocked cards and counts them in the delivery milestone', () => {
    const board = buildDeliveryBoard({
      result: resultWith({
        state: 'conditional',
        timelines: [timeline(A, 10, 10, 0, 1)],
        blocked: [A],
      }),
      plan: createForecastPlan({
        ...plan([A]),
        blockedFeatureIds: [A],
      }),
      rows,
    });

    expect(board.columns[0].milestone.blockedCount).toBe(1);
    expect(board.columns[0].blocks[0].cards[0].blocked).toBe(true);
  });

  it('labels a milestone from the nearest group when one is available', () => {
    const board = buildDeliveryBoard({
      result: resultWith({
        timelines: [timeline(A, 10, 10, 0, 1)],
      }),
      plan: plan([A]),
      rows,
      groupTitle: () => 'Identity and access',
    });
    expect(board.columns[0].milestone.label).toBe('Identity and access');
  });

  it('falls back to feature titles when no group label exists', () => {
    const board = buildDeliveryBoard({
      result: resultWith({
        timelines: [timeline(A, 10, 10, 0, 1)],
      }),
      plan: plan([A]),
      rows,
    });
    expect(board.columns[0].milestone.label).toBe('Social login');
  });


  it('starts the visible board at the as-of sprint', () => {
    const base = resultWith({
      timelines: [
        timeline(A, 10, 10, 0, 1),
        timeline(B, 11, 11, 1, 2),
      ],
    });
    if (!base.arithmetic) throw new Error('test result needs arithmetic');
    const result = {
      ...base,
      arithmetic: {
        ...base.arithmetic,
        asOfDate: '2026-09-21',
        asOfOffset: { numerator: 1, denominator: 1 },
      },
    };
    const board = buildDeliveryBoard({ result, plan: plan([A, B]), rows });
    expect(board.columns.map((column) => column.sprint)).toEqual([11, 12]);
  });

  it('returns an empty projection for non-ready results', () => {
    const result = resultWith({
      state: 'incomplete',
      timelines: [timeline(A, 10, 10, 0, 1)],
    });
    const board = buildDeliveryBoard({ result, plan: plan([A]), rows });
    expect(board.columns).toEqual([]);
    expect(board.milestones).toEqual([]);
  });

  it('keeps a withheld block out of the dated columns', () => {
    const board = buildDeliveryBoard({
      result: resultWith({
        timelines: [
          timeline(A, 10, 10, 0, 1),
          { ...timeline(B, 11, 11, 1, 2), startOffset: null, finishOffset: null, startSprintOrdinal: null, completionSprintOrdinal: null },
        ],
      }),
      plan: plan([A, B]),
      rows,
    });
    expect(board.unplaced).toHaveLength(1);
    expect(board.unplaced[0].withheld).toBe(true);
  });
});
