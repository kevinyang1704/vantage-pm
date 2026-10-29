/**
 * Coherence Review Projection (Story 4.7, FR-38).
 *
 * Groups all active coherence findings into three structured categories:
 *   - Group A: Orphaned Work
 *   - Group B: Sequencing Conflicts & Cycles
 *   - Group C: Strategic & Effort Imbalances
 * Inside each group, findings are ordered deterministically by tree position.
 */

import type { Node } from '../../domain/tree/node.entity';
import type {
  CoherenceFinding,
  OrphanedFeatureFinding,
  PhaseSequencingConflictFinding,
  DateSequencingConflictFinding,
  UnlockCycleFinding,
  StrategicImbalanceFinding,
} from '../../contracts/analysis-protocol';

export interface GroupedCoherenceReview {
  readonly groupAOrphans: readonly OrphanedFeatureFinding[];
  readonly groupBSequencingAndCycles: readonly (PhaseSequencingConflictFinding | DateSequencingConflictFinding | UnlockCycleFinding)[];
  readonly groupCImbalances: readonly StrategicImbalanceFinding[];
  readonly totalOpenCount: number;
}

export function projectCoherenceReview(
  findings: readonly CoherenceFinding[],
  nodes: readonly Node[],
): GroupedCoherenceReview {
  const nodeRankMap = new Map<string, number>();
  nodes.forEach((n, idx) => nodeRankMap.set(n.id, idx));

  const groupA: OrphanedFeatureFinding[] = [];
  const groupB: (PhaseSequencingConflictFinding | DateSequencingConflictFinding | UnlockCycleFinding)[] = [];
  const groupC: StrategicImbalanceFinding[] = [];

  for (const f of findings) {
    switch (f.kind) {
      case 'OrphanedFeature':
        groupA.push(f);
        break;
      case 'PhaseSequencingConflict':
      case 'DateSequencingConflict':
      case 'UnlockCycle':
        groupB.push(f);
        break;
      case 'StrategicImbalance':
        groupC.push(f);
        break;
    }
  }

  // Sort inside group by node position in tree
  const sortByTreeOrder = (a: { targetNodeId: string }, b: { targetNodeId: string }) => {
    const rankA = nodeRankMap.get(a.targetNodeId) ?? 999999;
    const rankB = nodeRankMap.get(b.targetNodeId) ?? 999999;
    return rankA - rankB;
  };

  groupA.sort(sortByTreeOrder);
  groupB.sort(sortByTreeOrder);
  groupC.sort(sortByTreeOrder);

  const totalOpenCount = groupA.length + groupB.length + groupC.length;

  return Object.freeze({
    groupAOrphans: Object.freeze(groupA),
    groupBSequencingAndCycles: Object.freeze(groupB),
    groupCImbalances: Object.freeze(groupC),
    totalOpenCount,
  });
}
