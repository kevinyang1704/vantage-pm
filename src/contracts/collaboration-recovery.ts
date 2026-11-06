/** Version-one authored graph and recovery history; device state is deliberately separate. */
import type { ProductCommand, ProductCommandResult } from './repository-commands';
export { validateRecoveryEnvelope, validateConfirmedHistoryEntry, recoveryPayloadDigest } from './collaboration-recovery.validation';
export type RecoveryProjectRow = Readonly<{
  id: string;
  name: string;
  revision: number;
}>;
export type RecoveryPhasesRow = Readonly<{
  id: string;
  projectId: string;
  name: string;
  position: number;
}>;
export type RecoveryNodesRow = Readonly<{
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  bodyText: string | null;
  position: number;
  nodeType: string | null;
  startDate: string | null;
  endDate: string | null;
  durationDays: number | null;
  scheduleSourceMode: string | null;
  completed: boolean;
  effortPoints: number | null;
  effortPointsDone: number | null;
  strategicWeight: number | null;
  phaseId: string | null;
  deliveryStatus: string | null;
}>;
export type RecoveryCustomFieldsRow = Readonly<{
  projectId: string;
  nodeId: string;
  fieldKey: string;
  fieldValue: string | null;
}>;
export type RecoveryTypeTemplateFieldsRow = Readonly<{
  projectId: string;
  nodeType: string;
  fieldKey: string;
  fieldLabel: string;
  position: number;
}>;
export type RecoveryUnlockEdgesRow = Readonly<{
  id: string;
  projectId: string;
  sourceNodeId: string;
  targetNodeId: string;
}>;
export type RecoveryDismissalsRow = Readonly<{
  projectId: string;
  findingId: string;
  findingKind: string;
  targetId: string;
  fingerprint: string;
  dismissedAt: string;
}>;
export type RecoveryAffectedReasonsRow = Readonly<{
  id: string;
  projectId: string;
  affectedNodeId: string;
  causalNodeId: string;
  causalNodeTitle: string;
  deltaDays: number;
  causalDateSummary: string;
  createdAt: string;
  acknowledgedAt: string | null;
}>;
export type RecoveryOpenQuestionsRow = Readonly<{
  id: string;
  projectId: string;
  nodeId: string;
  questionText: string;
  status: string;
  decisionText: string | null;
  position: number;
  resolvedAtIso: string | null;
  createdAtIso: string;
}>;
export type RecoveryForecastPlansRow = Readonly<{
  projectId: string;
  selectedFeatureIds: string;
  parallelGroups: string;
  blockedFeatureIds: string;
  pointsPerSprint: number | null;
  sprintLengthDays: number | null;
  cadence: string;
  startSprintOrdinal: number | null;
  startDate: string | null;
  policyVersion: string;
  planningLevel: string;
  roster: string;
  assignments: string;
  sprintPlan: string;
}>;
export type RecoveryForecastScenariosRow = Readonly<{
  scenarioId: string;
  projectId: string;
  label: string;
  baselineRevision: number;
  baselineFingerprint: string;
  policyVersion: string;
  createdAtIso: string;
  baselineJson: string;
  patchJson: string;
}>;
export type RecoveryGraph = Readonly<{
  project: RecoveryProjectRow;
  phases: readonly RecoveryPhasesRow[];
  nodes: readonly RecoveryNodesRow[];
  customFields: readonly RecoveryCustomFieldsRow[];
  typeTemplateFields: readonly RecoveryTypeTemplateFieldsRow[];
  unlockEdges: readonly RecoveryUnlockEdgesRow[];
  dismissals: readonly RecoveryDismissalsRow[];
  affectedReasons: readonly RecoveryAffectedReasonsRow[];
  openQuestions: readonly RecoveryOpenQuestionsRow[];
  forecastPlans: readonly RecoveryForecastPlansRow[];
  forecastScenarios: readonly RecoveryForecastScenariosRow[];
}>;
export type FootprintTarget = Readonly<
  | { kind: 'entity'; entityType: string; id: string }
  | { kind: 'field'; entityType: string; id: string; field: string }
  | { kind: 'order'; collectionType: string; ownerId: string }
  | { kind: 'reference'; relation: string; sourceId: string; targetId: string }
>;
export type RecoveryFootprints = Readonly<{ availability: 'complete' | 'unavailable'; knownTargets: readonly FootprintTarget[]; reason: string | null }>;
export type ConfirmedHistoryEntry = Readonly<{
  command: ProductCommand; result: ProductCommandResult; payloadDigest: string;
  actorId: string | null; wireIdentityAvailability: 'original' | 'legacy-admitted-wire'; protocolVersion: string; serverRevision: number;
  receiptRevisionAvailability: 'authoritative' | 'legacy-client-revision';
  recordedAtIso: string | null; label: string | null;
  commandFootprint: RecoveryFootprints; effectFootprint: RecoveryFootprints;
  deletionMetadata: 'complete' | 'legacy-incomplete' | 'not-applicable';
}>;
export type TerminalRejection = Readonly<{ command: ProductCommand; result: ProductCommandResult; payloadDigest: string; actorId: string | null; wireIdentityAvailability: 'original' | 'legacy-admitted-wire'; protocolVersion: string }>;
export type RecoveryEnvelope = Readonly<{
  version: 1; protocolVersion: string; projectId: string; streamEpoch: number;
  serverRevision: number; historyFloor: number; dedupCoverage: 'complete' | 'unavailable';
  graph: RecoveryGraph; confirmedHistory: readonly ConfirmedHistoryEntry[]; terminalRejections: readonly TerminalRejection[];
}>;

