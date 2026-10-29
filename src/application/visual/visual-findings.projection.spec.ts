import { describe, it, expect } from 'vitest';
import { projectVisualFindings } from './visual-findings.projection';
import type {
  CoherenceFinding,
  OrphanedFeatureFinding,
  DateSequencingConflictFinding,
  StrategicImbalanceFinding,
  UnlockCycleFinding,
} from '../../contracts/analysis-protocol';

describe('visual-findings.projection', () => {
  it('buckets in-scope orphans and sequencing conflicts while excluding out-of-scope and balance/cycle findings', () => {
    const inScopeOrphan: OrphanedFeatureFinding = {
      id: 'f1',
      kind: 'OrphanedFeature',
      projectId: 'proj-1',
      targetNodeId: 'node-1',
      title: 'Orphaned Feature',
      narrative: 'Feature is orphaned',
      fingerprint: 'fp1',
      missingContainment: true,
      missingUnlockEdges: true,
    };

    const outOfScopeOrphan: OrphanedFeatureFinding = {
      id: 'f2',
      kind: 'OrphanedFeature',
      projectId: 'proj-1',
      targetNodeId: 'node-outside',
      title: 'Outside Orphan',
      narrative: 'Outside orphan',
      fingerprint: 'fp2',
      missingContainment: true,
      missingUnlockEdges: true,
    };

    const inScopeSeq: DateSequencingConflictFinding = {
      id: 'f3',
      kind: 'DateSequencingConflict',
      projectId: 'proj-1',
      targetNodeId: 'node-2',
      title: 'Date Conflict',
      edgeId: 'edge-1',
      sourceNodeId: 'node-1',
      sourceEndDate: '2026-09-10',
      targetStartDate: '2026-09-01',
      overlapDays: 9,
      narrative: 'Date conflict narrative',
      fingerprint: 'fp3',
    };

    const imbalance: StrategicImbalanceFinding = {
      id: 'f4',
      kind: 'StrategicImbalance',
      projectId: 'proj-1',
      targetNodeId: 'theme-1',
      themeId: 'theme-1',
      themeName: 'Theme Alpha',
      strategicWeightShare: 20,
      effortShare: 50,
      spanShare: 30,
      divergencePercentage: 30,
      coveragePercentage: 100,
      missingDataNotes: [],
      title: 'Imbalance',
      narrative: 'Imbalance narrative',
      fingerprint: 'fp4',
    };

    const cycle: UnlockCycleFinding = {
      id: 'f5',
      kind: 'UnlockCycle',
      projectId: 'proj-1',
      targetNodeId: 'node-1',
      cycleId: 'cycle-1',
      pathNodeIds: ['node-1'],
      pathNodeTitles: ['Node 1'],
      edgeIds: ['edge-1'],
      title: 'Cycle',
      narrative: 'Cycle narrative',
      fingerprint: 'fp5',
    };

    const findings: CoherenceFinding[] = [
      inScopeOrphan,
      outOfScopeOrphan,
      inScopeSeq,
      imbalance,
      cycle,
    ];

    const result = projectVisualFindings({
      coherenceFindings: findings,
      subtreeNodeIds: new Set(['node-1', 'node-2']),
      subtreeEdgeIds: new Set(['edge-1']),
    });

    expect(result.orphanFindingsByNodeId.get('node-1')).toBe(inScopeOrphan);
    expect(result.orphanFindingsByNodeId.has('node-outside')).toBe(false);
    expect(result.violationFindingsByEdgeId.get('edge-1')).toBe(inScopeSeq);
  });
});
