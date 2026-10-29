import { describe, it, expect } from 'vitest';
import { resolveGanttDependencies } from './gantt-dependencies';
import type { GanttRow } from '../../contracts/gantt';
import type { UnlockEdge } from '../../domain/edge/unlock-edge.entity';

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

describe('resolveGanttDependencies (Story 7.4)', () => {
  const rowA = createMockRow({
    nodeId: 'node-a',
    startDate: '2026-06-01',
    endDate: '2026-06-15',
  });
  const rowB = createMockRow({
    nodeId: 'node-b',
    startDate: '2026-06-20',
    endDate: '2026-06-30',
  });
  const rowViolating = createMockRow({
    nodeId: 'node-violating',
    startDate: '2026-06-05', // Starts before rowA ends!
    endDate: '2026-06-25',
  });

  const edgeNormal: UnlockEdge = {
    id: 'edge-1',
    projectId: 'p1',
    sourceNodeId: 'node-a',
    targetNodeId: 'node-b',
  };

  const edgeViolating: UnlockEdge = {
    id: 'edge-2',
    projectId: 'p1',
    sourceNodeId: 'node-a',
    targetNodeId: 'node-violating',
  };

  const edgeOutside: UnlockEdge = {
    id: 'edge-3',
    projectId: 'p1',
    sourceNodeId: 'node-a',
    targetNodeId: 'node-outside-scope',
  };

  it('routes valid dependency between two visible rows', () => {
    const routes = resolveGanttDependencies({
      visibleRows: [rowA, rowB],
      unlockEdges: [edgeNormal],
      dateToX: (date) => (date === '2026-06-15' ? 150 : 200),
      rowHeight: 28,
    });

    expect(routes.length).toBe(1);
    expect(routes[0].edgeId).toBe('edge-1');
    expect(routes[0].isViolating).toBe(false);
    expect(routes[0].pathD).toContain('M 150 14');
    // vertices match the path endpoints (forward-step branch: 4 vertices)
    expect(routes[0].vertices.length).toBe(4);
    expect(routes[0].vertices[0]).toEqual({ x: 150, y: 14 });
    expect(routes[0].vertices[routes[0].vertices.length - 1]).toEqual({ x: 200, y: 42 });
  });

  it('flags sequencing violation when target starts before source ends', () => {
    const routes = resolveGanttDependencies({
      visibleRows: [rowA, rowViolating],
      unlockEdges: [edgeViolating],
      dateToX: (date) => (date === '2026-06-15' ? 150 : 50),
      rowHeight: 28,
    });

    expect(routes.length).toBe(1);
    expect(routes[0].edgeId).toBe('edge-2');
    expect(routes[0].isViolating).toBe(true);
  });

  it('omits edges where either endpoint is outside visible scope', () => {
    const routes = resolveGanttDependencies({
      visibleRows: [rowA], // target is missing
      unlockEdges: [edgeOutside],
      dateToX: () => 100,
      rowHeight: 28,
    });

    expect(routes.length).toBe(0);
  });

  it('populates vertices matching pathD for the backward/overlap branch', () => {
    // Both rows at the same row index so targetX < sourceX triggers the backward branch
    const sameRow = createMockRow({
      nodeId: 'node-c',
      startDate: '2026-06-01',
      endDate: '2026-06-10',
    });
    const edgeBackward: UnlockEdge = {
      id: 'edge-bw',
      projectId: 'p1',
      sourceNodeId: 'node-a',
      targetNodeId: 'node-c',
    };
    const routes = resolveGanttDependencies({
      visibleRows: [rowA, sameRow],
      unlockEdges: [edgeBackward],
      // rowA ends at x=150, sameRow starts at x=50 -> targetX < sourceX
      dateToX: (date) => (date === '2026-06-15' ? 150 : 50),
      rowHeight: 28,
    });
    expect(routes.length).toBe(1);
    expect(routes[0].isViolating).toBe(true);
    // Backward branch has 6 vertices; first and last match the source/target points
    expect(routes[0].vertices.length).toBe(6);
    expect(routes[0].vertices[0]).toEqual({ x: 150, y: 14 });
    // sameRow is at row index 1 -> targetY = 14 + 28 = 42
    expect(routes[0].vertices[routes[0].vertices.length - 1]).toEqual({ x: 50, y: 42 });
    // Every consecutive vertex pair is axis-aligned (orthogonal)
    for (let i = 1; i < routes[0].vertices.length; i++) {
      const a = routes[0].vertices[i - 1];
      const b = routes[0].vertices[i];
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
  });
});
