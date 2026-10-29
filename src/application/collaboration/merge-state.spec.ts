import { describe, expect, it } from 'vitest';
import { mergeStateFromSnapshot } from './merge-state';
import type { Node } from '../../domain/tree/node.entity';

const P = '019ffb00-0000-7000-8000-000000000001';
function node(id: string, parentId: string | null, position: bigint, effortPoints: number | null = null): Node {
  return { id, projectId: P, parentId, title: '', bodyText: null, position, nodeType: null, startDate: null, endDate: null, durationDays: null,
    scheduleSourceMode: null, completed: false, effortPoints, effortPointsDone: effortPoints === null ? null : 0, strategicWeight: null, phaseId: null, deliveryStatus: 'not-started' } as unknown as Node;
}

describe('merge state from the analysis snapshot', () => {
  it('orders siblings by authored position, records structure, points and plan', () => {
    const state = mergeStateFromSnapshot({ projectId: P, nodes: [node('b', null, 20n), node('a', null, 10n), node('c', 'a', 5n, 3), node('d', 'a', 5n)],
      forecastPlan: { selectedFeatureIds: ['c'], parallelGroups: [{ featureIds: ['c'] }], assignments: { c: ['p1'] }, roster: [{ id: 'p1', name: 'x', weightUnits: 100 }] } as never });
    expect(state.order.get('')).toEqual(['a', 'b']);
    expect(state.order.get('a')).toEqual(['c', 'd']);
    expect(state.nodes.get('c')).toEqual({ parentId: 'a' });
    expect(state.points.get('c')).toBe(3);
    expect(state.points.has('d')).toBe(false);
    expect(state.forecastOrder).toEqual(['c']);
    expect(state.forecastGroups).toEqual([{ featureIds: ['c'] }]);
    expect(state.assignments).toEqual({ c: ['p1'] });
    expect(state.rosterIds.has('p1')).toBe(true);
  });

  it('is empty-safe without a forecast plan', () => {
    const state = mergeStateFromSnapshot({ projectId: P, nodes: [] });
    expect(state.forecastOrder).toEqual([]);
    expect(state.rosterIds.size).toBe(0);
  });
});
