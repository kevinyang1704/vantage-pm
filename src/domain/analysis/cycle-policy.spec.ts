import { describe, expect, it } from 'vitest';
import { detectUnlockCycles } from './cycle-policy';
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

describe('cycle-policy', () => {
  it('detects a simple 2-node cycle A -> B -> A', () => {
    const nodes: Node[] = [
      createMockNode({ id: 'node-a', title: 'Task A' }),
      createMockNode({ id: 'node-b', title: 'Task B' }),
    ];
    const edges: UnlockEdge[] = [
      { id: 'e1', projectId: 'proj-1', sourceNodeId: 'node-a', targetNodeId: 'node-b' },
      { id: 'e2', projectId: 'proj-1', sourceNodeId: 'node-b', targetNodeId: 'node-a' },
    ];

    const findings = detectUnlockCycles(nodes, edges);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('UnlockCycle');
    expect(findings[0].pathNodeIds).toEqual(['node-a', 'node-b', 'node-a']);
    expect(findings[0].narrative).toContain('"Task A" unlocks "Task B" unlocks "Task A"');
  });

  it('detects a 3-node cycle and canonicalizes by min id', () => {
    const nodes: Node[] = [
      createMockNode({ id: 'c-node', title: 'Task C' }),
      createMockNode({ id: 'a-node', title: 'Task A' }),
      createMockNode({ id: 'b-node', title: 'Task B' }),
    ];
    const edges: UnlockEdge[] = [
      { id: 'e1', projectId: 'proj-1', sourceNodeId: 'c-node', targetNodeId: 'a-node' },
      { id: 'e2', projectId: 'proj-1', sourceNodeId: 'a-node', targetNodeId: 'b-node' },
      { id: 'e3', projectId: 'proj-1', sourceNodeId: 'b-node', targetNodeId: 'c-node' },
    ];

    const findings = detectUnlockCycles(nodes, edges);
    expect(findings).toHaveLength(1);
    expect(findings[0].pathNodeIds).toEqual(['a-node', 'b-node', 'c-node', 'a-node']);
  });

  it('returns empty when graph is acyclic (DAG)', () => {
    const nodes: Node[] = [
      createMockNode({ id: 'node-a', title: 'Task A' }),
      createMockNode({ id: 'node-b', title: 'Task B' }),
      createMockNode({ id: 'node-c', title: 'Task C' }),
    ];
    const edges: UnlockEdge[] = [
      { id: 'e1', projectId: 'proj-1', sourceNodeId: 'node-a', targetNodeId: 'node-b' },
      { id: 'e2', projectId: 'proj-1', sourceNodeId: 'node-b', targetNodeId: 'node-c' },
    ];

    const findings = detectUnlockCycles(nodes, edges);
    expect(findings).toHaveLength(0);
  });
});
