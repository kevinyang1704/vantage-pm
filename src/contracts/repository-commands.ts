import { validateDeletionBundle } from './deletion-bundle';
/**
 * Repository command contracts (Epic 1, Epic 2, Epic 3, AD-4, AD-7, AD-8, AD-9, AD-16).
 *
 * Defines the wire-format discriminated union of product domain commands
 * that flow through the repository worker. Each command carries the
 * protocol envelope (protocolVersion, expectedRevision) required by the
 * Gate-A-qualified commit pipeline.
 */

import {
  PROTOCOL_VERSION,
  assertUuidV7,
} from '../../spikes/phase-0-durability/src/command-receipt';

export { PROTOCOL_VERSION };

import type { CreateProjectCommand as DomainCreateProject } from '../domain/project/create-project.command';
import type { RenameProjectCommand as DomainRenameProject } from '../domain/project/rename-project.command';
import type { CreateNodeCommand as DomainCreateNode } from '../domain/tree/create-node.command';
import type { SetNodeTitleCommand as DomainSetNodeTitle } from '../domain/tree/set-node-title.command';
import type { SetNodeBodyTextCommand as DomainSetNodeBodyText } from '../domain/tree/set-node-body-text.command';
import type { MoveNodeCommand as DomainMoveNode } from '../domain/tree/move-node.command';
import type { SetNodeTypeCommand as DomainSetNodeType } from '../domain/tree/set-node-type.command';
import type { SetNodeCustomFieldCommand as DomainSetNodeCustomField } from '../domain/tree/set-node-custom-field.command';
import type { PromoteFieldToTemplateCommand as DomainPromoteFieldToTemplate } from '../domain/tree/promote-field-to-template.command';
import type { SetNodeScheduleCommand as DomainSetNodeSchedule } from '../domain/tree/set-node-schedule.command';
import type { ToggleNodeCompletedCommand as DomainToggleNodeCompleted } from '../domain/tree/toggle-node-completed.command';
import type { SetNodeEffortCommand as DomainSetNodeEffort } from '../domain/tree/set-node-effort.command';
import type { SetNodePointsDoneCommand as DomainSetNodePointsDone } from '../domain/tree/set-node-points-done.command';
import type { SetNodeStatusCommand as DomainSetNodeStatus } from '../domain/tree/set-node-status.command';
import type { SetThemeWeightCommand as DomainSetThemeWeight } from '../domain/tree/set-theme-weight.command';
import type {
  CreatePhaseCommand as DomainCreatePhase,
  RenamePhaseCommand as DomainRenamePhase,
  ReorderPhasesCommand as DomainReorderPhases,
  AssignNodePhaseCommand as DomainAssignNodePhase,
  DeletePhaseCommand as DomainDeletePhase,
  RestorePhaseCommand as DomainRestorePhase,
} from '../domain/phase/phase.commands';
import type {
  CreateUnlockEdgeCommand as DomainCreateUnlockEdge,
  DeleteUnlockEdgeCommand as DomainDeleteUnlockEdge,
} from '../domain/edge/unlock-edge.commands';
import type { DeliveryStatus, NodeType, ScheduleSourceMode } from '../domain/tree/node.entity';
import type { ChangeSet } from './change-set';

// ── Wire-format command types ──────────────────────────────────────────────

export type CreateProjectCommand = Readonly<{
  type: 'CreateProject';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: 0;
  expectedRevision: 1;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  name: string;
}>;

export type RenameProjectCommand = Readonly<{
  type: 'RenameProject';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  name: string;
}>;

/** Wire-format DeleteProject command with protocol envelope (Story 1.10 wiring). */
export type DeleteProjectWireCommand = Readonly<{
  type: 'DeleteProject';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
}>;

export type CreateNodeWireCommand = Readonly<{
  type: 'CreateNode';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  nodeId: string;
  parentId: string | null;
  position: string; // decimal string
  title: string;
}>;

export type SetNodeTitleWireCommand = Readonly<{
  type: 'SetNodeTitle';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  nodeId: string;
  title: string;
}>;

export type SetNodeBodyTextWireCommand = Readonly<{
  type: 'SetNodeBodyText';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  nodeId: string;
  bodyText: string | null;
}>;

export type MoveNodeWireCommand = Readonly<{
  type: 'MoveNode';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  nodeId: string;
  newParentId: string | null;
  newPosition: string; // decimal string
  /**
   * Optional D8(c) placement intent (Story 27.2, R3). When present, the shared
   * path resolves the placement from the anchors and index instead of the bare
   * decimal position; when absent, local behavior is exactly as before. Either
   * anchor may be null at a collection end.
   */
  afterId?: string | null;
  beforeId?: string | null;
  intendedIndex?: number;
}>;

export type DeleteSubtreeWireCommand = Readonly<{
  type: 'DeleteSubtree';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  nodeId: string;
}>;

export type DuplicateSubtreeWireCommand = Readonly<{
  type: 'DuplicateSubtree';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  sourceNodeId: string;
  newRootId: string;
  idMap: Readonly<Record<string, string>>;
  newPosition: string; // decimal string
}>;

export type RestoreSubtreeWireCommand = Readonly<{
  type: 'RestoreSubtree';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  rootNodeId: string;
  nodes: readonly import('./change-set').NodeSnapshot[];
  deletionBundle?: import('./deletion-bundle').DeletionBundle;
}>;

// ── Epic 3 Wire Commands ───────────────────────────────────────────

export type SetNodeTypeWireCommand = Readonly<{
  type: 'SetNodeType';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  nodeId: string;
  nodeType: NodeType | null;
}>;

export type SetNodeCustomFieldWireCommand = Readonly<{
  type: 'SetNodeCustomField';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  nodeId: string;
  fieldKey: string;
  fieldValue: string | null;
}>;

export type PromoteFieldToTemplateWireCommand = Readonly<{
  type: 'PromoteFieldToTemplate';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  nodeType: NodeType;
  fieldKey: string;
  fieldLabel: string;
}>;

export type SetNodeScheduleWireCommand = Readonly<{
  type: 'SetNodeSchedule';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  nodeId: string;
  startDate: string | null;
  endDate: string | null;
  durationDays: number | null;
  sourceMode: ScheduleSourceMode;
}>;

export type ToggleNodeCompletedWireCommand = Readonly<{
  type: 'ToggleNodeCompleted';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  nodeId: string;
  completed: boolean;
}>;

export type SetNodeEffortWireCommand = Readonly<{
  type: 'SetNodeEffort';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  nodeId: string;
  effortPoints: number | null;
  /** Restored assignments when un-zeroing an estimate (Story 22.4, SF-FR21) */
  restoredAssignments?: readonly string[];
}>;

export type SetNodePointsDoneWireCommand = Readonly<{
  type: 'SetNodePointsDone';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  nodeId: string;
  effortPointsDone: number | null;
}>;

export type SetNodeStatusWireCommand = Readonly<{
  type: 'SetNodeStatus';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  nodeId: string;
  deliveryStatus: DeliveryStatus;
}>;

export type SetThemeWeightWireCommand = Readonly<{
  type: 'SetThemeWeight';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  nodeId: string;
  strategicWeight: number | null;
}>;

export type CreatePhaseWireCommand = Readonly<{
  type: 'CreatePhase';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  phaseId: string;
  name: string;
  position: string; // decimal string
}>;

export type RenamePhaseWireCommand = Readonly<{
  type: 'RenamePhase';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  phaseId: string;
  name: string;
}>;

export type ReorderPhasesWireCommand = Readonly<{
  type: 'ReorderPhases';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  phases: readonly Readonly<{ phaseId: string; position: string }>[];
}>;

/**
 * Move one phase to a new place among its siblings (Story 27.2, D8(c), R3).
 * Anchors plus intended index; either anchor may be null at an end.
 */
export type MovePhaseWireCommand = Readonly<{
  type: 'MovePhase';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  phaseId: string;
  afterId: string | null;
  beforeId: string | null;
  intendedIndex: number;
}>;

export type AssignNodePhaseWireCommand = Readonly<{
  type: 'AssignNodePhase';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  nodeId: string;
  phaseId: string | null;
}>;

export type DeletePhaseWireCommand = Readonly<{
  type: 'DeletePhase';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  phaseId: string;
  reassignments: Readonly<Record<string, string | null>>;
}>;

export type RestorePhaseWireCommand = Readonly<{
  type: 'RestorePhase';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  phaseId: string;
  name: string;
  position: string;
  priorAssignments: Readonly<Record<string, string | null>>;
}>;

export type CreateUnlockEdgeWireCommand = Readonly<{
  type: 'CreateUnlockEdge';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
}>;

export type DeleteUnlockEdgeWireCommand = Readonly<{
  type: 'DeleteUnlockEdge';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  edgeId: string;
  sourceNodeId?: string;
  targetNodeId?: string;
}>;

// ── Epic 4 Wire Commands ──────────────────────────────────────────
export type DismissFindingWireCommand = Readonly<{
  type: 'DismissFinding';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  findingId: string;
  findingKind: 'OrphanedFeature' | 'PhaseSequencingConflict' | 'DateSequencingConflict' | 'UnlockCycle' | 'StrategicImbalance' | 'ExplicitOverrideBoundaryViolation';
  targetId: string;
  fingerprint: string;
  dismissedAt: string;
}>;

export type UndismissFindingWireCommand = Readonly<{
  type: 'UndismissFinding';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  findingId: string;
  findingKind: 'OrphanedFeature' | 'PhaseSequencingConflict' | 'DateSequencingConflict' | 'UnlockCycle' | 'StrategicImbalance' | 'ExplicitOverrideBoundaryViolation';
  targetId: string;
  fingerprint: string;
}>;

