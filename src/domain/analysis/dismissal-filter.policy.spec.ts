import { describe, expect, it } from 'vitest';
import { filterActiveFindings } from './dismissal-filter.policy';
import type { CoherenceFinding, FindingDismissal } from '../../contracts/analysis-protocol';

describe('dismissal-filter.policy', () => {
  const findingA: CoherenceFinding = {
    id: 'f1',
    kind: 'OrphanedFeature',
    projectId: 'p1',
    targetNodeId: 'node-1',
    title: 'Orphan 1',
    narrative: 'Orphan',
    fingerprint: 'fp-123',
    missingContainment: true,
    missingUnlockEdges: true,
  };

  const findingB: CoherenceFinding = {
    id: 'f2',
    kind: 'DateSequencingConflict',
    projectId: 'p1',
    targetNodeId: 'node-2',
    title: 'Conflict 2',
    narrative: 'Conflict',
    fingerprint: 'fp-456',
    edgeId: 'e1',
    sourceNodeId: 'src-1',
    sourceEndDate: '2026-09-15',
    targetStartDate: '2026-09-10',
    overlapDays: 5,
  };

  it('filters out finding when dismissal matches kind, targetId, and fingerprint', () => {
    const dismissals: FindingDismissal[] = [
      {
        projectId: 'p1',
        findingId: 'f1',
        findingKind: 'OrphanedFeature',
        targetId: 'node-1',
        fingerprint: 'fp-123',
        dismissedAt: '2026-08-15T00:00:00Z',
      },
    ];

    const active = filterActiveFindings([findingA, findingB], dismissals);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('f2');
  });

  it('does not filter finding if fingerprint has changed (material input changed)', () => {
    const staleDismissals: FindingDismissal[] = [
      {
        projectId: 'p1',
        findingId: 'f1',
        findingKind: 'OrphanedFeature',
        targetId: 'node-1',
        fingerprint: 'fp-old-fingerprint',
        dismissedAt: '2026-08-15T00:00:00Z',
      },
    ];

    const active = filterActiveFindings([findingA, findingB], staleDismissals);
    expect(active).toHaveLength(2);
  });
});
