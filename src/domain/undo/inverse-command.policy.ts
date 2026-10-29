import { validateDeletionBundle } from '../../contracts/deletion-bundle';
/**
 * Pure inverse command policy (Epic 2, Epic 3, AD-4).
 *
 * Derives the exact inverse command descriptor from an authoritative ChangeSet.
 * Pure and framework-free.
 */

import type { ChangeSet } from '../../contracts/change-set';
import type { DeliveryStatus, NodeType, ScheduleSourceMode } from '../tree/node.entity';

export type InverseCommandDescriptor =
  | Readonly<{
      type: 'DeleteSubtree';
      nodeId: string;
    }>
  | Readonly<{
      type: 'SetNodeTitle';
      nodeId: string;
      title: string;
    }>
  | Readonly<{
      type: 'SetNodeBodyText';
      nodeId: string;
      bodyText: string | null;
    }>
  | Readonly<{
      type: 'MoveNode';
      nodeId: string;
      newParentId: string | null;
      newPosition: string;
    }>
  | Readonly<{
      type: 'RestoreSubtree';
      rootNodeId: string;
      nodes: readonly import('../../contracts/change-set').NodeSnapshot[];
      deletionBundle?: import('../../contracts/deletion-bundle').DeletionBundle;
    }>
  | Readonly<{
      type: 'SetNodeType';
      nodeId: string;
      nodeType: NodeType | null;
    }>
  | Readonly<{
      type: 'SetNodeCustomField';
      nodeId: string;
      fieldKey: string;
      fieldValue: string | null;
    }>
  | Readonly<{
      type: 'SetNodeSchedule';
      nodeId: string;
      startDate: string | null;
      endDate: string | null;
      durationDays: number | null;
      sourceMode: ScheduleSourceMode;
    }>
  | Readonly<{
      type: 'ToggleNodeCompleted';
      nodeId: string;
      completed: boolean;
    }>
  | Readonly<{
      type: 'SetNodeEffort';
      nodeId: string;
      effortPoints: number | null;
      restoredAssignments?: readonly string[];
    }>
  | Readonly<{
      type: 'SetNodePointsDone';
      nodeId: string;
      effortPointsDone: number | null;
    }>
  | Readonly<{
      type: 'SetNodeStatus';
      nodeId: string;
      deliveryStatus: DeliveryStatus;
    }>
  | Readonly<{
      type: 'SetThemeWeight';
      nodeId: string;
      strategicWeight: number | null;
    }>
  | Readonly<{
      type: 'DeletePhase';
      phaseId: string;
      reassignments: Readonly<Record<string, string | null>>;
    }>
  | Readonly<{
      type: 'RenamePhase';
      phaseId: string;
      name: string;
    }>
  | Readonly<{
      type: 'ReorderPhases';
      phases: readonly Readonly<{ phaseId: string; position: string }>[];
    }>
  | Readonly<{
      type: 'AssignNodePhase';
      nodeId: string;
      phaseId: string | null;
    }>
  | Readonly<{
      type: 'RestorePhase';
      phaseId: string;
      name: string;
      position: string;
      priorAssignments: Readonly<Record<string, string | null>>;
    }>
  | Readonly<{
      type: 'DeleteUnlockEdge';
      edgeId: string;
      sourceNodeId: string;
      targetNodeId: string;
    }>
  | Readonly<{
      type: 'CreateUnlockEdge';
      edgeId: string;
      sourceNodeId: string;
      targetNodeId: string;
    }>
  | Readonly<{
      type: 'UndismissFinding';
      findingId: string;
      findingKind: 'OrphanedFeature' | 'PhaseSequencingConflict' | 'DateSequencingConflict' | 'UnlockCycle' | 'StrategicImbalance' | 'ExplicitOverrideBoundaryViolation';
      targetId: string;
      fingerprint: string;
    }>
  | Readonly<{
      type: 'DismissFinding';
      findingId: string;
      findingKind: 'OrphanedFeature' | 'PhaseSequencingConflict' | 'DateSequencingConflict' | 'UnlockCycle' | 'StrategicImbalance' | 'ExplicitOverrideBoundaryViolation';
      targetId: string;
      fingerprint: string;
      dismissedAt: string;
    }>
  // ── Epic 18 Inversions (Story 18.2) ────────────────────────────────
  | Readonly<{
      type: 'ConfigureForecastPlan';
      pointsPerSprint: number | null;
      sprintLengthDays: number | null;
      startSprintOrdinal: number | null;
      startDate: string | null;
    }>
  // ── Epic 21 Inversions (Story 21.13 D5) ───────────────────────────
  | Readonly<{
      type: 'DeleteForecastPlan';
      projectId: string;
    }>
  | Readonly<{
      type: 'SetForecastMembership';
      featureId: string;
      included: boolean;
    }>
  // ── Epic 19 Inversions (Story 19.2) ────────────────────────────────
  | Readonly<{
      type: 'ReorderForecastFeatures';
      featureIds: readonly string[];
    }>
  | Readonly<{
      type: 'SetForecastParallelGroups';
      parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
    }>
  | Readonly<{
      type: 'SetForecastSequence';
      featureIds: readonly string[];
      parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
    }>
  | Readonly<{
      type: 'MoveForecastFeature';
      featureId: string;
      afterId: string | null;
      beforeId: string | null;
      intendedIndex: number;
      groupChange: import('../forecast/forecast.commands').ForecastGroupChange;
    }>
  | Readonly<{
      type: 'RestoreForecastScope';
      selectedFeatureIds: readonly string[];
      parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
      blockedFeatureIds: readonly string[];
      assignments?: Readonly<Record<string, readonly string[]>>;
    }>
  // ── Epic 20 Inversions (Story 20.1) ────────────────────────────────
  | Readonly<{
      type: 'SetForecastBlocker';
      featureId: string;
      blocked: boolean;
    }>
  // ── Epic 20 Inversions (Story 20.4) ────────────────────────────────
  | Readonly<{
      type: 'RemoveForecastScenario';
      scenarioId: string;
    }>
  | Readonly<{
      type: 'RestoreForecastScenario';
      scenario: import('../forecast/scenario').PersistedForecastScenario;
    }>
  // ── Epic 21 Inversions (Story 21.7) ────────────────────────────────
  | Readonly<{
      type: 'RestoreForecastPlanningLevel';
      planningLevel: import('../forecast/forecast-plan.entity').ForecastNodeLevel;
      selectedFeatureIds: readonly string[];
      parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
      blockedFeatureIds: readonly string[];
      assignments?: Readonly<Record<string, readonly string[]>>;
    }>
  // ── Epic 22 Inversions (Story 22.3, Story 22.4) ────────────────────
  | Readonly<{
      type: 'RemoveForecastPerson';
      personId: string;
    }>
  | Readonly<{
      type: 'UpdateForecastPerson';
      personId: string;
      name: string;
      weightUnits: number;
    }>
  | Readonly<{
      type: 'RestoreForecastPerson';
      person: import('../forecast/forecast-plan.entity').ForecastPerson;
      assignments?: Readonly<Record<string, readonly string[]>>;
    }>
  | Readonly<{
      type: 'SetForecastAssignments';
      featureId: string;
      personIds: readonly string[];
    }>
  | Readonly<{
      type: 'SetForecastPolicy';
      policyVersion: import('../forecast/forecast-plan.entity').ForecastPolicyVersion;
    }>;

