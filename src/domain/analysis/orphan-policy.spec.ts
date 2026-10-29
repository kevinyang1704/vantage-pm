import { describe, expect, it } from 'vitest';
import { detectOrphanedFeatures } from './orphan-policy';
import type { Node } from '../tree/node.entity';
import type { UnlockEdge } from '../edge/unlock-edge.entity';

function createMockNode(params: Partial<Node> & { id: string }): Node {
  return {
    id: params.id,
    projectId: params.projectId ?? 'proj-1',
    parentId: params.parentId ?? null,
    title: params.title ?? 'Test Node',
    bodyText: null,
    position: 1000n,
    nodeType: params.nodeType ?? null,
    startDate: null,
    endDate: null,
    durationDays: null,
    scheduleSourceMode: null,
    completed: false,
    effortPoints: null,
    effortPointsDone: null,
    strategicWeight: null,
    phaseId: null,
    deliveryStatus: 'not_started',
  };
}

describe('orphan-policy', () => {
  it('detects feature without theme parent and without unlock edges as orphan', () => {
    const nodes: Node[] = [
      createMockNode({ id: 'f1', title: 'Root Feature', nodeType: 'Feature', parentId: null }),
    ];
    const edges: UnlockEdge[] = [];

    const findings = detectOrphanedFeatures(nodes, edges);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('OrphanedFeature');
    expect(findings[0].targetNodeId).toBe('f1');
    expect(findings[0].missingContainment).toBe(true);
    expect(findings[0].missingUnlockEdges).toBe(true);
  });

  it('does not flag feature nested under a Theme', () => {
    const nodes: Node[] = [
      createMockNode({ id: 't1', title: 'Theme 1', nodeType: 'Theme', parentId: null }),
      createMockNode({ id: 'f1', title: 'Feature 1', nodeType: 'Feature', parentId: 't1' }),
    ];
    const edges: UnlockEdge[] = [];

    const findings = detectOrphanedFeatures(nodes, edges);
    expect(findings).toHaveLength(0);
  });

  it('does not flag a feature nested under a Component under a Theme (orphan boundary stays at Theme)', () => {
    const nodes: Node[] = [
      createMockNode({ id: 't1', title: 'Theme 1', nodeType: 'Theme', parentId: null }),
      createMockNode({ id: 'c1', title: 'Account Opening', nodeType: 'Component', parentId: 't1' }),
      createMockNode({ id: 'f1', title: 'CB Account Opening', nodeType: 'Feature', parentId: 'c1' }),
    ];

    const findings = detectOrphanedFeatures(nodes, []);
    expect(findings).toHaveLength(0);
  });

  it('flags a feature under a Component that has no Theme ancestor', () => {
    const nodes: Node[] = [
      createMockNode({ id: 'c1', title: 'Rootless Component', nodeType: 'Component', parentId: null }),
      createMockNode({ id: 'f1', title: 'Feature 1', nodeType: 'Feature', parentId: 'c1' }),
    ];

    const findings = detectOrphanedFeatures(nodes, []);
    expect(findings).toHaveLength(1);
    expect(findings[0].targetNodeId).toBe('f1');
    expect(findings[0].missingContainment).toBe(true);
  });

  it('does not flag root feature if it participates in an unlock edge', () => {
    const nodes: Node[] = [
      createMockNode({ id: 'f1', title: 'Feature 1', nodeType: 'Feature', parentId: null }),
      createMockNode({ id: 'f2', title: 'Feature 2', nodeType: 'Feature', parentId: null }),
    ];
    const edges: UnlockEdge[] = [
      {
        id: 'edge-1',
        projectId: 'proj-1',
        sourceNodeId: 'f1',
        targetNodeId: 'f2',
      },
    ];

    const findings = detectOrphanedFeatures(nodes, edges);
    expect(findings).toHaveLength(0);
  });

  it('ignores non-feature nodes (Vision, Theme, AC)', () => {
    const nodes: Node[] = [
      createMockNode({ id: 'v1', title: 'Vision', nodeType: 'Vision', parentId: null }),
      createMockNode({ id: 'ac1', title: 'AC', nodeType: 'AcceptanceCriterion', parentId: null }),
    ];
    const edges: UnlockEdge[] = [];

    const findings = detectOrphanedFeatures(nodes, edges);
    expect(findings).toHaveLength(0);
  });
});
