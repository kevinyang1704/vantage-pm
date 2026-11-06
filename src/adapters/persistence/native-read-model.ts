/**
 * Native snapshot row → domain read-model projection (E9-FR3, E9-AR1).
 *
 * The Rust side exposes raw row surfaces only; every projection and domain
 * rule stays in TypeScript. This module ports the row→model mapping the
 * browser worker performs in `repository.worker.ts`, reusing the same pure
 * domain policies so the desktop read models are identical.
 */

import type { DeliveryStatus, NodeType, ScheduleSourceMode } from '../../domain/tree/node.entity';
import type { Phase } from '../../domain/phase/phase.entity';
import type { UnlockEdge } from '../../domain/edge/unlock-edge.entity';
import type { FindingDismissal, AffectedReason } from '../../contracts/analysis-protocol';
import type { Node } from '../../domain/tree/node.entity';
import { coerceDeliveryStatus } from '../../domain/tree/node.entity';
import { formatNodeTypeTag } from '../../domain/tree/node-type.policy';
import { calculateAcceptanceRatio } from '../../domain/tree/acceptance-criteria.policy';
import { resolveEffectiveField } from '../../domain/tree/field-inheritance.policy';
import { deriveAncestorSpan } from '../../domain/tree/schedule.policy';
import { computeNodeEdgeCounts } from '../../domain/edge/unlock-edge.policy';

export interface NativeNodeRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly title: string;
  readonly bodyText: string | null;
  readonly position: number;
  readonly nodeType: NodeType | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly durationDays: number | null;
  readonly scheduleSourceMode: ScheduleSourceMode | null;
  readonly completed: boolean;
  readonly effortPoints: number | null;
  /** Story 26.5: points done; absent on a native row from an older build. */
  readonly effortPointsDone?: number | null;
  readonly strategicWeight: number | null;
  readonly phaseId: string | null;
  readonly deliveryStatus: string | null;
}

export interface NativePhaseRow {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly position: number;
}

export interface NativeUnlockEdgeRow {
  readonly id: string;
  readonly projectId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
}

export interface NativeCustomFieldRow {
  readonly nodeId: string;
  readonly fieldKey: string;
  readonly fieldValue: string | null;
}

export interface NativeDismissalRow {
  readonly projectId: string;
  readonly findingId: string;
  readonly findingKind: string;
  readonly targetId: string;
  readonly fingerprint: string;
  readonly dismissedAt: string;
}

export interface NativeAffectedReasonRow {
  readonly id: string;
  readonly projectId: string;
  readonly affectedNodeId: string;
  readonly causalNodeId: string;
  readonly causalNodeTitle: string;
  readonly deltaDays: number;
  readonly causalDateSummary: string;
  readonly createdAt: string;
  readonly acknowledgedAt: string | null;
}

export interface NativeNodeOpenQuestionRow {
  readonly id: string;
  readonly projectId: string;
  readonly nodeId: string;
  readonly questionText: string;
  readonly status: 'OPEN' | 'DECIDED';
  readonly decisionText: string | null;
  readonly position: number;
  readonly resolvedAtISO: string | null;
  readonly createdAtISO: string;
}

export interface NativeForecastPlanRow {
  readonly planningLevel?: string | null;
  readonly selectedFeatureIds: readonly string[];
  readonly parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
  /** Forecast-owned blocked Feature IDs (Epic 20, Story 20.1). Optional for
   * back-compat with a native build that predates the column. */
  readonly blockedFeatureIds?: readonly string[];
  readonly pointsPerSprint: number | null;
  readonly sprintLengthDays: number | null;
  readonly cadence: 'fixed-contiguous';
  readonly startSprintOrdinal: number | null;
  readonly startDate: string | null;
  readonly policyVersion: string;
  readonly roster?: readonly import('../../domain/forecast/forecast-plan.entity').ForecastPerson[];
  readonly assignments?: Readonly<Record<string, readonly string[]>>;
  /** The Delivery Board's sprint plan. Optional for a native build without it. */
  readonly sprintPlan?: import('../../domain/forecast/forecast-plan.entity').ForecastSprintPlan;
}

