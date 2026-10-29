import { describe, it, expect } from 'vitest';
import { narrateVisualTree } from './visual-tree-narration';
import type { VisualTreeProjection } from '../../contracts/visual-tree';
import type { VisualFindingsProjection } from '../visual/visual-findings.projection';
import type { OrphanedFeatureFinding, DateSequencingConflictFinding } from '../../contracts/analysis-protocol';

describe('visual-tree-narration (Story 6.8 AC1)', () => {
  it('generates revision-matched structured prose for visual tree with findings, edges, and ghost destination', () => {
    const projection: VisualTreeProjection = {
      projectId: 'proj-1',
      projectRevision: 42,
      themeId: 'theme-1',
      nodeCount: 4,
      degraded: false,
      renderLimit: 200,
      nodes: [
        {
          nodeId: 'theme-1',
          parentId: null,
          title: 'Core Engine',
          nodeType: 'Theme',
          depth: 0,
          siblingIndex: 0,
          siblingSetSize: 1,
          completed: false,
          startDate: '2026-09-01',
          endDate: '2026-12-31',
          durationDays: 121,
          scheduleSourceMode: 'start_end',
        },
        {
          nodeId: 'feat-1',
          parentId: 'theme-1',
          title: 'Parser Module',
          nodeType: 'Feature',
          depth: 1,
          siblingIndex: 0,
          siblingSetSize: 3,
          completed: true,
          startDate: '2026-09-01',
          endDate: '2026-09-30',
          durationDays: 30,
          scheduleSourceMode: 'start_end',
        },
        {
          nodeId: 'feat-2',
          parentId: 'theme-1',
          title: 'Emitter Module',
          nodeType: 'Feature',
          depth: 1,
          siblingIndex: 1,
          siblingSetSize: 3,
          completed: false,
          startDate: '2026-10-01',
          endDate: '2026-10-15',
          durationDays: 14,
          scheduleSourceMode: 'start_end',
        },
        {
          nodeId: 'feat-orphan',
          parentId: 'theme-1',
          title: 'Orphaned Module',
          nodeType: 'Feature',
          depth: 1,
          siblingIndex: 2,
          siblingSetSize: 3,
          completed: false,
          startDate: null,
          endDate: null,
          durationDays: null,
          scheduleSourceMode: null,
        },
      ],
      unlockEdges: [
        {
          edgeId: 'edge-1',
          sourceNodeId: 'feat-1',
          targetNodeId: 'feat-2',
          sourceInSubtree: true,
          targetInSubtree: true,
          outsideEndpoint: null,
        },
        {
          edgeId: 'edge-2',
          sourceNodeId: 'feat-2',
          targetNodeId: 'outside-node-1',
          sourceInSubtree: true,
          targetInSubtree: false,
          outsideEndpoint: {
            nodeId: 'outside-node-1',
            title: 'CLI Client',
            themeId: 'theme-2',
            themeName: 'Client Surface',
          },
        },
      ],
    };

    const orphanFinding: OrphanedFeatureFinding = {
      id: 'f-orphan',
      kind: 'OrphanedFeature',
      projectId: 'proj-1',
      targetNodeId: 'feat-orphan',
      title: 'Orphaned Feature',
      narrative: 'Feature carries no containment line and no unlock connection.',
      fingerprint: 'fp1',
      missingContainment: true,
      missingUnlockEdges: true,
    };

    const seqFinding: DateSequencingConflictFinding = {
      id: 'f-seq',
      kind: 'DateSequencingConflict',
      projectId: 'proj-1',
      targetNodeId: 'feat-2',
      title: 'Date Conflict',
      edgeId: 'edge-1',
      sourceNodeId: 'feat-1',
      sourceEndDate: '2026-09-30',
      targetStartDate: '2026-09-15',
      overlapDays: 15,
      narrative: 'Starts 15 days before prerequisite ends.',
      fingerprint: 'fp2',
    };

    const findings: VisualFindingsProjection = {
      orphanFindingsByNodeId: new Map([['feat-orphan', orphanFinding]]),
      violationFindingsByEdgeId: new Map([['edge-1', seqFinding]]),
    };

    const prose = narrateVisualTree(projection, 'Core Engine', findings);

    expect(prose).toContain('Visual tree for Core Engine, revision 42.');
    expect(prose).toContain('Contains 4 nodes across depth 2.');
    expect(prose).toContain('• Core Engine [Theme] (2026-09-01 to 2026-12-31)');
    expect(prose).toContain('• Parser Module [Feature] (completed)');
    expect(prose).toContain('• Emitter Module [Feature] (2026-10-01 to 2026-10-15)');
    expect(prose).toContain('The children, left to right in start-date order, are: Parser Module, Emitter Module.');
    expect(prose).toContain('Feature carries no containment line and no unlock connection.');
    expect(prose).toContain('Unlock dependencies: 2 total.');
    expect(prose).toContain('Sequencing violation: Parser Module unlocks Emitter Module. Starts 15 days before prerequisite ends.');
    expect(prose).toContain('Unlocks cross-branch destination: CLI Client in theme Client Surface.');
  });
});