export type RecordAffectedReasonsWireCommand = Readonly<{
  type: 'RecordAffectedReasons';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  reasons: readonly Readonly<{
    id: string;
    affectedNodeId: string;
    causalNodeId: string;
    causalNodeTitle: string;
    deltaDays: number;
    causalDateSummary: string;
    createdAt: string;
  }>[];
}>;

export type AcknowledgeAffectedReasonWireCommand = Readonly<{
  type: 'AcknowledgeAffectedReason';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  reasonId: string;
  acknowledgedAt: string;
}>;

export type ClearNodeAffectedReasonsWireCommand = Readonly<{
  type: 'ClearNodeAffectedReasons';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  nodeId: string;
}>;

// ── Epic 16 Wire Commands (Story 16.1, E16-AR1) ──────────────────────

export type AddNodeQuestionWireCommand = Readonly<{
  type: 'AddNodeQuestion';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  questionId: string;
  nodeId: string;
  questionText: string;
  position: string; // decimal string
  createdAtISO: string;
}>;

export type UpdateNodeQuestionWireCommand = Readonly<{
  type: 'UpdateNodeQuestion';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  questionId: string;
  questionText: string;
}>;

export type ResolveNodeQuestionWireCommand = Readonly<{
  type: 'ResolveNodeQuestion';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  questionId: string;
  decisionText: string;
  resolvedAtISO: string;
}>;

export type ReorderNodeQuestionsWireCommand = Readonly<{
  type: 'ReorderNodeQuestions';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  nodeId: string;
  questionIds: readonly string[];
}>;

/**
 * Move one node question among its siblings (Story 27.2, D8(c), R3). Anchors
 * plus intended index; either anchor may be null at an end.
 */
export type MoveNodeQuestionWireCommand = Readonly<{
  type: 'MoveNodeQuestion';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  nodeId: string;
  questionId: string;
  afterId: string | null;
  beforeId: string | null;
  intendedIndex: number;
}>;

export type DeleteNodeQuestionWireCommand = Readonly<{
  type: 'DeleteNodeQuestion';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  questionId: string;
}>;

// ── Epic 18 Wire Commands (Story 18.1, Story 18.2) ─────────────────────

export type ConfigureForecastPlanWireCommand = Readonly<{
  type: 'ConfigureForecastPlan';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  pointsPerSprint: number | null;
  sprintLengthDays: number | null;
  startSprintOrdinal: number | null;
  startDate: string | null;
  /** Optional planning level applied atomically with the configuration (Story 21.13 D5); null preserves the current level. */
  planningLevel: import('../domain/forecast/forecast-plan.entity').ForecastNodeLevel | null;
}>;

export type SetForecastMembershipWireCommand = Readonly<{
  type: 'SetForecastMembership';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  featureId: string;
  included: boolean;
}>;

/** Undo-side inverse of plan creation (Story 21.13, D5). */
export type RemoveForecastPlanWireCommand = Readonly<{
  type: 'RemoveForecastPlan';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
}>;

// ── Epic 20 Wire Commands (Story 20.1) ────────────────────────────────

export type SetForecastBlockerWireCommand = Readonly<{
  type: 'SetForecastBlocker';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  featureId: string;
  blocked: boolean;
}>;

// ── Epic 20 Wire Commands (Story 20.4) ────────────────────────────────

export type CreateForecastScenarioWireCommand = Readonly<{
  type: 'CreateForecastScenario';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  scenarioId: string;
  label: string;
  baselineRevision: number;
  expectedMaterialFingerprint: string;
  createdAtISO: string;
  patch: import('../domain/forecast/scenario').ForecastScenarioPatch;
}>;

export type RemoveForecastScenarioWireCommand = Readonly<{
  type: 'RemoveForecastScenario';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  scenarioId: string;
}>;

export type RestoreForecastScenarioWireCommand = Readonly<{
  type: 'RestoreForecastScenario';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  scenario: import('../domain/forecast/scenario').PersistedForecastScenario;
}>;

// ── Epic 19 Wire Commands (Story 19.2) ─────────────────────────────────

export type ReorderForecastFeaturesWireCommand = Readonly<{
  type: 'ReorderForecastFeatures';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  featureIds: readonly string[];
}>;

export type SetForecastSequenceWireCommand = Readonly<{
  type: 'SetForecastSequence'; protocolVersion: typeof PROTOCOL_VERSION; commandId: string; projectId: string;
  baseRevision: number; expectedRevision: number; actorId?: string; featureIds: readonly string[];
  parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
}>;

export type SetForecastParallelGroupsWireCommand = Readonly<{
  type: 'SetForecastParallelGroups';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
}>;

export type RestoreForecastScopeWireCommand = Readonly<{
  type: 'RestoreForecastScope';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  selectedFeatureIds: readonly string[];
  parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
  /** Blocked set to restore alongside scope/groups (Epic 20, Story 20.1). */
  blockedFeatureIds: readonly string[];
  /** Assignments to restore alongside scope/groups (Story 22.4). */
  assignments?: Readonly<Record<string, readonly string[]>>;
}>;

// ── Epic 21 Wire Commands (Story 21.7, D4/D7) ─────────────────────────

export type SetForecastPlanningLevelWireCommand = Readonly<{
  type: 'SetForecastPlanningLevel';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  planningLevel: import('../domain/forecast/forecast-plan.entity').ForecastNodeLevel;
}>;

export type RestoreForecastPlanningLevelWireCommand = Readonly<{
  type: 'RestoreForecastPlanningLevel';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  planningLevel: import('../domain/forecast/forecast-plan.entity').ForecastNodeLevel;
  selectedFeatureIds: readonly string[];
  parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
  blockedFeatureIds: readonly string[];
  /** Assignments to restore alongside level/scope (Story 22.4). */
  assignments?: Readonly<Record<string, readonly string[]>>;
}>;

// ── Epic 22 Commands (Story 22.3, Story 22.4) ──────────────────────

export type AddForecastPersonWireCommand = Readonly<{
  type: 'AddForecastPerson';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  personId: string;
  name: string;
  weightUnits: number;
}>;

export type UpdateForecastPersonWireCommand = Readonly<{
  type: 'UpdateForecastPerson';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  personId: string;
  name: string;
  weightUnits: number;
}>;

export type RemoveForecastPersonWireCommand = Readonly<{
  type: 'RemoveForecastPerson';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  personId: string;
}>;

export type RestoreForecastPersonWireCommand = Readonly<{
  type: 'RestoreForecastPerson';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  person: import('../domain/forecast/forecast-plan.entity').ForecastPerson;
  /** Assignments to restore alongside person (Story 22.4). */
  assignments?: Readonly<Record<string, readonly string[]>>;
}>;

export type SetForecastAssignmentsWireCommand = Readonly<{
  type: 'SetForecastAssignments';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  featureId: string;
  personIds: readonly string[];
}>;

export type SetForecastPolicyWireCommand = Readonly<{
  type: 'SetForecastPolicy';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  policyVersion: import('../domain/forecast/forecast-plan.entity').ForecastPolicyVersion;
}>;

/**
 * Move one scope member in forecast priority order with an optional group
 * change (Story 27.2, D8(c), R3). Anchors plus intended index; either anchor
 * may be null at an end.
 */
export type MoveForecastFeatureWireCommand = Readonly<{
  type: 'MoveForecastFeature';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  featureId: string;
  afterId: string | null;
  beforeId: string | null;
  intendedIndex: number;
  groupChange: import('../domain/forecast/forecast.commands').ForecastGroupChange;
}>;

/**
 * Assign or unassign one roster person on one forecast item (Story 27.2, D8(d)).
 */
export type SetForecastAssignmentWireCommand = Readonly<{
  type: 'SetForecastAssignment';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  expectedRevision: number;
  /** Actor identity (Story 27.3). Optional on the wire; the repository stamps it. */
  actorId?: string;
  featureId: string;
  personId: string;
  assigned: boolean;
}>;

/** Discriminated union of all product domain commands. */
export type ProductCommand =
  | CreateProjectCommand
  | RenameProjectCommand
  | DeleteProjectWireCommand
  | CreateNodeWireCommand
  | SetNodeTitleWireCommand
  | SetNodeBodyTextWireCommand
  | MoveNodeWireCommand
  | DeleteSubtreeWireCommand
  | DuplicateSubtreeWireCommand
  | RestoreSubtreeWireCommand
  // Epic 3 commands
  | SetNodeTypeWireCommand
  | SetNodeCustomFieldWireCommand
  | PromoteFieldToTemplateWireCommand
  | SetNodeScheduleWireCommand
  | ToggleNodeCompletedWireCommand
  | SetNodeEffortWireCommand
  | SetNodePointsDoneWireCommand
  | SetNodeStatusWireCommand
  | SetThemeWeightWireCommand
  | CreatePhaseWireCommand
  | RenamePhaseWireCommand
  | ReorderPhasesWireCommand
  | MovePhaseWireCommand
  | AssignNodePhaseWireCommand
  | DeletePhaseWireCommand
  | RestorePhaseWireCommand
  | CreateUnlockEdgeWireCommand
  | DeleteUnlockEdgeWireCommand
  // Epic 4 commands
  | DismissFindingWireCommand
  | UndismissFindingWireCommand
  | RecordAffectedReasonsWireCommand
  | AcknowledgeAffectedReasonWireCommand
  | ClearNodeAffectedReasonsWireCommand
  // Epic 16 commands
  | AddNodeQuestionWireCommand
  | UpdateNodeQuestionWireCommand
  | ResolveNodeQuestionWireCommand
  | ReorderNodeQuestionsWireCommand
  | MoveNodeQuestionWireCommand
  | DeleteNodeQuestionWireCommand
  // Epic 18 commands
  | ConfigureForecastPlanWireCommand
  | SetForecastMembershipWireCommand
  // Epic 21 commands (Story 21.13 D5)
  | RemoveForecastPlanWireCommand
  // Epic 19 commands
  | ReorderForecastFeaturesWireCommand
  | SetForecastSequenceWireCommand
  | SetForecastParallelGroupsWireCommand
  | RestoreForecastScopeWireCommand
  // Epic 20 commands
  | SetForecastBlockerWireCommand
  | CreateForecastScenarioWireCommand
  | RemoveForecastScenarioWireCommand
  | RestoreForecastScenarioWireCommand
  // Epic 21 commands
  | SetForecastPlanningLevelWireCommand
  | RestoreForecastPlanningLevelWireCommand
  // Epic 22 commands (Story 22.3, Story 22.4)
  | AddForecastPersonWireCommand
  | UpdateForecastPersonWireCommand
  | RemoveForecastPersonWireCommand
  | RestoreForecastPersonWireCommand
  | SetForecastAssignmentsWireCommand
  | SetForecastPolicyWireCommand
  | MoveForecastFeatureWireCommand
  | SetForecastAssignmentWireCommand;