export function computeInverseDescriptor(changeSet: ChangeSet): InverseCommandDescriptor | null {
  if (!changeSet.changes || changeSet.changes.length === 0) {
    return null;
  }

  // A first forecast mutation emits ForecastPlanCreated followed by the
  // configuration/scope change that carries the actual inverse. Skip the
  // plan-created marker when selecting the primary change.
  //
  // Plan CREATION is atomic (Story 21.13 D5): it was one command, so its
  // inverse is the whole-plan delete — a single Undo returns to the
  // pre-creation state (the level step), never to a Feature plan with the
  // Theme configuration retained.
  const hasPlanCreatedMarker =
    changeSet.changes.length > 1 && changeSet.changes[0].type === 'ForecastPlanCreated';
  if (hasPlanCreatedMarker && changeSet.changes[1].type === 'ForecastConfigurationSet') {
    return Object.freeze({ type: 'DeleteForecastPlan', projectId: changeSet.projectId });
  }
  const primaryChange =
    hasPlanCreatedMarker
      ? changeSet.changes[1]
      : changeSet.changes[0];

  switch (primaryChange.type) {
    case 'NodeCreated':
      return Object.freeze({
        type: 'DeleteSubtree',
        nodeId: primaryChange.nodeId,
      });

    case 'NodeTitleSet':
      return Object.freeze({
        type: 'SetNodeTitle',
        nodeId: primaryChange.nodeId,
        title: primaryChange.priorTitle,
      });

    case 'NodeBodyTextSet':
      return Object.freeze({
        type: 'SetNodeBodyText',
        nodeId: primaryChange.nodeId,
        bodyText: primaryChange.priorBodyText,
      });

    case 'NodeMoved':
      return Object.freeze({
        type: 'MoveNode',
        nodeId: primaryChange.nodeId,
        newParentId: primaryChange.priorParentId,
        newPosition: primaryChange.priorPosition,
      });

    case 'SubtreeDeleted':
      return Object.freeze({
        type: 'RestoreSubtree',
        rootNodeId: primaryChange.rootNodeId,
        nodes: Object.freeze(primaryChange.nodes.map(node => Object.freeze({...node}))),
        ...(primaryChange.deletionBundle === undefined ? {} : { deletionBundle: validateDeletionBundle(primaryChange.deletionBundle,changeSet.projectId,primaryChange.rootNodeId,primaryChange.nodes) }),
      });

    case 'SubtreeRestored':
      return Object.freeze({
        type: 'DeleteSubtree',
        nodeId: primaryChange.rootNodeId,
      });

    case 'SubtreeDuplicated':
      return Object.freeze({
        type: 'DeleteSubtree',
        nodeId: primaryChange.newRootId,
      });

    // ── Epic 3 Inversions ──────────────────────────────────────────
    case 'NodeTypeSet':
      return Object.freeze({
        type: 'SetNodeType',
        nodeId: primaryChange.nodeId,
        nodeType: primaryChange.priorNodeType,
      });

    case 'NodeCustomFieldSet':
      return Object.freeze({
        type: 'SetNodeCustomField',
        nodeId: primaryChange.nodeId,
        fieldKey: primaryChange.fieldKey,
        fieldValue: primaryChange.priorFieldValue,
      });

    case 'NodeScheduleSet':
      return Object.freeze({
        type: 'SetNodeSchedule',
        nodeId: primaryChange.nodeId,
        startDate: primaryChange.priorStartDate,
        endDate: primaryChange.priorEndDate,
        durationDays: primaryChange.priorDurationDays,
        sourceMode: primaryChange.priorSourceMode,
      });

    case 'NodeCompletedToggled':
      return Object.freeze({
        type: 'ToggleNodeCompleted',
        nodeId: primaryChange.nodeId,
        completed: primaryChange.priorCompleted,
      });

    case 'NodeEffortSet':
      return Object.freeze({
        type: 'SetNodeEffort',
        nodeId: primaryChange.nodeId,
        effortPoints: primaryChange.priorEffortPoints,
        ...(primaryChange.clearedAssignments && primaryChange.clearedAssignments.length > 0
          ? { restoredAssignments: primaryChange.clearedAssignments }
          : {}),
      });

    case 'NodePointsDoneSet':
      return Object.freeze({
        type: 'SetNodePointsDone',
        nodeId: primaryChange.nodeId,
        effortPointsDone: primaryChange.priorEffortPointsDone,
      });

    case 'NodeStatusSet':
      return Object.freeze({
        type: 'SetNodeStatus',
        nodeId: primaryChange.nodeId,
        deliveryStatus: primaryChange.priorDeliveryStatus,
      });

    case 'ThemeWeightSet':
      return Object.freeze({
        type: 'SetThemeWeight',
        nodeId: primaryChange.nodeId,
        strategicWeight: primaryChange.priorStrategicWeight,
      });

    case 'PhaseCreated':
      return Object.freeze({
        type: 'DeletePhase',
        phaseId: primaryChange.phaseId,
        reassignments: Object.freeze({}),
      });

    case 'PhaseRenamed':
      return Object.freeze({
        type: 'RenamePhase',
        phaseId: primaryChange.phaseId,
        name: primaryChange.priorName,
      });

    case 'PhasesReordered':
      return Object.freeze({
        type: 'ReorderPhases',
        phases: primaryChange.priorPhases,
      });

    case 'NodePhaseAssigned':
      return Object.freeze({
        type: 'AssignNodePhase',
        nodeId: primaryChange.nodeId,
        phaseId: primaryChange.priorPhaseId,
      });

    case 'PhaseDeleted':
      return Object.freeze({
        type: 'RestorePhase',
        phaseId: primaryChange.phaseId,
        name: primaryChange.name,
        position: primaryChange.position,
        priorAssignments: primaryChange.priorAssignments,
      });

    case 'PhaseRestored':
      return Object.freeze({
        type: 'DeletePhase',
        phaseId: primaryChange.phaseId,
        reassignments: primaryChange.priorAssignments,
      });

    case 'UnlockEdgeCreated':
      return Object.freeze({
        type: 'DeleteUnlockEdge',
        edgeId: primaryChange.edgeId,
        sourceNodeId: primaryChange.sourceNodeId,
        targetNodeId: primaryChange.targetNodeId,
      });

    case 'UnlockEdgeDeleted':
      return Object.freeze({
        type: 'CreateUnlockEdge',
        edgeId: primaryChange.edgeId,
        sourceNodeId: primaryChange.sourceNodeId,
        targetNodeId: primaryChange.targetNodeId,
      });

    // ── Epic 4 Inversions ──────────────────────────────────────────
    case 'FindingDismissed':
      return Object.freeze({
        type: 'UndismissFinding',
        findingId: primaryChange.findingId,
        findingKind: primaryChange.findingKind,
        targetId: primaryChange.targetId,
        fingerprint: primaryChange.fingerprint,
      });

    case 'FindingUndismissed':
      return Object.freeze({
        type: 'DismissFinding',
        findingId: primaryChange.findingId,
        findingKind: primaryChange.findingKind,
        targetId: primaryChange.targetId,
        fingerprint: primaryChange.fingerprint,
        dismissedAt: primaryChange.priorDismissedAt,
      });

    // ── Epic 18 Inversions (Story 18.2) ──────────────────────────────
    case 'ForecastPlanCreated':
      return null; // the accompanying configuration/scope change carries the inverse

    case 'ForecastConfigurationSet':
      return Object.freeze({
        type: 'ConfigureForecastPlan',
        pointsPerSprint: primaryChange.priorPointsPerSprint,
        sprintLengthDays: primaryChange.priorSprintLengthDays,
        startSprintOrdinal: primaryChange.priorStartSprintOrdinal,
        startDate: primaryChange.priorStartDate,
      });

    case 'ForecastScopeSet':
      // A scope change is invertible through a single membership toggle ONLY
      // when it is exactly reversible that way: `SetForecastMembership`
      // appends on include and removes-by-id on exclude, so it can restore the
      // prior array only when the sole difference is the *last* element.
      //
      //  - pure single append  → exclude that id (removes the appended tail) ✓
      //  - pure removal of the last prior element → re-include (appends it back
      //    to the same tail position) ✓
      //
      // A mid-list removal, a multi-member change, a reorder, or any parallel
      // group edit cannot be reproduced by a membership toggle without
      // silently changing order or dropping a dissolved group. Those return
      // null (non-invertible) rather than a wrong inverse — exact scope/group
      // restoration is delivered with the reorder/group commands in Epic 19.
      {
        const prior = primaryChange.priorSelectedFeatureIds;
        const next = primaryChange.selectedFeatureIds;
        const priorGroups = JSON.stringify(primaryChange.priorParallelGroups ?? []);
        const nextGroups = JSON.stringify(primaryChange.parallelGroups ?? []);
        // A membership toggle also cannot restore a cleared blocker (Story
        // 20.1) or cleared assignments (Story 22.4) — only take the shortcut
        // when both blocked set and assignments are unchanged.
        const priorBlocked = primaryChange.priorBlockedFeatureIds ?? [];
        const nextBlocked = primaryChange.blockedFeatureIds ?? [];
        const blockedUnchanged =
          priorBlocked.length === nextBlocked.length &&
          priorBlocked.every((id, i) => id === nextBlocked[i]);
        const assignmentsUnchanged =
          !primaryChange.clearedAssignments || primaryChange.clearedAssignments.length === 0;
        const added = next.filter((id) => !prior.includes(id));
        const removed = prior.filter((id) => !next.includes(id));

        // Pure single append: next === [...prior, added[0]]
        const isPureAppend =
          added.length === 1 &&
          removed.length === 0 &&
          next.length === prior.length + 1 &&
          next[next.length - 1] === added[0] &&
          next.slice(0, prior.length).every((id, i) => id === prior[i]) &&
          priorGroups === nextGroups &&
          blockedUnchanged &&
          assignmentsUnchanged;
        if (isPureAppend) {
          return Object.freeze({ type: 'SetForecastMembership', featureId: added[0], included: false });
        }

        // Pure removal of the last prior element: prior === [...next, removed[0]]
        const isPureTailRemoval =
          removed.length === 1 &&
          added.length === 0 &&
          prior.length === next.length + 1 &&
          prior[prior.length - 1] === removed[0] &&
          prior.slice(0, next.length).every((id, i) => id === next[i]) &&
          priorGroups === nextGroups &&
          blockedUnchanged &&
          assignmentsUnchanged;
        if (isPureTailRemoval) {
          return Object.freeze({ type: 'SetForecastMembership', featureId: removed[0], included: true });
        }

        return Object.freeze({
          type: 'RestoreForecastScope',
          selectedFeatureIds: prior,
          parallelGroups: primaryChange.priorParallelGroups,
          blockedFeatureIds: priorBlocked,
          ...(primaryChange.priorAssignments ? { assignments: primaryChange.priorAssignments } : {}),
        });
      }

    // ── Epic 19 Inversions (Story 19.2) ──────────────────────────────
    case 'ForecastOrderSet':
      // Story 27.2: a single-move origin inverts to a single move (AC 27.2-3);
      // a legacy whole-list change keeps its whole-list inverse.
      if (primaryChange.priorMove) {
        return Object.freeze({
          type: 'MoveForecastFeature',
          featureId: primaryChange.priorMove.featureId,
          afterId: primaryChange.priorMove.afterId,
          beforeId: primaryChange.priorMove.beforeId,
          intendedIndex: primaryChange.priorMove.intendedIndex,
          groupChange: primaryChange.priorMove.groupChange,
        });
      }
      return Object.freeze({
        type: 'ReorderForecastFeatures',
        featureIds: primaryChange.priorSelectedFeatureIds,
      });

    case 'ForecastSequenceSet':
      if (primaryChange.priorMove) {
        return Object.freeze({
          type: 'MoveForecastFeature',
          featureId: primaryChange.priorMove.featureId,
          afterId: primaryChange.priorMove.afterId,
          beforeId: primaryChange.priorMove.beforeId,
          intendedIndex: primaryChange.priorMove.intendedIndex,
          groupChange: primaryChange.priorMove.groupChange,
        });
      }
      return Object.freeze({
        type: 'SetForecastSequence',
        featureIds: primaryChange.priorSelectedFeatureIds,
        parallelGroups: primaryChange.priorParallelGroups,
      });

    case 'ForecastParallelGroupsSet':
      return Object.freeze({
        type: 'SetForecastParallelGroups',
        parallelGroups: primaryChange.priorParallelGroups,
      });

    // ── Epic 20 Inversions (Story 20.1) ──────────────────────────────
    case 'ForecastBlockerSet':
      return Object.freeze({
        type: 'SetForecastBlocker',
        featureId: primaryChange.featureId,
        blocked: primaryChange.priorBlocked,
      });

    // ── Epic 20 Inversions (Story 20.4) ──────────────────────────────
    case 'ForecastScenarioCreated':
    case 'ForecastScenarioRestored':
      return Object.freeze({ type: 'RemoveForecastScenario', scenarioId: primaryChange.scenario.scenarioId });

    case 'ForecastScenarioRemoved':
      return Object.freeze({ type: 'RestoreForecastScenario', scenario: primaryChange.scenario });

    // ── Epic 21 Inversions (Story 21.7) ──────────────────────────────
    case 'ForecastPlanningLevelSet':
      return Object.freeze({
        type: 'RestoreForecastPlanningLevel',
        planningLevel: primaryChange.priorPlanningLevel,
        selectedFeatureIds: primaryChange.priorSelectedFeatureIds,
        parallelGroups: primaryChange.priorParallelGroups,
        blockedFeatureIds: primaryChange.priorBlockedFeatureIds,
        ...(primaryChange.priorAssignments ? { assignments: primaryChange.priorAssignments } : {}),
      });

    // ── Epic 22 Inversions (Story 22.3, Story 22.4) ──────────────────
    case 'ForecastPersonAdded':
      return Object.freeze({
        type: 'RemoveForecastPerson',
        personId: primaryChange.person.id,
      });

    case 'ForecastPersonUpdated':
      return Object.freeze({
        type: 'UpdateForecastPerson',
        personId: primaryChange.personId,
        name: primaryChange.priorName,
        weightUnits: primaryChange.priorWeightUnits,
      });

    case 'ForecastPersonRemoved':
      return Object.freeze({
        type: 'RestoreForecastPerson',
        person: primaryChange.person,
        ...(primaryChange.priorAssignments ? { assignments: primaryChange.priorAssignments } : {}),
      });

    case 'ForecastPersonRestored':
      return Object.freeze({
        type: 'RemoveForecastPerson',
        personId: primaryChange.person.id,
      });

    case 'ForecastAssignmentsSet':
      return Object.freeze({
        type: 'SetForecastAssignments',
        featureId: primaryChange.featureId,
        personIds: primaryChange.priorPersonIds,
      });

    case 'ForecastPolicySet':
      return Object.freeze({
        type: 'SetForecastPolicy',
        policyVersion: primaryChange.priorPolicyVersion,
      });

    default:
      return null;
  }
}
