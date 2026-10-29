import { describe, expect, it } from 'vitest';
import {
  detectPhaseSequencingConflicts,
  detectDateSequencingConflicts,
} from './sequencing-conflict.policy';
import type { Node } from '../tree/node.entity';
import type { Phase } from '../phase/phase.entity';
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
    startDate: params.startDate ?? null,
    endDate: params.endDate ?? null,
    durationDays: params.durationDays ?? null,
    scheduleSourceMode: null,
    completed: false,
    effortPoints: null,
    effortPointsDone: null,
    strategicWeight: null,
    phaseId: params.phaseId ?? null,
    deliveryStatus: params.deliveryStatus ?? 'not_started',
  };
}

describe('sequencing-conflict.policy', () => {
  const phases: Phase[] = [
    { id: 'p1', projectId: 'proj-1', name: 'Phase 1: Alpha', position: 1000n },
    { id: 'p2', projectId: 'proj-1', name: 'Phase 2: Beta', position: 2000n },
  ];

  it('detects phase sequencing conflict when prerequisite is in later phase than dependent', () => {
    const nodes: Node[] = [
      createMockNode({ id: 'src', title: 'Prerequisite', phaseId: 'p2' }), // in Phase 2
      createMockNode({ id: 'tgt', title: 'Dependent', phaseId: 'p1' }),    // in Phase 1
    ];
    const edges: UnlockEdge[] = [
      { id: 'e1', projectId: 'proj-1', sourceNodeId: 'src', targetNodeId: 'tgt' },
    ];

    const findings = detectPhaseSequencingConflicts(nodes, phases, edges);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('PhaseSequencingConflict');
    expect(findings[0].sourcePhaseId).toBe('p2');
    expect(findings[0].targetPhaseId).toBe('p1');
  });

  it('does not flag phase sequencing conflict when prerequisite is in earlier phase or same phase', () => {
    const nodes: Node[] = [
      createMockNode({ id: 'src', title: 'Prerequisite', phaseId: 'p1' }),
      createMockNode({ id: 'tgt', title: 'Dependent', phaseId: 'p2' }),
    ];
    const edges: UnlockEdge[] = [
      { id: 'e1', projectId: 'proj-1', sourceNodeId: 'src', targetNodeId: 'tgt' },
    ];

    const findings = detectPhaseSequencingConflicts(nodes, phases, edges);
    expect(findings).toHaveLength(0);
  });

  it('detects date sequencing conflict when dependent starts before prerequisite ends', () => {
    const nodes: Node[] = [
      createMockNode({ id: 'src', title: 'Prerequisite', startDate: '2026-09-01', endDate: '2026-09-15' }),
      createMockNode({ id: 'tgt', title: 'Dependent', startDate: '2026-09-10', endDate: '2026-09-20' }),
    ];
    const edges: UnlockEdge[] = [
      { id: 'e1', projectId: 'proj-1', sourceNodeId: 'src', targetNodeId: 'tgt' },
    ];

    const findings = detectDateSequencingConflicts(nodes, edges);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('DateSequencingConflict');
    expect(findings[0].sourceEndDate).toBe('2026-09-15');
    expect(findings[0].targetStartDate).toBe('2026-09-10');
    expect(findings[0].overlapDays).toBe(5);
  });

  it('does not flag date sequencing conflict when dependent starts on or after prerequisite ends', () => {
    const nodes: Node[] = [
      createMockNode({ id: 'src', title: 'Prerequisite', startDate: '2026-09-01', endDate: '2026-09-15' }),
      createMockNode({ id: 'tgt', title: 'Dependent', startDate: '2026-09-15', endDate: '2026-09-20' }),
    ];
    const edges: UnlockEdge[] = [
      { id: 'e1', projectId: 'proj-1', sourceNodeId: 'src', targetNodeId: 'tgt' },
    ];

    const findings = detectDateSequencingConflicts(nodes, edges);
    expect(findings).toHaveLength(0);
  });
});
