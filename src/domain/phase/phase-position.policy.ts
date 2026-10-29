/**
 * Phase position & ordering policy (Story 3.7, AD-7).
 *
 * Implements gap positioning, reordering analysis, and deletion reassignment validation.
 */

import type { Phase } from './phase.entity';

export const PHASE_POSITION_SPACING = 4294967296n; // 2^32 signed 64-bit integer gap

export function sortPhases(phases: readonly Phase[]): readonly Phase[] {
  return Object.freeze(
    [...phases].sort((a, b) => {
      if (a.position < b.position) return -1;
      if (a.position > b.position) return 1;
      return a.id.localeCompare(b.id);
    }),
  );
}

export function normalizePhaseName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

export function movePhaseInList(
  phases: readonly Phase[],
  fromIndex: number,
  toIndex: number,
): readonly Phase[] {
  const list = [...phases];
  const [removed] = list.splice(fromIndex, 1);
  list.splice(toIndex, 0, removed);
  const rebalanced = rebalancePhasePositions(list);
  return Object.freeze(
    list.map((p, idx) =>
      Object.freeze({
        ...p,
        position: rebalanced[idx].position,
      }),
    ),
  );
}

export function rebalancePhasePositions(
  phases: readonly Phase[],
): readonly Readonly<{ phaseId: string; position: bigint }>[] {
  const sorted = sortPhases(phases);
  const result: { phaseId: string; position: bigint }[] = [];

  let current = PHASE_POSITION_SPACING;
  for (const p of sorted) {
    result.push(Object.freeze({ phaseId: p.id, position: current }));
    current += PHASE_POSITION_SPACING;
  }

  return Object.freeze(result);
}

export function validatePhaseDeletionReassignments(
  assignedNodeIds: readonly string[],
  reassignments: Readonly<Record<string, string | null>>,
  existingPhaseIds: ReadonlySet<string>,
  deletedPhaseId: string,
): { ok: true } | { ok: false; error: string } {
  for (const nodeId of assignedNodeIds) {
    if (!(nodeId in reassignments)) {
      return {
        ok: false,
        error: `Node ${nodeId} has not been explicitly reassigned or unassigned.`,
      };
    }
    const target = reassignments[nodeId];
    if (target !== null) {
      if (target === deletedPhaseId) {
        return {
          ok: false,
          error: `Cannot reassign node ${nodeId} to the phase being deleted.`,
        };
      }
      if (!existingPhaseIds.has(target)) {
        return {
          ok: false,
          error: `Target phase ${target} does not exist.`,
        };
      }
    }
  }

  return { ok: true };
}

/**
 * Previews sequencing conflict changes if phases are reordered.
 * A sequencing conflict occurs when sourceNode (unlocks targetNode) is in a phase strictly AFTER targetNode's phase.
 */
export function previewPhaseReorderImpact(
  currentPhases: readonly Phase[],
  newPhaseOrderIds: readonly string[],
  nodePhaseMap: ReadonlyMap<string, string>, // nodeId -> phaseId
  unlockEdges: readonly { sourceNodeId: string; targetNodeId: string }[],
): { currentConflicts: number; projectedConflicts: number; delta: number } {
  const currentRankMap = new Map<string, number>();
  const sortedCurrent = sortPhases(currentPhases);
  sortedCurrent.forEach((p, idx) => currentRankMap.set(p.id, idx));

  const projectedRankMap = new Map<string, number>();
  newPhaseOrderIds.forEach((id, idx) => projectedRankMap.set(id, idx));

  function countConflicts(rankMap: Map<string, number>): number {
    let count = 0;
    for (const edge of unlockEdges) {
      const srcPhase = nodePhaseMap.get(edge.sourceNodeId);
      const tgtPhase = nodePhaseMap.get(edge.targetNodeId);
      if (srcPhase && tgtPhase && srcPhase !== tgtPhase) {
        const srcRank = rankMap.get(srcPhase);
        const tgtRank = rankMap.get(tgtPhase);
        if (srcRank !== undefined && tgtRank !== undefined && srcRank > tgtRank) {
          // Source phase is later than target phase -> conflict
          count++;
        }
      }
    }
    return count;
  }

  const currentConflicts = countConflicts(currentRankMap);
  const projectedConflicts = countConflicts(projectedRankMap);

  return Object.freeze({
    currentConflicts,
    projectedConflicts,
    delta: projectedConflicts - currentConflicts,
  });
}
