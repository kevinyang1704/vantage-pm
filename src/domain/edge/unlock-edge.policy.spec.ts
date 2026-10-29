import { describe, it, expect } from 'vitest';
import {
  validateUnlockEdge,
  computeNodeEdgeCounts,
} from './unlock-edge.policy';

describe('unlock-edge.policy', () => {
  const existingNodeIds = new Set(['node1', 'node2', 'node3']);
  const existingEdges = [{ sourceNodeId: 'node1', targetNodeId: 'node2' }];

  it('validates non-self-referential, unique edges across existing nodes', () => {
    const valid = validateUnlockEdge('node2', 'node3', existingEdges, existingNodeIds);
    expect(valid.ok).toBe(true);

    const selfRef = validateUnlockEdge('node1', 'node1', existingEdges, existingNodeIds);
    expect(selfRef.ok).toBe(false);
    expect(selfRef.code).toBe('SELF_REFERENTIAL');

    const missingSource = validateUnlockEdge('nonexistent', 'node2', existingEdges, existingNodeIds);
    expect(missingSource.ok).toBe(false);
    expect(missingSource.code).toBe('SOURCE_NOT_FOUND');

    const duplicate = validateUnlockEdge('node1', 'node2', existingEdges, existingNodeIds);
    expect(duplicate.ok).toBe(false);
    expect(duplicate.code).toBe('DUPLICATE_EDGE');
  });

  it('computes inbound and outbound edge counts', () => {
    const edges = [
      { sourceNodeId: 'node1', targetNodeId: 'node2' },
      { sourceNodeId: 'node1', targetNodeId: 'node3' },
      { sourceNodeId: 'node3', targetNodeId: 'node1' },
    ];

    const counts = computeNodeEdgeCounts('node1', edges);
    expect(counts.unlocksCount).toBe(2);
    expect(counts.unlockedByCount).toBe(1);
  });
});