/** Command outcome union. */
export type CommandOutcome =
  | Readonly<{ type: 'CommandDispatched'; commandId: string; projectId: string; result: ProductCommandResult }>
  | Readonly<{ type: 'DependencyRejected'; commandId: string; blockedByCommandId: string; cause: string }>;

/** Successful command application result. */
export type ProductCommandApplied = Readonly<{
  type: 'ProductCommandApplied';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  projectId: string;
  baseRevision: number;
  targetRevision: number;
  outcome: 'VfsCommitAccepted';
  disposition: 'NewCommit' | 'StoredResultReturned';
  changeSet?: ChangeSet;
}>;

/** Typed rejection for product commands. */
export type ProductCommandRejected = Readonly<{
  type: 'ProductCommandRejected';
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  code:
    | 'INVALID_NODE_STATUS'
    | 'INVALID_DELETION_BUNDLE'
    | 'RESTORE_IDENTITY_CONFLICT'
    | 'RESTORE_POSITION_CONFLICT'
    | 'RESTORE_DEPENDENCY_MISSING'
    | 'SHARED_BUNDLED_RESTORE_UNAVAILABLE'
    | 'SHARED_ATOMIC_GROUP_UNAVAILABLE'
    | 'ATOMIC_GROUP_REJECTED'
    | 'VIEWER_CANNOT_WRITE'
    | 'SHARED_PROJECT_READ_ONLY'
    | 'SHARED_PROJECT_NOT_CONNECTED'
    | 'REVISION_CONFLICT'
    | 'PROJECT_NOT_FOUND'
    | 'COMMAND_IDENTITY_CONFLICT'
    | 'NODE_NOT_FOUND'
    | 'PARENT_NOT_FOUND'
    | 'CYCLE_DETECTED'
    | 'PHASE_NOT_FOUND'
    | 'EDGE_CONFLICT'
    | 'FIELD_CONFLICT'
    | 'HIERARCHY_CONFLICT'
    | 'FORECAST_SCOPE_INVALID'
    | 'FORECAST_GROUP_INVALID'
    | 'FORECAST_GROUP_SPLIT'
    | 'FORECAST_CONFIG_INVALID'
    | 'FORECAST_POLICY_UNSUPPORTED'
    | 'FORECAST_BLOCKER_INVALID'
    | 'FORECAST_SCENARIO_INVALID'
    | 'FORECAST_SCENARIO_STALE'
    | 'FORECAST_SCENARIO_NOT_FOUND'
    | 'FORECAST_PERSON_INVALID'
    | 'FORECAST_PERSON_NOT_FOUND'
    | 'FORECAST_PERSON_ASSIGNED'
    | 'FORECAST_PERSON_EXISTS'
    | 'FORECAST_ASSIGNMENT_INVALID'
    | 'FORECAST_ASSIGNMENT_CONFLICT'
    | 'FORECAST_ASSIGNMENT_ZERO_WORK'
    | 'FORECAST_POLICY_INVALID'
    | 'FORECAST_PLAN_CORRUPT'
    | 'EFFORT_BELOW_POINTS_DONE'
    | 'POINTS_DONE_CONFLICT'
    | 'UNSUPPORTED_NEWER_SCHEMA'
    | 'SELF_ANCHOR'
    | 'INVALID_PLACEMENT'
    | 'CHANGED_BY_OTHER_ACTOR';
  expectedRevision?: number;
  projectId?: string;
  nodeId?: string;
  personId?: string;
  conflictingFeatureIds?: readonly string[];
  featureId?: string;
  column?: string;
  /** Story 26.5: the recorded points done that refuses a lower estimate. */
  priorPointsDone?: number;
}>;

/** Result of applying a product command. */
export type ProductCommandResult = ProductCommandApplied | ProductCommandRejected;

// ── Constructors ───────────────────────────────────────────────────────────

export function createCreateProjectCommand(domain: DomainCreateProject): CreateProjectCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  if (domain.baseRevision !== 0) throw new Error('INVALID_BASE_REVISION');
  if (typeof domain.name !== 'string') throw new Error('INVALID_PROJECT_NAME');
  return Object.freeze({
    type: 'CreateProject',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: 0 as const,
    expectedRevision: 1 as const,
    name: domain.name,
  });
}

export function createRenameProjectCommand(domain: DomainRenameProject): RenameProjectCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  if (typeof domain.name !== 'string') throw new Error('INVALID_PROJECT_NAME');
  return Object.freeze({
    type: 'RenameProject',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    name: domain.name,
  });
}

export function createDeleteProjectWireCommand(
  domain: import('../domain/project/delete-project.command').DeleteProjectCommand,
): DeleteProjectWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'DeleteProject',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
  });
}

export function createCreateNodeWireCommand(domain: DomainCreateNode): CreateNodeWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.nodeId, 'nodeId');
  if (domain.parentId) assertUuidV7(domain.parentId, 'parentId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'CreateNode',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    nodeId: domain.nodeId,
    parentId: domain.parentId,
    position: domain.position.toString(),
    title: domain.title,
  });
}

export function createSetNodeTitleWireCommand(domain: DomainSetNodeTitle): SetNodeTitleWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.nodeId, 'nodeId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'SetNodeTitle',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    nodeId: domain.nodeId,
    title: domain.title,
  });
}

export function createSetNodeBodyTextWireCommand(domain: DomainSetNodeBodyText): SetNodeBodyTextWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.nodeId, 'nodeId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'SetNodeBodyText',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    nodeId: domain.nodeId,
    bodyText: domain.bodyText,
  });
}

export function createMoveNodeWireCommand(domain: DomainMoveNode): MoveNodeWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.nodeId, 'nodeId');
  if (domain.newParentId) assertUuidV7(domain.newParentId, 'newParentId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'MoveNode',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    nodeId: domain.nodeId,
    newParentId: domain.newParentId,
    newPosition: domain.newPosition.toString(),
  });
}

/**
 * Build a MoveNode wire command with explicit D8(c) placement intent (Story
 * 27.2). The decimal `newPosition` is still required for local compatibility;
 * the anchors and index are what the shared path resolves from.
 */
export function createAnchorMoveNodeWireCommand(domain: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  newParentId: string | null;
  newPosition: bigint;
  afterId: string | null;
  beforeId: string | null;
  intendedIndex: number;
}): MoveNodeWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.nodeId, 'nodeId');
  if (domain.newParentId) assertUuidV7(domain.newParentId, 'newParentId');
  if (domain.afterId) assertUuidV7(domain.afterId, 'afterId');
  if (domain.beforeId) assertUuidV7(domain.beforeId, 'beforeId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(domain.intendedIndex) || domain.intendedIndex < 0) throw new Error('INVALID_INTENDED_INDEX');
  return Object.freeze({
    type: 'MoveNode',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    nodeId: domain.nodeId,
    newParentId: domain.newParentId,
    newPosition: domain.newPosition.toString(),
    afterId: domain.afterId,
    beforeId: domain.beforeId,
    intendedIndex: domain.intendedIndex,
  });
}

export function createDeleteSubtreeWireCommand(domain: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
}): DeleteSubtreeWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.nodeId, 'nodeId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'DeleteSubtree',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    nodeId: domain.nodeId,
  });
}

export function createDuplicateSubtreeWireCommand(domain: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  sourceNodeId: string;
  newRootId: string;
  idMap: Readonly<Record<string, string>>;
  newPosition: bigint;
}): DuplicateSubtreeWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.sourceNodeId, 'sourceNodeId');
  assertUuidV7(domain.newRootId, 'newRootId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'DuplicateSubtree',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    sourceNodeId: domain.sourceNodeId,
    newRootId: domain.newRootId,
    idMap: domain.idMap,
    newPosition: domain.newPosition.toString(),
  });
}

export function createRestoreSubtreeWireCommand(domain: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  rootNodeId: string;
  nodes: readonly import('./change-set').NodeSnapshot[];
  deletionBundle?: import('./deletion-bundle').DeletionBundle;
}): RestoreSubtreeWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.rootNodeId, 'rootNodeId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'RestoreSubtree',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    rootNodeId: domain.rootNodeId,
    nodes: Object.freeze(domain.nodes.map(node => Object.freeze({...node}))),
    ...(domain.deletionBundle === undefined ? {} : { deletionBundle: validateDeletionBundle(domain.deletionBundle, domain.projectId, domain.rootNodeId, domain.nodes) }),
  });
}

export function createSetNodeTypeWireCommand(domain: DomainSetNodeType): SetNodeTypeWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.nodeId, 'nodeId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'SetNodeType',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    nodeId: domain.nodeId,
    nodeType: domain.nodeType,
  });
}

