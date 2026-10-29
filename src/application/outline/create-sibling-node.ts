/**
 * Create-sibling node shaping (Story 6.3 Task 1).
 *
 * Shared, view-agnostic sibling-insertion math — extracted from OutlineView's
 * createSibling so Outline and Visual can never drift on position calculation.
 * Pure: no React, no I/O.
 */

import { positionBetween, positionForAppend } from '../../domain/tree/sibling-position.policy';
import type { NodeType } from '../../domain/tree/node.entity';

export interface SiblingNodeInput {
  readonly id: string;
  readonly parentId: string | null;
  readonly position: bigint;
}

export interface CreateSiblingResult {
  readonly nodeId: string;
  readonly parentId: string | null;
  readonly position: bigint;
  readonly title: string;
  /**
   * Enter on a Feature makes a Feature, so it reaches the Forecast at Feature
   * level; likewise for acceptance criteria. Container types (Vision, Theme,
   * Component) are not copied: Enter then Tab is how children are added under
   * them. A default only: the type stays optional and editable inline.
   */
  readonly nodeType: NodeType | null;
}

/**
 * Compute the parentId + gap position for a new sibling of referenceNodeId.
 * `nodes` are the current siblings/structural nodes (OutlineNodeReadModel-like:
 * id, parentId, position). Returns the params for onCreateNode.
 */
const INHERITED_SIBLING_TYPES: ReadonlySet<NodeType> = new Set<NodeType>(['Feature', 'AcceptanceCriterion']);

export function computeSiblingInsertion(params: {
  nodes: readonly { id: string; parentId: string | null; position: bigint; nodeType?: NodeType | null }[];
  referenceNodeId: string | null;
  newId: string;
}): CreateSiblingResult {
  const { nodes, referenceNodeId, newId } = params;

  let parentId: string | null = null;
  let newPosition = positionForAppend(null);
  let nodeType: NodeType | null = null;

  if (referenceNodeId) {
    const currentNode = nodes.find((n) => n.id === referenceNodeId);
    if (currentNode) {
      parentId = currentNode.parentId;
      nodeType = currentNode.nodeType && INHERITED_SIBLING_TYPES.has(currentNode.nodeType) ? currentNode.nodeType : null;
      const siblings = nodes
        .filter((n) => n.parentId === parentId)
        .slice()
        .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));

      const currentIndex = siblings.findIndex((s) => s.id === referenceNodeId);
      const nextSibling = currentIndex !== -1 ? siblings[currentIndex + 1] : undefined;

      const posRes = positionBetween(currentNode.position, nextSibling?.position ?? null);
      newPosition = posRes.kind === 'Position' ? posRes.position : positionForAppend(currentNode.position);
    }
  }

  return Object.freeze({
    nodeId: newId,
    parentId,
    position: newPosition,
    title: '',
    nodeType,
  });
}