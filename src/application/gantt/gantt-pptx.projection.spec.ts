import { describe, it, expect } from 'vitest';
import { buildGanttPptxSlidePlan, DEFAULT_GANTT_PPTX_GEOMETRY } from './gantt-pptx.projection';
import { projectGantt } from './gantt.projection';
import { resolveGanttVisibleScope } from './gantt-scope';
import { createNode, type Node } from '../../domain/tree/node.entity';
import { createPhase, type Phase } from '../../domain/phase/phase.entity';
import type { UnlockEdge } from '../../domain/edge/unlock-edge.entity';

const P = '019ffe00-0000-7000-8000-000000000001';
const R = '019ffe00-0000-7000-8000-000000000010';
const F1 = '019ffe00-0000-7000-8000-000000000020';
const F2 = '019ffe00-0000-7000-8000-000000000021';
const PH1 = '019ffe00-0000-7000-8000-000000000030';

function n(overrides: Partial<Node>): Node {
  return createNode({ id: '019ffe00-0000-7000-8000-000000000090', projectId: P, position: 0n, ...overrides });
}

const root = createNode({ id: R, projectId: P, position: 0n, title: 'Theme', nodeType: 'Theme' });
const feat1 = createNode({
  id: F1, projectId: P, parentId: R, position: 0n, title: 'Feature One', nodeType: 'Feature',
  startDate: '2026-01-01', endDate: '2026-01-15', durationDays: 15, scheduleSourceMode: 'start_end',
});
const feat2 = createNode({
  id: F2, projectId: P, parentId: R, position: 1n, title: 'Feature Two', nodeType: 'Feature',
  startDate: '2026-01-10', endDate: '2026-01-31', durationDays: 22, scheduleSourceMode: 'start_end',
});
const phase = createPhase({ id: PH1, projectId: P, name: 'Phase A', position: 0n });
const nodes = [root, feat1, feat2];

function buildScope(collapsedNodeIds: readonly string[] = []) {
  const projection = projectGantt({ projectId: P, projectRevision: 3, nodes });
  return resolveGanttVisibleScope({
    projection,
    window: { dateWindowStart: '2026-01-01', dateWindowEnd: '2026-01-31', granularity: 'month' },
    collapsedNodeIds,
  });
}

describe('buildGanttPptxSlidePlan (Story 8.3 Task 3)', () => {
  it('builds hierarchy labels and bars for visible rows with authored/derived distinction', () => {
    const plan = buildGanttPptxSlidePlan({
      scope: buildScope(),
      phases: [phase],
      nodes,
      unlockEdges: [],
      projectName: 'Sample',
      generatedAt: '2026-08-16T12:00:00Z',
    });

    // root is derived, two features authored
    expect(plan.bars.length).toBe(3);
    const rootBar = plan.bars.find((b) => b.nodeId === R)!;
    expect(rootBar.kind).toBe('derived');
    const f1 = plan.bars.find((b) => b.nodeId === F1)!;
    expect(f1.kind).toBe('authored');
    // derived bars are visually distinct (kind field)
    expect(rootBar.kind).not.toBe(f1.kind);

    // hierarchy indentation by depth
    const rootLabel = plan.hierarchyLabels.find((l) => l.nodeId === R)!;
    const f1Label = plan.hierarchyLabels.find((l) => l.nodeId === F1)!;
    expect(f1Label.xIn).toBeGreaterThan(rootLabel.xIn);
  });

  it('clips bars at the window edges', () => {
    // Feature Two ends exactly at the window end -> not clipped right
    const plan = buildGanttPptxSlidePlan({
      scope: buildScope(),
      phases: [],
      nodes,
      unlockEdges: [],
      projectName: 'Sample',
      generatedAt: '2026-08-16T12:00:00Z',
    });
    const f2 = plan.bars.find((b) => b.nodeId === F2)!;
    expect(f2.isClippedRight).toBe(false);
    expect(f2.isClippedLeft).toBe(false);
  });

  it('carries each row\'s workstreamHueIndex onto its bar verbatim', () => {
    const scope = buildScope();
    const plan = buildGanttPptxSlidePlan({
      scope,
      phases: [],
      nodes,
      unlockEdges: [],
      projectName: 'Sample',
      generatedAt: '2026-08-16T12:00:00Z',
    });
    // root is a Theme -> workstream 1; its features inherit it.
    for (const bar of plan.bars) {
      const row = scope.visibleRows.find((r) => r.nodeId === bar.nodeId)!;
      expect(bar.workstreamHueIndex).toBe(row.workstreamHueIndex);
    }
    expect(plan.bars.every((b) => b.workstreamHueIndex === 1)).toBe(true);
  });

  it('emits a violating dependency line', () => {
    const edge: UnlockEdge = { id: 'e1', projectId: P, sourceNodeId: F1, targetNodeId: F2 };
    const plan = buildGanttPptxSlidePlan({
      scope: buildScope(),
      phases: [],
      nodes,
      unlockEdges: [edge],
      projectName: 'Sample',
      generatedAt: '2026-08-16T12:00:00Z',
    });
    expect(plan.dependencyLines.length).toBe(1);
    expect(plan.dependencyLines[0].edgeId).toBe('e1');
    // target starts (Jan 10) before source ends (Jan 15) -> violating
    expect(plan.dependencyLines[0].isViolating).toBe(true);
    expect(plan.dependencyLines[0].points.length).toBeGreaterThanOrEqual(2);
  });

  it('builds exclusionSummary and footerStamp from known counts/timestamp', () => {
    // Collapse the root -> features excluded (collapsedCount), root stays (derived)
    const plan = buildGanttPptxSlidePlan({
      scope: buildScope([R]),
      phases: [],
      nodes,
      unlockEdges: [],
      projectName: 'Sample Project',
      generatedAt: '2026-08-16T12:00:00Z',
    });
    expect(plan.footerStamp).toBe('Sample Project — Generated 16 Aug 2026');
    // collapsed count includes the two feature rows hidden under collapsed root
    expect(plan.exclusionSummary).toContain('collapsed');
    expect(plan.exclusionSummary).toContain('2 collapsed');
  });

  it('respects the geometry config', () => {
    const plan = buildGanttPptxSlidePlan({
      scope: buildScope(),
      phases: [],
      nodes,
      unlockEdges: [],
      projectName: 'Sample',
      generatedAt: '2026-08-16T12:00:00Z',
      geometry: { rowHeightIn: 0.5, headerHeightIn: 0.6 },
    });
    const firstLabel = plan.hierarchyLabels[0];
    // first row top = headerHeightIn
    expect(firstLabel.yIn).toBeCloseTo(0.6, 5);
  });

  it('never sorts rows — preserves scope.visibleRows order', () => {
    const plan = buildGanttPptxSlidePlan({
      scope: buildScope(),
      phases: [],
      nodes,
      unlockEdges: [],
      projectName: 'Sample',
      generatedAt: '2026-08-16T12:00:00Z',
    });
    // visible order is [root, feat1, feat2]
    expect(plan.bars.map((b) => b.nodeId)).toEqual([R, F1, F2]);
    expect(plan.hierarchyLabels.map((l) => l.nodeId)).toEqual([R, F1, F2]);
  });
});