export const RECOVERY_GRAPH_TABLES = [['project', 'projects', [['id', 'id', 's'], ['name', 'name', 's'], ['revision', 'revision', 'i']]], ['phases', 'phases', [['id', 'id', 's'], ['projectId', 'project_id', 's'], ['name', 'name', 's'], ['position', 'position', 'i']]], ['nodes', 'nodes', [['id', 'id', 's'], ['projectId', 'project_id', 's'], ['parentId', 'parent_id', 's?'], ['title', 'title', 's'], ['bodyText', 'body_text', 's?'], ['position', 'position', 'i'], ['nodeType', 'node_type', 's?'], ['startDate', 'start_date', 's?'], ['endDate', 'end_date', 's?'], ['durationDays', 'duration_days', 'i?'], ['scheduleSourceMode', 'schedule_source_mode', 's?'], ['completed', 'completed', 'b'], ['effortPoints', 'effort_points', 'i?'], ['effortPointsDone', 'effort_points_done', 'i?'], ['strategicWeight', 'strategic_weight', 'i?'], ['phaseId', 'phase_id', 's?'], ['deliveryStatus', 'delivery_status', 's?']]], ['customFields', 'node_custom_fields', [['projectId', 'project_id', 's'], ['nodeId', 'node_id', 's'], ['fieldKey', 'field_key', 's'], ['fieldValue', 'field_value', 's?']]], ['typeTemplateFields', 'type_template_fields', [['projectId', 'project_id', 's'], ['nodeType', 'node_type', 's'], ['fieldKey', 'field_key', 's'], ['fieldLabel', 'field_label', 's'], ['position', 'position', 'i']]], ['unlockEdges', 'unlock_edges', [['id', 'id', 's'], ['projectId', 'project_id', 's'], ['sourceNodeId', 'source_node_id', 's'], ['targetNodeId', 'target_node_id', 's']]], ['dismissals', 'finding_dismissals', [['projectId', 'project_id', 's'], ['findingId', 'finding_id', 's'], ['findingKind', 'finding_kind', 's'], ['targetId', 'target_id', 's'], ['fingerprint', 'fingerprint', 's'], ['dismissedAt', 'dismissed_at', 's']]], ['affectedReasons', 'affected_reasons', [['id', 'id', 's'], ['projectId', 'project_id', 's'], ['affectedNodeId', 'affected_node_id', 's'], ['causalNodeId', 'causal_node_id', 's'], ['causalNodeTitle', 'causal_node_title', 's'], ['deltaDays', 'delta_days', 'i'], ['causalDateSummary', 'causal_date_summary', 's'], ['createdAt', 'created_at', 's'], ['acknowledgedAt', 'acknowledged_at', 's?']]], ['openQuestions', 'node_open_questions', [['id', 'id', 's'], ['projectId', 'project_id', 's'], ['nodeId', 'node_id', 's'], ['questionText', 'question_text', 's'], ['status', 'status', 's'], ['decisionText', 'decision_text', 's?'], ['position', 'position', 'i'], ['resolvedAtIso', 'resolved_at_iso', 's?'], ['createdAtIso', 'created_at_iso', 's']]], ['forecastPlans', 'forecast_plans', [['projectId', 'project_id', 's'], ['selectedFeatureIds', 'selected_feature_ids', 's'], ['parallelGroups', 'parallel_groups', 's'], ['blockedFeatureIds', 'blocked_feature_ids', 's'], ['pointsPerSprint', 'points_per_sprint', 'i?'], ['sprintLengthDays', 'sprint_length_days', 'i?'], ['cadence', 'cadence', 's'], ['startSprintOrdinal', 'start_sprint_ordinal', 'i?'], ['startDate', 'start_date', 's?'], ['policyVersion', 'policy_version', 's'], ['planningLevel', 'planning_level', 's'], ['roster', 'roster', 's'], ['assignments', 'assignments', 's'], ['sprintPlan', 'sprint_plan', 's']]], ['forecastScenarios', 'forecast_scenarios', [['scenarioId', 'scenario_id', 's'], ['projectId', 'project_id', 's'], ['label', 'label', 's'], ['baselineRevision', 'baseline_revision', 'i'], ['baselineFingerprint', 'baseline_fingerprint', 's'], ['policyVersion', 'policy_version', 's'], ['createdAtIso', 'created_at_iso', 's'], ['baselineJson', 'baseline_json', 's'], ['patchJson', 'patch_json', 's']]]] as const;
