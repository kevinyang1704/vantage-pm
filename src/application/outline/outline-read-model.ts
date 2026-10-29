/**
 * Outline read model (Epic 2, Epic 3).
 *
 * Rich read model consumed by `projectVisibleOutline` and UI components.
 */

import type { DeliveryStatus, NodeType, ScheduleSourceMode } from '../../domain/tree/node.entity';
import type { NodeOpenQuestion } from '../../domain/tree/node-question.entity';
import type { Phase } from '../../domain/phase/phase.entity';
import type { UnlockEdge } from '../../domain/edge/unlock-edge.entity';
import { formatNodeTypeTag } from '../../domain/tree/node-type.policy';

export interface OutlineNodeReadModel {
  readonly id: string; // lowercase RFC 9562 UUIDv7 (AD-7)
  readonly parentId: string | null; // null = project root child
  readonly title: string;
  readonly bodyText: string | null; // authored markdown prose (FR-8, Story 16.2)
  readonly position: bigint; // signed 64-bit gap position (AD-7)
  readonly typeTag: string | null; // already-resolved display label; null renders NO TYPE
  readonly nodeType: NodeType | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly durationDays: number | null;
  readonly scheduleSourceMode: ScheduleSourceMode | null;
  /** Derived ancestor span (earliest start / latest end across dated descendants)
   *  — present only when this node has no authored dates of its own (UAT #8). */
  readonly derivedStartDate: string | null;
  readonly derivedEndDate: string | null;
  readonly derivedDurationDays: number | null;
  readonly completed: boolean;
  readonly effortPoints: number | null;
  /** Story 26.5, FC-FR5: recorded points done (null = not recorded). */
  readonly effortPointsDone: number | null;
  readonly strategicWeight: number | null;
  readonly deliveryStatus: DeliveryStatus;
  readonly phaseId: string | null;
  readonly phaseName: string | null;
  readonly effectivePhaseName: string | null;
  readonly effectivePhaseSource: 'explicit' | 'inherited' | 'none';
  readonly unlocksCount: number;
  readonly unlockedByCount: number;
  readonly customFields: Readonly<Record<string, string>>;
  readonly acceptanceSummary: string | null;
  /** Open questions & decisions for this node, pre-sorted by position ascending (Story 16.1 AC4). */
  readonly openQuestions: readonly NodeOpenQuestion[];
}

export interface OutlineReadModel {
  readonly projectId: string;
  readonly projectRevision: number; // AD-2: projections are revision-tagged
  readonly nodes: readonly OutlineNodeReadModel[];
  readonly phases?: readonly Phase[];
  readonly unlockEdges?: readonly UnlockEdge[];
}

export function createOutlineReadModel(
  projectId: string,
  projectRevision: number,
  nodes: readonly (OutlineNodeReadModel | (Pick<OutlineNodeReadModel, 'id' | 'parentId' | 'title' | 'position'> & Partial<OutlineNodeReadModel>))[],
  phases?: readonly Phase[],
  unlockEdges?: readonly UnlockEdge[],
): OutlineReadModel {
  return Object.freeze({
    projectId,
    projectRevision,
    nodes: Object.freeze(
      nodes.map((n) =>
        Object.freeze({
          id: n.id,
          parentId: n.parentId,
          title: n.title,
          bodyText: n.bodyText ?? null,
          position: n.position,
          typeTag: n.typeTag ?? (n.nodeType ? formatNodeTypeTag(n.nodeType) : null),
          nodeType: n.nodeType ?? null,
          startDate: n.startDate ?? null,
          endDate: n.endDate ?? null,
          durationDays: n.durationDays ?? null,
          scheduleSourceMode: n.scheduleSourceMode ?? null,
          derivedStartDate: n.derivedStartDate ?? null,
          derivedEndDate: n.derivedEndDate ?? null,
          derivedDurationDays: n.derivedDurationDays ?? null,
          completed: n.completed ?? false,
          effortPoints: n.effortPoints ?? null,
          effortPointsDone: n.effortPointsDone ?? null,
          strategicWeight: n.strategicWeight ?? null,
          deliveryStatus: n.deliveryStatus ?? 'not_started',
          phaseId: n.phaseId ?? null,
          phaseName: n.phaseName ?? null,
          effectivePhaseName: n.effectivePhaseName ?? null,
          effectivePhaseSource: n.effectivePhaseSource ?? 'none',
          unlocksCount: n.unlocksCount ?? 0,
          unlockedByCount: n.unlockedByCount ?? 0,
          customFields: n.customFields ?? Object.freeze({}),
          acceptanceSummary: n.acceptanceSummary ?? null,
          openQuestions: n.openQuestions ?? Object.freeze([]),
        }),
      ),
    ),
    phases: phases ? Object.freeze(phases.map((p) => Object.freeze({ ...p }))) : Object.freeze([]),
    unlockEdges: unlockEdges ? Object.freeze(unlockEdges.map((e) => Object.freeze({ ...e }))) : Object.freeze([]),
  });
}
