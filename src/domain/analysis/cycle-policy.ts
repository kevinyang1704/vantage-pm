/**
 * Unlock Cycle Detection Policy (Story 4.4, FR-35).
 *
 * Detects directed cycles in the unlock graph, normalizes them canonically
 * by starting at the minimum node UUID, and formats a loop-closing narrative.
 */

import type { Node } from '../tree/node.entity';
import type { UnlockEdge } from '../edge/unlock-edge.entity';
import type { UnlockCycleFinding } from '../../contracts/analysis-protocol';

export function detectUnlockCycles(
  nodes: readonly Node[],
  edges: readonly UnlockEdge[],
): readonly UnlockCycleFinding[] {
  const nodeMap = new Map<string, Node>();
  for (const n of nodes) nodeMap.set(n.id, n);

  // Adjacency list: sourceId -> array of { targetId, edgeId }
  const adj = new Map<string, { targetId: string; edgeId: string }[]>();
  for (const edge of edges) {
    if (!adj.has(edge.sourceNodeId)) {
      adj.set(edge.sourceNodeId, []);
    }
    adj.get(edge.sourceNodeId)!.push({ targetId: edge.targetNodeId, edgeId: edge.id });
  }

  const rawCycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];

  function dfs(curr: string) {
    visited.add(curr);
    inStack.add(curr);
    stack.push(curr);

    const neighbors = adj.get(curr) ?? [];
    for (const neighbor of neighbors) {
      const nextId = neighbor.targetId;
      if (!visited.has(nextId)) {
        dfs(nextId);
      } else if (inStack.has(nextId)) {
        // Cycle detected: extract subpath from nextId to current
        const cycleStartIndex = stack.indexOf(nextId);
        if (cycleStartIndex !== -1) {
          const cyclePath = stack.slice(cycleStartIndex);
          rawCycles.push(cyclePath);
        }
      }
    }

    stack.pop();
    inStack.delete(curr);
  }

  for (const n of nodes) {
    if (!visited.has(n.id)) {
      dfs(n.id);
    }
  }

  // Canonicalize cycles:
  // 1. Rotate each cycle so the lexicographically smallest node ID is first
  // 2. Deduplicate cycles by serialized key
  const seenCanonicalCycles = new Set<string>();
  const findings: UnlockCycleFinding[] = [];

  for (const cycle of rawCycles) {
    if (cycle.length < 2) continue;

    // Find min element index
    let minIdx = 0;
    for (let i = 1; i < cycle.length; i++) {
      if (cycle[i].localeCompare(cycle[minIdx]) < 0) {
        minIdx = i;
      }
    }

    // Rotate
    const normalized: string[] = [
      ...cycle.slice(minIdx),
      ...cycle.slice(0, minIdx),
    ];

    const cycleKey = normalized.join('->');
    if (seenCanonicalCycles.has(cycleKey)) continue;
    seenCanonicalCycles.add(cycleKey);

    // Close the loop
    const closedPathIds = [...normalized, normalized[0]];
    const pathTitles = closedPathIds.map((id) => nodeMap.get(id)?.title || '(Untitled)');

    // Collect participating edge IDs
    const edgeIds: string[] = [];
    for (let i = 0; i < normalized.length; i++) {
      const u = normalized[i];
      const v = normalized[(i + 1) % normalized.length];
      const edge = edges.find((e) => e.sourceNodeId === u && e.targetNodeId === v);
      if (edge) edgeIds.push(edge.id);
    }

    const narrative = `Circular unlock dependency: ${pathTitles.map((t) => `"${t}"`).join(' unlocks ')}`;
    const fingerprint = `cycle:${cycleKey}:${edgeIds.sort().join(',')}`;

    findings.push(
      Object.freeze({
        id: `cycle-${normalized[0]}-${normalized.length}`,
        kind: 'UnlockCycle',
        projectId: nodes[0]?.projectId ?? '',
        targetNodeId: normalized[0],
        title: `Circular unlock cycle (${normalized.length} nodes)`,
        narrative,
        actionableEditPrompt: `Break circular dependency by removing an unlock edge in the path: ${pathTitles.join(' → ')}.`,
        cycleId: cycleKey,
        pathNodeIds: Object.freeze(closedPathIds),
        pathNodeTitles: Object.freeze(pathTitles),
        edgeIds: Object.freeze(edgeIds),
        fingerprint,
      }),
    );
  }

  return Object.freeze(findings);
}
