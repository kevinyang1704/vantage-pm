/**
 * Sequencing Conflict Policy (Story 4.3, FR-33, FR-34).
 *
 * Detects phase ordering conflicts and chronological date conflicts
 * between directional unlock prerequisites and dependents.
 * Zero JavaScript `Date` instances — strictly uses `Temporal.PlainDate`.
 */

import { Temporal } from 'temporal-polyfill';
import type { Node } from '../tree/node.entity';
import type { Phase } from '../phase/phase.entity';
import type { UnlockEdge } from '../edge/unlock-edge.entity';
import type {
  PhaseSequencingConflictFinding,
  DateSequencingConflictFinding,
} from '../../contracts/analysis-protocol';
import { isValidIsoDate } from '../tree/schedule.policy';

export function detectPhaseSequencingConflicts(
  nodes: readonly Node[],
  phases: readonly Phase[],
  edges: readonly UnlockEdge[],
): readonly PhaseSequencingConflictFinding[] {
  const nodeMap = new Map<string, Node>();
  for (const n of nodes) nodeMap.set(n.id, n);

  const phaseMap = new Map<string, Phase>();
  for (const p of phases) phaseMap.set(p.id, p);

  const findings: PhaseSequencingConflictFinding[] = [];

  for (const edge of edges) {
    const srcNode = nodeMap.get(edge.sourceNodeId);
    const tgtNode = nodeMap.get(edge.targetNodeId);

    if (!srcNode || !tgtNode) continue;
    if (!srcNode.phaseId || !tgtNode.phaseId) continue;
    if (srcNode.phaseId === tgtNode.phaseId) continue;

    const srcPhase = phaseMap.get(srcNode.phaseId);
    const tgtPhase = phaseMap.get(tgtNode.phaseId);

    if (!srcPhase || !tgtPhase) continue;

    if (srcPhase.position > tgtPhase.position) {
      const fingerprint = `phase-conflict:${edge.id}:${srcNode.id}:${tgtNode.id}:${srcPhase.position}:${tgtPhase.position}`;
      findings.push(
        Object.freeze({
          id: `phase-conflict-${edge.id}`,
          kind: 'PhaseSequencingConflict',
          projectId: edge.projectId,
          targetNodeId: tgtNode.id,
          title: `Phase conflict: "${tgtNode.title || 'Untitled'}"`,
          narrative: `Prerequisite "${srcNode.title || 'Untitled'}" is in later phase "${srcPhase.name}" while dependent "${tgtNode.title || 'Untitled'}" is in earlier phase "${tgtPhase.name}".`,
          actionableEditPrompt: `Reassign "${tgtNode.title || 'dependent'}" to "${srcPhase.name}" or a later phase.`,
          edgeId: edge.id,
          sourceNodeId: srcNode.id,
          sourcePhaseId: srcPhase.id,
          sourcePhaseName: srcPhase.name,
          targetPhaseId: tgtPhase.id,
          targetPhaseName: tgtPhase.name,
          fingerprint,
        }),
      );
    }
  }

  return Object.freeze(findings);
}

export function detectDateSequencingConflicts(
  nodes: readonly Node[],
  edges: readonly UnlockEdge[],
): readonly DateSequencingConflictFinding[] {
  const nodeMap = new Map<string, Node>();
  for (const n of nodes) nodeMap.set(n.id, n);

  const findings: DateSequencingConflictFinding[] = [];

  for (const edge of edges) {
    const srcNode = nodeMap.get(edge.sourceNodeId);
    const tgtNode = nodeMap.get(edge.targetNodeId);

    if (!srcNode || !tgtNode) continue;

    // Prerequisite effective end date
    const srcEndIso = srcNode.endDate ?? srcNode.startDate;
    // Dependent start date
    const tgtStartIso = tgtNode.startDate;

    if (!srcEndIso || !tgtStartIso) continue;
    if (!isValidIsoDate(srcEndIso) || !isValidIsoDate(tgtStartIso)) continue;

    const srcEnd = Temporal.PlainDate.from(srcEndIso);
    const tgtStart = Temporal.PlainDate.from(tgtStartIso);

    // If dependent starts strictly before prerequisite ends
    if (Temporal.PlainDate.compare(tgtStart, srcEnd) < 0) {
      const diff = tgtStart.since(srcEnd);
      const overlapDays = Math.abs(diff.days);
      const fingerprint = `date-conflict:${edge.id}:${srcNode.id}:${tgtNode.id}:${srcEndIso}:${tgtStartIso}`;

      findings.push(
        Object.freeze({
          id: `date-conflict-${edge.id}`,
          kind: 'DateSequencingConflict',
          projectId: edge.projectId,
          targetNodeId: tgtNode.id,
          title: `Schedule conflict: "${tgtNode.title || 'Untitled'}"`,
          narrative: `Dependent starts on ${tgtStartIso} before prerequisite "${srcNode.title || 'Untitled'}" ends on ${srcEndIso} (${overlapDays} days overlap).`,
          actionableEditPrompt: `Adjust start date of "${tgtNode.title || 'dependent'}" to on or after ${srcEndIso}.`,
          edgeId: edge.id,
          sourceNodeId: srcNode.id,
          sourceEndDate: srcEndIso,
          targetStartDate: tgtStartIso,
          overlapDays,
          fingerprint,
        }),
      );
    }
  }

  return Object.freeze(findings);
}
