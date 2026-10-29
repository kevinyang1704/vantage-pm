import { describe, expect, it } from 'vitest';
import { projectCoherenceReview } from './coherence-review.projection';
import type { Node } from '../../domain/tree/node.entity';
import type { CoherenceFinding } from '../../contracts/analysis-protocol';

function createMockNode(id: string): Node {
  return {
    id,
    projectId: 'p1',
    parentId: null,
    title: `Node ${id}`,
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

describe('coherence-review.projection', () => {
  it('groups findings into A (Orphans), B (Sequencing/Cycles), C (Imbalances) and sorts by tree order', () => {
    const nodes = [createMockNode('n1'), createMockNode('n2'), createMockNode('n3')];

    const findings: CoherenceFinding[] = [
      {
        id: 'f-imbalance',
        kind: 'StrategicImbalance',
        projectId: 'p1',
        targetNodeId: 'n3',
        title: 'Imbalance',
        narrative: '',
        fingerprint: 'fp1',
        themeId: 'n3',
        themeName: 'Theme 3',
        strategicWeightShare: 20,
        effortShare: 60,
        spanShare: 0,
        divergencePercentage: 40,
        coveragePercentage: 100,
        missingDataNotes: [],
      },
      {
        id: 'f-orphan-2',
        kind: 'OrphanedFeature',
        projectId: 'p1',
        targetNodeId: 'n2',
        title: 'Orphan 2',
        narrative: '',
        fingerprint: 'fp2',
        missingContainment: true,
        missingUnlockEdges: true,
      },
      {
        id: 'f-orphan-1',
        kind: 'OrphanedFeature',
        projectId: 'p1',
        targetNodeId: 'n1',
        title: 'Orphan 1',
        narrative: '',
        fingerprint: 'fp3',
        missingContainment: true,
        missingUnlockEdges: true,
      },
      {
        id: 'f-cycle',
        kind: 'UnlockCycle',
        projectId: 'p1',
        targetNodeId: 'n1',
        title: 'Cycle',
        narrative: '',
        fingerprint: 'fp4',
        cycleId: 'c1',
        pathNodeIds: ['n1', 'n2', 'n1'],
        pathNodeTitles: ['Node n1', 'Node n2', 'Node n1'],
        edgeIds: ['e1', 'e2'],
      },
    ];

    const review = projectCoherenceReview(findings, nodes);
    expect(review.totalOpenCount).toBe(4);
    expect(review.groupAOrphans).toHaveLength(2);
    // Tree order: n1 before n2
    expect(review.groupAOrphans[0].targetNodeId).toBe('n1');
    expect(review.groupAOrphans[1].targetNodeId).toBe('n2');

    expect(review.groupBSequencingAndCycles).toHaveLength(1);
    expect(review.groupBSequencingAndCycles[0].kind).toBe('UnlockCycle');

    expect(review.groupCImbalances).toHaveLength(1);
    expect(review.groupCImbalances[0].themeId).toBe('n3');
  });
});