export function createSetNodeCustomFieldWireCommand(domain: DomainSetNodeCustomField): SetNodeCustomFieldWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.nodeId, 'nodeId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'SetNodeCustomField',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    nodeId: domain.nodeId,
    fieldKey: domain.fieldKey,
    fieldValue: domain.fieldValue,
  });
}

export function createPromoteFieldToTemplateWireCommand(domain: DomainPromoteFieldToTemplate): PromoteFieldToTemplateWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'PromoteFieldToTemplate',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    nodeType: domain.nodeType,
    fieldKey: domain.fieldKey,
    fieldLabel: domain.fieldLabel,
  });
}

export function createSetNodeScheduleWireCommand(domain: DomainSetNodeSchedule): SetNodeScheduleWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.nodeId, 'nodeId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'SetNodeSchedule',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    nodeId: domain.nodeId,
    startDate: domain.startDate,
    endDate: domain.endDate,
    durationDays: domain.durationDays,
    sourceMode: domain.sourceMode,
  });
}

export function createToggleNodeCompletedWireCommand(domain: DomainToggleNodeCompleted): ToggleNodeCompletedWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.nodeId, 'nodeId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'ToggleNodeCompleted',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    nodeId: domain.nodeId,
    completed: domain.completed,
  });
}

export function createSetNodeEffortWireCommand(domain: DomainSetNodeEffort): SetNodeEffortWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.nodeId, 'nodeId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'SetNodeEffort',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    nodeId: domain.nodeId,
    effortPoints: domain.effortPoints,
    ...(domain.restoredAssignments ? { restoredAssignments: Object.freeze([...domain.restoredAssignments]) } : {}),
  });
}

export function createSetNodePointsDoneWireCommand(
  domain: DomainSetNodePointsDone,
): SetNodePointsDoneWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.nodeId, 'nodeId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'SetNodePointsDone',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    nodeId: domain.nodeId,
    effortPointsDone: domain.effortPointsDone,
  });
}

export function createSetNodeStatusWireCommand(domain: DomainSetNodeStatus): SetNodeStatusWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.nodeId, 'nodeId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'SetNodeStatus',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    nodeId: domain.nodeId,
    deliveryStatus: domain.deliveryStatus,
  });
}

export function createSetThemeWeightWireCommand(domain: DomainSetThemeWeight): SetThemeWeightWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.nodeId, 'nodeId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'SetThemeWeight',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    nodeId: domain.nodeId,
    strategicWeight: domain.strategicWeight,
  });
}

export function createCreatePhaseWireCommand(domain: DomainCreatePhase): CreatePhaseWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.phaseId, 'phaseId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'CreatePhase',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    phaseId: domain.phaseId,
    name: domain.name,
    position: domain.position.toString(),
  });
}

export function createRenamePhaseWireCommand(domain: DomainRenamePhase): RenamePhaseWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.phaseId, 'phaseId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'RenamePhase',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    phaseId: domain.phaseId,
    name: domain.name,
  });
}

export function createReorderPhasesWireCommand(domain: DomainReorderPhases): ReorderPhasesWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'ReorderPhases',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    phases: Object.freeze(domain.phases.map((p) => Object.freeze({ phaseId: p.phaseId, position: p.position.toString() }))),
  });
}

/** Build a MovePhase wire command (Story 27.2, D8(c), R3). */
export function createMovePhaseWireCommand(domain: import('../domain/phase/phase.commands').MovePhaseCommand): MovePhaseWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.phaseId, 'phaseId');
  if (domain.afterId) assertUuidV7(domain.afterId, 'afterId');
  if (domain.beforeId) assertUuidV7(domain.beforeId, 'beforeId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(domain.intendedIndex) || domain.intendedIndex < 0) throw new Error('INVALID_INTENDED_INDEX');
  return Object.freeze({
    type: 'MovePhase',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    phaseId: domain.phaseId,
    afterId: domain.afterId,
    beforeId: domain.beforeId,
    intendedIndex: domain.intendedIndex,
  });
}

export function createAssignNodePhaseWireCommand(domain: DomainAssignNodePhase): AssignNodePhaseWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.nodeId, 'nodeId');
  if (domain.phaseId) assertUuidV7(domain.phaseId, 'phaseId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'AssignNodePhase',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    nodeId: domain.nodeId,
    phaseId: domain.phaseId,
  });
}

export function createDeletePhaseWireCommand(domain: DomainDeletePhase): DeletePhaseWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.phaseId, 'phaseId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'DeletePhase',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    phaseId: domain.phaseId,
    reassignments: domain.reassignments,
  });
}

export function createRestorePhaseWireCommand(domain: DomainRestorePhase): RestorePhaseWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.phaseId, 'phaseId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'RestorePhase',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    phaseId: domain.phaseId,
    name: domain.name,
    position: domain.position.toString(),
    priorAssignments: domain.priorAssignments,
  });
}

export function createCreateUnlockEdgeWireCommand(domain: DomainCreateUnlockEdge): CreateUnlockEdgeWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.edgeId, 'edgeId');
  assertUuidV7(domain.sourceNodeId, 'sourceNodeId');
  assertUuidV7(domain.targetNodeId, 'targetNodeId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'CreateUnlockEdge',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    edgeId: domain.edgeId,
    sourceNodeId: domain.sourceNodeId,
    targetNodeId: domain.targetNodeId,
  });
}

export function createDeleteUnlockEdgeWireCommand(domain: DomainDeleteUnlockEdge): DeleteUnlockEdgeWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.edgeId, 'edgeId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'DeleteUnlockEdge',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    edgeId: domain.edgeId,
    sourceNodeId: domain.sourceNodeId,
    targetNodeId: domain.targetNodeId,
  });
}

// ── Epic 4 Domain Types & Constructors ────────────────────────────

export type DomainDismissFinding = Readonly<{
  commandId: string;
  projectId: string;
  baseRevision: number;
  findingId: string;
  findingKind: 'OrphanedFeature' | 'PhaseSequencingConflict' | 'DateSequencingConflict' | 'UnlockCycle' | 'StrategicImbalance' | 'ExplicitOverrideBoundaryViolation';
  targetId: string;
  fingerprint: string;
  dismissedAt: string;
}>;

export type DomainUndismissFinding = Readonly<{
  commandId: string;
  projectId: string;
  baseRevision: number;
  findingId: string;
  findingKind: 'OrphanedFeature' | 'PhaseSequencingConflict' | 'DateSequencingConflict' | 'UnlockCycle' | 'StrategicImbalance' | 'ExplicitOverrideBoundaryViolation';
  targetId: string;
  fingerprint: string;
}>;

export type DomainRecordAffectedReasons = Readonly<{
  commandId: string;
  projectId: string;
  baseRevision: number;
  reasons: readonly Readonly<{
    id: string;
    affectedNodeId: string;
    causalNodeId: string;
    causalNodeTitle: string;
    deltaDays: number;
    causalDateSummary: string;
    createdAt: string;
  }>[];
}>;

export type DomainAcknowledgeAffectedReason = Readonly<{
  commandId: string;
  projectId: string;
  baseRevision: number;
  reasonId: string;
  acknowledgedAt: string;
}>;

export type DomainClearNodeAffectedReasons = Readonly<{
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
}>;

export function createDismissFindingWireCommand(domain: DomainDismissFinding): DismissFindingWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'DismissFinding',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    findingId: domain.findingId,
    findingKind: domain.findingKind,
    targetId: domain.targetId,
    fingerprint: domain.fingerprint,
    dismissedAt: domain.dismissedAt,
  });
}

export function createUndismissFindingWireCommand(domain: DomainUndismissFinding): UndismissFindingWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'UndismissFinding',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    findingId: domain.findingId,
    findingKind: domain.findingKind,
    targetId: domain.targetId,
    fingerprint: domain.fingerprint,
  });
}

export function createRecordAffectedReasonsWireCommand(domain: DomainRecordAffectedReasons): RecordAffectedReasonsWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'RecordAffectedReasons',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    reasons: Object.freeze(domain.reasons.map((r) => Object.freeze({ ...r }))),
  });
}

export function createAcknowledgeAffectedReasonWireCommand(domain: DomainAcknowledgeAffectedReason): AcknowledgeAffectedReasonWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'AcknowledgeAffectedReason',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    reasonId: domain.reasonId,
    acknowledgedAt: domain.acknowledgedAt,
  });
}

export function createClearNodeAffectedReasonsWireCommand(domain: DomainClearNodeAffectedReasons): ClearNodeAffectedReasonsWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.nodeId, 'nodeId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'ClearNodeAffectedReasons',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    nodeId: domain.nodeId,
  });
}

// ── Epic 16 Constructors (Story 16.1) ─────────────────────────────────

export function createAddNodeQuestionWireCommand(domain: import('../domain/tree/node-question.commands').AddNodeQuestionCommand): AddNodeQuestionWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.questionId, 'questionId');
  assertUuidV7(domain.nodeId, 'nodeId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'AddNodeQuestion',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    questionId: domain.questionId,
    nodeId: domain.nodeId,
    questionText: domain.questionText,
    position: domain.position.toString(),
    createdAtISO: domain.createdAtISO,
  });
}

export function createUpdateNodeQuestionWireCommand(domain: import('../domain/tree/node-question.commands').UpdateNodeQuestionCommand): UpdateNodeQuestionWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.questionId, 'questionId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'UpdateNodeQuestion',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    questionId: domain.questionId,
    questionText: domain.questionText,
  });
}

export function createResolveNodeQuestionWireCommand(domain: import('../domain/tree/node-question.commands').ResolveNodeQuestionCommand): ResolveNodeQuestionWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.questionId, 'questionId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'ResolveNodeQuestion',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    questionId: domain.questionId,
    decisionText: domain.decisionText,
    resolvedAtISO: domain.resolvedAtISO,
  });
}

