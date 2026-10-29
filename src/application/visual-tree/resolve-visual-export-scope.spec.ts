import { describe, expect, it } from 'vitest';
import { createNode, type Node } from '../../domain/tree/node.entity';
import { createUnlockEdge, type UnlockEdge } from '../../domain/edge/unlock-edge.entity';
import {
  projectVisualTree,
  VISUAL_TREE_NODE_LIMIT,
  type VisualTreeProjectionInput,
} from './visual-tree.projection';
import { resolveVisualExportScope } from './resolve-visual-export-scope';

const P = '019ffe00-0000-7000-8000-000000000001';
const V = '019ffe00-0000-7000-8000-000000000010';
const T1 = '019ffe00-0000-7000-8000-000000000020';
const T2 = '019ffe00-0000-7000-8000-000000000021';
const F1 = '019ffe00-0000-7000-8000-000000000030';
const F2 = '019ffe00-0000-7000-8000-000000000031';
const AC1 = '019ffe00-0000-7000-8000-000000000040';
const F3 = '019ffe00-0000-7000-8000-000000000041';

function node(id: string, parentId: string | null, nodeType: Node['nodeType'] | null = null): Node {
  return createNode({ id, projectId: P, parentId, title: id, position: 1n, nodeType });
}

function edge(id: string, sourceNodeId: string, targetNodeId: string): UnlockEdge {
  return createUnlockEdge({ id, projectId: P, sourceNodeId, targetNodeId });
}

function fixture(): VisualTreeProjectionInput {
  return {
    projectId: P,
    projectRevision: 7,
    themeId: T1,
    nodes: [
      node(V, null, 'Vision'),
      node(T1, V, 'Theme'),
      node(T2, V, 'Theme'),
      node(F1, T1, 'Feature'),
      node(F2, T1, 'Feature'),
      node(AC1, F1, 'AcceptanceCriterion'),
      node(F3, T2, 'Feature'),
    ],
    unlockEdges: [edge('019ffe00-0000-7000-8000-000000000050', F1, F2)],
  };
}

describe('resolveVisualExportScope (Story 8.1 Task 3)', () => {
  it('orderedNodeIds matches projectVisualTree nodes order exactly (no reimplementation)', () => {
    const input = fixture();
    const scope = resolveVisualExportScope(input);
    const projection = projectVisualTree(input);
    expect(scope.orderedNodeIds).toEqual(projection.nodes.map((n) => n.nodeId));
    // AC1 is excluded from the visual tree (inspector-only), so it is never
    // part of the visual export scope either.
    expect(scope.orderedNodeIds).toEqual([T1, F1, F2]);
  });

  it('echoes nodeCount and degraded straight through', () => {
    const scope = resolveVisualExportScope(fixture());
    expect(scope.nodeCount).toBe(3);
    expect(scope.degraded).toBe(false);
    expect(scope.themeId).toBe(T1);
    expect(scope.projectRevision).toBe(7);
  });

  it('keeps full nodeCount and degraded=true for the 300-node case (no truncation)', () => {
    const nodes: Node[] = [node(T1, V, 'Theme')];
    for (let i = 0; i < VISUAL_TREE_NODE_LIMIT + 2; i++) {
      nodes.push(
        node(
          `019ffe00-0000-7000-8000-${(i + 100).toString(16).padStart(12, '0')}`,
          T1,
          'Feature',
        ),
      );
    }
    const input: VisualTreeProjectionInput = { ...fixture(), nodes, unlockEdges: [] };
    const scope = resolveVisualExportScope(input);
    expect(scope.nodeCount).toBe(VISUAL_TREE_NODE_LIMIT + 3);
    expect(scope.orderedNodeIds.length).toBe(scope.nodeCount);
    expect(scope.degraded).toBe(true);
  });
});
