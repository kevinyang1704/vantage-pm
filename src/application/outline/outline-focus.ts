/**
 * Outline focus resolution (Story 2.2 Task 3).
 *
 * Pure focus target resolver: determines which ancestors must be expanded
 * so the target node becomes part of the visible projection.
 */

import type { OutlineReadModel } from './outline-read-model';

export type FocusResolutionResult =
  | Readonly<{ kind: 'NotInProject' }>
  | Readonly<{
      kind: 'Resolved';
      collapsedAfterExpand: ReadonlySet<string>;
      ancestorsExpanded: readonly string[];
    }>;

export function resolveFocusTarget(
  model: OutlineReadModel,
  collapsedNodeIds: ReadonlySet<string>,
  targetNodeId: string,
): FocusResolutionResult {
  const nodeMap = new Map<string, string | null>(); // id -> parentId
  for (const node of model.nodes) {
    nodeMap.set(node.id, node.parentId);
  }

  if (!nodeMap.has(targetNodeId)) {
    return Object.freeze({ kind: 'NotInProject' });
  }

  const ancestorsExpanded: string[] = [];
  const nextCollapsed = new Set<string>(collapsedNodeIds);

  let currentParent = nodeMap.get(targetNodeId);
  const visited = new Set<string>();

  while (currentParent !== null && currentParent !== undefined) {
    if (visited.has(currentParent)) {
      break; // prevent cycle
    }
    visited.add(currentParent);

    if (nextCollapsed.has(currentParent)) {
      nextCollapsed.delete(currentParent);
      ancestorsExpanded.push(currentParent);
    }
    currentParent = nodeMap.get(currentParent);
  }

  return Object.freeze({
    kind: 'Resolved',
    collapsedAfterExpand: Object.freeze(nextCollapsed),
    ancestorsExpanded: Object.freeze(ancestorsExpanded),
  });
}