export function createReorderNodeQuestionsWireCommand(domain: import('../domain/tree/node-question.commands').ReorderNodeQuestionsCommand): ReorderNodeQuestionsWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.nodeId, 'nodeId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'ReorderNodeQuestions',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    nodeId: domain.nodeId,
    questionIds: Object.freeze([...domain.questionIds]),
  });
}

/** Build a MoveNodeQuestion wire command (Story 27.2, D8(c), R3). */
export function createMoveNodeQuestionWireCommand(
  domain: import('../domain/tree/node-question.commands').MoveNodeQuestionCommand,
): MoveNodeQuestionWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.nodeId, 'nodeId');
  assertUuidV7(domain.questionId, 'questionId');
  if (domain.afterId) assertUuidV7(domain.afterId, 'afterId');
  if (domain.beforeId) assertUuidV7(domain.beforeId, 'beforeId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(domain.intendedIndex) || domain.intendedIndex < 0) throw new Error('INVALID_INTENDED_INDEX');
  return Object.freeze({
    type: 'MoveNodeQuestion',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    nodeId: domain.nodeId,
    questionId: domain.questionId,
    afterId: domain.afterId,
    beforeId: domain.beforeId,
    intendedIndex: domain.intendedIndex,
  });
}

export function createDeleteNodeQuestionWireCommand(domain: import('../domain/tree/node-question.commands').DeleteNodeQuestionCommand): DeleteNodeQuestionWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.questionId, 'questionId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'DeleteNodeQuestion',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    questionId: domain.questionId,
  });
}

// ── Epic 18 Constructors (Story 18.1) ─────────────────────────────────

export function createConfigureForecastPlanWireCommand(
  domain: import('../domain/forecast/forecast.commands').ConfigureForecastPlanCommand,
): ConfigureForecastPlanWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'ConfigureForecastPlan',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    pointsPerSprint: domain.pointsPerSprint,
    sprintLengthDays: domain.sprintLengthDays,
    startSprintOrdinal: domain.startSprintOrdinal,
    startDate: domain.startDate,
    planningLevel: domain.planningLevel,
  });
}

export function createRemoveForecastPlanWireCommand(
  domain: import('../domain/forecast/forecast.commands').RemoveForecastPlanCommand,
): RemoveForecastPlanWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'RemoveForecastPlan',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
  });
}

export function createSetForecastMembershipWireCommand(
  domain: import('../domain/forecast/forecast.commands').SetForecastMembershipCommand,
): SetForecastMembershipWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.featureId, 'featureId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'SetForecastMembership',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    featureId: domain.featureId,
    included: domain.included,
  });
}

// ── Epic 20 Constructors (Story 20.1) ─────────────────────────────────

export function createSetForecastBlockerWireCommand(
  domain: import('../domain/forecast/forecast.commands').SetForecastBlockerCommand,
): SetForecastBlockerWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.featureId, 'featureId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'SetForecastBlocker',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    featureId: domain.featureId,
    blocked: domain.blocked,
  });
}

export function createCreateForecastScenarioWireCommand(
  domain: import('../domain/forecast/forecast.commands').CreateForecastScenarioCommand,
): CreateForecastScenarioWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.scenarioId, 'scenarioId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'CreateForecastScenario',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    scenarioId: domain.scenarioId,
    label: domain.label,
    baselineRevision: domain.baselineRevision,
    expectedMaterialFingerprint: domain.expectedMaterialFingerprint,
    createdAtISO: domain.createdAtISO,
    patch: domain.patch,
  });
}

export function createRemoveForecastScenarioWireCommand(
  domain: import('../domain/forecast/forecast.commands').RemoveForecastScenarioCommand,
): RemoveForecastScenarioWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.scenarioId, 'scenarioId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'RemoveForecastScenario',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    scenarioId: domain.scenarioId,
  });
}

export function createRestoreForecastScenarioWireCommand(
  domain: import('../domain/forecast/forecast.commands').RestoreForecastScenarioCommand,
): RestoreForecastScenarioWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.scenario.scenarioId, 'scenario.scenarioId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'RestoreForecastScenario',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    scenario: domain.scenario,
  });
}

// ── Epic 19 Constructors (Story 19.2) ─────────────────────────────────

export function createReorderForecastFeaturesWireCommand(
  domain: import('../domain/forecast/forecast.commands').ReorderForecastFeaturesCommand,
): ReorderForecastFeaturesWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'ReorderForecastFeatures',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    featureIds: Object.freeze([...domain.featureIds]),
  });
}

export function createSetForecastSequenceWireCommand(
  domain: import('../domain/forecast/forecast.commands').SetForecastSequenceCommand,
): SetForecastSequenceWireCommand {
  assertUuidV7(domain.commandId, 'commandId'); assertUuidV7(domain.projectId, 'projectId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({ type: 'SetForecastSequence', protocolVersion: PROTOCOL_VERSION, commandId: domain.commandId,
    projectId: domain.projectId, baseRevision: domain.baseRevision, expectedRevision: domain.baseRevision + 1,
    featureIds: Object.freeze([...domain.featureIds]), parallelGroups: Object.freeze(domain.parallelGroups.map((g) => Object.freeze({ featureIds: Object.freeze([...g.featureIds]) }))) });
}

export function createSetForecastParallelGroupsWireCommand(
  domain: import('../domain/forecast/forecast.commands').SetForecastParallelGroupsCommand,
): SetForecastParallelGroupsWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'SetForecastParallelGroups',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    parallelGroups: Object.freeze(
      domain.parallelGroups.map((g) => Object.freeze({ featureIds: Object.freeze([...g.featureIds]) })),
    ),
  });
}

export function createRestoreForecastScopeWireCommand(
  domain: import('../domain/forecast/forecast.commands').RestoreForecastScopeCommand,
): RestoreForecastScopeWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'RestoreForecastScope',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    selectedFeatureIds: Object.freeze([...domain.selectedFeatureIds]),
    parallelGroups: Object.freeze(
      domain.parallelGroups.map((g) => Object.freeze({ featureIds: Object.freeze([...g.featureIds]) })),
    ),
    blockedFeatureIds: Object.freeze([...domain.blockedFeatureIds]),
    assignments: domain.assignments ? Object.freeze({ ...domain.assignments }) : undefined,
  });
}

// ── Epic 21 Constructors (Story 21.7) ─────────────────────────────────

export function createSetForecastPlanningLevelWireCommand(
  domain: import('../domain/forecast/forecast.commands').SetForecastPlanningLevelCommand,
): SetForecastPlanningLevelWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  if (!['Theme', 'Component', 'Feature'].includes(domain.planningLevel)) throw new Error('INVALID_PLANNING_LEVEL');
  return Object.freeze({
    type: 'SetForecastPlanningLevel',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    planningLevel: domain.planningLevel,
  });
}

export function createRestoreForecastPlanningLevelWireCommand(
  domain: import('../domain/forecast/forecast.commands').RestoreForecastPlanningLevelCommand,
): RestoreForecastPlanningLevelWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  if (!['Theme', 'Component', 'Feature'].includes(domain.planningLevel)) throw new Error('INVALID_PLANNING_LEVEL');
  return Object.freeze({
    type: 'RestoreForecastPlanningLevel',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    planningLevel: domain.planningLevel,
    selectedFeatureIds: Object.freeze([...domain.selectedFeatureIds]),
    parallelGroups: Object.freeze(
      domain.parallelGroups.map((g) => Object.freeze({ featureIds: Object.freeze([...g.featureIds]) })),
    ),
    blockedFeatureIds: Object.freeze([...domain.blockedFeatureIds]),
    assignments: domain.assignments ? Object.freeze({ ...domain.assignments }) : undefined,
  });
}

// ── Epic 22 Wire Creators (Story 22.3, Story 22.4) ──────────────────

export function createAddForecastPersonWireCommand(
  domain: import('../domain/forecast/forecast.commands').AddForecastPersonCommand,
): AddForecastPersonWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.personId, 'personId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  if (typeof domain.name !== 'string' || domain.name.trim().length === 0) throw new Error('INVALID_PERSON_NAME');
  const weightUnits = domain.weightUnits ?? 100;
  if (!Number.isSafeInteger(weightUnits) || weightUnits <= 0) throw new Error('INVALID_STAFFING_WEIGHT');
  return Object.freeze({
    type: 'AddForecastPerson',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    personId: domain.personId,
    name: domain.name.trim(),
    weightUnits,
  });
}

export function createUpdateForecastPersonWireCommand(
  domain: import('../domain/forecast/forecast.commands').UpdateForecastPersonCommand,
): UpdateForecastPersonWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.personId, 'personId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  if (typeof domain.name !== 'string' || domain.name.trim().length === 0) throw new Error('INVALID_PERSON_NAME');
  if (!Number.isSafeInteger(domain.weightUnits) || domain.weightUnits <= 0) throw new Error('INVALID_STAFFING_WEIGHT');
  return Object.freeze({
    type: 'UpdateForecastPerson',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    personId: domain.personId,
    name: domain.name.trim(),
    weightUnits: domain.weightUnits,
  });
}

export function createRemoveForecastPersonWireCommand(
  domain: import('../domain/forecast/forecast.commands').RemoveForecastPersonCommand,
): RemoveForecastPersonWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.personId, 'personId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'RemoveForecastPerson',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    personId: domain.personId,
  });
}

