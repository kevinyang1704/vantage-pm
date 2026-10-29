/**
 * Effort frontier & strategic weight rollup policy (Story 3.6, AD-9).
 *
 * Prevents double-counting in tree hierarchies by identifying "frontier" nodes:
 * nodes with explicitly authored effort that have no explicit-effort descendants.
 *
 * Also provides coverage calculation to ensure missing inputs are never silently
 * treated as 0.
 */

export interface EffortTreeNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly effortPoints: number | null;
}

export interface SubtreeEffortSummary {
  readonly authoredEffort: number | null;
  readonly frontierEffort: number;
  readonly frontierNodeIds: readonly string[];
  readonly totalNodes: number;
  readonly nodesWithEffort: number;
  readonly coveragePercentage: number;
}

/** A reusable parent/child index over a node set (Story 25.3 AC 25.3-5). */
export interface EffortIndex {
  readonly nodeMap: ReadonlyMap<string, EffortTreeNode>;
  readonly childrenMap: ReadonlyMap<string | null, readonly string[]>;
}

/**
 * Build the node/children index once so many `computeSubtreeEffort` calls over
 * the same node set do not each rebuild it (Story 25.3 AC 25.3-5).
 */
export function createEffortIndex(allNodes: readonly EffortTreeNode[]): EffortIndex {
  const nodeMap = new Map<string, EffortTreeNode>();
  const childrenMap = new Map<string | null, string[]>();
  for (const n of allNodes) {
    nodeMap.set(n.id, n);
    let list = childrenMap.get(n.parentId);
    if (!list) {
      list = [];
      childrenMap.set(n.parentId, list);
    }
    list.push(n.id);
  }
  return Object.freeze({ nodeMap, childrenMap });
}

/**
 * Computes frontier effort summation for a subtree rooted at rootNodeId.
 */
export function computeSubtreeEffort(
  allNodes: readonly EffortTreeNode[],
  rootNodeId: string,
): SubtreeEffortSummary {
  return computeSubtreeEffortWithIndex(createEffortIndex(allNodes), rootNodeId);
}

/**
 * The index-parameterised form of `computeSubtreeEffort`. Output is identical
 * to building the index internally; only the repeated construction is removed.
 */
export function computeSubtreeEffortWithIndex(
  index: EffortIndex,
  rootNodeId: string,
): SubtreeEffortSummary {
  const { nodeMap, childrenMap } = index;

  const root = nodeMap.get(rootNodeId);
  const authoredEffort = root?.effortPoints ?? null;

  // Collect all subtree nodes
  const subtreeIds: string[] = [];
  function collectSubtree(id: string): void {
    subtreeIds.push(id);
    const children = childrenMap.get(id) ?? [];
    for (const c of children) {
      collectSubtree(c);
    }
  }

  if (root) {
    collectSubtree(rootNodeId);
  }

  const totalNodes = subtreeIds.length;
  let nodesWithEffort = 0;
  for (const id of subtreeIds) {
    const node = nodeMap.get(id);
    if (node && node.effortPoints !== null && node.effortPoints !== undefined) {
      nodesWithEffort++;
    }
  }

  // Find frontier nodes:
  // A node is a frontier node if it has explicit effort, AND no descendant in its subtree has explicit effort.
  // Exception: If a node has explicit effort and has descendants with explicit effort, the descendants' effort takes precedence (leaf-ward precedence).
  const frontierNodeIds: string[] = [];
  let frontierEffort = 0;

  function findFrontier(id: string): void {
    const node = nodeMap.get(id);
    if (!node) return;

    const children = childrenMap.get(id) ?? [];

    // Check if any descendant in this subtree has explicit effort
    let hasDescendantWithEffort = false;
    function checkDescendants(childId: string): void {
      const c = nodeMap.get(childId);
      if (c && c.effortPoints !== null && c.effortPoints !== undefined) {
        hasDescendantWithEffort = true;
        return;
      }
      const grandchildren = childrenMap.get(childId) ?? [];
      for (const g of grandchildren) {
        if (hasDescendantWithEffort) return;
        checkDescendants(g);
      }
    }

    for (const c of children) {
      checkDescendants(c);
      if (hasDescendantWithEffort) break;
    }

    if (node.effortPoints !== null && node.effortPoints !== undefined && !hasDescendantWithEffort) {
      frontierNodeIds.push(node.id);
      frontierEffort += node.effortPoints;
    } else {
      for (const c of children) {
        findFrontier(c);
      }
    }
  }

  if (root) {
    findFrontier(rootNodeId);
  }

  const coveragePercentage = totalNodes === 0 ? 100 : Math.round((nodesWithEffort / totalNodes) * 100);

  return Object.freeze({
    authoredEffort,
    frontierEffort,
    frontierNodeIds: Object.freeze(frontierNodeIds),
    totalNodes,
    nodesWithEffort,
    coveragePercentage,
  });
}
