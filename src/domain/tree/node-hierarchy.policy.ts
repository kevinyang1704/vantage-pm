/**
 * Node hierarchy policy (Story 2.4, AD-16).
 *
 * Defines the fixed rank hierarchy:
 *   Vision (0) -> Theme (1) -> Component (2) -> Feature (3) -> Acceptance Criterion (4)
 *
 * Invariant: for every typed parent/child edge:
 *   rank(parent) <= rank(child)
 *
 * Equal ranks are valid (Vision -> Vision, Theme -> Theme, etc.).
 * Untyped (null) nodes are permanently permissive at either end.
 */

import type { NodeType } from './node.entity';
import { formatNodeTypeLabel } from './node-type.policy';

export const HIERARCHY_RANKS: Readonly<Record<NodeType, number>> = Object.freeze({
  Vision: 0,
  Theme: 1,
  Component: 2,
  Feature: 3,
  AcceptanceCriterion: 4,
});

export function nodeTypeRank(type: NodeType): number {
  return HIERARCHY_RANKS[type];
}

/**
 * Checks if parentType can validly contain childType.
 * Untyped (null) on either side is permissive and returns true.
 */
export function canParentNodeType(
  parentType: NodeType | null,
  childType: NodeType | null,
): boolean {
  if (parentType === null || childType === null) {
    return true;
  }
  return nodeTypeRank(parentType) <= nodeTypeRank(childType);
}

/**
 * Formats a plain-language explanation for why a typed parent/child edge is invalid.
 */
export function formatHierarchyInversionReason(
  parentType: NodeType,
  childType: NodeType,
): string {
  return `A ${formatNodeTypeLabel(parentType)} cannot contain a ${formatNodeTypeLabel(childType)}.`;
}

export type HierarchyValidationResult = Readonly<{
  valid: boolean;
  reason?: string;
}>;

/**
 * Validates a proposed node type against its immediate typed parent and all direct typed children.
 */
export function validateTypedNeighborhood(params: {
  parentType: NodeType | null;
  proposedType: NodeType | null;
  childTypes: readonly (NodeType | null)[];
}): HierarchyValidationResult {
  const { parentType, proposedType, childTypes } = params;

  if (proposedType === null) {
    return Object.freeze({ valid: true });
  }

  if (parentType !== null && !canParentNodeType(parentType, proposedType)) {
    return Object.freeze({
      valid: false,
      reason: formatHierarchyInversionReason(parentType, proposedType),
    });
  }

  for (const childType of childTypes) {
    if (childType !== null && !canParentNodeType(proposedType, childType)) {
      return Object.freeze({
        valid: false,
        reason: formatHierarchyInversionReason(proposedType, childType),
      });
    }
  }

  return Object.freeze({ valid: true });
}
