/**
 * Visual findings projection (Story 6.6 Task 1).
 *
 * Pure bucketing of active CoherenceFindings into subtree-scoped maps.
 * Zero detection logic — does not recompute findings.
 * Excludes StrategicImbalanceFinding (AD-16/AC4) and UnlockCycleFinding.
 * Pure: no React, no I/O.
 */

import type {
  CoherenceFinding,
  OrphanedFeatureFinding,
  PhaseSequencingConflictFinding,
  DateSequencingConflictFinding,
} from '../../contracts/analysis-protocol';

export interface VisualFindingsProjection {
  readonly orphanFindingsByNodeId: ReadonlyMap<string, OrphanedFeatureFinding>;
  readonly violationFindingsByEdgeId: ReadonlyMap<
    string,
    PhaseSequencingConflictFinding | DateSequencingConflictFinding
  >;
}

export function projectVisualFindings(params: {
  coherenceFindings: readonly CoherenceFinding[];
  subtreeNodeIds: ReadonlySet<string>;
  subtreeEdgeIds: ReadonlySet<string>;
}): VisualFindingsProjection {
  const { coherenceFindings, subtreeNodeIds, subtreeEdgeIds } = params;

  const orphanFindings = new Map<string, OrphanedFeatureFinding>();
  const violationFindings = new Map<
    string,
    PhaseSequencingConflictFinding | DateSequencingConflictFinding
  >();

  for (const finding of coherenceFindings) {
    if (finding.kind === 'OrphanedFeature') {
      if (subtreeNodeIds.has(finding.targetNodeId)) {
        orphanFindings.set(finding.targetNodeId, finding);
      }
    } else if (
      finding.kind === 'PhaseSequencingConflict' ||
      finding.kind === 'DateSequencingConflict'
    ) {
      if (subtreeEdgeIds.has(finding.edgeId)) {
        violationFindings.set(finding.edgeId, finding);
      }
    }
  }

  return Object.freeze({
    orphanFindingsByNodeId: orphanFindings,
    violationFindingsByEdgeId: violationFindings,
  });
}
