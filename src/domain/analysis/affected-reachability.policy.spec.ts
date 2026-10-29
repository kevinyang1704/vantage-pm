import { describe, expect, it } from 'vitest';
import { calculateDownstreamAffectedWork } from './affected-reachability.policy';
import type { Node } from '../tree/node.entity';
import type { UnlockEdge } from '../edge/unlock-edge.entity';

function createMockNode(params: Partial<Node> & { id: string }): Node {
  return {
    id: params.id,
    projectId: 'proj-1',
    parentId: null,
    title: params.title ?? 'Test Node',
    bodyText: null,
    position: 1000n,
    nodeType: 'Feature',
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

describe('affected-reachability.policy', () => {
  it('transitively identifies all downstream nodes on unlock edge chains', () => {
    // Chain: A -> B -> C and A -> D
    const nodes: Node[] = [
      createMockNode({ id: 'node-a', title: 'Task A' }),
      createMockNode({ id: 'node-b', title: 'Task B' }),
      createMockNode({ id: 'node-c', title: 'Task C' }),
      createMockNode({ id: 'node-d', title: 'Task D' }),
    ];
    const edges: UnlockEdge[] = [
      { id: 'e1', projectId: 'proj-1', sourceNodeId: 'node-a', targetNodeId: 'node-b' },
      { id: 'e2', projectId: 'proj-1', sourceNodeId: 'node-b', targetNodeId: 'node-c' },
      { id: 'e3', projectId: 'proj-1', sourceNodeId: 'node-a', targetNodeId: 'node-d' },
    ];

    const affected = calculateDownstreamAffectedWork({
      nodes,
      edges,
      causalNodeId: 'node-a',
      priorStartDate: '2026-09-01',
      newStartDate: '2026-09-10',
      deltaDays: 9,
      createdAt: '2026-08-15T00:00:00Z',
    });

    expect(affected).toHaveLength(3);
    const affectedIds = affected.map((r) => r.affectedNodeId);
    expect(affectedIds).toContain('node-b');
    expect(affectedIds).toContain('node-c');
    expect(affectedIds).toContain('node-d');
    expect(affected[0].causalNodeTitle).toBe('Task A');
    expect(affected[0].deltaDays).toBe(9);
  });
});