export function createRestoreForecastPersonWireCommand(
  domain: import('../domain/forecast/forecast.commands').RestoreForecastPersonCommand,
): RestoreForecastPersonWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  if (!domain.person) throw new Error('INVALID_PERSON');
  assertUuidV7(domain.person.id, 'person.id');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  if (typeof domain.person.name !== 'string' || domain.person.name.trim().length === 0) throw new Error('INVALID_PERSON_NAME');
  if (!Number.isSafeInteger(domain.person.weightUnits) || domain.person.weightUnits <= 0) throw new Error('INVALID_STAFFING_WEIGHT');
  return Object.freeze({
    type: 'RestoreForecastPerson',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    person: Object.freeze({
      id: domain.person.id,
      name: domain.person.name.trim(),
      weightUnits: domain.person.weightUnits,
    }),
    assignments: domain.assignments ? Object.freeze({ ...domain.assignments }) : undefined,
  });
}

export function createSetForecastAssignmentsWireCommand(
  domain: import('../domain/forecast/forecast.commands').SetForecastAssignmentsCommand,
): SetForecastAssignmentsWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.featureId, 'featureId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Array.isArray(domain.personIds)) throw new Error('INVALID_PERSON_IDS');
  for (const pid of domain.personIds) {
    assertUuidV7(pid, 'personId in personIds must be a valid UUIDv7');
  }
  return Object.freeze({
    type: 'SetForecastAssignments',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    featureId: domain.featureId,
    personIds: Object.freeze([...new Set(domain.personIds)]),
  });
}

export function createSetForecastPolicyWireCommand(
  domain: import('../domain/forecast/forecast.commands').SetForecastPolicyCommand,
): SetForecastPolicyWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  if (
    domain.policyVersion !== 'shared-capacity-v1' &&
    domain.policyVersion !== 'staffed-capacity-v1'
  ) {
    throw new Error('INVALID_POLICY_VERSION');
  }
  return Object.freeze({
    type: 'SetForecastPolicy',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    policyVersion: domain.policyVersion,
  });
}

/** Build a MoveForecastFeature wire command (Story 27.2, D8(c), R3). */
export function createMoveForecastFeatureWireCommand(
  domain: import('../domain/forecast/forecast.commands').MoveForecastFeatureCommand,
): MoveForecastFeatureWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.featureId, 'featureId');
  if (domain.afterId) assertUuidV7(domain.afterId, 'afterId');
  if (domain.beforeId) assertUuidV7(domain.beforeId, 'beforeId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(domain.intendedIndex) || domain.intendedIndex < 0) throw new Error('INVALID_INTENDED_INDEX');
  if (domain.groupChange.kind === 'join') assertUuidV7(domain.groupChange.partnerId, 'groupChange.partnerId');
  return Object.freeze({
    type: 'MoveForecastFeature',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    featureId: domain.featureId,
    afterId: domain.afterId,
    beforeId: domain.beforeId,
    intendedIndex: domain.intendedIndex,
    groupChange: domain.groupChange,
  });
}

/** Build a SetForecastAssignment wire command (Story 27.2, D8(d)). */
export function createSetForecastAssignmentWireCommand(
  domain: import('../domain/forecast/forecast.commands').SetForecastAssignmentCommand,
): SetForecastAssignmentWireCommand {
  assertUuidV7(domain.commandId, 'commandId');
  assertUuidV7(domain.projectId, 'projectId');
  assertUuidV7(domain.featureId, 'featureId');
  assertUuidV7(domain.personId, 'personId');
  if (!Number.isSafeInteger(domain.baseRevision) || domain.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'SetForecastAssignment',
    protocolVersion: PROTOCOL_VERSION,
    commandId: domain.commandId,
    projectId: domain.projectId,
    baseRevision: domain.baseRevision,
    expectedRevision: domain.baseRevision + 1,
    featureId: domain.featureId,
    personId: domain.personId,
    assigned: domain.assigned,
  });
}

// ── Validators ─────────────────────────────────────────────────────────────

export function validateCreateProjectCommand(input: unknown): CreateProjectCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<CreateProjectCommand>;
  if (cmd.type !== 'CreateProject' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  if (cmd.baseRevision !== 0 || cmd.expectedRevision !== 1) throw new Error('INVALID_BASE_REVISION');
  if (typeof cmd.name !== 'string') throw new Error('INVALID_PROJECT_NAME');
  return cmd as CreateProjectCommand;
}

export function validateRenameProjectCommand(input: unknown): RenameProjectCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<RenameProjectCommand>;
  if (cmd.type !== 'RenameProject' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  if (typeof cmd.name !== 'string') throw new Error('INVALID_PROJECT_NAME');
  return cmd as RenameProjectCommand;
}

export function validateDeleteProjectWireCommand(input: unknown): DeleteProjectWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<DeleteProjectWireCommand>;
  if (cmd.type !== 'DeleteProject' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  return cmd as DeleteProjectWireCommand;
}

