/**
 * Visual tree accessible narration (Story 6.8 Task 1).
 *
 * Produces a revision-matched, deterministic prose text alternative for
 * assistive technology describing the focused theme tree, unlock relationships,
 * and structural findings.
 * Pure: no React, no DOM, no I/O.
 */

import type { VisualTreeProjection, VisualTreeNode } from '../../contracts/visual-tree';
import type { VisualFindingsProjection } from '../visual/visual-findings.projection';

export function narrateVisualTree(
  projection: VisualTreeProjection,
  themeName?: string,
  findings?: VisualFindingsProjection,
): string {
  const lines: string[] = [];

  const name = themeName ?? 'Theme';
  const maxDepth = projection.nodes.reduce(
    (max, n) => Math.max(max, n.depth),
    0,
  );

  lines.push(`Visual tree for ${name}, revision ${projection.projectRevision}.`);
  lines.push(`Contains ${projection.nodeCount} nodes across depth ${maxDepth + 1}.`);

  if (projection.degraded) {
    lines.push(
      `Display budget exceeded: showing first ${projection.renderLimit} nodes.`,
    );
  }

  const nodeMap = new Map(projection.nodes.map((n) => [n.nodeId, n]));
  const childrenByParent = new Map<string, VisualTreeNode[]>();
  for (const n of projection.nodes) {
    if (n.parentId !== null) {
      const list = childrenByParent.get(n.parentId) ?? [];
      list.push(n);
      childrenByParent.set(n.parentId, list);
    }
  }

  for (const node of projection.nodes) {
    const indent = '  '.repeat(node.depth);
    const tag = node.nodeType ? ` [${node.nodeType}]` : '';
    const status = node.completed ? ' (completed)' : '';
    const dateStr =
      node.startDate && node.endDate
        ? ` (${node.startDate} to ${node.endDate})`
        : node.startDate
          ? ` (starts ${node.startDate})`
          : '';
    lines.push(`${indent}• ${node.title}${tag}${status}${dateStr}`);

    // Story 6.6 AC1: orphan cards state, in their own narration segment, that
    // they carry no containment line and no unlock connection — reusing the
    // finding's own narrative rather than composing new phrasing.
    const orphanFinding = findings?.orphanFindingsByNodeId.get(node.nodeId);
    if (orphanFinding) {
      lines.push(`${indent}  ${orphanFinding.narrative}`);
    }

    // Story 6.6 AC3: state the same start-date ordering premise the visible
    // "by start date →" row header carries, for the same 2+ dated-children rows.
    const children = childrenByParent.get(node.nodeId) ?? [];
    const datedChildren = children.filter((c) => c.startDate !== null);
    if (datedChildren.length >= 2) {
      const childIndent = '  '.repeat(node.depth + 1);
      const names = datedChildren.map((c) => c.title).join(', ');
      lines.push(`${childIndent}The children, left to right in start-date order, are: ${names}.`);
    }
  }

  if (projection.unlockEdges.length > 0) {
    lines.push(`Unlock dependencies: ${projection.unlockEdges.length} total.`);
    for (const edge of projection.unlockEdges) {
      if (edge.outsideEndpoint) {
        lines.push(
          `  • Unlocks cross-branch destination: ${edge.outsideEndpoint.title} in theme ${edge.outsideEndpoint.themeName ?? 'unknown'}.`,
        );
      } else {
        const src = nodeMap.get(edge.sourceNodeId);
        const tgt = nodeMap.get(edge.targetNodeId);
        const violation = findings?.violationFindingsByEdgeId.get(edge.edgeId);
        if (violation) {
          lines.push(
            `  • Sequencing violation: ${src?.title || edge.sourceNodeId} unlocks ${tgt?.title || edge.targetNodeId}. ${violation.narrative}`,
          );
        } else {
          lines.push(
            `  • ${src?.title || edge.sourceNodeId} unlocks ${tgt?.title || edge.targetNodeId}.`,
          );
        }
      }
    }
  }

  return lines.join('\n');
}
