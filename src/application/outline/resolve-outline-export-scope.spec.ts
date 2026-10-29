import { describe, expect, it } from 'vitest';
import { createOutlineReadModel, type OutlineReadModel } from './outline-read-model';
import { projectVisibleOutline } from './outline-visible.projection';
import { resolveOutlineExportScope } from './resolve-outline-export-scope';

const P = '019ffe00-0000-7000-8000-000000000001';
const R = '019ffe00-0000-7000-8000-000000000010';
const T1 = '019ffe00-0000-7000-8000-000000000020';
const T2 = '019ffe00-0000-7000-8000-000000000021';
const F1 = '019ffe00-0000-7000-8000-000000000030';
const F2 = '019ffe00-0000-7000-8000-000000000031';
const F3 = '019ffe00-0000-7000-8000-000000000032';
const AC = '019ffe00-0000-7000-8000-000000000040';

function node(
  id: string,
  parentId: string | null,
  position: bigint,
  nodeType: 'Theme' | 'Feature' | 'AcceptanceCriterion' | null = null,
  startDate: string | null = null,
  endDate: string | null = null,
) {
  return { id, parentId, title: id, position, nodeType, startDate, endDate };
}

function model(nodes: ReturnType<typeof node>[]): OutlineReadModel {
  return createOutlineReadModel(P, 3, nodes);
}

describe('resolveOutlineExportScope (Story 8.1 Task 2)', () => {
  it('reports collapsed-excluded and zoom-excluded nodes with distinct reasons', () => {
    const m = model([
      node(R, null, 1n, 'Theme'),
      node(T1, R, 2n, 'Theme'),
      node(T2, R, 3n, 'Theme'),
      node(F1, T1, 4n, 'Feature'),
      node(F2, T1, 5n, 'Feature'),
      node(AC, F1, 6n, 'AcceptanceCriterion'),
    ]);

    // Zoom into T1; collapse T1 so F1/F2/AC are collapsed-excluded; T2/R are zoom-excluded.
    const scope = resolveOutlineExportScope(m, T1, new Set([T1]));

    expect(scope.kind).toBe('OutlineVisible');
    expect(scope.zoomRootId).toBe(T1);
    // Only T1 itself is visible (its children are collapsed).
    expect(scope.orderedNodeIds).toEqual([T1]);

    const collapsed = scope.excluded.filter((e) => e.reason === 'collapsed').map((e) => e.nodeId);
    const zoomed = scope.excluded.filter((e) => e.reason === 'zoom-out-of-scope').map((e) => e.nodeId);
    expect(collapsed.sort()).toEqual([F1, F2, AC].sort());
    expect(zoomed.sort()).toEqual([R, T2].sort());
  });

  it('includes the whole project with no exclusions when zoomRootId is null and nothing is collapsed', () => {
    const m = model([
      node(R, null, 1n, 'Theme'),
      node(T1, R, 2n, 'Theme'),
      node(F1, T1, 3n, 'Feature'),
    ]);
    const scope = resolveOutlineExportScope(m, null, new Set());
    expect(scope.orderedNodeIds).toEqual([R, T1, F1]);
    expect(scope.excluded).toEqual([]);
  });

  it('reports collapsed exclusions when zoomRootId is null', () => {
    const m = model([
      node(R, null, 1n, 'Theme'),
      node(T1, R, 2n, 'Theme'),
      node(F1, T1, 3n, 'Feature'),
    ]);
    const scope = resolveOutlineExportScope(m, null, new Set([T1]));
    expect(scope.orderedNodeIds).toEqual([R, T1]);
    expect(scope.excluded).toEqual([{ nodeId: F1, title: F1, reason: 'collapsed' }]);
  });

  it('matches projectVisibleOutline order exactly for mixed dated/undated siblings', () => {
    const m = model([
      node(R, null, 1n, 'Theme'),
      node(T1, R, 2n, 'Theme', '2026-01-01', '2026-01-10'),
      node(T2, R, 3n, 'Theme'),
      node(F1, T1, 4n, 'Feature', '2026-02-01', '2026-02-05'),
      node(F2, T1, 5n, 'Feature'),
      node(F3, T2, 6n, 'Feature'),
    ]);

    const scope = resolveOutlineExportScope(m, null, new Set());
    const expected = projectVisibleOutline(m, new Set()).rows.map((r) => r.nodeId);
    expect(scope.orderedNodeIds).toEqual(expected);
    expect(scope.orderedNodeIds).toEqual([R, T1, F1, F2, T2, F3]);
  });

  it('does not silently drop any node: membership + exclusions cover the full model', () => {
    const m = model([
      node(R, null, 1n, 'Theme'),
      node(T1, R, 2n, 'Theme'),
      node(T2, R, 3n, 'Theme'),
      node(F1, T1, 4n, 'Feature'),
      node(F2, T1, 5n, 'Feature'),
    ]);
    const scope = resolveOutlineExportScope(m, T1, new Set([T1]));
    const covered = new Set([...scope.orderedNodeIds, ...scope.excluded.map((e) => e.nodeId)]);
    expect(covered).toEqual(new Set([R, T1, T2, F1, F2]));
  });
});
