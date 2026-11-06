import { describe, expect, it } from 'vitest';
import { createForecastConfiguration, createForecastPlan } from '../../domain/forecast/forecast-plan.entity';
import { buildSprintBoard, currentSprintOrdinal, evaluateSprintCapacity, evaluateSprintDrop } from './sprint-board-projection';

const P = '019ffe00-0000-7000-8000-0000000000f1';
const A = '019ffe00-0000-7000-8000-0000000000a1';
const B = '019ffe00-0000-7000-8000-0000000000b1';
const C = '019ffe00-0000-7000-8000-0000000000c1';
const X = '019ffe00-0000-7000-8000-0000000000d1';

const plan = createForecastPlan({
  projectId: P,
  selectedFeatureIds: [A, B, C],
  configuration: createForecastConfiguration({ pointsPerSprint: 10, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-11-02' }),
});
const rows = [
  { id: A, title: 'Alpha', effortPoints: 8, included: true },
  { id: B, title: 'Beta', effortPoints: 6, included: true },
  { id: C, title: 'Gamma', effortPoints: null, included: true },
  { id: X, title: 'Outside', effortPoints: 3, included: false },
];

describe('buildSprintBoard', () => {
  it('starts at the sprint holding today and dates every column', () => {
    expect(currentSprintOrdinal(plan, '2026-11-20')).toBe(2);
    expect(currentSprintOrdinal(plan, '2026-10-01')).toBe(1);
    const board = buildSprintBoard({ plan, rows, unlockEdges: [], asOfDate: '2026-11-05' })!;
    expect(board.firstSprint).toBe(1);
    expect(board.columns[0]).toMatchObject({ sprint: 1, startDate: '2026-11-02', endDate: '2026-11-15', capacity: 10 });
    // Nothing goes into a sprint on its own.
    expect(board.cards.get(A)).toMatchObject({ source: null, startSprint: null });
    expect(board.unscheduled.map((card) => card.id)).toEqual([A, B]);
    expect(board.cards.get(C)?.held).toBe('Needs an estimate before it can go in a sprint.');
    expect(board.launchSprint).toBeNull();

    const placed = createForecastPlan({ ...plan, sprintPlan: { placements: [{ itemId: B, sprint: 1 }, { itemId: A, sprint: 2 }], capacities: {} } });
    const filled = buildSprintBoard({ plan: placed, rows, unlockEdges: [], asOfDate: '2026-11-05' })!;
    expect(filled.cards.get(B)).toMatchObject({ source: 'placed', startSprint: 1, finishSprint: 1 });
    expect(filled.cards.get(A)?.slices).toEqual([{ sprint: 2, points: 8 }]);
    expect(filled.cards.get(A)).toMatchObject({ startSprint: 2, finishSprint: 2 });
    expect(filled.unscheduled).toEqual([]);
    expect(filled.launchSprint).toBe(2);
  });

  it('holds work that depends on an item outside the plan, and lets a Backlog item be dropped in', () => {
    const board = buildSprintBoard({
      plan,
      rows,
      unlockEdges: [{ sourceNodeId: X, targetNodeId: B }],
      asOfDate: '2026-11-05',
    })!;
    expect(board.cards.get(B)?.held).toBe('Depends on Outside, which is not in the plan.');
    const drop = evaluateSprintDrop(board, { id: X, points: 3, delivered: false, blocked: false }, 2);
    expect(drop.ok).toBe(true);
  });

  it('checks a sprint capacity change against hand-placed work', () => {
    const placed = createForecastPlan({ ...plan, sprintPlan: { placements: [{ itemId: A, sprint: 1 }], capacities: {} } });
    const board = buildSprintBoard({ plan: placed, rows, unlockEdges: [], asOfDate: '2026-11-05' })!;
    expect(evaluateSprintCapacity(board, 1, 5).ok).toBe(false);
    expect(evaluateSprintCapacity(board, 1, 12).ok).toBe(true);
    expect(evaluateSprintCapacity(board, 2, 0).ok).toBe(true);
  });
});
