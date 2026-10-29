import { describe, it, expect } from 'vitest';
import { resolveGanttVisibleScope, generateHeaderColumns } from './gantt-scope';
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

describe('resolveGanttVisibleScope (Story 7.2 & 7.3)', () => {
  const row1 = createMockRow({
    nodeId: 'node-1',
    startDate: '2026-06-01',
    endDate: '2026-06-15',
  });
  const row2 = createMockRow({
    nodeId: 'node-2',
    startDate: '2026-07-01',
    endDate: '2026-07-20',
  });
  const row3 = createMockRow({
    nodeId: 'node-3',
    startDate: '2026-08-10',
    endDate: '2026-08-30',
  });

  const mockProjection: GanttProjection = {
    projectId: '018f6c40-1111-7000-8000-000000000001',
    projectRevision: 1,
    rows: [row1, row2, row3],
    totalProjectNodes: 5,
    datedNodeCount: 3,
    undatedCount: 2,
    minProjectDate: '2026-06-01',
    maxProjectDate: '2026-08-30',
  };

  it('filters rows intersecting active date window and computes outOfWindowCount', () => {
    const scope = resolveGanttVisibleScope({
      projection: mockProjection,
      window: {
        dateWindowStart: '2026-06-10',
        dateWindowEnd: '2026-07-15',
        granularity: 'month',
      },
    });

    // row1 (ends Jun 15) and row2 (starts Jul 01) intersect window
    // row3 (starts Aug 10) is completely out of window
    expect(scope.visibleRows.map((r) => r.nodeId)).toEqual(['node-1', 'node-2']);
    expect(scope.outOfWindowCount).toBe(1);
    expect(scope.undatedCount).toBe(2);
    expect(scope.totalProjectNodes).toBe(5);
  });

  it('generates monthly header columns accurately (Epic 14: major + minor week guides)', () => {
    const columns = generateHeaderColumns('2026-06-01', '2026-08-31', 'month', 5);
    const majors = columns.filter((c) => c.level === 'major');
    expect(majors.length).toBe(3);
    expect(majors[0].label).toBe('Jun 2026');
    expect(majors[1].label).toBe('Jul 2026');
    expect(majors[2].label).toBe('Aug 2026');
    // Minor week-start guides exist within the months (E14-FR2/AR3).
    const minors = columns.filter((c) => c.level === 'minor');
    expect(minors.length).toBeGreaterThan(0);
    for (const minor of minors) {
      expect(minor.label).toBe('');
      expect(minor.pixelWidth).toBe(0);
    }
  });

  it('generates quarterly header columns accurately (Epic 14: major + minor month guides)', () => {
    const columns = generateHeaderColumns('2026-01-01', '2026-12-31', 'quarter', 2);
    const majors = columns.filter((c) => c.level === 'major');
    expect(majors.length).toBe(4);
    expect(majors[0].label).toBe('Q1 2026');
    expect(majors[1].label).toBe('Q2 2026');
    expect(majors[2].label).toBe('Q3 2026');
    expect(majors[3].label).toBe('Q4 2026');
    // Minor month-start guides exist within the quarters.
    const minors = columns.filter((c) => c.level === 'minor');
    expect(minors.length).toBeGreaterThan(0);
  });

  it('generates weekly header columns with no minor tier (finest granularity)', () => {
    const columns = generateHeaderColumns('2026-06-01', '2026-06-21', 'week', 18);
    expect(columns.every((c) => c.level === 'major')).toBe(true);
    expect(columns.length).toBe(3);
  });
});
