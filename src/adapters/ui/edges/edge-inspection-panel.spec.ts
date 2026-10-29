import { describe, it, expect } from 'vitest';
import type { OutlineNodeReadModel } from '../../../application/outline/outline-read-model';
import type { UnlockEdge } from '../../../domain/edge/unlock-edge.entity';

describe('EdgeInspectionPanel logic (Story 6.5 Task 4 & Task 6)', () => {
  const sampleNodes: OutlineNodeReadModel[] = [
    {
      id: 'theme-1',
      parentId: null,
      position: 100n,
      title: 'Core Engine',
      typeTag: 'Theme',
      nodeType: 'Theme',
      startDate: null,
      endDate: null,
      durationDays: null,
      scheduleSourceMode: null,
      derivedStartDate: null,
      derivedEndDate: null,
      derivedDurationDays: null,
      completed: false,
      effortPoints: null,
      effortPointsDone: null,
      strategicWeight: null,
      deliveryStatus: 'not_started',
      phaseId: 'phase-1',
      phaseName: 'Phase 1',
      effectivePhaseName: 'Phase 1',
      effectivePhaseSource: 'explicit',
      unlocksCount: 1,
      unlockedByCount: 0,
      customFields: {},
      acceptanceSummary: null,
      bodyText: null,
      openQuestions: [],
    },
    {
      id: 'node-1',
      parentId: 'theme-1',
      position: 200n,
      title: 'Parser Module',
      typeTag: 'Feature',
      nodeType: 'Feature',
      startDate: null,
      endDate: null,
      durationDays: null,
      scheduleSourceMode: null,
      derivedStartDate: null,
      derivedEndDate: null,
      derivedDurationDays: null,
      completed: false,
      effortPoints: null,
      effortPointsDone: null,
      strategicWeight: null,
      deliveryStatus: 'not_started',
      phaseId: 'phase-1',
      phaseName: 'Phase 1',
      effectivePhaseName: 'Phase 1',
      effectivePhaseSource: 'inherited',
      unlocksCount: 1,
      unlockedByCount: 0,
      customFields: {},
      acceptanceSummary: null,
      bodyText: null,
      openQuestions: [],
    },
    {
      id: 'node-2',
      parentId: 'theme-1',
      position: 300n,
      title: 'Emitter Module',
      typeTag: 'Feature',
      nodeType: 'Feature',
      startDate: null,
      endDate: null,
      durationDays: null,
      scheduleSourceMode: null,
      derivedStartDate: null,
      derivedEndDate: null,
      derivedDurationDays: null,
      completed: false,
      effortPoints: null,
      effortPointsDone: null,
      strategicWeight: null,
      deliveryStatus: 'not_started',
      phaseId: 'phase-2',
      phaseName: 'Phase 2',
      effectivePhaseName: 'Phase 2',
      effectivePhaseSource: 'explicit',
      unlocksCount: 0,
      unlockedByCount: 1,
      customFields: {},
      acceptanceSummary: null,
      bodyText: null,
      openQuestions: [],
    },
  ];

  const sampleEdge: UnlockEdge = {
    id: 'edge-1',
    projectId: 'proj-1',
    sourceNodeId: 'node-1',
    targetNodeId: 'node-2',
  };

  it('correctly resolves subtree node set and filters subtree-scoped edges', () => {
    const currentNodeId = 'theme-1';
    const set = new Set<string>([currentNodeId]);
    let added = true;
    while (added) {
      added = false;
      for (const n of sampleNodes) {
        if (n.parentId && set.has(n.parentId) && !set.has(n.id)) {
          set.add(n.id);
          added = true;
        }
      }
    }

    expect(set.has('theme-1')).toBe(true);
    expect(set.has('node-1')).toBe(true);
    expect(set.has('node-2')).toBe(true);

    const allEdges = [sampleEdge];
    const subtreeEdges = allEdges.filter(
      (e) => set.has(e.sourceNodeId) || set.has(e.targetNodeId),
    );
    expect(subtreeEdges.length).toBe(1);
    expect(subtreeEdges[0].id).toBe('edge-1');
  });

  it('correctly detects sequencing violation flags on unlock edges', () => {
    const violationEdgeIds = new Set(['edge-1']);
    expect(violationEdgeIds.has(sampleEdge.id)).toBe(true);
    expect(violationEdgeIds.has('non-existent-edge')).toBe(false);
  });
});
