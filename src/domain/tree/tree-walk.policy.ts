/**
 * Tree-walk helpers (Story 6.1 Task 2, AD-7).
 *
 * Tree-generic containment walks extracted from analysis-specific modules so
 * every consumer shares one implementation.
 */

import type { Node } from './node.entity';

/** A reusable parent → children index over a node set (Story 25.3 AC 25.3-5). */
export interface ChildrenIndex<N> {
  readonly childrenMap: ReadonlyMap<string, readonly N[]>;
}

/**
 * Build the parent → children index once so many descendant walks over the same
 * node set do not each rebuild it (Story 25.3 AC 25.3-5).
 */
export function createChildrenIndex<N extends { readonly id: string; readonly parentId: string | null }>(
  nodes: readonly N[],
): ChildrenIndex<N> {
  const childrenMap = new Map<string, N[]>();
  for (const n of nodes) {
    if (n.parentId) {
      if (!childrenMap.has(n.parentId)) childrenMap.set(n.parentId, []);
      childrenMap.get(n.parentId)!.push(n);
    }
  }
  return Object.freeze({ childrenMap });
}

/**
 * Depth-first containment walk from a root by parentId, restricted to a
 * cycle-safe visited set. Returns nodes in pre-order (root's children first,
 * recursively).
 */
export function getDescendantNodes(nodes: readonly Node[], rootId: string): readonly Node[] {
  return getDescendantNodesWithIndex(createChildrenIndex(nodes), rootId);
}

/**
 * The index-parameterised form of `getDescendantNodes`. Output is identical to
 * building the index internally; only the repeated construction is removed.
 */
export function getDescendantNodesWithIndex<N extends { readonly id: string }>(
  index: ChildrenIndex<N>,
  rootId: string,
): readonly N[] {
  const { childrenMap } = index;

  const result: N[] = [];
  const visited = new Set<string>();
  function traverse(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const children = childrenMap.get(id) ?? [];
    for (const c of children) {
      result.push(c);
      traverse(c.id);
    }
  }
  traverse(rootId);
  return result;
}

/**
 * Resolve the zoom-subtree membership for a given zoom root (Story 8.1 Task 2).
 *
 * Returns the scoped nodes (the zoom root plus all its descendants, in the
 * input node order) and the set of node ids excluded because they fall outside
 * the zoom root's subtree. Cycle-safe.
 */
export function resolveZoomSubtree<N extends { readonly id: string; readonly parentId: string | null }>(
  nodes: readonly N[],
  zoomRootId: string | null,
): { readonly scopedNodes: readonly N[]; readonly excludedNodeIds: ReadonlySet<string> } {
  if (zoomRootId === null) {
    return { scopedNodes: nodes, excludedNodeIds: new Set() };
  }

  // Build the subtree membership via a cycle-safe BFS/DFS over parentId.
  const subtreeIds = new Set<string>([zoomRootId]);
  let added = true;
  while (added) {
    added = false;
    for (const node of nodes) {
      if (node.parentId && subtreeIds.has(node.parentId) && !subtreeIds.has(node.id)) {
        subtreeIds.add(node.id);
        added = true;
      }
    }
  }

  const scopedNodes: N[] = [];
  const excludedNodeIds = new Set<string>();
  for (const n of nodes) {
    if (subtreeIds.has(n.id)) scopedNodes.push(n);
    else excludedNodeIds.add(n.id);
  }

  return { scopedNodes, excludedNodeIds };
}