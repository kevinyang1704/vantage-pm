/**
 * Visual tree projection builder (Story 6.1 Task 4, AD-2, AD-11, AD-12, FR-63..66, NFR-22).
 *
 * Pure functional-core: maps a full project snapshot + focused themeId to a
 * VisualTreeProjection. No I/O, no React, no layout-engine involvement.
 *
 * CRITICAL INVARIANT: VisualTreeNode.siblingIndex/depth are the ONLY
 * authoritative source of visual sibling order for downstream stories.
 * ELK's LayoutResultResponse geometry is disposable and must never be
 * treated as an order signal (AD-11).
 */

import type { Node } from '../../domain/tree/node.entity';
import type { UnlockEdge } from '../../domain/edge/unlock-edge.entity';
import type {
  VisualTreeProjection,
  VisualTreeNode,
  VisualTreeUnlockEdge,
} from '../../contracts/visual-tree';
import { getDescendantNodes } from '../../domain/tree/tree-walk.policy';
import { compareVisualSiblingOrder } from '../../domain/tree/visual-order.policy';
import { attributeNodeToNearestTheme } from '../../domain/analysis/theme-attribution.policy';
import { deriveNodeSchedule } from '../../domain/tree/schedule.policy';

export const VISUAL_TREE_NODE_LIMIT = 300; // NFR-22

export interface VisualTreeProjectionInput {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly themeId: string;
  readonly nodes: readonly Node[]; // full project nodes (outside-endpoint labels need the whole graph)
  readonly unlockEdges: readonly UnlockEdge[]; // full project edges
}

export function projectVisualTree(input: VisualTreeProjectionInput): VisualTreeProjection {
  const themeNode = input.nodes.find((n) => n.id === input.themeId);
  if (!themeNode) {
    throw new Error(`VISUAL_TREE_THEME_NOT_FOUND: ${input.themeId}`);
  }
  if (themeNode.nodeType !== 'Theme') {
    throw new Error(`VISUAL_TREE_THEME_NOT_THEME: ${input.themeId} is ${String(themeNode.nodeType ?? 'untyped')}`);
  }

  // Acceptance criteria live only in the node inspector (Story 16.3) — they
  // are never their own visual cards. themeNode is a Theme so the filter
  // always keeps it; the full input.nodes map is still used below for
  // outside-endpoint edge labels.
  const subtree = [themeNode, ...getDescendantNodes(input.nodes, input.themeId)].filter(
    (n) => n.nodeType !== 'AcceptanceCriterion',
  );
  const subtreeIds = new Set(subtree.map((n) => n.id));

  const childrenByParent = new Map<string, Node[]>();
  for (const n of subtree) {
    if (n.parentId && subtreeIds.has(n.parentId)) {
      const list = childrenByParent.get(n.parentId) ?? [];
      list.push(n);
      childrenByParent.set(n.parentId, list);
    }
  }
  for (const list of childrenByParent.values()) {
    list.sort(compareVisualSiblingOrder);
  }

  const nodeMap = new Map(input.nodes.map((n) => [n.id, n]));

  const visualNodes: VisualTreeNode[] = [];
  const visited = new Set<string>();

  function walk(nodeId: string, depth: number): void {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = nodeMap.get(nodeId)!;
    const siblings = childrenByParent.get(node.parentId ?? '') ?? [];
    const siblingIndex = siblings.findIndex((s) => s.id === nodeId);

    const schedule = deriveNodeSchedule({
      startDate: node.startDate,
      endDate: node.endDate,
      durationDays: node.durationDays,
      sourceMode: node.scheduleSourceMode,
    });

    visualNodes.push(
      Object.freeze({
        nodeId: node.id,
        parentId: node.parentId && subtreeIds.has(node.parentId) ? node.parentId : null,
        title: node.title,
        nodeType: node.nodeType,
        startDate: schedule.startDate,
        endDate: schedule.endDate,
        durationDays: schedule.durationDays,
        scheduleSourceMode: node.scheduleSourceMode,
        completed: node.completed,
        depth,
        siblingIndex: siblingIndex >= 0 ? siblingIndex : 0,
        siblingSetSize: siblings.length,
      }),
    );

    const children = childrenByParent.get(nodeId) ?? [];
    for (const child of children) {
      walk(child.id, depth + 1);
    }
  }

  walk(input.themeId, 0);

  const unlockEdges: VisualTreeUnlockEdge[] = input.unlockEdges
    .filter((e) => subtreeIds.has(e.sourceNodeId) || subtreeIds.has(e.targetNodeId))
    .map((e) => {
      const sourceInSubtree = subtreeIds.has(e.sourceNodeId);
      const targetInSubtree = subtreeIds.has(e.targetNodeId);
      let outsideEndpoint: VisualTreeUnlockEdge['outsideEndpoint'] = null;

      if (sourceInSubtree !== targetInSubtree) {
        const outsideId = sourceInSubtree ? e.targetNodeId : e.sourceNodeId;
        const outsideNode = nodeMap.get(outsideId);
        const themeId = attributeNodeToNearestTheme(input.nodes, outsideId);
        const themeNodeRef = themeId ? nodeMap.get(themeId) : undefined;
        outsideEndpoint = Object.freeze({
          nodeId: outsideId,
          title: outsideNode?.title ?? '',
          themeId,
          themeName: themeNodeRef?.title ?? null,
        });
      }

      return Object.freeze({
        edgeId: e.id,
        sourceNodeId: e.sourceNodeId,
        targetNodeId: e.targetNodeId,
        sourceInSubtree,
        targetInSubtree,
        outsideEndpoint,
      });
    });

  return Object.freeze({
    themeId: input.themeId,
    projectId: input.projectId,
    projectRevision: input.projectRevision,
    nodes: Object.freeze(visualNodes),
    unlockEdges: Object.freeze(unlockEdges),
    nodeCount: visualNodes.length,
    degraded: visualNodes.length > VISUAL_TREE_NODE_LIMIT,
    renderLimit: VISUAL_TREE_NODE_LIMIT,
  });
}