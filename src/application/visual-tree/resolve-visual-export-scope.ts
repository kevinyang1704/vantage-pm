/**
 * Visual export scope resolver (Story 8.1 Task 3, AD-12).
 *
 * Thin, order-preserving wrapper: calls `projectVisualTree` verbatim and maps
 * its pre-order `nodes` to ordered node IDs, echoing `nodeCount`/`degraded`
 * straight through. Zero new membership logic — the exact-subtree walk lives in
 * `projectVisualTree` (Story 6.1). No exclusion list: AD-12's `VisualFocus`
 * variant excludes outside endpoints (edges), not nodes.
 */

import { projectVisualTree, type VisualTreeProjectionInput } from './visual-tree.projection';
import type { VisualFocusScope } from '../../contracts/view-scope';

export function resolveVisualExportScope(input: VisualTreeProjectionInput): VisualFocusScope {
  const projection = projectVisualTree(input);
  return Object.freeze({
    kind: 'VisualFocus',
    projectId: projection.projectId,
    projectRevision: projection.projectRevision,
    themeId: projection.themeId,
    orderedNodeIds: Object.freeze(projection.nodes.map((n) => n.nodeId)),
    nodeCount: projection.nodeCount,
    degraded: projection.degraded,
  });
}
