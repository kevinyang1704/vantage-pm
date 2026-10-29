import { describe, it, expect } from 'vitest';
import {
  sortPhases,
  rebalancePhasePositions,
  validatePhaseDeletionReassignments,
  previewPhaseReorderImpact,
} from './phase-position.policy';
import type { Phase } from './phase.entity';

describe('phase-position.policy', () => {
  const p1: Phase = { id: 'p1', projectId: 'proj1', name: 'Alpha', position: 10n };
  const p2: Phase = { id: 'p2', projectId: 'proj1', name: 'Beta', position: 20n };
  const p3: Phase = { id: 'p3', projectId: 'proj1', name: 'Gamma', position: 30n };

  it('sorts phases deterministically', () => {
    const sorted = sortPhases([p3, p1, p2]);
    expect(sorted.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('rebalances phase positions with 2^32 gap spacing', () => {
    const rebalanced = rebalancePhasePositions([p2, p1]);
    expect(rebalanced[0].phaseId).toBe('p1');
    expect(rebalanced[0].position).toBe(4294967296n);
    expect(rebalanced[1].phaseId).toBe('p2');
    expect(rebalanced[1].position).toBe(8589934592n);
  });

  it('validates phase deletion reassignments', () => {
    const assigned = ['node1', 'node2'];
    const existing = new Set(['p2', 'p3']);

    const valid = validatePhaseDeletionReassignments(
      assigned,
      { node1: 'p2', node2: null },
      existing,
      'p1',
    );
    expect(valid.ok).toBe(true);

    const missingNode = validatePhaseDeletionReassignments(
      assigned,
      { node1: 'p2' },
      existing,
      'p1',
    );
    expect(missingNode.ok).toBe(false);

    const reassignedToDeleted = validatePhaseDeletionReassignments(
      assigned,
      { node1: 'p1', node2: null },
      existing,
      'p1',
    );
    expect(reassignedToDeleted.ok).toBe(false);
  });

  it('previews phase reorder conflict impact', () => {
    // nodeA (in p1) unlocks nodeB (in p2) -> No conflict currently (p1 comes before p2)
    // If we reorder to [p2, p1], nodeA is now in later phase than nodeB -> 1 conflict
    const nodePhaseMap = new Map([
      ['nodeA', 'p1'],
      ['nodeB', 'p2'],
    ]);
    const edges = [{ sourceNodeId: 'nodeA', targetNodeId: 'nodeB' }];

    const preview = previewPhaseReorderImpact([p1, p2], ['p2', 'p1'], nodePhaseMap, edges);
    expect(preview.currentConflicts).toBe(0);
    expect(preview.projectedConflicts).toBe(1);
    expect(preview.delta).toBe(1);
  });
});
