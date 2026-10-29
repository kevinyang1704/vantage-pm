import { describe, expect, it } from 'vitest';
import { createNode, type Node } from './node.entity';
import { getDescendantNodes, resolveZoomSubtree } from './tree-walk.policy';

const P = '019ffe00-0000-7000-8000-000000000001';
const R = '019ffe00-0000-7000-8000-000000000010';
const T1 = '019ffe00-0000-7000-8000-000000000020';
const T2 = '019ffe00-0000-7000-8000-000000000021';
const F1 = '019ffe00-0000-7000-8000-000000000030';
const F2 = '019ffe00-0000-7000-8000-000000000031';
const AC = '019ffe00-0000-7000-8000-000000000040';
const A = '019ffe00-0000-7000-8000-000000000050';
const B = '019ffe00-0000-7000-8000-000000000051';

function node(id: string, parentId: string | null): Node {
  return createNode({ id, projectId: P, parentId, title: id, position: 1n });
}

describe('tree-walk policy (Story 6.1 Task 2)', () => {
  it('returns multi-level descendants in pre-order from a root', () => {
    const nodes = [
      node(R, null),
      node(T1, R),
      node(T2, R),
      node(F1, T1),
      node(F2, T1),
      node(AC, F1),
    ];
    expect(getDescendantNodes(nodes, R).map((n) => n.id)).toEqual([T1, F1, AC, F2, T2]);
  });

  it('returns empty for a root with no children', () => {
    const nodes = [node(R, null)];
    expect(getDescendantNodes(nodes, R)).toEqual([]);
  });

  it('does not infinite-loop on a cyclic parent chain', () => {
    const result = getDescendantNodes([node(A, B), node(B, A)], A);
    expect(result.length).toBeLessThanOrEqual(2);
  });
});

describe('resolveZoomSubtree (Story 8.1 Task 2)', () => {
  const nodes = [
    node(R, null),
    node(T1, R),
    node(T2, R),
    node(F1, T1),
    node(F2, T1),
    node(AC, F1),
  ];

  it('returns the whole node set with no exclusions when zoomRootId is null', () => {
    const { scopedNodes, excludedNodeIds } = resolveZoomSubtree(nodes, null);
    expect(scopedNodes.map((n) => n.id)).toEqual([R, T1, T2, F1, F2, AC]);
    expect(excludedNodeIds.size).toBe(0);
  });

  it('scopes to the zoom root plus descendants and excludes the rest', () => {
    const { scopedNodes, excludedNodeIds } = resolveZoomSubtree(nodes, T1);
    expect(scopedNodes.map((n) => n.id)).toEqual([T1, F1, F2, AC]);
    expect([...excludedNodeIds].sort()).toEqual([R, T2].sort());
  });

  it('is cycle-safe', () => {
    const { scopedNodes } = resolveZoomSubtree([node(A, B), node(B, A)], A);
    expect(scopedNodes.length).toBeLessThanOrEqual(2);
  });
});
