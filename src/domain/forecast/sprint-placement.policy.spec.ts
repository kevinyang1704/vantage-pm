import { describe, expect, it } from 'vitest';
import {
  calculateSprintPlacement,
  evaluateSprintPlanChange,
  type SprintPlacementInput,
  type SprintPlacementItem,
} from './sprint-placement.policy';

function item(id: string, points: number | null, extra: Partial<SprintPlacementItem> = {}): SprintPlacementItem {
  return { id, points, delivered: false, blocked: false, ...extra };
}

function input(overrides: Partial<SprintPlacementInput> = {}): SprintPlacementInput {
  return {
    items: [item('a', 5), item('b', 8), item('c', 13)],
    dependencies: [],
    teamCapacity: 10,
    capacities: {},
    placements: [],
    firstSprint: 1,
    ...overrides,
  };
}

describe('calculateSprintPlacement', () => {
  it('fills sprints in rank order with the team capacity when nothing is placed by hand', () => {
    const result = calculateSprintPlacement(input());
    expect(result.allocations.get('a')).toMatchObject({ source: 'forecast', startSprint: 1, finishSprint: 1 });
    expect(result.allocations.get('b')).toMatchObject({ startSprint: 1, finishSprint: 2 });
    expect(result.allocations.get('b')?.slices).toEqual([
      { sprint: 1, points: 5 },
      { sprint: 2, points: 3 },
    ]);
    expect(result.allocations.get('c')).toMatchObject({ startSprint: 2, finishSprint: 3 });
    expect(result.lastSprint).toBe(3);
  });

  it('places hand-placed items first and lets the forecast use what is left', () => {
    const result = calculateSprintPlacement(input({ placements: [{ itemId: 'c', sprint: 1 }] }));
    expect(result.allocations.get('c')).toMatchObject({ source: 'placed', startSprint: 1, finishSprint: 2 });
    expect(result.allocations.get('a')).toMatchObject({ source: 'forecast', startSprint: 2, finishSprint: 2 });
    expect(result.sprints[0]).toMatchObject({ sprint: 1, capacity: 10, placedPoints: 10, forecastPoints: 0 });
  });

  it('uses a per-sprint capacity override instead of the team capacity', () => {
    const result = calculateSprintPlacement(input({ capacities: { '1': 3 } }));
    expect(result.sprints[0]).toMatchObject({ capacity: 3, overridden: true });
    expect(result.allocations.get('a')?.slices).toEqual([
      { sprint: 1, points: 3 },
      { sprint: 2, points: 2 },
    ]);
  });

  it('holds blocked and unestimated items and everything that depends on them', () => {
    const result = calculateSprintPlacement(
      input({
        items: [item('a', 5, { blocked: true }), item('b', null), item('c', 3), item('d', 2)],
        dependencies: [
          { sourceId: 'a', targetId: 'c' },
          { sourceId: 'b', targetId: 'd' },
        ],
      }),
    );
    expect(result.held.get('a')).toEqual({ kind: 'blocked' });
    expect(result.held.get('b')).toEqual({ kind: 'unestimated' });
    expect(result.held.get('c')).toEqual({ kind: 'waiting', on: ['a'] });
    expect(result.held.get('d')).toEqual({ kind: 'waiting', on: ['b'] });
    expect(result.allocations.size).toBe(0);
  });

  it('starts a dependent item after its dependency finishes, even when it ranks first', () => {
    const result = calculateSprintPlacement(
      input({
        items: [item('a', 2), item('b', 2)],
        dependencies: [{ sourceId: 'b', targetId: 'a' }],
      }),
    );
    expect(result.allocations.get('b')).toMatchObject({ startSprint: 1, finishSprint: 1 });
    expect(result.allocations.get('a')).toMatchObject({ startSprint: 2, finishSprint: 2 });
  });

  it('treats a delivered dependency as done and holds on one outside the plan', () => {
    const result = calculateSprintPlacement(
      input({
        items: [item('a', 2, { delivered: true }), item('b', 2), item('c', 2)],
        outsideItems: new Map([['x', { delivered: false }]]),
        dependencies: [
          { sourceId: 'a', targetId: 'b' },
          { sourceId: 'x', targetId: 'c' },
        ],
      }),
    );
    expect(result.allocations.get('b')).toMatchObject({ startSprint: 1 });
    expect(result.allocations.has('a')).toBe(false);
    expect(result.held.get('c')).toEqual({ kind: 'outside', on: ['x'] });
  });

  it('reports a dependency cycle', () => {
    const result = calculateSprintPlacement(
      input({
        items: [item('a', 2), item('b', 2)],
        dependencies: [
          { sourceId: 'a', targetId: 'b' },
          { sourceId: 'b', targetId: 'a' },
        ],
      }),
    );
    expect(result.held.get('a')?.kind).toBe('cycle');
    expect(result.held.get('b')?.kind).toBe('cycle');
  });

  it('holds a hand placement whose sprint is full, or whose carry-over sprint is full', () => {
    const full = calculateSprintPlacement(
      input({
        items: [item('a', 10), item('b', 4), item('c', 15)],
        placements: [{ itemId: 'a', sprint: 1 }, { itemId: 'b', sprint: 1 }, { itemId: 'c', sprint: 2 }],
        capacities: { '3': 0 },
      }),
    );
    expect(full.held.get('b')).toEqual({ kind: 'full', sprint: 1 });
    expect(full.held.get('c')).toEqual({ kind: 'overflow', sprint: 3 });
    expect(full.brokenPlacements).toEqual(['b', 'c']);
  });

  it('never places a hand-placed item before the current sprint', () => {
    const result = calculateSprintPlacement(input({ placements: [{ itemId: 'a', sprint: 1 }], firstSprint: 4 }));
    expect(result.allocations.get('a')).toMatchObject({ source: 'placed', startSprint: 4 });
  });
});

