import { describe, expect, it } from 'vitest';
import { createNode, type Node } from '../../domain/tree/node.entity';
import { createUnlockEdge, type UnlockEdge } from '../../domain/edge/unlock-edge.entity';
import {
  projectVisualTree,
  VISUAL_TREE_NODE_LIMIT,
  type VisualTreeProjectionInput,
} from './visual-tree.projection';

const P = '019ffe00-0000-7000-8000-000000000001';
const V = '019ffe00-0000-7000-8000-000000000010';
const T1 = '019ffe00-0000-7000-8000-000000000020';
const T2 = '019ffe00-0000-7000-8000-000000000021';
const F1 = '019ffe00-0000-7000-8000-000000000030';
const F2 = '019ffe00-0000-7000-8000-000000000031';
const AC1 = '019ffe00-0000-7000-8000-000000000040';
const F3 = '019ffe00-0000-7000-8000-000000000041'; // under T2 (outside)
const E_IN = '019ffe00-0000-7000-8000-000000000050';
const E_OUT = '019ffe00-0000-7000-8000-000000000051';
const E_BOTH_OUT = '019ffe00-0000-7000-8000-000000000052';

function node(id: string, parentId: string | null, nodeType: Node['nodeType'] | null = null, title?: string): Node {
  return createNode({ id, projectId: P, parentId, title: title ?? id, position: 1n, nodeType });
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
      node(V, null, 'Vision', 'Vision'),
      node(T1, V, 'Theme', 'Theme 1'),
      node(T2, V, 'Theme', 'Theme 2'),
      node(F1, T1, 'Feature', 'Feature 1'),
      node(F2, T1, 'Feature', 'Feature 2'),
      node(AC1, F1, 'AcceptanceCriterion', 'AC 1'),
      node(F3, T2, 'Feature', 'Feature 3'),
    ],
    unlockEdges: [
      edge(E_IN, F1, F2), // both in subtree
      edge(E_OUT, F1, F3), // target outside
      edge(E_BOTH_OUT, F3, F2), // both outside, excluded
    ],
  };
}

describe('visual-tree projection (Story 6.1)', () => {
  it('includes exactly the theme subtree, excluding acceptance criteria (pre-order, no outside nodes)', () => {
    const out = projectVisualTree(fixture());

    // AC1 is a child of F1 but never a visual card — it lives only in the
    // node inspector (Story 16.3).
    expect(out.nodes.map((n) => n.nodeId)).toEqual([T1, F1, F2]);
    expect(out.nodeCount).toBe(3);
    expect(out.nodes.some((n) => n.nodeId === AC1)).toBe(false);
    expect(out.projectRevision).toBe(7);
  });

  it('emits parentId null only for the theme root', () => {
    const out = projectVisualTree(fixture());
    expect(out.nodes[0].parentId).toBeNull();
    expect(out.nodes[1].parentId).toBe(T1);
    expect(out.nodes[2].parentId).toBe(T1);
  });

  it('computes depth and siblingIndex per AD-11 order', () => {
    const out = projectVisualTree(fixture());
    const f1 = out.nodes.find((n) => n.nodeId === F1)!;
    const f2 = out.nodes.find((n) => n.nodeId === F2)!;
    expect(f1.siblingIndex).toBe(0);
    expect(f2.siblingIndex).toBe(1);
    expect(f1.siblingSetSize).toBe(2);
    expect(f1.depth).toBe(1);
    // F1's only child is an acceptance criterion, so F1 is a leaf in the
    // visual tree.
    expect(out.nodes.some((n) => n.parentId === F1)).toBe(false);
  });

  it('buckets unlock edges: inside both, one-outside with outsideEndpoint, both-outside excluded', () => {
    const bothOutside = projectVisualTree({
      ...fixture(),
      unlockEdges: [edge(E_BOTH_OUT, F3, V)], // F3 (T2) -> V (root): both outside T1 subtree
    });
    expect(bothOutside.unlockEdges.some((e) => e.edgeId === E_BOTH_OUT)).toBe(false);

    const out = projectVisualTree(fixture());

    const inEdge = out.unlockEdges.find((e) => e.edgeId === E_IN)!;
    expect(inEdge.sourceInSubtree).toBe(true);
    expect(inEdge.targetInSubtree).toBe(true);
    expect(inEdge.outsideEndpoint).toBeNull();

    const outEdge = out.unlockEdges.find((e) => e.edgeId === E_OUT)!;
    expect(outEdge.sourceInSubtree).toBe(true);
    expect(outEdge.targetInSubtree).toBe(false);
    expect(outEdge.outsideEndpoint).not.toBeNull();
    expect(outEdge.outsideEndpoint!.nodeId).toBe(F3);
    expect(outEdge.outsideEndpoint!.title).toBe('Feature 3');
    expect(outEdge.outsideEndpoint!.themeId).toBe(T2);
    expect(outEdge.outsideEndpoint!.themeName).toBe('Theme 2');
  });

  it('throws on a missing or non-Theme themeId', () => {
    expect(() => projectVisualTree({ ...fixture(), themeId: '019ffe00-0000-7000-8000-000000000099' })).toThrow();
    expect(() => projectVisualTree({ ...fixture(), themeId: F1 })).toThrow();
  });

  it('does not truncate past the render limit but flags degraded (NFR-22)', () => {
    const nodes: Node[] = [node(T1, V, 'Theme')];
    for (let i = 0; i < VISUAL_TREE_NODE_LIMIT + 2; i++) {
      nodes.push(
        node(
          `019ffe00-0000-7000-8000-${(i + 100).toString(16).padStart(12, '0')}`,
          T1,
          'Feature',
          `F${i}`,
        ),
      );
    }
    const out = projectVisualTree({ ...fixture(), nodes, unlockEdges: [] });
    expect(out.nodeCount).toBe(VISUAL_TREE_NODE_LIMIT + 3);
    expect(out.nodes.length).toBe(out.nodeCount);
    expect(out.degraded).toBe(true);
    expect(out.renderLimit).toBe(VISUAL_TREE_NODE_LIMIT);
  });

  it('is not degraded at the exact 300-node boundary', () => {
    const nodes: Node[] = [node(T1, V, 'Theme')];
    for (let i = 0; i < VISUAL_TREE_NODE_LIMIT - 1; i++) {
      nodes.push(
        node(
          `019ffe00-0000-7000-8000-${(i + 100).toString(16).padStart(12, '0')}`,
          T1,
          'Feature',
          `F${i}`,
        ),
      );
    }
    const out = projectVisualTree({ ...fixture(), nodes, unlockEdges: [] });
    expect(out.nodeCount).toBe(VISUAL_TREE_NODE_LIMIT);
    expect(out.degraded).toBe(false);
  });
});