export interface NativeProjectSnapshot {
  readonly forecastScenarios?: readonly import('../../domain/forecast/scenario').PersistedForecastScenario[];
  readonly projectId: string;
  readonly projectName: string;
  readonly revision: number;
  readonly nodes: readonly NativeNodeRow[];
  readonly phases: readonly NativePhaseRow[];
  readonly unlockEdges: readonly NativeUnlockEdgeRow[];
  readonly customFields: readonly NativeCustomFieldRow[];
  readonly dismissals: readonly NativeDismissalRow[];
  readonly affectedReasons: readonly NativeAffectedReasonRow[];
  readonly openQuestions?: readonly NativeNodeOpenQuestionRow[];
  /** Optional project-owned forecast plan (Epic 18, Story 18.2). */
  readonly forecastPlan?: NativeForecastPlanRow;
  /**
   * Set by the native reader when the stored plan exists but a cell cannot be
   * read (`FORECAST_PLAN_CORRUPT: <column>`). `forecastPlan` is then absent.
   */
  readonly forecastPlanError?: string;
}

export interface NativeProjectRow {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
}

export interface NativeViewStateRow {
  readonly projectId: string;
  readonly viewId: string;
  readonly viewStateRevision: number;
  readonly collapsedNodeIds: string;
  readonly zoomRootId: string | null;
  readonly scrollTop: number;
  readonly focusedThemeId: string | null;
  readonly dateWindowStart: string | null;
  readonly dateWindowEnd: string | null;
  readonly granularity: string | null;
  readonly navCollapsed: boolean;
}

export function mapPhases(rows: readonly NativePhaseRow[]): readonly Phase[] {
  return Object.freeze(
    rows.map((r) =>
      Object.freeze({
        id: r.id,
        projectId: r.projectId,
        name: r.name,
        position: BigInt(r.position),
      }),
    ),
  );
}

export function mapUnlockEdges(rows: readonly NativeUnlockEdgeRow[]): readonly UnlockEdge[] {
  return Object.freeze(
    rows.map((r) =>
      Object.freeze({
        id: r.id,
        projectId: r.projectId,
        sourceNodeId: r.sourceNodeId,
        targetNodeId: r.targetNodeId,
      }),
    ),
  );
}

export function mapDismissals(rows: readonly NativeDismissalRow[]): readonly FindingDismissal[] {
  return Object.freeze(
    rows.map((r) =>
      Object.freeze({
        projectId: r.projectId,
        findingId: r.findingId,
        findingKind: r.findingKind as FindingDismissal['findingKind'],
        targetId: r.targetId,
        fingerprint: r.fingerprint,
        dismissedAt: r.dismissedAt,
      }),
    ),
  );
}

export function mapAffectedReasons(rows: readonly NativeAffectedReasonRow[]): readonly AffectedReason[] {
  return Object.freeze(
    rows.map((r) =>
      Object.freeze({
        id: r.id,
        projectId: r.projectId,
        affectedNodeId: r.affectedNodeId,
        causalNodeId: r.causalNodeId,
        causalNodeTitle: r.causalNodeTitle,
        deltaDays: r.deltaDays,
        causalDateSummary: r.causalDateSummary,
        createdAt: r.createdAt,
        acknowledgedAt: r.acknowledgedAt,
      }),
    ),
  );
}

export function mapNodeOpenQuestions(rows: readonly NativeNodeOpenQuestionRow[]): readonly import('../../domain/tree/node-question.entity').NodeOpenQuestion[] {
  return Object.freeze(
    rows.map((r) =>
      Object.freeze({
        id: r.id,
        projectId: r.projectId,
        nodeId: r.nodeId,
        questionText: r.questionText,
        status: r.status,
        decisionText: r.decisionText,
        position: BigInt(r.position),
        resolvedAtISO: r.resolvedAtISO,
        createdAtISO: r.createdAtISO,
      }),
    ),
  );
}

/** Domain `Node` list for the analysis snapshot. */
export function mapDomainNodes(snapshot: NativeProjectSnapshot): readonly Node[] {
  return Object.freeze(
    snapshot.nodes.map((r) =>
      Object.freeze({
        id: r.id,
        projectId: snapshot.projectId,
        parentId: r.parentId,
        title: r.title,
        bodyText: r.bodyText,
        position: BigInt(r.position),
        nodeType: r.nodeType,
        startDate: r.startDate,
        endDate: r.endDate,
        durationDays: r.durationDays,
        scheduleSourceMode: r.scheduleSourceMode,
        completed: r.completed,
        effortPoints: r.effortPoints,
        effortPointsDone: r.effortPointsDone ?? null,
        strategicWeight: r.strategicWeight,
        phaseId: r.phaseId,
        deliveryStatus: coerceDeliveryStatus(r.deliveryStatus),
      }),
    ),
  );
}
