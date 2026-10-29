/**
 * Orphaned Feature Policy (Story 4.2, FR-32).
 *
 * Identifies feature-level work without containment under a Theme
 * and without any unlock relationships (inbound or outbound).
 */

import type { Node } from '../tree/node.entity';
import type { UnlockEdge } from '../edge/unlock-edge.entity';
import type { OrphanedFeatureFinding } from '../../contracts/analysis-protocol';

export function detectOrphanedFeatures(
  nodes: readonly Node[],
  edges: readonly UnlockEdge[],
): readonly OrphanedFeatureFinding[] {
  const nodeMap = new Map<string, Node>();
  for (const n of nodes) {
    nodeMap.set(n.id, n);
  }

  // Set of node IDs participating in any unlock edge
  const unlockParticipantIds = new Set<string>();
  for (const e of edges) {
    unlockParticipantIds.add(e.sourceNodeId);
    unlockParticipantIds.add(e.targetNodeId);
  }

  // Helper to check if node has a Theme ancestor
  function hasThemeAncestor(startNode: Node): boolean {
    let curr: Node | undefined = startNode;
    while (curr && curr.parentId) {
      curr = nodeMap.get(curr.parentId);
      if (curr && curr.nodeType === 'Theme') {
        return true;
      }
    }
    return false;
  }

  const findings: OrphanedFeatureFinding[] = [];

  for (const node of nodes) {
    if (node.nodeType === 'Feature') {
      const isUnderTheme = hasThemeAncestor(node);
      const hasUnlock = unlockParticipantIds.has(node.id);

      if (!isUnderTheme && !hasUnlock) {
        const fingerprint = computeOrphanFingerprint(node.id, node.parentId, isUnderTheme, hasUnlock);
        findings.push(
          Object.freeze({
            id: `orphan-${node.id}`,
            kind: 'OrphanedFeature',
            projectId: node.projectId,
            targetNodeId: node.id,
            title: node.title || '(Untitled Feature)',
            narrative: `Feature "${node.title || 'Untitled'}" is not nested under any Theme and has no unlock connections.`,
            actionableEditPrompt: 'Nest under a Theme or link an unlock dependency.',
            missingContainment: !isUnderTheme,
            missingUnlockEdges: !hasUnlock,
            fingerprint,
          }),
        );
      }
    }
  }

  return Object.freeze(findings);
}

export function computeOrphanFingerprint(
  nodeId: string,
  parentId: string | null,
  hasTheme: boolean,
  hasUnlock: boolean,
): string {
  return `orphan:${nodeId}:${parentId ?? 'null'}:${hasTheme}:${hasUnlock}`;
}
