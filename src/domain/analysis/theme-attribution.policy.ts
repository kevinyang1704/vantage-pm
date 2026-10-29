/**
 * Theme attribution policy (Story 5.1 Task 3, AD-9).
 *
 * Attributes each node to its nearest Theme ancestor by walking parentId
 * upward. Nodes with no Theme ancestor map to null (project-root orphans).
 */

import type { Node } from '../tree/node.entity';

export function attributeNodesToNearestTheme(
  nodes: readonly Node[],
): ReadonlyMap<string, string | null> {
  const nodeMap = new Map<string, Node>();
  for (const n of nodes) nodeMap.set(n.id, n);

  const result = new Map<string, string | null>();

  for (const n of nodes) {
    let current: Node | undefined = nodeMap.get(n.id);
    let themeId: string | null = null;
    const visited = new Set<string>();

    while (current) {
      if (visited.has(current.id)) break;
      visited.add(current.id);

      if (current.nodeType === 'Theme') {
        themeId = current.id;
        break;
      }
      current = current.parentId ? nodeMap.get(current.parentId) : undefined;
    }

    result.set(n.id, themeId);
  }

  return result;
}

export function attributeNodeToNearestTheme(
  nodes: readonly Node[],
  targetNodeId: string,
): string | null {
  const nodeMap = new Map<string, Node>();
  for (const n of nodes) nodeMap.set(n.id, n);

  let current: Node | undefined = nodeMap.get(targetNodeId);
  const visited = new Set<string>();

  while (current) {
    if (visited.has(current.id)) break;
    visited.add(current.id);

    if (current.nodeType === 'Theme') {
      return current.id;
    }
    current = current.parentId ? nodeMap.get(current.parentId) : undefined;
  }

  return null;
}
