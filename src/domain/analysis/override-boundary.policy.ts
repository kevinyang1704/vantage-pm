/**
 * Explicit-override boundary violation policy (Story 7.6, FR-50, AD-8, AD-10).
 *
 * Emits coherence findings when a descendant's resolved schedule falls outside
 * an ancestor's complete explicit schedule bounds.
 * Partial draft ancestor bounds emit zero false positives (AC3).
 */

import type { Node } from '../tree/node.entity';
import type { ExplicitOverrideBoundaryViolationFinding, OverrideViolationBoundary } from '../../contracts/analysis-protocol';
import { deriveNodeSchedule, isValidIsoDate } from '../tree/schedule.policy';

export function detectOverrideBoundaryViolations(
  nodes: readonly Node[],
): readonly ExplicitOverrideBoundaryViolationFinding[] {
  const childrenMap = new Map<string, Node[]>();
  const nodeMap = new Map<string, Node>();

  for (const node of nodes) {
    nodeMap.set(node.id, node);
    if (node.parentId) {
      const list = childrenMap.get(node.parentId);
      if (list) {
        list.push(node);
      } else {
        childrenMap.set(node.parentId, [node]);
      }
    }
  }

  const findings: ExplicitOverrideBoundaryViolationFinding[] = [];

  // Helper to collect all transitive descendants
  function getTransitiveDescendants(rootId: string): Node[] {
    const results: Node[] = [];
    const queue = [...(childrenMap.get(rootId) ?? [])];
    while (queue.length > 0) {
      const current = queue.shift()!;
      results.push(current);
      const children = childrenMap.get(current.id) ?? [];
      queue.push(...children);
    }
    return results;
  }

  for (const ancestor of nodes) {
    // AC3: Ancestor must have COMPLETE explicit start and end bounds
    if (!ancestor.startDate || !ancestor.endDate) continue;
    if (!isValidIsoDate(ancestor.startDate) || !isValidIsoDate(ancestor.endDate)) continue;

    const descendants = getTransitiveDescendants(ancestor.id);
    if (descendants.length === 0) continue;

    for (const descendant of descendants) {
      const schedule = deriveNodeSchedule({
        startDate: descendant.startDate,
        endDate: descendant.endDate,
        durationDays: descendant.durationDays,
        sourceMode: descendant.scheduleSourceMode,
      });

      if (!schedule.isValid || !schedule.startDate || !schedule.endDate) continue;

      const isBeforeStart = schedule.startDate < ancestor.startDate;
      const isAfterEnd = schedule.endDate > ancestor.endDate;

      if (isBeforeStart || isAfterEnd) {
        const violatedBoundary: OverrideViolationBoundary =
          isBeforeStart && isAfterEnd
            ? 'both'
            : isBeforeStart
            ? 'before_start'
            : 'after_end';

        const ancestorTitle = ancestor.title || 'Untitled Ancestor';
        const descendantTitle = descendant.title || 'Untitled Descendant';

        const boundaryDesc =
          violatedBoundary === 'both'
            ? `starts before (${schedule.startDate} < ${ancestor.startDate}) and ends after (${schedule.endDate} > ${ancestor.endDate})`
            : violatedBoundary === 'before_start'
            ? `starts before parent start (${schedule.startDate} < ${ancestor.startDate})`
            : `ends after parent end (${schedule.endDate} > ${ancestor.endDate})`;

        const narrative = `Descendant "${descendantTitle}" ${boundaryDesc} declared by explicit commitment on "${ancestorTitle}" (${ancestor.startDate} – ${ancestor.endDate}).`;

        findings.push({
          id: `override-violation-${ancestor.id}-${descendant.id}`,
          kind: 'ExplicitOverrideBoundaryViolation',
          projectId: ancestor.projectId,
          targetNodeId: descendant.id,
          title: 'Outside Ancestor Schedule Commitment',
          narrative,
          fingerprint: `${ancestor.startDate}:${ancestor.endDate}:${schedule.startDate}:${schedule.endDate}`,
          actionableEditPrompt: `Adjust dates on "${descendantTitle}" or extend the commitment on "${ancestorTitle}".`,
          ancestorNodeId: ancestor.id,
          ancestorTitle,
          ancestorStartDate: ancestor.startDate,
          ancestorEndDate: ancestor.endDate,
          descendantNodeId: descendant.id,
          descendantTitle,
          descendantStartDate: schedule.startDate,
          descendantEndDate: schedule.endDate,
          violatedBoundary,
        });
      }
    }
  }

  return Object.freeze(findings);
}
