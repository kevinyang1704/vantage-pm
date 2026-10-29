import { describe, expect, it } from 'vitest';
import { createNode, type Node } from '../../domain/tree/node.entity';
import type { ViewScope } from '../../contracts/view-scope';
import { formatExportScopeSentence } from './format-export-scope-sentence';

const P = '019ffe00-0000-7000-8000-000000000001';

function node(id: string, nodeType: Node['nodeType']): Node {
  return createNode({ id, projectId: P, parentId: null, title: id, position: 1n, nodeType });
}

const nodes: readonly Node[] = [
  node('019ffe00-0000-7000-8000-000000000010', 'Theme'),
  node('019ffe00-0000-7000-8000-000000000011', 'Theme'),
  node('019ffe00-0000-7000-8000-000000000020', 'Feature'),
  node('019ffe00-0000-7000-8000-000000000021', 'Feature'),
  node('019ffe00-0000-7000-8000-000000000022', 'Feature'),
];

const themeIds = ['019ffe00-0000-7000-8000-000000000010', '019ffe00-0000-7000-8000-000000000011'];
const featureIds = ['019ffe00-0000-7000-8000-000000000020', '019ffe00-0000-7000-8000-000000000021', '019ffe00-0000-7000-8000-000000000022'];

describe('formatExportScopeSentence (Story 8.1 Task 5)', () => {
  it('formats a Gantt scope with date window and undated exclusion (worked example pattern)', () => {
    const scope: ViewScope = {
      kind: 'GanttVisible',
      projectId: P,
      projectRevision: 1,
      window: { dateWindowStart: '2026-01-01', dateWindowEnd: '2026-12-31', granularity: 'month' },
      orderedNodeIds: [...themeIds, ...featureIds],
      undatedCount: 6,
      outOfWindowCount: 0,
      collapsedCount: 0,
    };
    expect(formatExportScopeSentence(scope, nodes)).toBe('2 themes · 3 features · 1 Jan 2026 – 31 Dec 2026 · 6 undated excluded');
  });

  it('omits the undated-excluded segment when undatedCount is zero', () => {
    const scope: ViewScope = {
      kind: 'GanttVisible',
      projectId: P,
      projectRevision: 1,
      window: { dateWindowStart: '2026-01-01', dateWindowEnd: '2026-12-31', granularity: 'month' },
      orderedNodeIds: [...themeIds, ...featureIds],
      undatedCount: 0,
      outOfWindowCount: 0,
      collapsedCount: 0,
    };
    expect(formatExportScopeSentence(scope, nodes)).toBe('2 themes · 3 features · 1 Jan 2026 – 31 Dec 2026');
  });

  it('omits the date-window segment for an Outline scope and surfaces exclusions', () => {
    const scope: ViewScope = {
      kind: 'OutlineVisible',
      projectId: P,
      projectRevision: 1,
      zoomRootId: null,
      orderedNodeIds: [...themeIds, ...featureIds],
      excluded: [
        { nodeId: '019ffe00-0000-7000-8000-000000000030', title: 'hidden', reason: 'collapsed' },
        { nodeId: '019ffe00-0000-7000-8000-000000000031', title: 'outside', reason: 'zoom-out-of-scope' },
      ],
    };
    expect(formatExportScopeSentence(scope, nodes)).toBe('2 themes · 3 features · 2 excluded');
  });

  it('omits the exclusion segment for an Outline scope with no exclusions', () => {
    const scope: ViewScope = {
      kind: 'OutlineVisible',
      projectId: P,
      projectRevision: 1,
      zoomRootId: null,
      orderedNodeIds: [...themeIds, ...featureIds],
      excluded: [],
    };
    expect(formatExportScopeSentence(scope, nodes)).toBe('2 themes · 3 features');
  });

  it('renders a Visual scope with no exclusion or date segment at all', () => {
    const scope: ViewScope = {
      kind: 'VisualFocus',
      projectId: P,
      projectRevision: 1,
      themeId: themeIds[0],
      orderedNodeIds: [themeIds[0], ...featureIds],
      nodeCount: 4,
      degraded: false,
    };
    expect(formatExportScopeSentence(scope, nodes)).toBe('1 theme · 3 features');
  });

  it('uses singular forms for a single theme and single feature', () => {
    const scope: ViewScope = {
      kind: 'VisualFocus',
      projectId: P,
      projectRevision: 1,
      themeId: themeIds[0],
      orderedNodeIds: [themeIds[0], featureIds[0]],
      nodeCount: 2,
      degraded: false,
    };
    expect(formatExportScopeSentence(scope, nodes)).toBe('1 theme · 1 feature');
  });
});
