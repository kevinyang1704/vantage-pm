/**
 * MoveNode policy (Story 2.4 Task 2, AD-1, AD-7, AD-10, AD-11).
 *
 * Pure gesture resolution, move constraints, and acyclicity checks.
 */

import type { Node, NodeType } from './node.entity';
import { canParentNodeType } from './node-hierarchy.policy';
import {
  positionBetween,
  positionForAppend,
} from './sibling-position.policy';

export type StructuralNode = Readonly<{
  id: string;
  parentId: string | null;
  position: bigint;
  projectId?: string;
  nodeType?: NodeType | null;
}>;

export type StructuralGesture = 'Indent' | 'Outdent' | 'MoveUp' | 'MoveDown';

export type MoveConstraint =
  | 'NoPrecedingSiblingToNestUnder' // Tab on a first child / first root
  | 'AlreadyAtTopLevel' // Shift+Tab on a parentId === null node
  | 'AlreadyFirstAmongSiblings' // Alt+Shift+Up at position 0
  | 'AlreadyLastAmongSiblings' // Alt+Shift+Down at the last position
  | 'HierarchyConflict'; // Nesting under an invalid node type

export type MoveResolution =
  | Readonly<{ kind: 'Move'; newParentId: string | null; newPosition: bigint }>
  | Readonly<{
      kind: 'RebalanceRequired';
      newParentId: string | null;
      placeAfterSiblingId: string | null;
    }>
  | Readonly<{ kind: 'Constrained'; constraint: MoveConstraint }>;

export function isMoveAcyclic(
  nodes: readonly StructuralNode[],
  nodeId: string,
  newParentId: string | null,
): boolean {
  if (newParentId === null) return true;
  if (newParentId === nodeId) return false;

  let currentId: string | null = newParentId;
  let iterations = 0;
  const maxIterations = nodes.length;

  while (currentId !== null && iterations <= maxIterations) {
    if (currentId === nodeId) return false;
    const parentNode: StructuralNode | undefined = nodes.find((n) => n.id === currentId);
    if (!parentNode) return true;
    currentId = parentNode.parentId;
    iterations++;
  }

  return iterations <= maxIterations;
}

export function isMoveWithinProject(
  nodes: readonly StructuralNode[],
  nodeId: string,
  newParentId: string | null,
): boolean {
  if (newParentId === null) return true;
  const targetNode = nodes.find((n) => n.id === nodeId);
  const parentNode = nodes.find((n) => n.id === newParentId);
  if (!targetNode || !parentNode) return false;
  if (targetNode.projectId && parentNode.projectId) {
    return targetNode.projectId === parentNode.projectId;
  }
  return true;
}

function getOrderedSiblings(nodes: readonly StructuralNode[], parentId: string | null): readonly StructuralNode[] {
  return nodes
    .filter((n) => n.parentId === parentId)
    .slice()
    .sort((a, b) => {
      if (a.position < b.position) return -1;
      if (a.position > b.position) return 1;
      return a.id.localeCompare(b.id);
    });
}

