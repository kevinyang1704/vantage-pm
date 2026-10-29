/**
 * Affected Work Reachability Policy (Story 4.8, FR-39, FR-40, FR-41).
 *
 * Traverses outbound directional unlock edges from a modified causal node
 * to compute all downstream affected consequences without automatic rescheduling.
 */

import type { Node } from '../tree/node.entity';
import type { UnlockEdge } from '../edge/unlock-edge.entity';
import type { AffectedReason } from '../../contracts/analysis-protocol';

export function calculateDownstreamAffectedWork(params: {
  nodes: readonly Node[];
  edges: readonly UnlockEdge[];
  causalNodeId: string;
  priorStartDate: string | null;
  newStartDate: string | null;
  deltaDays: number;
  createdAt: string;
}): readonly AffectedReason[] {
  const { nodes, edges, causalNodeId, priorStartDate, newStartDate, deltaDays, createdAt } = params;

  const nodeMap = new Map<string, Node>();
  for (const n of nodes) nodeMap.set(n.id, n);

  const causalNode = nodeMap.get(causalNodeId);
  const causalTitle = causalNode?.title || '(Untitled Node)';

  // Build outbound adjacency list
  const outboundMap = new Map<string, string[]>();
  for (const edge of edges) {
    if (!outboundMap.has(edge.sourceNodeId)) {
      outboundMap.set(edge.sourceNodeId, []);
    }
    outboundMap.get(edge.sourceNodeId)!.push(edge.targetNodeId);
  }

  // Transitive BFS traversal
  const visited = new Set<string>();
  const queue: string[] = [...(outboundMap.get(causalNodeId) ?? [])];
  const affectedNodeIds: string[] = [];

  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (visited.has(curr)) continue;
    visited.add(curr);
    affectedNodeIds.push(curr);

    const nextHop = outboundMap.get(curr) ?? [];
    for (const nextId of nextHop) {
      if (!visited.has(nextId)) {
        queue.push(nextId);
      }
    }
  }

  const sign = deltaDays >= 0 ? `+${deltaDays}` : `${deltaDays}`;
  const dateSummary = priorStartDate && newStartDate
    ? `Shifted by ${sign} days (${priorStartDate} → ${newStartDate})`
    : `Schedule updated (${sign} days)`;

  const reasons: AffectedReason[] = [];

  for (const affId of affectedNodeIds) {
    reasons.push(
      Object.freeze({
        id: `aff-${affId}-${causalNodeId}-${createdAt}`,
        projectId: causalNode?.projectId ?? '',
        affectedNodeId: affId,
        causalNodeId,
        causalNodeTitle: causalTitle,
        deltaDays,
        causalDateSummary: dateSummary,
        createdAt,
        acknowledgedAt: null,
      }),
    );
  }

  return Object.freeze(reasons);
}
