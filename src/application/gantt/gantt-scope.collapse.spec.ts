import { describe, it, expect } from 'vitest';
import { projectGantt } from './gantt.projection';
import { resolveGanttVisibleScope } from './gantt-scope';
import type { Node } from '../../domain/tree/node.entity';

function createMockNode(overrides: Partial<Node> & { id: string; projectId: string; position: bigint }): Node {
  return {
    parentId: null,
    title: `Node ${overrides.id}`,
    bodyText: null,
    nodeType: null,
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
    ...overrides,
  };
}

describe('Gantt Branch Collapse (Story 7.3)', () => {
  const projectId = '018f6c40-1111-7000-8000-000000000001';

  const theme = createMockNode({
    id: '018f6c40-1111-7000-8000-000000000010',
    projectId,
    position: 1000n,
    title: 'Core Platform Theme',
    nodeType: 'Theme',
  });

  const featureA = createMockNode({
    id: '018f6c40-1111-7000-8000-000000000011',
    projectId,
    parentId: theme.id,
    position: 1000n,
    title: 'Feature A',
    nodeType: 'Feature',
    startDate: '2026-06-01',
    endDate: '2026-06-30',
    durationDays: 30,
    scheduleSourceMode: 'start_end',
  });

  const featureB = createMockNode({
    id: '018f6c40-1111-7000-8000-000000000012',
    projectId,
    parentId: theme.id,
    position: 2000n,
    title: 'Feature B',
    nodeType: 'Feature',
    startDate: '2026-07-01',
    endDate: '2026-07-31',
    durationDays: 31,
    scheduleSourceMode: 'start_end',
  });

  const subTaskB1 = createMockNode({
    id: '018f6c40-1111-7000-8000-000000000013',
    projectId,
    parentId: featureB.id,
    position: 1000n,
    title: 'SubTask B1',
    nodeType: 'AcceptanceCriterion',
    startDate: '2026-07-15',
    endDate: '2026-07-31',
    durationDays: 17,
    scheduleSourceMode: 'start_end',
  });

  it('excludes descendants when branch is collapsed while parent retains pre-scope derived span', () => {
    // 1. Project canonical plan
    const projection = projectGantt({
      projectId,
      projectRevision: 1,
      nodes: [theme, featureA, featureB, subTaskB1],
    });

    expect(projection.rows.length).toBe(4);
    // Theme span covers Jun 1 to Jul 31
    expect(projection.rows[0].nodeId).toBe(theme.id);
    expect(projection.rows[0].startDate).toBe('2026-06-01');
    expect(projection.rows[0].endDate).toBe('2026-07-31');
    expect(projection.rows[0].durationDays).toBe(61);

    // 2. Resolve scope with theme collapsed
    const scoped = resolveGanttVisibleScope({
      projection,
      window: {
        dateWindowStart: '2026-01-01',
        dateWindowEnd: '2026-12-31',
        granularity: 'month',
      },
      collapsedNodeIds: [theme.id],
    });

    // Only theme remains visible
    expect(scoped.visibleRows.length).toBe(1);
    const visibleTheme = scoped.visibleRows[0];
    expect(visibleTheme.nodeId).toBe(theme.id);
    expect(visibleTheme.hasChildren).toBe(true);

    // Critical Invariant: Theme MUST retain its derived pre-scope span!
    expect(visibleTheme.startDate).toBe('2026-06-01');
    expect(visibleTheme.endDate).toBe('2026-07-31');
    expect(visibleTheme.durationDays).toBe(61);

    // Exclusion metric accurately reports 3 collapsed descendants
    expect(scoped.collapsedCount).toBe(3);
  });

  it('handles deep nested collapse where child is also collapsed', () => {
    const projection = projectGantt({
      projectId,
      projectRevision: 1,
      nodes: [theme, featureA, featureB, subTaskB1],
    });

    // Collapse only Feature B
    const scopedChild = resolveGanttVisibleScope({
      projection,
      window: {
        dateWindowStart: '2026-01-01',
        dateWindowEnd: '2026-12-31',
        granularity: 'month',
      },
      collapsedNodeIds: [featureB.id],
    });

    // Theme, Feature A, Feature B visible; SubTask B1 hidden
    expect(scopedChild.visibleRows.map((r) => r.nodeId)).toEqual([theme.id, featureA.id, featureB.id]);
    expect(scopedChild.collapsedCount).toBe(1);
  });
});
