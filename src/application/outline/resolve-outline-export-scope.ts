/**
 * Outline export scope resolver (Story 8.1 Task 2, AD-12).
 *
 * Thin derived wrapper: reuses `resolveZoomSubtree` (zoom filter) and
 * `projectVisibleOutline` (collapse-respecting walk) verbatim, re-expressing
 * their membership as ordered node IDs plus exclusion reasons. It does NOT
 * re-walk the tree a second, competing way.
 *
 * Membership order matches `projectVisibleOutline`'s `VisibleOutlineRow[]`
 * order exactly. Exclusions are derived by set-difference against the scoped
 * node set, never by a second traversal that could disagree with the walk.
 */

import type { OutlineReadModel } from './outline-read-model';
import { projectVisibleOutline } from './outline-visible.projection';
import { resolveZoomSubtree } from '../../domain/tree/tree-walk.policy';
import type { OutlineVisibleScope, ScopeExclusion } from '../../contracts/view-scope';

export function resolveOutlineExportScope(
  model: OutlineReadModel,
  zoomRootId: string | null,
  collapsedNodeIds: ReadonlySet<string>,
): OutlineVisibleScope {
  const { scopedNodes, excludedNodeIds: zoomExcluded } = resolveZoomSubtree(model.nodes, zoomRootId);

  const scopedModel: OutlineReadModel = { ...model, nodes: scopedNodes };
  const visible = projectVisibleOutline(scopedModel, collapsedNodeIds);

  const orderedNodeIds = visible.rows.map((r) => r.nodeId);
  const visibleIds = new Set(orderedNodeIds);

  const excluded: ScopeExclusion[] = [];

  // Collapsed-exclusion: every scoped node NOT present in visible.rows and NOT
  // already zoom-excluded (i.e. a descendant of a collapsed node within the
  // zoom subtree). `projectVisibleOutline`'s own walk already stops descending
  // into a collapsed node, so this is a set-difference, not a new walk.
  for (const node of scopedNodes) {
    if (visibleIds.has(node.id)) continue;
    if (zoomExcluded.has(node.id)) continue;
    excluded.push({ nodeId: node.id, title: node.title, reason: 'collapsed' });
  }

  // Zoom-exclusion: every node outside the zoom root's subtree.
  for (const node of model.nodes) {
    if (zoomExcluded.has(node.id)) {
      excluded.push({ nodeId: node.id, title: node.title, reason: 'zoom-out-of-scope' });
    }
  }

  return Object.freeze({
    kind: 'OutlineVisible',
    projectId: model.projectId,
    projectRevision: model.projectRevision,
    zoomRootId,
    orderedNodeIds: Object.freeze(orderedNodeIds),
    excluded: Object.freeze(excluded),
  });
}