describe('evaluateSprintPlanChange', () => {
  it('accepts a drop into a sprint with room', () => {
    const verdict = evaluateSprintPlanChange(input(), { placements: [], capacities: {} }, { itemId: 'c', sprint: 2 });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.placements).toEqual([{ itemId: 'c', sprint: 2 }]);
      expect(verdict.placement.allocations.get('c')).toMatchObject({ source: 'placed', startSprint: 2, finishSprint: 3 });
    }
  });

  it('refuses a drop into a sprint already full of hand-placed work', () => {
    const base = input({ placements: [{ itemId: 'c', sprint: 1 }] });
    const verdict = evaluateSprintPlanChange(base, { placements: base.placements, capacities: {} }, { itemId: 'a', sprint: 1 });
    expect(verdict).toMatchObject({ ok: false, itemId: 'a', reason: { kind: 'full', sprint: 1 } });
  });

  it('refuses a drop for a blocked item, an unestimated item, a delivered item and a past sprint', () => {
    const base = input({
      items: [item('a', 5, { blocked: true }), item('b', null), item('c', 3, { delivered: true }), item('d', 1)],
      firstSprint: 3,
    });
    const change = { placements: [], capacities: {} };
    expect(evaluateSprintPlanChange(base, change, { itemId: 'a', sprint: 3 })).toMatchObject({ ok: false, reason: { kind: 'blocked' } });
    expect(evaluateSprintPlanChange(base, change, { itemId: 'b', sprint: 3 })).toMatchObject({ ok: false, reason: { kind: 'unestimated' } });
    expect(evaluateSprintPlanChange(base, change, { itemId: 'c', sprint: 3 })).toMatchObject({ ok: false, reason: { kind: 'delivered' } });
    expect(evaluateSprintPlanChange(base, change, { itemId: 'd', sprint: 2 })).toMatchObject({ ok: false, reason: { kind: 'past', sprint: 2 } });
  });

  it('refuses a drop into the same sprint as, or before, its dependency', () => {
    const base = input({
      items: [item('a', 5), item('b', 3)],
      dependencies: [{ sourceId: 'a', targetId: 'b' }],
      placements: [{ itemId: 'a', sprint: 2 }],
    });
    const change = { placements: base.placements, capacities: {} };
    expect(evaluateSprintPlanChange(base, change, { itemId: 'b', sprint: 2 })).toMatchObject({
      ok: false,
      reason: { kind: 'waiting', on: ['a'] },
    });
    expect(evaluateSprintPlanChange(base, change, { itemId: 'b', sprint: 3 }).ok).toBe(true);
  });

  it('lets a drop share a sprint that still has room without pushing hand-placed work later', () => {
    const base = input({ items: [item('a', 2), item('c', 6)], placements: [{ itemId: 'c', sprint: 1 }] });
    const verdict = evaluateSprintPlanChange(base, { placements: base.placements, capacities: {} }, { itemId: 'a', sprint: 1 });
    expect(verdict.ok).toBe(true);
    // A bigger item takes the room left and carries the rest into the next sprint.
    const bigger = input({ items: [item('a', 6), item('c', 6)], placements: [{ itemId: 'c', sprint: 1 }] });
    const spill = evaluateSprintPlanChange(bigger, { placements: bigger.placements, capacities: {} }, { itemId: 'a', sprint: 1 });
    expect(spill.ok).toBe(true);
    if (spill.ok) {
      expect(spill.placement.allocations.get('c')?.slices).toEqual([{ sprint: 1, points: 6 }]);
      expect(spill.placement.allocations.get('a')?.slices).toEqual([
        { sprint: 1, points: 4 },
        { sprint: 2, points: 2 },
      ]);
    }
  });

  it('refuses a drop when the dependency is blocked', () => {
    const base = input({
      items: [item('a', 5, { blocked: true }), item('b', 3)],
      dependencies: [{ sourceId: 'a', targetId: 'b' }],
    });
    expect(evaluateSprintPlanChange(base, { placements: [], capacities: {} }, { itemId: 'b', sprint: 4 })).toMatchObject({
      ok: false,
      reason: { kind: 'waiting', on: ['a'] },
    });
  });

  it('keeps a forecast-placed dependency in its sprint when its dependent is dropped', () => {
    const base = input({
      items: [item('a', 5), item('b', 3)],
      dependencies: [{ sourceId: 'a', targetId: 'b' }],
    });
    const verdict = evaluateSprintPlanChange(base, { placements: [], capacities: {} }, { itemId: 'b', sprint: 2 });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.placements).toEqual([{ itemId: 'a', sprint: 1 }, { itemId: 'b', sprint: 2 }]);
      expect(verdict.addedPlacements).toEqual(['a']);
    }
  });

  it('refuses moving a dependency to or after the sprint of an item that depends on it', () => {
    const base = input({
      items: [item('a', 5), item('b', 3)],
      dependencies: [{ sourceId: 'a', targetId: 'b' }],
      placements: [{ itemId: 'a', sprint: 1 }, { itemId: 'b', sprint: 2 }],
    });
    const verdict = evaluateSprintPlanChange(base, { placements: base.placements, capacities: {} }, { itemId: 'a', sprint: 2 });
    expect(verdict).toMatchObject({ ok: false, displaced: ['b'] });
  });

  it('refuses lowering a sprint capacity below its hand-placed work', () => {
    const base = input({ placements: [{ itemId: 'b', sprint: 1 }] });
    const verdict = evaluateSprintPlanChange(base, { placements: base.placements, capacities: { '1': 0 } });
    expect(verdict).toMatchObject({ ok: false, itemId: null, displaced: ['b'] });
    expect(evaluateSprintPlanChange(base, { placements: base.placements, capacities: { '1': 4 } })).toMatchObject({
      ok: false,
      displaced: ['b'],
    });
    expect(evaluateSprintPlanChange(base, { placements: base.placements, capacities: { '1': 20 } }).ok).toBe(true);
  });
});
