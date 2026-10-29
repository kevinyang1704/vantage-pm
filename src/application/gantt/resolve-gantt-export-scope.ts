/**
 * Gantt export scope resolver (Story 8.1 Task 4, AD-12).
 *
 * Thin, order-preserving wrapper: calls `resolveGanttVisibleScope` verbatim and
 * maps its `visibleRows` to ordered node IDs, passing `undatedCount`/
 * `outOfWindowCount`/`collapsedCount`/`window` straight through unchanged.
 * Zero new membership logic — the collapsed-set + inclusive-window filter lives
 * in `resolveGanttVisibleScope` (Story 7.2/7.3).
 */

import { resolveGanttVisibleScope, type ResolveGanttScopeInput } from './gantt-scope';
import type { GanttVisibleScope } from '../../contracts/view-scope';

export function resolveGanttExportScope(input: ResolveGanttScopeInput): GanttVisibleScope {
  const result = resolveGanttVisibleScope(input);
  return Object.freeze({
    kind: 'GanttVisible',
    projectId: input.projection.projectId,
    projectRevision: input.projection.projectRevision,
    window: result.window,
    orderedNodeIds: Object.freeze(result.visibleRows.map((r) => r.nodeId)),
    undatedCount: result.undatedCount,
    outOfWindowCount: result.outOfWindowCount,
    collapsedCount: result.collapsedCount,
  });
}
