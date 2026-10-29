import { describe, expect, it } from 'vitest';
import { resolveGanttVisibleScope } from './gantt-scope';
import { resolveGanttExportScope } from './resolve-gantt-export-scope';
import type { GanttProjection, GanttRow } from '../../contracts/gantt';

function createMockRow(overrides: Partial<GanttRow> & { nodeId: string; startDate: string; endDate: string }): GanttRow {
  return {
    parentId: null,
    depth: 0,
    title: `Row ${overrides.nodeId}`,
    nodeType: 'Feature',
    completed: false,
    siblingIndex: 0,
    siblingSetSize: 1,
    hasChildren: false,
    isCollapsed: false,
    barKind: 'authored',
    durationDays: 10,
    scheduleSourceMode: 'start_end',
    isExplicitOverride: false,
    workstreamId: null,
    workstreamHueIndex: null,
    ...overrides,
  };
}

const mockProjection: GanttProjection = {
  projectId: '018f6c40-1111-7000-8000-000000000001',
  projectRevision: 1,
  rows: [
    createMockRow({ nodeId: 'node-1', startDate: '2026-06-01', endDate: '2026-06-15' }),
    createMockRow({ nodeId: 'node-2', startDate: '2026-07-01', endDate: '2026-07-20' }),
    createMockRow({ nodeId: 'node-3', startDate: '2026-08-10', endDate: '2026-08-30' }),
  ],
  totalProjectNodes: 5,
  datedNodeCount: 3,
  undatedCount: 2,
  minProjectDate: '2026-06-01',
  maxProjectDate: '2026-08-30',
};

const window = {
  dateWindowStart: '2026-06-10',
  dateWindowEnd: '2026-07-15',
  granularity: 'month' as const,
};

describe('resolveGanttExportScope (Story 8.1 Task 4)', () => {
  it('orderedNodeIds matches resolveGanttVisibleScope visibleRows order exactly (no reimplementation)', () => {
    const input = { projection: mockProjection, window };
    const scope = resolveGanttExportScope(input);
    const direct = resolveGanttVisibleScope(input);
    expect(scope.orderedNodeIds).toEqual(direct.visibleRows.map((r) => r.nodeId));
    expect(scope.orderedNodeIds).toEqual(['node-1', 'node-2']);
  });

  it('passes counts and window through byte-for-byte identical to the direct call', () => {
    const input = { projection: mockProjection, window };
    const scope = resolveGanttExportScope(input);
    const direct = resolveGanttVisibleScope(input);
    expect(scope.undatedCount).toBe(direct.undatedCount);
    expect(scope.outOfWindowCount).toBe(direct.outOfWindowCount);
    expect(scope.collapsedCount).toBe(direct.collapsedCount);
    expect(scope.window).toEqual(direct.window);
    expect(scope.undatedCount).toBe(2);
    expect(scope.outOfWindowCount).toBe(1);
    expect(scope.collapsedCount).toBe(0);
  });

  it('carries projectId and projectRevision from the projection', () => {
    const scope = resolveGanttExportScope({ projection: mockProjection, window });
    expect(scope.projectId).toBe(mockProjection.projectId);
    expect(scope.projectRevision).toBe(mockProjection.projectRevision);
  });
});
