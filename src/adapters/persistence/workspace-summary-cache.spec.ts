import { describe, expect, it } from 'vitest';
import { WorkspaceSummaryCache } from './workspace-summary-cache';
import type { WorkspaceProjectRow } from '../../contracts/workspace-overview';

function fakeRow(projectId: string, revision: number): WorkspaceProjectRow {
  return Object.freeze({
    projectId,
    projectName: 'Project',
    projectRevision: revision,
    nodeCount: 0,
    phaseCount: 0,
    featureCount: 0,
    statusCounts: Object.freeze({ notStarted: 0, inProgress: 0, delivered: 0 }),
    unattributedFeatureCount: 0,
    openFindingCount: 0,
    coverage: Object.freeze({ weightCoveragePercentage: 0, effortCoveragePercentage: 0, scheduleCoveragePercentage: 0 }),
    themes: Object.freeze([]),
  });
}

describe('workspace-summary-cache', () => {
  it('hits on the same project + revision', () => {
    const cache = new WorkspaceSummaryCache();
    cache.set('p1', 3, fakeRow('p1', 3));

    expect(cache.get('p1', 3)).toBeDefined();
    expect(cache.get('p1', 3)!.projectRevision).toBe(3);
  });

  it('forces a miss on revision mismatch even without invalidate', () => {
    const cache = new WorkspaceSummaryCache();
    cache.set('p1', 3, fakeRow('p1', 3));

    expect(cache.get('p1', 4)).toBeUndefined();
  });

  it('misses on an unknown project', () => {
    const cache = new WorkspaceSummaryCache();
    expect(cache.get('missing', 1)).toBeUndefined();
  });

  it('invalidate removes only the targeted project', () => {
    const cache = new WorkspaceSummaryCache();
    cache.set('p1', 1, fakeRow('p1', 1));
    cache.set('p2', 1, fakeRow('p2', 1));

    cache.invalidate('p1');

    expect(cache.get('p1', 1)).toBeUndefined();
    expect(cache.get('p2', 1)).toBeDefined();
    expect(cache.size).toBe(1);
  });

  it('clear removes every entry', () => {
    const cache = new WorkspaceSummaryCache();
    cache.set('p1', 1, fakeRow('p1', 1));
    cache.set('p2', 1, fakeRow('p2', 1));
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('set overwrites a stale entry at the same key', () => {
    const cache = new WorkspaceSummaryCache();
    cache.set('p1', 2, fakeRow('p1', 2));
    cache.set('p1', 3, fakeRow('p1', 3));

    expect(cache.get('p1', 2)).toBeUndefined();
    expect(cache.get('p1', 3)).toBeDefined();
  });
});
