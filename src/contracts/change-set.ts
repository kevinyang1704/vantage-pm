/**
 * Authoritative ChangeSet and NodeChange contracts (Epic 2, Epic 3, AD-4, AD-5).
 *
 * Every NodeChange carries enough authoritative data from the repository to
 * be strictly self-inverting without consulting current state.
 * Structured-clone-safe.
 */

import { PROTOCOL_VERSION } from '../../spikes/phase-0-durability/src/command-receipt';
import type { DeliveryStatus, NodeType, ScheduleSourceMode } from '../domain/tree/node.entity';

export type NodeSnapshot = Readonly<{
  nodeId: string;
  parentId: string | null;
  title: string;
  bodyText: string | null;
  position: string; // decimal string
  depth: number;    // 0 = subtree root; restore pre-order key
  nodeType?: NodeType | null;
  startDate?: string | null;
  endDate?: string | null;
  durationDays?: number | null;
  scheduleSourceMode?: ScheduleSourceMode | null;
  completed?: boolean;
  effortPoints?: number | null;
  effortPointsDone?: number | null;
  strategicWeight?: number | null;
  phaseId?: string | null;
  deliveryStatus?: DeliveryStatus;
}>;

export type NodeChange =
  | Readonly<{
      type: 'NodeCreated';
      nodeId: string;
      parentId: string | null;
      position: string;
      title: string;
    }>
  | Readonly<{
      type: 'NodeTitleSet';
      nodeId: string;
      title: string;
      priorTitle: string;
    }>
  | Readonly<{
      type: 'NodeBodyTextSet';
      nodeId: string;
      bodyText: string | null;
      priorBodyText: string | null;
    }>
  | Readonly<{
      type: 'NodeMoved';
      nodeId: string;
      parentId: string | null;
      position: string;
      priorParentId: string | null;
      priorPosition: string;
    }>
  | Readonly<{
      type: 'SiblingPositionsRebalanced';
      parentId: string | null;
      positions: readonly Readonly<{ nodeId: string; position: string }>[];
      priorPositions?: readonly Readonly<{ nodeId: string; position: string }>[];
    }>
  | Readonly<{
      type: 'SubtreeDeleted';
      rootNodeId: string;
      nodes: readonly NodeSnapshot[];
      deletionBundle?: import('./deletion-bundle').DeletionBundle;
    }>
  | Readonly<{
      type: 'SubtreeRestored';
      rootNodeId: string;
      nodes: readonly NodeSnapshot[];
      deletionBundle?: import('./deletion-bundle').DeletionBundle;
    }>
  | Readonly<{
      type: 'SubtreeDuplicated';
      sourceRootId: string;
      newRootId: string;
      nodes: readonly NodeSnapshot[];
    }>
  // ── Epic 3 Changes ───────────────────────────────────────────────
  | Readonly<{
      type: 'NodeTypeSet';
      nodeId: string;
      nodeType: NodeType | null;
      priorNodeType: NodeType | null;
    }>
  | Readonly<{
      type: 'NodeCustomFieldSet';
      nodeId: string;
      fieldKey: string;
      fieldValue: string | null;
      priorFieldValue: string | null;
    }>
  | Readonly<{
      type: 'FieldTemplatePromoted';
      nodeType: NodeType;
      fieldKey: string;
      fieldLabel: string;
    }>
  | Readonly<{
      type: 'NodeScheduleSet';
      nodeId: string;
      startDate: string | null;
      endDate: string | null;
      durationDays: number | null;
      sourceMode: ScheduleSourceMode;
      priorStartDate: string | null;
      priorEndDate: string | null;
      priorDurationDays: number | null;
      priorSourceMode: ScheduleSourceMode;
    }>
  | Readonly<{
      type: 'NodeCompletedToggled';
      nodeId: string;
      completed: boolean;
      priorCompleted: boolean;
    }>
  | Readonly<{
      type: 'NodeEffortSet';
      nodeId: string;
      effortPoints: number | null;
      priorEffortPoints: number | null;
      clearedAssignments?: readonly string[];
    }>
  | Readonly<{
      /** Story 26.5, FC-FR5: recorded points done on an item. */
      type: 'NodePointsDoneSet';
      nodeId: string;
      effortPointsDone: number | null;
      priorEffortPointsDone: number | null;
    }>
  | Readonly<{
      type: 'NodeStatusSet';
      nodeId: string;
      deliveryStatus: DeliveryStatus;
      priorDeliveryStatus: DeliveryStatus;
    }>
  | Readonly<{
      type: 'ThemeWeightSet';
      nodeId: string;
      strategicWeight: number | null;
      priorStrategicWeight: number | null;
    }>
  | Readonly<{
      type: 'PhaseCreated';
      phaseId: string;
      name: string;
      position: string;
    }>
  | Readonly<{
      type: 'PhaseRenamed';
      phaseId: string;
      name: string;
      priorName: string;
    }>
  | Readonly<{
      type: 'PhasesReordered';
      phases: readonly Readonly<{ phaseId: string; position: string }>[];
      priorPhases: readonly Readonly<{ phaseId: string; position: string }>[];
    }>
  | Readonly<{
      type: 'NodePhaseAssigned';
      nodeId: string;
      phaseId: string | null;
      priorPhaseId: string | null;
    }>
  | Readonly<{
      type: 'PhaseDeleted';
      phaseId: string;
      name: string;
      position: string;
      reassignments: Readonly<Record<string, string | null>>;
      priorAssignments: Readonly<Record<string, string | null>>;
    }>
  | Readonly<{
      type: 'PhaseRestored';
      phaseId: string;
      name: string;
      position: string;
      priorAssignments: Readonly<Record<string, string | null>>;
    }>
  | Readonly<{
      type: 'UnlockEdgeCreated';
      edgeId: string;
      sourceNodeId: string;
      targetNodeId: string;
    }>
  | Readonly<{
      type: 'UnlockEdgeDeleted';
      edgeId: string;
      sourceNodeId: string;
      targetNodeId: string;
    }>
  // ── Epic 4 & Epic 7 Changes ─────────────────────────────────────
  | Readonly<{
      type: 'FindingDismissed';
      findingId: string;
      findingKind: 'OrphanedFeature' | 'PhaseSequencingConflict' | 'DateSequencingConflict' | 'UnlockCycle' | 'StrategicImbalance' | 'ExplicitOverrideBoundaryViolation';
      targetId: string;
      fingerprint: string;
      dismissedAt: string;
    }>
  | Readonly<{
      type: 'FindingUndismissed';
      findingId: string;
      findingKind: 'OrphanedFeature' | 'PhaseSequencingConflict' | 'DateSequencingConflict' | 'UnlockCycle' | 'StrategicImbalance' | 'ExplicitOverrideBoundaryViolation';
      targetId: string;
      fingerprint: string;
      priorDismissedAt: string;
    }>
  | Readonly<{
      type: 'AffectedReasonsRecorded';
      reasons: readonly Readonly<{
        id: string;
        affectedNodeId: string;
        causalNodeId: string;
        deltaDays: number;
        causalDateSummary: string;
        createdAt: string;
      }>[];
    }>
  | Readonly<{
      type: 'AffectedReasonAcknowledged';
      reasonId: string;
      acknowledgedAt: string;
    }>
  // ── Epic 16 Changes (Story 16.1) ──────────────────────────────────
  | Readonly<{
      type: 'NodeQuestionAdded';
      questionId: string;
      nodeId: string;
      questionText: string;
      position: string;
      createdAtISO: string;
    }>
  | Readonly<{
      type: 'NodeQuestionUpdated';
      questionId: string;
      questionText: string;
      priorQuestionText: string;
    }>
  | Readonly<{
      type: 'NodeQuestionResolved';
      questionId: string;
      decisionText: string;
      resolvedAtISO: string;
      priorStatus: 'OPEN' | 'DECIDED';
      priorDecisionText: string | null;
      priorResolvedAtISO: string | null;
    }>
  | Readonly<{
      type: 'NodeQuestionsReordered';
      nodeId: string;
      questionIds: readonly string[];
      priorQuestionIds: readonly string[];
    }>
  | Readonly<{
      type: 'NodeQuestionDeleted';
      questionId: string;
      nodeId: string;
      questionText: string;
      status: 'OPEN' | 'DECIDED';
      decisionText: string | null;
      position: string;
      resolvedAtISO: string | null;
      createdAtISO: string;
    }>
  // ── Epic 18 Changes (Story 18.1, Story 18.2) ─────────────────────────
  | Readonly<{
      type: 'ForecastPlanCreated';
      projectId: string;
    }>
  | Readonly<{
      /** Undo of plan creation: the plan row is deleted (Story 21.13 D5). */
      type: 'ForecastPlanRemoved';
      projectId: string;
    }>
  | Readonly<{
      type: 'ForecastConfigurationSet';
      pointsPerSprint: number | null;
      sprintLengthDays: number | null;
      startSprintOrdinal: number | null;
      startDate: string | null;
      priorPointsPerSprint: number | null;
      priorSprintLengthDays: number | null;
      priorStartSprintOrdinal: number | null;
      priorStartDate: string | null;
    }>
  | Readonly<{
      type: 'ForecastScopeSet';
      selectedFeatureIds: readonly string[];
      parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
      priorSelectedFeatureIds: readonly string[];
      priorParallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
      /**
       * Blocked set after/before this scope change (Story 20.1, AR-19).
       * Excluding a blocked Feature clears its blocker atomically; both fields
       * are always present so the transition is fully described and reversible.
       */
      blockedFeatureIds: readonly string[];
      priorBlockedFeatureIds: readonly string[];
      clearedAssignments?: readonly string[];
      priorAssignments?: Readonly<Record<string, readonly string[]>>;
      assignments?: Readonly<Record<string, readonly string[]>>;
    }>
  // ── Epic 19 Changes (Story 19.2) ──────────────────────────────────
  | Readonly<{
      type: 'ForecastOrderSet';
      selectedFeatureIds: readonly string[];
      priorSelectedFeatureIds: readonly string[];
      /** Story 27.2: exact single-move inverse when a MoveForecastFeature
       *  produced this change (AC 27.2-3). Absent on legacy whole-list changes. */
      priorMove?: Readonly<{
        featureId: string;
        afterId: string | null;
        beforeId: string | null;
        intendedIndex: number;
        groupChange: import('../domain/forecast/forecast.commands').ForecastGroupChange;
      }>;
    }>
  | Readonly<{
      type: 'ForecastSequenceSet';
      selectedFeatureIds: readonly string[];
      parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
      priorSelectedFeatureIds: readonly string[];
      priorParallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
      /** Story 27.2: exact single-move inverse (AC 27.2-3). */
      priorMove?: Readonly<{
        featureId: string;
        afterId: string | null;
        beforeId: string | null;
        intendedIndex: number;
        groupChange: import('../domain/forecast/forecast.commands').ForecastGroupChange;
      }>;
    }>
  | Readonly<{
      type: 'ForecastParallelGroupsSet';
      parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
      priorParallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
    }>
  // ── Epic 20 Changes (Story 20.1) ──────────────────────────────────
  | Readonly<{
      type: 'ForecastBlockerSet';
      featureId: string;
      blocked: boolean;
      priorBlocked: boolean;
    }>
  // ── Epic 20 Changes (Story 20.4) ──────────────────────────────────
  | Readonly<{
      type: 'ForecastScenarioCreated';
      scenario: import('../domain/forecast/scenario').PersistedForecastScenario;
    }>
  | Readonly<{
      type: 'ForecastScenarioRemoved';
      scenarioId: string;
      scenario: import('../domain/forecast/scenario').PersistedForecastScenario;
    }>
  | Readonly<{
      type: 'ForecastScenarioRestored';
      scenario: import('../domain/forecast/scenario').PersistedForecastScenario;
    }>
  // ── Epic 21 Changes (Story 21.7) ──────────────────────────────────
  | Readonly<{
      type: 'ForecastPlanningLevelSet';
      planningLevel: import('../domain/forecast/forecast-plan.entity').ForecastNodeLevel;
      selectedFeatureIds: readonly string[];
      parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
      blockedFeatureIds: readonly string[];
      priorPlanningLevel: import('../domain/forecast/forecast-plan.entity').ForecastNodeLevel;
      priorSelectedFeatureIds: readonly string[];
      priorParallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
      priorBlockedFeatureIds: readonly string[];
      priorAssignments?: Readonly<Record<string, readonly string[]>>;
      assignments?: Readonly<Record<string, readonly string[]>>;
    }>
  // ── Epic 22 Changes (Story 22.3, Story 22.4) ──────────────────────
  | Readonly<{
      type: 'ForecastPersonAdded';
      projectId: string;
      person: import('../domain/forecast/forecast-plan.entity').ForecastPerson;
    }>
  | Readonly<{
      type: 'ForecastPersonUpdated';
      projectId: string;
      personId: string;
      name: string;
      weightUnits: number;
      priorName: string;
      priorWeightUnits: number;
    }>
  | Readonly<{
      type: 'ForecastPersonRemoved';
      projectId: string;
      person: import('../domain/forecast/forecast-plan.entity').ForecastPerson;
      priorAssignments?: Readonly<Record<string, readonly string[]>>;
    }>
  | Readonly<{
      type: 'ForecastPersonRestored';
      projectId: string;
      person: import('../domain/forecast/forecast-plan.entity').ForecastPerson;
      assignments?: Readonly<Record<string, readonly string[]>>;
    }>
  | Readonly<{
      type: 'ForecastAssignmentsSet';
      projectId: string;
      featureId: string;
      personIds: readonly string[];
      priorPersonIds: readonly string[];
    }>
  | Readonly<{
      type: 'ForecastPolicySet';
      projectId: string;
      policyVersion: import('../domain/forecast/forecast-plan.entity').ForecastPolicyVersion;
      priorPolicyVersion: import('../domain/forecast/forecast-plan.entity').ForecastPolicyVersion;
    }>;

export type ChangeSet = Readonly<{
  protocolVersion: typeof PROTOCOL_VERSION;
  projectId: string;
  baseRevision: number;
  targetRevision: number;
  changes: readonly NodeChange[];
}>;

export function createChangeSet(params: {
  projectId: string;
  baseRevision: number;
  targetRevision: number;
  changes: readonly NodeChange[];
}): ChangeSet {
  return Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    targetRevision: params.targetRevision,
    changes: Object.freeze([...params.changes]),
  });
}