export function validateCreateNodeWireCommand(input: unknown): CreateNodeWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<CreateNodeWireCommand>;
  if (cmd.type !== 'CreateNode' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  assertUuidV7(String(cmd.nodeId), 'nodeId');
  if (cmd.parentId) assertUuidV7(String(cmd.parentId), 'parentId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  if (typeof cmd.position !== 'string') throw new Error('INVALID_POSITION');
  if (typeof cmd.title !== 'string') throw new Error('INVALID_TITLE');
  return cmd as CreateNodeWireCommand;
}

export function validateSetNodeTitleWireCommand(input: unknown): SetNodeTitleWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<SetNodeTitleWireCommand>;
  if (cmd.type !== 'SetNodeTitle' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  assertUuidV7(String(cmd.nodeId), 'nodeId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  if (typeof cmd.title !== 'string') throw new Error('INVALID_TITLE');
  return cmd as SetNodeTitleWireCommand;
}

export function validateSetNodeBodyTextWireCommand(input: unknown): SetNodeBodyTextWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<SetNodeBodyTextWireCommand>;
  if (cmd.type !== 'SetNodeBodyText' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  assertUuidV7(String(cmd.nodeId), 'nodeId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  if (cmd.bodyText !== null && typeof cmd.bodyText !== 'string') throw new Error('INVALID_BODY_TEXT');
  return cmd as SetNodeBodyTextWireCommand;
}

export function validateMoveNodeWireCommand(input: unknown): MoveNodeWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<MoveNodeWireCommand>;
  if (cmd.type !== 'MoveNode' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  assertUuidV7(String(cmd.nodeId), 'nodeId');
  if (cmd.newParentId) assertUuidV7(String(cmd.newParentId), 'newParentId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  if (typeof cmd.newPosition !== 'string') throw new Error('INVALID_POSITION');
  return cmd as MoveNodeWireCommand;
}

export function validateDeleteSubtreeWireCommand(input: unknown): DeleteSubtreeWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<DeleteSubtreeWireCommand>;
  if (cmd.type !== 'DeleteSubtree' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  assertUuidV7(String(cmd.nodeId), 'nodeId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  return cmd as DeleteSubtreeWireCommand;
}

export function validateDuplicateSubtreeWireCommand(input: unknown): DuplicateSubtreeWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<DuplicateSubtreeWireCommand>;
  if (cmd.type !== 'DuplicateSubtree' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  assertUuidV7(String(cmd.sourceNodeId), 'sourceNodeId');
  assertUuidV7(String(cmd.newRootId), 'newRootId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  return cmd as DuplicateSubtreeWireCommand;
}

export function validateRestoreSubtreeWireCommand(input: unknown): RestoreSubtreeWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<RestoreSubtreeWireCommand>;
  if (cmd.type !== 'RestoreSubtree' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  assertUuidV7(String(cmd.rootNodeId), 'rootNodeId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  if (!Array.isArray(cmd.nodes)) throw new Error('INVALID_NODES');
  if (cmd.deletionBundle !== undefined) validateDeletionBundle(cmd.deletionBundle, String(cmd.projectId), String(cmd.rootNodeId), cmd.nodes);
  return Object.freeze({...cmd, nodes: Object.freeze(cmd.nodes.map(node => Object.freeze({...node}))), ...(cmd.deletionBundle === undefined ? {} : {deletionBundle: validateDeletionBundle(cmd.deletionBundle,cmd.projectId!,cmd.rootNodeId!,cmd.nodes)})}) as RestoreSubtreeWireCommand;
}

export function validateConfigureForecastPlanWireCommand(input: unknown): ConfigureForecastPlanWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<ConfigureForecastPlanWireCommand>;
  if (cmd.type !== 'ConfigureForecastPlan' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  if (cmd.pointsPerSprint !== null && cmd.pointsPerSprint !== undefined) {
    if (!Number.isSafeInteger(cmd.pointsPerSprint) || cmd.pointsPerSprint < 0) throw new Error('INVALID_POINTS');
  }
  if (cmd.sprintLengthDays !== null && cmd.sprintLengthDays !== undefined) {
    if (!Number.isSafeInteger(cmd.sprintLengthDays) || cmd.sprintLengthDays <= 0) throw new Error('INVALID_SPRINT_LENGTH');
  }
  if (cmd.startSprintOrdinal !== null && cmd.startSprintOrdinal !== undefined) {
    if (!Number.isSafeInteger(cmd.startSprintOrdinal) || cmd.startSprintOrdinal <= 0) throw new Error('INVALID_START_ORDINAL');
  }
  if (cmd.startDate !== null && cmd.startDate !== undefined) {
    if (typeof cmd.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(cmd.startDate)) throw new Error('INVALID_START_DATE');
  }
  if (cmd.planningLevel !== null && cmd.planningLevel !== undefined) {
    if (!['Theme', 'Component', 'Feature'].includes(String(cmd.planningLevel))) throw new Error('INVALID_PLANNING_LEVEL');
  }
  return cmd as ConfigureForecastPlanWireCommand;
}

export function validateSetForecastMembershipWireCommand(input: unknown): SetForecastMembershipWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<SetForecastMembershipWireCommand>;
  if (cmd.type !== 'SetForecastMembership' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  assertUuidV7(String(cmd.featureId), 'featureId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  if (typeof cmd.included !== 'boolean') throw new Error('INVALID_INCLUDED');
  return cmd as SetForecastMembershipWireCommand;
}

export function validateRemoveForecastPlanWireCommand(input: unknown): RemoveForecastPlanWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<RemoveForecastPlanWireCommand>;
  if (cmd.type !== 'RemoveForecastPlan' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  return cmd as RemoveForecastPlanWireCommand;
}

// ── Epic 20 Validators (Story 20.1) ───────────────────────────────────

export function validateSetForecastBlockerWireCommand(input: unknown): SetForecastBlockerWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<SetForecastBlockerWireCommand>;
  if (cmd.type !== 'SetForecastBlocker' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  assertUuidV7(String(cmd.featureId), 'featureId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  if (typeof cmd.blocked !== 'boolean') throw new Error('INVALID_BLOCKED');
  return cmd as SetForecastBlockerWireCommand;
}

function assertScenarioEnvelope(cmd: { commandId?: unknown; projectId?: unknown; baseRevision?: unknown; expectedRevision?: unknown }): void {
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
}

export function validateCreateForecastScenarioWireCommand(input: unknown): CreateForecastScenarioWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<CreateForecastScenarioWireCommand>;
  if (cmd.type !== 'CreateForecastScenario' || cmd.protocolVersion !== PROTOCOL_VERSION) throw new Error('PROTOCOL_VERSION_MISMATCH');
  assertScenarioEnvelope(cmd);
  assertUuidV7(String(cmd.scenarioId), 'scenarioId');
  if (typeof cmd.label !== 'string' || cmd.label.trim().length === 0) throw new Error('INVALID_SCENARIO_LABEL');
  if (!Number.isSafeInteger(cmd.baselineRevision) || Number(cmd.baselineRevision) < 0) throw new Error('INVALID_BASELINE_REVISION');
  if (typeof cmd.expectedMaterialFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(cmd.expectedMaterialFingerprint)) {
    throw new Error('INVALID_SCENARIO_FINGERPRINT');
  }
  if (typeof cmd.createdAtISO !== 'string' || cmd.createdAtISO.length === 0) throw new Error('INVALID_SCENARIO_CREATED_AT');
  if (!cmd.patch || typeof cmd.patch !== 'object') throw new Error('INVALID_SCENARIO_PATCH');
  return cmd as CreateForecastScenarioWireCommand;
}

export function validateRemoveForecastScenarioWireCommand(input: unknown): RemoveForecastScenarioWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<RemoveForecastScenarioWireCommand>;
  if (cmd.type !== 'RemoveForecastScenario' || cmd.protocolVersion !== PROTOCOL_VERSION) throw new Error('PROTOCOL_VERSION_MISMATCH');
  assertScenarioEnvelope(cmd);
  assertUuidV7(String(cmd.scenarioId), 'scenarioId');
  return cmd as RemoveForecastScenarioWireCommand;
}

export function validateRestoreForecastScenarioWireCommand(input: unknown): RestoreForecastScenarioWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<RestoreForecastScenarioWireCommand>;
  if (cmd.type !== 'RestoreForecastScenario' || cmd.protocolVersion !== PROTOCOL_VERSION) throw new Error('PROTOCOL_VERSION_MISMATCH');
  assertScenarioEnvelope(cmd);
  if (!cmd.scenario || typeof cmd.scenario !== 'object') throw new Error('INVALID_SCENARIO');
  assertUuidV7(String((cmd.scenario as { scenarioId?: unknown }).scenarioId), 'scenario.scenarioId');
  return cmd as RestoreForecastScenarioWireCommand;
}

// ── Epic 19 Validators (Story 19.2) ───────────────────────────────────

export function validateReorderForecastFeaturesWireCommand(input: unknown): ReorderForecastFeaturesWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<ReorderForecastFeaturesWireCommand>;
  if (cmd.type !== 'ReorderForecastFeatures' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  if (!Array.isArray(cmd.featureIds)) throw new Error('INVALID_FEATURE_IDS');
  for (const id of cmd.featureIds) {
    assertUuidV7(String(id), 'featureId');
  }
  return cmd as ReorderForecastFeaturesWireCommand;
}

export function validateSetForecastParallelGroupsWireCommand(input: unknown): SetForecastParallelGroupsWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<SetForecastParallelGroupsWireCommand>;
  if (cmd.type !== 'SetForecastParallelGroups' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  if (!Array.isArray(cmd.parallelGroups)) throw new Error('INVALID_PARALLEL_GROUPS');
  for (const g of cmd.parallelGroups) {
    if (!g || typeof g !== 'object' || !Array.isArray(g.featureIds)) throw new Error('INVALID_PARALLEL_GROUPS');
    for (const id of g.featureIds) {
      assertUuidV7(String(id), 'featureId');
    }
  }
  return cmd as SetForecastParallelGroupsWireCommand;
}

export function validateSetForecastSequenceWireCommand(input: unknown): SetForecastSequenceWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<SetForecastSequenceWireCommand>;
  if (cmd.type !== 'SetForecastSequence' || cmd.protocolVersion !== PROTOCOL_VERSION) throw new Error('PROTOCOL_VERSION_MISMATCH');
  assertUuidV7(String(cmd.commandId), 'commandId'); assertUuidV7(String(cmd.projectId), 'projectId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0 || !Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) throw new Error('INVALID_COMMAND');
  if (!Array.isArray(cmd.featureIds) || !Array.isArray(cmd.parallelGroups)) throw new Error('INVALID_FORECAST_SEQUENCE');
  for (const id of cmd.featureIds) assertUuidV7(String(id), 'featureId');
  for (const group of cmd.parallelGroups) { if (!group || typeof group !== 'object' || !Array.isArray(group.featureIds)) throw new Error('INVALID_PARALLEL_GROUPS'); for (const id of group.featureIds) assertUuidV7(String(id), 'featureId'); }
  return cmd as SetForecastSequenceWireCommand;
}

export function validateRestoreForecastScopeWireCommand(input: unknown): RestoreForecastScopeWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<RestoreForecastScopeWireCommand>;
  if (cmd.type !== 'RestoreForecastScope' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  if (!Array.isArray(cmd.selectedFeatureIds)) throw new Error('INVALID_SELECTED_FEATURE_IDS');
  for (const id of cmd.selectedFeatureIds) {
    assertUuidV7(String(id), 'featureId');
  }
  if (!Array.isArray(cmd.parallelGroups)) throw new Error('INVALID_PARALLEL_GROUPS');
  for (const g of cmd.parallelGroups) {
    if (!g || typeof g !== 'object' || !Array.isArray(g.featureIds)) throw new Error('INVALID_PARALLEL_GROUPS');
    for (const id of g.featureIds) {
      assertUuidV7(String(id), 'featureId');
    }
  }
  if (!Array.isArray(cmd.blockedFeatureIds)) throw new Error('INVALID_BLOCKED_FEATURE_IDS');
  for (const id of cmd.blockedFeatureIds) {
    assertUuidV7(String(id), 'featureId');
  }
  return cmd as RestoreForecastScopeWireCommand;
}

// ── Epic 21 Validators (Story 21.7) ────────────────────────────────────

export function validateSetForecastPlanningLevelWireCommand(input: unknown): SetForecastPlanningLevelWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<SetForecastPlanningLevelWireCommand>;
  if (cmd.type !== 'SetForecastPlanningLevel' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  if (!['Theme', 'Component', 'Feature'].includes(String(cmd.planningLevel))) throw new Error('INVALID_PLANNING_LEVEL');
  return cmd as SetForecastPlanningLevelWireCommand;
}

export function validateRestoreForecastPlanningLevelWireCommand(input: unknown): RestoreForecastPlanningLevelWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<RestoreForecastPlanningLevelWireCommand>;
  if (cmd.type !== 'RestoreForecastPlanningLevel' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  if (!['Theme', 'Component', 'Feature'].includes(String(cmd.planningLevel))) throw new Error('INVALID_PLANNING_LEVEL');
  if (!Array.isArray(cmd.selectedFeatureIds)) throw new Error('INVALID_SELECTED_FEATURE_IDS');
  for (const id of cmd.selectedFeatureIds) assertUuidV7(String(id), 'featureId');
  if (!Array.isArray(cmd.parallelGroups)) throw new Error('INVALID_PARALLEL_GROUPS');
  for (const g of cmd.parallelGroups) {
    if (!g || typeof g !== 'object' || !Array.isArray(g.featureIds)) throw new Error('INVALID_PARALLEL_GROUPS');
    for (const id of g.featureIds) assertUuidV7(String(id), 'featureId');
  }
  if (!Array.isArray(cmd.blockedFeatureIds)) throw new Error('INVALID_BLOCKED_FEATURE_IDS');
  for (const id of cmd.blockedFeatureIds) assertUuidV7(String(id), 'featureId');
  return cmd as RestoreForecastPlanningLevelWireCommand;
}

// ── Epic 22 Validators (Story 22.3) ────────────────────────────────────

export function validateAddForecastPersonWireCommand(input: unknown): AddForecastPersonWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<AddForecastPersonWireCommand>;
  if (cmd.type !== 'AddForecastPerson' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  assertUuidV7(String(cmd.personId), 'personId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  if (typeof cmd.name !== 'string' || cmd.name.trim().length === 0) throw new Error('INVALID_PERSON_NAME');
  if (!Number.isSafeInteger(cmd.weightUnits) || Number(cmd.weightUnits) <= 0) throw new Error('INVALID_STAFFING_WEIGHT');
  return cmd as AddForecastPersonWireCommand;
}

export function validateUpdateForecastPersonWireCommand(input: unknown): UpdateForecastPersonWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<UpdateForecastPersonWireCommand>;
  if (cmd.type !== 'UpdateForecastPerson' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  assertUuidV7(String(cmd.personId), 'personId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  if (typeof cmd.name !== 'string' || cmd.name.trim().length === 0) throw new Error('INVALID_PERSON_NAME');
  if (!Number.isSafeInteger(cmd.weightUnits) || Number(cmd.weightUnits) <= 0) throw new Error('INVALID_STAFFING_WEIGHT');
  return cmd as UpdateForecastPersonWireCommand;
}

export function validateRemoveForecastPersonWireCommand(input: unknown): RemoveForecastPersonWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<RemoveForecastPersonWireCommand>;
  if (cmd.type !== 'RemoveForecastPerson' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  assertUuidV7(String(cmd.personId), 'personId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  return cmd as RemoveForecastPersonWireCommand;
}

export function validateRestoreForecastPersonWireCommand(input: unknown): RestoreForecastPersonWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<RestoreForecastPersonWireCommand>;
  if (cmd.type !== 'RestoreForecastPerson' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  if (!cmd.person || typeof cmd.person !== 'object') throw new Error('INVALID_PERSON');
  assertUuidV7(String(cmd.person.id), 'person.id');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  if (typeof cmd.person.name !== 'string' || cmd.person.name.trim().length === 0) throw new Error('INVALID_PERSON_NAME');
  if (!Number.isSafeInteger(cmd.person.weightUnits) || Number(cmd.person.weightUnits) <= 0) throw new Error('INVALID_STAFFING_WEIGHT');
  return cmd as RestoreForecastPersonWireCommand;
}

export function validateSetForecastAssignmentsWireCommand(input: unknown): SetForecastAssignmentsWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<SetForecastAssignmentsWireCommand>;
  if (cmd.type !== 'SetForecastAssignments' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  assertUuidV7(String(cmd.featureId), 'featureId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  if (!Array.isArray(cmd.personIds)) throw new Error('INVALID_PERSON_IDS');
  for (const pid of cmd.personIds) assertUuidV7(String(pid), 'personId');
  return cmd as SetForecastAssignmentsWireCommand;
}

export function validateSetForecastPolicyWireCommand(input: unknown): SetForecastPolicyWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<SetForecastPolicyWireCommand>;
  if (cmd.type !== 'SetForecastPolicy' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  if (cmd.policyVersion !== 'shared-capacity-v1' && cmd.policyVersion !== 'staffed-capacity-v1') {
    throw new Error('INVALID_POLICY_VERSION');
  }
  return cmd as SetForecastPolicyWireCommand;
}

function assertAnchorsAndIndex(
  afterId: unknown,
  beforeId: unknown,
  intendedIndex: unknown,
): void {
  if (afterId !== null && afterId !== undefined) assertUuidV7(String(afterId), 'afterId');
  if (beforeId !== null && beforeId !== undefined) assertUuidV7(String(beforeId), 'beforeId');
  if (!Number.isSafeInteger(intendedIndex) || Number(intendedIndex) < 0) throw new Error('INVALID_INTENDED_INDEX');
}

export function validateMovePhaseWireCommand(input: unknown): MovePhaseWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<MovePhaseWireCommand>;
  if (cmd.type !== 'MovePhase' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  assertUuidV7(String(cmd.phaseId), 'phaseId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  assertAnchorsAndIndex(cmd.afterId, cmd.beforeId, cmd.intendedIndex);
  return cmd as MovePhaseWireCommand;
}

export function validateMoveNodeQuestionWireCommand(input: unknown): MoveNodeQuestionWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<MoveNodeQuestionWireCommand>;
  if (cmd.type !== 'MoveNodeQuestion' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  assertUuidV7(String(cmd.nodeId), 'nodeId');
  assertUuidV7(String(cmd.questionId), 'questionId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  assertAnchorsAndIndex(cmd.afterId, cmd.beforeId, cmd.intendedIndex);
  return cmd as MoveNodeQuestionWireCommand;
}

export function validateMoveForecastFeatureWireCommand(input: unknown): MoveForecastFeatureWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<MoveForecastFeatureWireCommand>;
  if (cmd.type !== 'MoveForecastFeature' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  assertUuidV7(String(cmd.featureId), 'featureId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  assertAnchorsAndIndex(cmd.afterId, cmd.beforeId, cmd.intendedIndex);
  const change = cmd.groupChange;
  if (!change || typeof change !== 'object') throw new Error('INVALID_GROUP_CHANGE');
  if (change.kind === 'join') {
    assertUuidV7(String(change.partnerId), 'groupChange.partnerId');
  } else if (change.kind !== 'unchanged' && change.kind !== 'leave') {
    throw new Error('INVALID_GROUP_CHANGE');
  }
  return cmd as MoveForecastFeatureWireCommand;
}

export function validateSetForecastAssignmentWireCommand(input: unknown): SetForecastAssignmentWireCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as Partial<SetForecastAssignmentWireCommand>;
  if (cmd.type !== 'SetForecastAssignment' || cmd.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(cmd.commandId), 'commandId');
  assertUuidV7(String(cmd.projectId), 'projectId');
  assertUuidV7(String(cmd.featureId), 'featureId');
  assertUuidV7(String(cmd.personId), 'personId');
  if (!Number.isSafeInteger(cmd.baseRevision) || Number(cmd.baseRevision) < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision !== Number(cmd.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND');
  }
  if (typeof cmd.assigned !== 'boolean') throw new Error('INVALID_ASSIGNED');
  return cmd as SetForecastAssignmentWireCommand;
}

export function validateProductCommand(input: unknown): ProductCommand {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const cmd = input as { type?: string };
  switch (cmd.type) {
    case 'CreateProject':
      return validateCreateProjectCommand(input);
    case 'RenameProject':
      return validateRenameProjectCommand(input);
    case 'DeleteProject':
      return validateDeleteProjectWireCommand(input);
    case 'CreateNode':
      return validateCreateNodeWireCommand(input);
    case 'SetNodeTitle':
      return validateSetNodeTitleWireCommand(input);
    case 'SetNodeBodyText':
      return validateSetNodeBodyTextWireCommand(input);
    case 'MoveNode':
      return validateMoveNodeWireCommand(input);
    case 'DeleteSubtree':
      return validateDeleteSubtreeWireCommand(input);
    case 'DuplicateSubtree':
      return validateDuplicateSubtreeWireCommand(input);
    case 'RestoreSubtree':
      return validateRestoreSubtreeWireCommand(input);
    case 'SetNodeType':
    case 'SetNodeCustomField':
    case 'PromoteFieldToTemplate':
    case 'SetNodeSchedule':
    case 'ToggleNodeCompleted':
    case 'SetNodeEffort':
    case 'SetNodePointsDone':
    case 'SetNodeStatus':
    case 'SetThemeWeight':
    case 'CreatePhase':
    case 'RenamePhase':
    case 'ReorderPhases':
    case 'AssignNodePhase':
    case 'DeletePhase':
    case 'RestorePhase':
    case 'CreateUnlockEdge':
    case 'DeleteUnlockEdge':
    case 'DismissFinding':
    case 'UndismissFinding':
    case 'RecordAffectedReasons':
    case 'AcknowledgeAffectedReason':
    case 'ClearNodeAffectedReasons':
    case 'AddNodeQuestion':
    case 'UpdateNodeQuestion':
    case 'ResolveNodeQuestion':
    case 'ReorderNodeQuestions':
    case 'DeleteNodeQuestion':
      return input as ProductCommand;
    case 'ConfigureForecastPlan':
      return validateConfigureForecastPlanWireCommand(input);
    case 'SetForecastMembership':
      return validateSetForecastMembershipWireCommand(input);
    case 'RemoveForecastPlan':
      return validateRemoveForecastPlanWireCommand(input);
    case 'SetForecastBlocker':
      return validateSetForecastBlockerWireCommand(input);
    case 'CreateForecastScenario':
      return validateCreateForecastScenarioWireCommand(input);
    case 'RemoveForecastScenario':
      return validateRemoveForecastScenarioWireCommand(input);
    case 'RestoreForecastScenario':
      return validateRestoreForecastScenarioWireCommand(input);
    case 'ReorderForecastFeatures':
      return validateReorderForecastFeaturesWireCommand(input);
    case 'SetForecastSequence':
      return validateSetForecastSequenceWireCommand(input);
    case 'SetForecastParallelGroups':
      return validateSetForecastParallelGroupsWireCommand(input);
    case 'RestoreForecastScope':
      return validateRestoreForecastScopeWireCommand(input);
    case 'SetForecastPlanningLevel':
      return validateSetForecastPlanningLevelWireCommand(input);
    case 'RestoreForecastPlanningLevel':
      return validateRestoreForecastPlanningLevelWireCommand(input);
    case 'AddForecastPerson':
      return validateAddForecastPersonWireCommand(input);
    case 'UpdateForecastPerson':
      return validateUpdateForecastPersonWireCommand(input);
    case 'RemoveForecastPerson':
      return validateRemoveForecastPersonWireCommand(input);
    case 'RestoreForecastPerson':
      return validateRestoreForecastPersonWireCommand(input);
    case 'SetForecastAssignments':
      return validateSetForecastAssignmentsWireCommand(input);
    case 'SetForecastPolicy':
      return validateSetForecastPolicyWireCommand(input);
    case 'MovePhase':
      return validateMovePhaseWireCommand(input);
    case 'MoveNodeQuestion':
      return validateMoveNodeQuestionWireCommand(input);
    case 'MoveForecastFeature':
      return validateMoveForecastFeatureWireCommand(input);
    case 'SetForecastAssignment':
      return validateSetForecastAssignmentWireCommand(input);
    default:
      throw new Error(`UNKNOWN_COMMAND_TYPE: ${String(cmd.type)}`);
  }
}
