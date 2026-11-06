/**
 * "A full sprint takes no more cards": every way a card can be dropped into a
 * sprint whose capacity is used up by hand-placed work is refused.
 */
import { describe, expect, it } from 'vitest';
import {
  calculateSprintPlacement,
  evaluateSprintPlanChange,
  type SprintPlacementInput,
  type SprintPlacementItem,
} from './sprint-placement.policy';

const item = (id: string, points: number | null, extra: Partial<SprintPlacementItem> = {}): SprintPlacementItem => ({
  id, points, delivered: false, blocked: false, ...extra,
});

function board(overrides: Partial<SprintPlacementInput>): SprintPlacementInput {
  return { items: [], dependencies: [], teamCapacity: 10, capacities: {}, placements: [], firstSprint: 1, ...overrides };
}

function drop(input: SprintPlacementInput, itemId: string, sprint: number) {
  return evaluateSprintPlanChange(input, { placements: input.placements, capacities: input.capacities }, { itemId, sprint });
}

describe('a full sprint refuses every drop', () => {
  const full = board({
    items: [item('a', 6), item('b', 4), item('c', 3), item('d', 0), item('x', 5)],
    placements: [{ itemId: 'a', sprint: 1 }, { itemId: 'b', sprint: 1 }],
  });

  it('refuses a forecast card, whatever its size', () => {
    expect(drop(full, 'c', 1)).toMatchObject({ ok: false, reason: { kind: 'full', sprint: 1 } });
    expect(drop(full, 'x', 1)).toMatchObject({ ok: false, reason: { kind: 'full', sprint: 1 } });
  });

  it('refuses a card with no points too', () => {
    expect(drop(full, 'd', 1)).toMatchObject({ ok: false, reason: { kind: 'full', sprint: 1 } });
  });

  it('refuses a card moved in from another sprint', () => {
    const moved = board({ ...full, placements: [...full.placements, { itemId: 'c', sprint: 2 }] });
    expect(drop(moved, 'c', 1)).toMatchObject({ ok: false, reason: { kind: 'full', sprint: 1 } });
  });

  it('refuses a Backlog item that is not in the plan yet', () => {
    const withNew = board({ ...full, items: [...full.items, item('new', 2)] });
    expect(drop(withNew, 'new', 1)).toMatchObject({ ok: false, reason: { kind: 'full', sprint: 1 } });
  });

  it('counts the carry-over of a big card placed in an earlier sprint', () => {
    const spill = board({ items: [item('big', 20), item('c', 1)], placements: [{ itemId: 'big', sprint: 1 }] });
    expect(drop(spill, 'c', 2)).toMatchObject({ ok: false, reason: { kind: 'full', sprint: 2 } });
    expect(drop(spill, 'c', 3).ok).toBe(true);
  });

  it('treats a sprint set to 0 points as full', () => {
    const zero = board({ items: [item('c', 1)], capacities: { '2': 0 } });
    expect(drop(zero, 'c', 2)).toMatchObject({ ok: false, reason: { kind: 'full', sprint: 2 } });
  });

  it('lets a card already in the full sprint be dropped there again', () => {
    expect(drop(full, 'a', 1).ok).toBe(true);
  });

  it('accepts the card in a sprint that still has room', () => {
    expect(drop(full, 'c', 2).ok).toBe(true);
  });

  it('never lets stored placements over-fill a sprint', () => {
    // e.g. a plan written by an older build or merged from two people.
    const over = calculateSprintPlacement(board({
      items: [item('a', 10), item('b', 4)],
      placements: [{ itemId: 'a', sprint: 1 }, { itemId: 'b', sprint: 1 }],
    }));
    expect(over.held.get('b')).toEqual({ kind: 'full', sprint: 1 });
    expect(over.sprints[0]).toMatchObject({ capacity: 10, placedPoints: 10 });
  });
});

describe('with auto-fill off, only dragged-in work is in a sprint', () => {
  const manual = (overrides: Partial<SprintPlacementInput>) => board({ autoFill: false, ...overrides });

  it('leaves every unplaced card out of the sprints', () => {
    const result = calculateSprintPlacement(manual({ items: [item('a', 5), item('b', 3)], placements: [{ itemId: 'b', sprint: 2 }] }));
    expect(result.allocations.has('a')).toBe(false);
    expect(result.held.has('a')).toBe(false);
    expect(result.allocations.get('b')).toMatchObject({ source: 'placed', startSprint: 2 });
    expect(result.sprints.map((s) => s.forecastPoints)).toEqual([0, 0]);
  });

  it('still explains why a card cannot go in yet, down a dependency chain', () => {
    const result = calculateSprintPlacement(manual({
      items: [item('c', 1), item('b', 1), item('a', 1, { blocked: true })],
      dependencies: [{ sourceId: 'a', targetId: 'b' }, { sourceId: 'b', targetId: 'c' }],
    }));
    expect(result.held.get('a')).toEqual({ kind: 'blocked' });
    expect(result.held.get('b')).toEqual({ kind: 'waiting', on: ['a'] });
    expect(result.held.get('c')).toEqual({ kind: 'waiting', on: ['b'] });
  });

  it('refuses a card whose dependency is not in a sprint yet, and takes it once the dependency is', () => {
    const base = manual({ items: [item('a', 5), item('b', 3)], dependencies: [{ sourceId: 'a', targetId: 'b' }] });
    expect(drop(base, 'b', 3)).toMatchObject({ ok: false, reason: { kind: 'waiting', on: ['a'] } });
    const withA = manual({ ...base, placements: [{ itemId: 'a', sprint: 1 }] });
    expect(drop(withA, 'b', 2).ok).toBe(true);
    expect(drop(withA, 'b', 1)).toMatchObject({ ok: false, reason: { kind: 'waiting', on: ['a'] } });
  });

  it('refuses taking a dependency back to the Backlog while work that needs it is in a sprint', () => {
    const base = manual({
      items: [item('a', 5), item('b', 3)],
      dependencies: [{ sourceId: 'a', targetId: 'b' }],
      placements: [{ itemId: 'a', sprint: 1 }, { itemId: 'b', sprint: 2 }],
    });
    const verdict = evaluateSprintPlanChange(base, { placements: [{ itemId: 'b', sprint: 2 }], capacities: {} });
    expect(verdict).toMatchObject({ ok: false, displaced: ['b'] });
  });
});