export function resolveStructuralMove(
  nodes: readonly StructuralNode[],
  nodeId: string,
  gesture: StructuralGesture,
): MoveResolution {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) {
    return Object.freeze({
      kind: 'Constrained',
      constraint: 'NoPrecedingSiblingToNestUnder',
    });
  }

  const siblings = getOrderedSiblings(nodes, node.parentId);
  const index = siblings.findIndex((s) => s.id === nodeId);
  if (index === -1) {
    return Object.freeze({
      kind: 'Constrained',
      constraint: 'NoPrecedingSiblingToNestUnder',
    });
  }

  switch (gesture) {
    case 'Indent': {
      if (index === 0) {
        return Object.freeze({
          kind: 'Constrained',
          constraint: 'NoPrecedingSiblingToNestUnder',
        });
      }
      const prevSibling = siblings[index - 1];
      const targetParentId = prevSibling.id;

      if (!isMoveAcyclic(nodes, nodeId, targetParentId)) {
        return Object.freeze({
          kind: 'Constrained',
          constraint: 'NoPrecedingSiblingToNestUnder',
        });
      }

      if (!canParentNodeType(prevSibling.nodeType ?? null, node.nodeType ?? null)) {
        return Object.freeze({
          kind: 'Constrained',
          constraint: 'HierarchyConflict',
        });
      }

      const targetChildren = getOrderedSiblings(nodes, targetParentId);
      const lastChildPos =
        targetChildren.length > 0
          ? targetChildren[targetChildren.length - 1].position
          : null;
      const newPos = positionForAppend(lastChildPos);

      return Object.freeze({
        kind: 'Move',
        newParentId: targetParentId,
        newPosition: newPos,
      });
    }

    case 'Outdent': {
      if (node.parentId === null) {
        return Object.freeze({
          kind: 'Constrained',
          constraint: 'AlreadyAtTopLevel',
        });
      }
      const parentNode = nodes.find((n) => n.id === node.parentId);
      if (!parentNode) {
        return Object.freeze({
          kind: 'Constrained',
          constraint: 'AlreadyAtTopLevel',
        });
      }

      const newParentId = parentNode.parentId;
      if (newParentId !== null) {
        const grandParent = nodes.find((n) => n.id === newParentId);
        if (grandParent && !canParentNodeType(grandParent.nodeType ?? null, node.nodeType ?? null)) {
          return Object.freeze({
            kind: 'Constrained',
            constraint: 'HierarchyConflict',
          });
        }
      }
      const destinationSiblings = getOrderedSiblings(nodes, newParentId);
      const parentIndex = destinationSiblings.findIndex(
        (s) => s.id === parentNode.id,
      );
      const nextSiblingOfParent =
        parentIndex !== -1 ? destinationSiblings[parentIndex + 1] : undefined;

      const posResult = positionBetween(
        parentNode.position,
        nextSiblingOfParent?.position ?? null,
      );

      if (posResult.kind === 'Position') {
        return Object.freeze({
          kind: 'Move',
          newParentId,
          newPosition: posResult.position,
        });
      }

      return Object.freeze({
        kind: 'RebalanceRequired',
        newParentId,
        placeAfterSiblingId: parentNode.id,
      });
    }

    case 'MoveUp': {
      if (index === 0) {
        return Object.freeze({
          kind: 'Constrained',
          constraint: 'AlreadyFirstAmongSiblings',
        });
      }
      const prevSibling = siblings[index - 1];
      const prevPrevSibling = index >= 2 ? siblings[index - 2] : undefined;

      const posResult = positionBetween(
        prevPrevSibling?.position ?? null,
        prevSibling.position,
      );

      if (posResult.kind === 'Position') {
        return Object.freeze({
          kind: 'Move',
          newParentId: node.parentId,
          newPosition: posResult.position,
        });
      }

      return Object.freeze({
        kind: 'RebalanceRequired',
        newParentId: node.parentId,
        placeAfterSiblingId: prevPrevSibling?.id ?? null,
      });
    }

    case 'MoveDown': {
      if (index === siblings.length - 1) {
        return Object.freeze({
          kind: 'Constrained',
          constraint: 'AlreadyLastAmongSiblings',
        });
      }
      const nextSibling = siblings[index + 1];
      const nextNextSibling =
        index + 2 < siblings.length ? siblings[index + 2] : undefined;

      const posResult = positionBetween(
        nextSibling.position,
        nextNextSibling?.position ?? null,
      );

      if (posResult.kind === 'Position') {
        return Object.freeze({
          kind: 'Move',
          newParentId: node.parentId,
          newPosition: posResult.position,
        });
      }

      return Object.freeze({
        kind: 'RebalanceRequired',
        newParentId: node.parentId,
        placeAfterSiblingId: nextSibling.id,
      });
    }
  }
}
