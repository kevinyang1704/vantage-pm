/**
 * Gantt phase boundary resolution (Story 7.4, FR-47, AD-12, EXPERIENCE.md).
 *
 * Derives earliest start and latest end dates for nodes assigned to each phase.
 * Produces phase boundary bands intersecting the active timeline window.
 */

import type { Phase } from '../../domain/phase/phase.entity';
import type { Node } from '../../domain/tree/node.entity';
import type { GanttPhaseBand } from '../../contracts/gantt';
import { deriveNodeSchedule, deriveAncestorSpan } from '../../domain/tree/schedule.policy';

export interface ResolveGanttPhasesInput {
  readonly phases: readonly Phase[];
  readonly nodes: readonly Node[];
  readonly dateToX: (date: string, isEnd?: boolean) => number;
  readonly windowStart: string; // ISO YYYY-MM-DD
  readonly windowEnd: string;   // ISO YYYY-MM-DD
}

export function resolveGanttPhases(input: ResolveGanttPhasesInput): readonly GanttPhaseBand[] {
  const { phases, nodes, dateToX, windowStart, windowEnd } = input;
  const sortedPhases = [...phases].sort((a, b) => (a.position < b.position ? -1 : 1));

  const bands: GanttPhaseBand[] = [];

  for (const phase of sortedPhases) {
    // Find all nodes assigned to this phase
    const assignedNodes = nodes.filter((n) => n.phaseId === phase.id);
    if (assignedNodes.length === 0) continue;

    const schedules: { startDate: string | null; endDate: string | null }[] = [];
    for (const node of assignedNodes) {
      const s = deriveNodeSchedule({
        startDate: node.startDate,
        endDate: node.endDate,
        durationDays: node.durationDays,
        sourceMode: node.scheduleSourceMode,
      });
      if (s.isValid && s.startDate && s.endDate) {
        schedules.push({ startDate: s.startDate, endDate: s.endDate });
      }
    }

    if (schedules.length === 0) continue;

    const span = deriveAncestorSpan(schedules);
    if (!span.startDate || !span.endDate) continue;

    // Check intersection with window
    const intersects = span.startDate <= windowEnd && span.endDate >= windowStart;
    if (!intersects) continue;

    const startX = dateToX(span.startDate, false);
    const endX = dateToX(span.endDate, true);

    bands.push({
      phaseId: phase.id,
      phaseName: phase.name,
      position: Number(phase.position),
      startDate: span.startDate,
      endDate: span.endDate,
      startX,
      endX,
    });
  }

  return Object.freeze(bands);
}
