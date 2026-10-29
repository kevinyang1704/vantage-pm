//! Closed tagged command types and result unions mirroring the TypeScript
//! `ProductCommand` / `ProductCommandResult` contracts in
//! `src/contracts/repository-commands.ts` (E9-FR3, E9-FR4, E9-FR5).
//!
//! All structs are immutable by convention; serde uses camelCase field
//! renames to match the webview wire format exactly. No field carries raw
//! SQL, filesystem paths, or authored body text beyond the command payload.

use std::collections::HashMap;
use super::deletion_bundle::DeletionBundle;
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: &str = "1.0.0";

/// Node type values (Epic 3).
pub const NODE_TYPE_VISION: &str = "Vision";
pub const NODE_TYPE_THEME: &str = "Theme";
pub const NODE_TYPE_COMPONENT: &str = "Component";
pub const NODE_TYPE_FEATURE: &str = "Feature";
pub const NODE_TYPE_ACCEPTANCE_CRITERION: &str = "AcceptanceCriterion";

/// Schedule source modes (Epic 3).
pub const SCHEDULE_SOURCE_START_END: &str = "start_end";
pub const SCHEDULE_SOURCE_START_DURATION: &str = "start_duration";
pub const SCHEDULE_SOURCE_END_DURATION: &str = "end_duration";
pub const SCHEDULE_SOURCE_NONE: &str = "none";

// ── Common envelope fields ─────────────────────────────────────────────────

// ── Project commands ────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectCommand {
    #[serde(skip)]
    pub type_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameProjectCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProjectCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
}

// ── Node commands ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNodeCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub node_id: String,
    pub parent_id: Option<String>,
    pub position: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetNodeTitleCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub node_id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetNodeBodyTextCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub node_id: String,
    pub body_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveNodeCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub node_id: String,
    pub new_parent_id: Option<String>,
    pub new_position: String,
    /// Optional D8(c) placement intent (Story 27.2, R3). When present, the
    /// shared path resolves the placement from the anchors and index instead of
    /// the bare decimal position; when absent, local behavior is exactly as
    /// before. Either anchor may be null at a collection end.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intended_index: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSubtreeCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub node_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateSubtreeCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub source_node_id: String,
    pub new_root_id: String,
    pub id_map: std::collections::HashMap<String, String>,
    pub new_position: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeSnapshot {
    pub node_id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub body_text: Option<String>,
    pub position: String,
    pub depth: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_days: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule_source_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort_points: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strategic_weight: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSubtreeCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub root_node_id: String,
    pub nodes: Vec<NodeSnapshot>,
    #[serde(default, deserialize_with = "super::deletion_bundle::present_bundle", skip_serializing_if = "Option::is_none")]
    pub deletion_bundle: Option<DeletionBundle>,
}

// ── Epic 3 commands ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetNodeTypeCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub node_id: String,
    pub node_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetNodeCustomFieldCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub node_id: String,
    pub field_key: String,
    pub field_value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromoteFieldToTemplateCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub node_type: String,
    pub field_key: String,
    pub field_label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetNodeScheduleCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub node_id: String,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub duration_days: Option<i64>,
    pub source_mode: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleNodeCompletedCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub node_id: String,
    pub completed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetNodeEffortCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub node_id: String,
    pub effort_points: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restored_assignments: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetNodeStatusCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub node_id: String,
    pub delivery_status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetThemeWeightCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub node_id: String,
    pub strategic_weight: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePhaseCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub phase_id: String,
    pub name: String,
    pub position: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamePhaseCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub phase_id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhasePosition {
    pub phase_id: String,
    pub position: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderPhasesCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub phases: Vec<PhasePosition>,
}

/// Move one phase to a new place among its siblings (Story 27.2, D8(c), R3).
/// Anchors plus intended index; either anchor may be null at an end.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MovePhaseCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub phase_id: String,
    pub after_id: Option<String>,
    pub before_id: Option<String>,
    pub intended_index: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignNodePhaseCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub node_id: String,
    pub phase_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePhaseCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub phase_id: String,
    pub reassignments: std::collections::HashMap<String, Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePhaseCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub phase_id: String,
    pub name: String,
    pub position: String,
    pub prior_assignments: std::collections::HashMap<String, Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateUnlockEdgeCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub edge_id: String,
    pub source_node_id: String,
    pub target_node_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteUnlockEdgeCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub edge_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_node_id: Option<String>,
}

// ── Epic 4 commands ─────────────────────────────────────────────────────────

pub const FINDING_ORPHANED_FEATURE: &str = "OrphanedFeature";
pub const FINDING_PHASE_SEQUENCING: &str = "PhaseSequencingConflict";
pub const FINDING_DATE_SEQUENCING: &str = "DateSequencingConflict";
pub const FINDING_UNLOCK_CYCLE: &str = "UnlockCycle";
pub const FINDING_STRATEGIC_IMBALANCE: &str = "StrategicImbalance";
pub const FINDING_OVERRIDE_BOUNDARY: &str = "ExplicitOverrideBoundaryViolation";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DismissFindingCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub finding_id: String,
    pub finding_kind: String,
    pub target_id: String,
    pub fingerprint: String,
    pub dismissed_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndismissFindingCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub finding_id: String,
    pub finding_kind: String,
    pub target_id: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AffectedReasonInput {
    pub id: String,
    pub affected_node_id: String,
    pub causal_node_id: String,
    pub causal_node_title: String,
    pub delta_days: i64,
    pub causal_date_summary: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordAffectedReasonsCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub reasons: Vec<AffectedReasonInput>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcknowledgeAffectedReasonCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub reason_id: String,
    pub acknowledged_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearNodeAffectedReasonsCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub node_id: String,
}

// ── Epic 16 commands (Story 16.1) ───────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddNodeQuestionCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub question_id: String,
    pub node_id: String,
    pub question_text: String,
    pub position: String,
    #[serde(rename = "createdAtISO", alias = "createdAtIso")]
    pub created_at_iso: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNodeQuestionCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub question_id: String,
    pub question_text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveNodeQuestionCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub question_id: String,
    pub decision_text: String,
    #[serde(rename = "resolvedAtISO", alias = "resolvedAtIso")]
    pub resolved_at_iso: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderNodeQuestionsCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub node_id: String,
    pub question_ids: Vec<String>,
}

/// Move one node question among its siblings (Story 27.2, D8(c), R3). Anchors
/// plus intended index; either anchor may be null at an end.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveNodeQuestionCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub node_id: String,
    pub question_id: String,
    pub after_id: Option<String>,
    pub before_id: Option<String>,
    pub intended_index: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteNodeQuestionCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub question_id: String,
}

// ── Epic 18 commands (Story 18.2) ─────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureForecastPlanCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub points_per_sprint: Option<i64>,
    pub sprint_length_days: Option<i64>,
    pub start_sprint_ordinal: Option<i64>,
    pub start_date: Option<String>,
    /// Story 21.13 D5: level applied atomically at plan CREATION; `None`
    /// preserves the stored level (edit-in-place saves never carry one).
    #[serde(default)]
    pub planning_level: Option<String>,
}

/// Story 21.13 D5: the undo-side inverse of atomic plan creation — deletes
/// the forecast plan row so a single Undo returns to the pre-creation state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveForecastPlanCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetForecastMembershipCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub feature_id: String,
    pub included: bool,
}

// ── Epic 19 commands (Story 19.2) ─────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderForecastFeaturesCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub feature_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetForecastSequenceCommand {
    #[serde(skip)] pub command_name: String,
    pub protocol_version: String, pub command_id: String, pub project_id: String,
    pub base_revision: i64, pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub feature_ids: Vec<String>, pub parallel_groups: Vec<ParallelGroup>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetForecastParallelGroupsCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub parallel_groups: Vec<ParallelGroup>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreForecastScopeCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub selected_feature_ids: Vec<String>,
    pub parallel_groups: Vec<ParallelGroup>,
    /// Blocked set to restore alongside scope/groups (Epic 20, Story 20.1).
    #[serde(default)]
    pub blocked_feature_ids: Vec<String>,
    /// Assignments to restore alongside scope/groups (Story 22.4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignments: Option<HashMap<String, Vec<String>>>,
}

// ── Epic 20 commands (Story 20.1) ─────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetForecastBlockerCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub feature_id: String,
    pub blocked: bool,
}

// ── Epic 20 commands (Story 20.4) ─────────────────────────────────────────
// The scenario baseline + patch are opaque validated JSON to the native
// layer — stored as blobs and reproduced verbatim (AD-22).

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateForecastScenarioCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub scenario_id: String,
    pub label: String,
    pub baseline_revision: i64,
    pub expected_material_fingerprint: String,
    pub created_at_iso: String,
    pub patch: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveForecastScenarioCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub scenario_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreForecastScenarioCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub scenario: serde_json::Value,
}

// ── Epic 21 commands (Story 21.7) ─────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetForecastPlanningLevelCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub planning_level: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreForecastPlanningLevelCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub planning_level: String,
    pub selected_feature_ids: Vec<String>,
    pub parallel_groups: Vec<ParallelGroup>,
    #[serde(default)]
    pub blocked_feature_ids: Vec<String>,
    /// Assignments to restore alongside level/scope (Story 22.4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignments: Option<HashMap<String, Vec<String>>>,
}

// ── Epic 22 Commands (Story 22.3, Story 22.4) ───────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastPersonDto {
    pub id: String,
    pub name: String,
    pub weight_units: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddForecastPersonCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub person_id: String,
    pub name: String,
    pub weight_units: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateForecastPersonCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub person_id: String,
    pub name: String,
    pub weight_units: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveForecastPersonCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub person_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreForecastPersonCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub person: ForecastPersonDto,
    /// Assignments to restore alongside person (Story 22.4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignments: Option<HashMap<String, Vec<String>>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetForecastAssignmentsCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub feature_id: String,
    pub person_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetForecastPolicyCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub policy_version: String,
}

/// Group placement intent carried by a forecast feature move (Story 27.2,
/// D8(c)):
/// - `Unchanged` — group membership is left exactly as it was;
/// - `Join` — the moved feature joins the group of `partner_id`;
/// - `Leave` — the moved feature leaves whatever group it was in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ForecastGroupChange {
    Unchanged,
    Join { partner_id: String },
    Leave,
}

/// Move one scope member in the forecast priority order with an optional group
/// change (Story 27.2, D8(c), R3). Anchors plus intended index; either anchor
/// may be null at an end.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveForecastFeatureCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub feature_id: String,
    pub after_id: Option<String>,
    pub before_id: Option<String>,
    pub intended_index: i64,
    pub group_change: ForecastGroupChange,
}

/// Assign or unassign one roster person on one forecast item (Story 27.2,
/// D8(d)).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetForecastAssignmentCommand {
    #[serde(skip)]
    pub command_name: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub expected_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub feature_id: String,
    pub person_id: String,
    pub assigned: bool,
}

// ── Discriminated union ─────────────────────────────────────────────────────

/// The full product command envelope (E9-FR3).
/// Tag names match the TypeScript `type` discriminant exactly (PascalCase).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ProductCommand {
    CreateProject(CreateProjectCommand),
    RenameProject(RenameProjectCommand),
    DeleteProject(DeleteProjectCommand),
    CreateNode(CreateNodeCommand),
    SetNodeTitle(SetNodeTitleCommand),
    SetNodeBodyText(SetNodeBodyTextCommand),
    MoveNode(MoveNodeCommand),
    DeleteSubtree(DeleteSubtreeCommand),
    DuplicateSubtree(DuplicateSubtreeCommand),
    RestoreSubtree(RestoreSubtreeCommand),
    SetNodeType(SetNodeTypeCommand),
    SetNodeCustomField(SetNodeCustomFieldCommand),
    PromoteFieldToTemplate(PromoteFieldToTemplateCommand),
    SetNodeSchedule(SetNodeScheduleCommand),
    ToggleNodeCompleted(ToggleNodeCompletedCommand),
    SetNodeEffort(SetNodeEffortCommand),
    SetNodeStatus(SetNodeStatusCommand),
    SetThemeWeight(SetThemeWeightCommand),
    CreatePhase(CreatePhaseCommand),
    RenamePhase(RenamePhaseCommand),
    ReorderPhases(ReorderPhasesCommand),
    MovePhase(MovePhaseCommand),
    AssignNodePhase(AssignNodePhaseCommand),
    DeletePhase(DeletePhaseCommand),
    RestorePhase(RestorePhaseCommand),
    CreateUnlockEdge(CreateUnlockEdgeCommand),
    DeleteUnlockEdge(DeleteUnlockEdgeCommand),
    DismissFinding(DismissFindingCommand),
    UndismissFinding(UndismissFindingCommand),
    RecordAffectedReasons(RecordAffectedReasonsCommand),
    AcknowledgeAffectedReason(AcknowledgeAffectedReasonCommand),
    ClearNodeAffectedReasons(ClearNodeAffectedReasonsCommand),
    AddNodeQuestion(AddNodeQuestionCommand),
    UpdateNodeQuestion(UpdateNodeQuestionCommand),
    ResolveNodeQuestion(ResolveNodeQuestionCommand),
    ReorderNodeQuestions(ReorderNodeQuestionsCommand),
    MoveNodeQuestion(MoveNodeQuestionCommand),
    DeleteNodeQuestion(DeleteNodeQuestionCommand),
    ConfigureForecastPlan(ConfigureForecastPlanCommand),
    SetForecastMembership(SetForecastMembershipCommand),
    SetForecastBlocker(SetForecastBlockerCommand),
    CreateForecastScenario(CreateForecastScenarioCommand),
    RemoveForecastScenario(RemoveForecastScenarioCommand),
    RestoreForecastScenario(RestoreForecastScenarioCommand),
    ReorderForecastFeatures(ReorderForecastFeaturesCommand),
    SetForecastSequence(SetForecastSequenceCommand),
    SetForecastParallelGroups(SetForecastParallelGroupsCommand),
    RestoreForecastScope(RestoreForecastScopeCommand),
    SetForecastPlanningLevel(SetForecastPlanningLevelCommand),
    RestoreForecastPlanningLevel(RestoreForecastPlanningLevelCommand),
    RemoveForecastPlan(RemoveForecastPlanCommand),
    AddForecastPerson(AddForecastPersonCommand),
    UpdateForecastPerson(UpdateForecastPersonCommand),
    RemoveForecastPerson(RemoveForecastPersonCommand),
    RestoreForecastPerson(RestoreForecastPersonCommand),
    SetForecastAssignments(SetForecastAssignmentsCommand),
    SetForecastPolicy(SetForecastPolicyCommand),
    MoveForecastFeature(MoveForecastFeatureCommand),
    SetForecastAssignment(SetForecastAssignmentCommand),
}

// ── Results ─────────────────────────────────────────────────────────────────

/// Node change type used inside change sets (subset needed for undo/redo).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum NodeChange {
    NodeCreated {
        node_id: String,
        parent_id: Option<String>,
        position: String,
        title: String,
    },
    NodeTitleSet {
        node_id: String,
        title: String,
        prior_title: String,
    },
    NodeBodyTextSet {
        node_id: String,
        body_text: Option<String>,
        prior_body_text: Option<String>,
    },
    NodeMoved {
        node_id: String,
        parent_id: Option<String>,
        position: String,
        prior_parent_id: Option<String>,
        prior_position: String,
    },
    SiblingPositionsRebalanced {
        parent_id: Option<String>,
        positions: Vec<PositionPair>,
    },
    SubtreeDeleted {
        root_node_id: String,
        nodes: Vec<NodeSnapshot>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        deletion_bundle: Option<DeletionBundle>,
    },
    SubtreeRestored {
        root_node_id: String,
        nodes: Vec<NodeSnapshot>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        deletion_bundle: Option<DeletionBundle>,
    },
    SubtreeDuplicated {
        source_root_id: String,
        new_root_id: String,
        nodes: Vec<NodeSnapshot>,
    },
    NodeTypeSet {
        node_id: String,
        node_type: Option<String>,
        prior_node_type: Option<String>,
    },
    NodeCustomFieldSet {
        node_id: String,
        field_key: String,
        field_value: Option<String>,
        prior_field_value: Option<String>,
    },
    FieldTemplatePromoted {
        node_type: String,
        field_key: String,
        field_label: String,
    },
    NodeScheduleSet {
        node_id: String,
        start_date: Option<String>,
        end_date: Option<String>,
        duration_days: Option<i64>,
        source_mode: String,
        prior_start_date: Option<String>,
        prior_end_date: Option<String>,
        prior_duration_days: Option<i64>,
        prior_source_mode: String,
    },
    NodeCompletedToggled {
        node_id: String,
        completed: bool,
        prior_completed: bool,
    },
    NodeEffortSet {
        node_id: String,
        effort_points: Option<i64>,
        prior_effort_points: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cleared_assignments: Option<Vec<String>>,
    },
    NodeStatusSet {
        node_id: String,
        delivery_status: String,
        prior_delivery_status: String,
    },
    ThemeWeightSet {
        node_id: String,
        strategic_weight: Option<i64>,
        prior_strategic_weight: Option<i64>,
    },
    PhaseCreated {
        phase_id: String,
        name: String,
        position: String,
    },
    PhaseRenamed {
        phase_id: String,
        name: String,
        prior_name: String,
    },
    PhasesReordered {
        phases: Vec<PositionPair>,
        prior_phases: Vec<PositionPair>,
    },
    NodePhaseAssigned {
        node_id: String,
        phase_id: Option<String>,
        prior_phase_id: Option<String>,
    },
    PhaseDeleted {
        phase_id: String,
        name: String,
        position: String,
        reassignments: std::collections::HashMap<String, Option<String>>,
        prior_assignments: std::collections::HashMap<String, Option<String>>,
    },
    PhaseRestored {
        phase_id: String,
        name: String,
        position: String,
        prior_assignments: std::collections::HashMap<String, Option<String>>,
    },
    UnlockEdgeCreated {
        edge_id: String,
        source_node_id: String,
        target_node_id: String,
    },
    UnlockEdgeDeleted {
        edge_id: String,
        source_node_id: String,
        target_node_id: String,
    },
    FindingDismissed {
        finding_id: String,
        finding_kind: String,
        target_id: String,
        fingerprint: String,
        dismissed_at: String,
    },
    FindingUndismissed {
        finding_id: String,
        finding_kind: String,
        target_id: String,
        fingerprint: String,
        prior_dismissed_at: String,
    },
    AffectedReasonsRecorded {
        reasons: Vec<AffectedReasonInput>,
    },
    AffectedReasonAcknowledged {
        reason_id: String,
        acknowledged_at: String,
    },
    NodeQuestionAdded {
        question_id: String,
        node_id: String,
        question_text: String,
        position: String,
        #[serde(rename = "createdAtISO", alias = "createdAtIso")]
        created_at_iso: String,
    },
    NodeQuestionUpdated {
        question_id: String,
        question_text: String,
        prior_question_text: String,
    },
    NodeQuestionResolved {
        question_id: String,
        decision_text: String,
        #[serde(rename = "resolvedAtISO", alias = "resolvedAtIso")]
        resolved_at_iso: String,
        prior_status: String,
        prior_decision_text: Option<String>,
        #[serde(rename = "priorResolvedAtISO", alias = "priorResolvedAtIso")]
        prior_resolved_at_iso: Option<String>,
    },
    NodeQuestionsReordered {
        node_id: String,
        question_ids: Vec<String>,
        prior_question_ids: Vec<String>,
    },
    NodeQuestionDeleted {
        question_id: String,
        node_id: String,
        question_text: String,
        status: String,
        decision_text: Option<String>,
        position: String,
        #[serde(rename = "resolvedAtISO", alias = "resolvedAtIso")]
        resolved_at_iso: Option<String>,
        #[serde(rename = "createdAtISO", alias = "createdAtIso")]
        created_at_iso: String,
    },
    // ── Epic 18 changes (Story 18.2) ────────────────────────────────────
    ForecastPlanCreated {
        project_id: String,
    },
    ForecastPlanRemoved {
        project_id: String,
    },
    ForecastConfigurationSet {
        points_per_sprint: Option<i64>,
        sprint_length_days: Option<i64>,
        start_sprint_ordinal: Option<i64>,
        start_date: Option<String>,
        prior_points_per_sprint: Option<i64>,
        prior_sprint_length_days: Option<i64>,
        prior_start_sprint_ordinal: Option<i64>,
        prior_start_date: Option<String>,
    },
    ForecastScopeSet {
        selected_feature_ids: Vec<String>,
        parallel_groups: Vec<ParallelGroup>,
        prior_selected_feature_ids: Vec<String>,
        prior_parallel_groups: Vec<ParallelGroup>,
        // Epic 20, Story 20.1: excluding a blocked Feature clears its blocker
        // in the same change so the transition is fully reversible (AR-19).
        blocked_feature_ids: Vec<String>,
        prior_blocked_feature_ids: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cleared_assignments: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prior_assignments: Option<HashMap<String, Vec<String>>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        assignments: Option<HashMap<String, Vec<String>>>,
    },
    ForecastOrderSet {
        selected_feature_ids: Vec<String>,
        prior_selected_feature_ids: Vec<String>,
    },
    ForecastSequenceSet {
        selected_feature_ids: Vec<String>,
        parallel_groups: Vec<ParallelGroup>,
        prior_selected_feature_ids: Vec<String>,
        prior_parallel_groups: Vec<ParallelGroup>,
    },
    ForecastParallelGroupsSet {
        parallel_groups: Vec<ParallelGroup>,
        prior_parallel_groups: Vec<ParallelGroup>,
    },
    // ── Epic 20 changes (Story 20.1) ───────────────────────────────────
    ForecastBlockerSet {
        feature_id: String,
        blocked: bool,
        prior_blocked: bool,
    },
    // ── Epic 20 changes (Story 20.4) ───────────────────────────────────
    ForecastScenarioCreated {
        scenario: serde_json::Value,
    },
    ForecastScenarioRemoved {
        scenario_id: String,
        scenario: serde_json::Value,
    },
    ForecastScenarioRestored {
        scenario: serde_json::Value,
    },
    // ── Epic 21 changes (Story 21.7) ───────────────────────────────────
    ForecastPlanningLevelSet {
        planning_level: String,
        selected_feature_ids: Vec<String>,
        parallel_groups: Vec<ParallelGroup>,
        blocked_feature_ids: Vec<String>,
        prior_planning_level: String,
        prior_selected_feature_ids: Vec<String>,
        prior_parallel_groups: Vec<ParallelGroup>,
        prior_blocked_feature_ids: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prior_assignments: Option<HashMap<String, Vec<String>>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        assignments: Option<HashMap<String, Vec<String>>>,
    },
    // ── Epic 22 changes (Story 22.3, Story 22.4) ───────────────────────
    ForecastPersonAdded {
        project_id: String,
        person: ForecastPersonDto,
    },
    ForecastPersonUpdated {
        project_id: String,
        person_id: String,
        name: String,
        weight_units: i64,
        prior_name: String,
        prior_weight_units: i64,
    },
    ForecastPersonRemoved {
        project_id: String,
        person: ForecastPersonDto,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prior_assignments: Option<HashMap<String, Vec<String>>>,
    },
    ForecastPersonRestored {
        project_id: String,
        person: ForecastPersonDto,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        assignments: Option<HashMap<String, Vec<String>>>,
    },
    ForecastAssignmentsSet {
        project_id: String,
        feature_id: String,
        person_ids: Vec<String>,
        prior_person_ids: Vec<String>,
    },
    ForecastPolicySet {
        project_id: String,
        policy_version: String,
        prior_policy_version: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParallelGroup {
    pub feature_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionPair {
    pub node_id: String,
    pub position: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    pub protocol_version: String,
    pub project_id: String,
    pub base_revision: i64,
    pub target_revision: i64,
    pub changes: Vec<NodeChange>,
}

fn applied_result_type() -> String { "ProductCommandApplied".into() }
fn rejected_result_type() -> String { "ProductCommandRejected".into() }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductCommandApplied {
    #[serde(skip, default = "applied_result_type")]
    pub result_type: String,
    pub protocol_version: String,
    pub command_id: String,
    pub project_id: String,
    pub base_revision: i64,
    pub target_revision: i64,
    pub outcome: String,
    pub disposition: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change_set: Option<ChangeSet>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductCommandRejected {
    #[serde(skip, default = "rejected_result_type")]
    pub result_type: String,
    pub protocol_version: String,
    pub command_id: String,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub person_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflicting_feature_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feature_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ProductCommandResult {
    ProductCommandApplied(ProductCommandApplied),
    ProductCommandRejected(ProductCommandRejected),
}

/// Native-only repository open result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryOpenResult {
    pub project_id: String,
    pub sqlite_version: String,
    pub application_id: i64,
    pub user_version: i64,
    pub ready: bool,
}

impl ProductCommand {
    /// Envelope field accessors — the webview always sends these fields.
    pub fn command_id(&self) -> &str {
        match self {
            ProductCommand::CreateProject(c) => &c.command_id,
            ProductCommand::RenameProject(c) => &c.command_id,
            ProductCommand::DeleteProject(c) => &c.command_id,
            ProductCommand::CreateNode(c) => &c.command_id,
            ProductCommand::SetNodeTitle(c) => &c.command_id,
            ProductCommand::SetNodeBodyText(c) => &c.command_id,
            ProductCommand::MoveNode(c) => &c.command_id,
            ProductCommand::DeleteSubtree(c) => &c.command_id,
            ProductCommand::DuplicateSubtree(c) => &c.command_id,
            ProductCommand::RestoreSubtree(c) => &c.command_id,
            ProductCommand::SetNodeType(c) => &c.command_id,
            ProductCommand::SetNodeCustomField(c) => &c.command_id,
            ProductCommand::PromoteFieldToTemplate(c) => &c.command_id,
            ProductCommand::SetNodeSchedule(c) => &c.command_id,
            ProductCommand::ToggleNodeCompleted(c) => &c.command_id,
            ProductCommand::SetNodeEffort(c) => &c.command_id,
            ProductCommand::SetNodeStatus(c) => &c.command_id,
            ProductCommand::SetThemeWeight(c) => &c.command_id,
            ProductCommand::CreatePhase(c) => &c.command_id,
            ProductCommand::RenamePhase(c) => &c.command_id,
            ProductCommand::ReorderPhases(c) => &c.command_id,
            ProductCommand::MovePhase(c) => &c.command_id,
            ProductCommand::AssignNodePhase(c) => &c.command_id,
            ProductCommand::DeletePhase(c) => &c.command_id,
            ProductCommand::RestorePhase(c) => &c.command_id,
            ProductCommand::CreateUnlockEdge(c) => &c.command_id,
            ProductCommand::DeleteUnlockEdge(c) => &c.command_id,
            ProductCommand::DismissFinding(c) => &c.command_id,
            ProductCommand::UndismissFinding(c) => &c.command_id,
            ProductCommand::RecordAffectedReasons(c) => &c.command_id,
            ProductCommand::AcknowledgeAffectedReason(c) => &c.command_id,
            ProductCommand::ClearNodeAffectedReasons(c) => &c.command_id,
            ProductCommand::AddNodeQuestion(c) => &c.command_id,
            ProductCommand::UpdateNodeQuestion(c) => &c.command_id,
            ProductCommand::ResolveNodeQuestion(c) => &c.command_id,
            ProductCommand::ReorderNodeQuestions(c) => &c.command_id,
            ProductCommand::MoveNodeQuestion(c) => &c.command_id,
            ProductCommand::DeleteNodeQuestion(c) => &c.command_id,
            ProductCommand::ConfigureForecastPlan(c) => &c.command_id,
            ProductCommand::SetForecastMembership(c) => &c.command_id,
            ProductCommand::SetForecastBlocker(c) => &c.command_id,
            ProductCommand::CreateForecastScenario(c) => &c.command_id,
            ProductCommand::RemoveForecastScenario(c) => &c.command_id,
            ProductCommand::RestoreForecastScenario(c) => &c.command_id,
            ProductCommand::ReorderForecastFeatures(c) => &c.command_id,
            ProductCommand::SetForecastSequence(c) => &c.command_id,
            ProductCommand::SetForecastParallelGroups(c) => &c.command_id,
            ProductCommand::RestoreForecastScope(c) => &c.command_id,
            ProductCommand::SetForecastPlanningLevel(c) => &c.command_id,
            ProductCommand::RestoreForecastPlanningLevel(c) => &c.command_id,
            ProductCommand::RemoveForecastPlan(c) => &c.command_id,
            ProductCommand::AddForecastPerson(c) => &c.command_id,
            ProductCommand::UpdateForecastPerson(c) => &c.command_id,
            ProductCommand::RemoveForecastPerson(c) => &c.command_id,
            ProductCommand::RestoreForecastPerson(c) => &c.command_id,
            ProductCommand::SetForecastAssignments(c) => &c.command_id,
            ProductCommand::SetForecastPolicy(c) => &c.command_id,
            ProductCommand::MoveForecastFeature(c) => &c.command_id,
            ProductCommand::SetForecastAssignment(c) => &c.command_id,
        }
    }

    /// Actor identity carried by the envelope, if any (Story 27.3).
    pub fn actor_id(&self) -> Option<&str> {
        match self {
            ProductCommand::CreateProject(c) => c.actor_id.as_deref(),
            ProductCommand::RenameProject(c) => c.actor_id.as_deref(),
            ProductCommand::DeleteProject(c) => c.actor_id.as_deref(),
            ProductCommand::CreateNode(c) => c.actor_id.as_deref(),
            ProductCommand::SetNodeTitle(c) => c.actor_id.as_deref(),
            ProductCommand::SetNodeBodyText(c) => c.actor_id.as_deref(),
            ProductCommand::MoveNode(c) => c.actor_id.as_deref(),
            ProductCommand::DeleteSubtree(c) => c.actor_id.as_deref(),
            ProductCommand::DuplicateSubtree(c) => c.actor_id.as_deref(),
            ProductCommand::RestoreSubtree(c) => c.actor_id.as_deref(),
            ProductCommand::SetNodeType(c) => c.actor_id.as_deref(),
            ProductCommand::SetNodeCustomField(c) => c.actor_id.as_deref(),
            ProductCommand::PromoteFieldToTemplate(c) => c.actor_id.as_deref(),
            ProductCommand::SetNodeSchedule(c) => c.actor_id.as_deref(),
            ProductCommand::ToggleNodeCompleted(c) => c.actor_id.as_deref(),
            ProductCommand::SetNodeEffort(c) => c.actor_id.as_deref(),
            ProductCommand::SetNodeStatus(c) => c.actor_id.as_deref(),
            ProductCommand::SetThemeWeight(c) => c.actor_id.as_deref(),
            ProductCommand::CreatePhase(c) => c.actor_id.as_deref(),
            ProductCommand::RenamePhase(c) => c.actor_id.as_deref(),
            ProductCommand::ReorderPhases(c) => c.actor_id.as_deref(),
            ProductCommand::MovePhase(c) => c.actor_id.as_deref(),
            ProductCommand::AssignNodePhase(c) => c.actor_id.as_deref(),
            ProductCommand::DeletePhase(c) => c.actor_id.as_deref(),
            ProductCommand::RestorePhase(c) => c.actor_id.as_deref(),
            ProductCommand::CreateUnlockEdge(c) => c.actor_id.as_deref(),
            ProductCommand::DeleteUnlockEdge(c) => c.actor_id.as_deref(),
            ProductCommand::DismissFinding(c) => c.actor_id.as_deref(),
            ProductCommand::UndismissFinding(c) => c.actor_id.as_deref(),
            ProductCommand::RecordAffectedReasons(c) => c.actor_id.as_deref(),
            ProductCommand::AcknowledgeAffectedReason(c) => c.actor_id.as_deref(),
            ProductCommand::ClearNodeAffectedReasons(c) => c.actor_id.as_deref(),
            ProductCommand::AddNodeQuestion(c) => c.actor_id.as_deref(),
            ProductCommand::UpdateNodeQuestion(c) => c.actor_id.as_deref(),
            ProductCommand::ResolveNodeQuestion(c) => c.actor_id.as_deref(),
            ProductCommand::ReorderNodeQuestions(c) => c.actor_id.as_deref(),
            ProductCommand::MoveNodeQuestion(c) => c.actor_id.as_deref(),
            ProductCommand::DeleteNodeQuestion(c) => c.actor_id.as_deref(),
            ProductCommand::ConfigureForecastPlan(c) => c.actor_id.as_deref(),
            ProductCommand::SetForecastMembership(c) => c.actor_id.as_deref(),
            ProductCommand::SetForecastBlocker(c) => c.actor_id.as_deref(),
            ProductCommand::CreateForecastScenario(c) => c.actor_id.as_deref(),
            ProductCommand::RemoveForecastScenario(c) => c.actor_id.as_deref(),
            ProductCommand::RestoreForecastScenario(c) => c.actor_id.as_deref(),
            ProductCommand::ReorderForecastFeatures(c) => c.actor_id.as_deref(),
            ProductCommand::SetForecastSequence(c) => c.actor_id.as_deref(),
            ProductCommand::SetForecastParallelGroups(c) => c.actor_id.as_deref(),
            ProductCommand::RestoreForecastScope(c) => c.actor_id.as_deref(),
            ProductCommand::SetForecastPlanningLevel(c) => c.actor_id.as_deref(),
            ProductCommand::RestoreForecastPlanningLevel(c) => c.actor_id.as_deref(),
            ProductCommand::RemoveForecastPlan(c) => c.actor_id.as_deref(),
            ProductCommand::AddForecastPerson(c) => c.actor_id.as_deref(),
            ProductCommand::UpdateForecastPerson(c) => c.actor_id.as_deref(),
            ProductCommand::RemoveForecastPerson(c) => c.actor_id.as_deref(),
            ProductCommand::RestoreForecastPerson(c) => c.actor_id.as_deref(),
            ProductCommand::SetForecastAssignments(c) => c.actor_id.as_deref(),
            ProductCommand::SetForecastPolicy(c) => c.actor_id.as_deref(),
            ProductCommand::MoveForecastFeature(c) => c.actor_id.as_deref(),
            ProductCommand::SetForecastAssignment(c) => c.actor_id.as_deref(),
        }
    }

    pub fn project_id(&self) -> &str {
        match self {
            ProductCommand::CreateProject(c) => &c.project_id,
            ProductCommand::RenameProject(c) => &c.project_id,
            ProductCommand::DeleteProject(c) => &c.project_id,
            ProductCommand::CreateNode(c) => &c.project_id,
            ProductCommand::SetNodeTitle(c) => &c.project_id,
            ProductCommand::SetNodeBodyText(c) => &c.project_id,
            ProductCommand::MoveNode(c) => &c.project_id,
            ProductCommand::DeleteSubtree(c) => &c.project_id,
            ProductCommand::DuplicateSubtree(c) => &c.project_id,
            ProductCommand::RestoreSubtree(c) => &c.project_id,
            ProductCommand::SetNodeType(c) => &c.project_id,
            ProductCommand::SetNodeCustomField(c) => &c.project_id,
            ProductCommand::PromoteFieldToTemplate(c) => &c.project_id,
            ProductCommand::SetNodeSchedule(c) => &c.project_id,
            ProductCommand::ToggleNodeCompleted(c) => &c.project_id,
            ProductCommand::SetNodeEffort(c) => &c.project_id,
            ProductCommand::SetNodeStatus(c) => &c.project_id,
            ProductCommand::SetThemeWeight(c) => &c.project_id,
            ProductCommand::CreatePhase(c) => &c.project_id,
            ProductCommand::RenamePhase(c) => &c.project_id,
            ProductCommand::ReorderPhases(c) => &c.project_id,
            ProductCommand::MovePhase(c) => &c.project_id,
            ProductCommand::AssignNodePhase(c) => &c.project_id,
            ProductCommand::DeletePhase(c) => &c.project_id,
            ProductCommand::RestorePhase(c) => &c.project_id,
            ProductCommand::CreateUnlockEdge(c) => &c.project_id,
            ProductCommand::DeleteUnlockEdge(c) => &c.project_id,
            ProductCommand::DismissFinding(c) => &c.project_id,
            ProductCommand::UndismissFinding(c) => &c.project_id,
            ProductCommand::RecordAffectedReasons(c) => &c.project_id,
            ProductCommand::AcknowledgeAffectedReason(c) => &c.project_id,
            ProductCommand::ClearNodeAffectedReasons(c) => &c.project_id,
            ProductCommand::AddNodeQuestion(c) => &c.project_id,
            ProductCommand::UpdateNodeQuestion(c) => &c.project_id,
            ProductCommand::ResolveNodeQuestion(c) => &c.project_id,
            ProductCommand::ReorderNodeQuestions(c) => &c.project_id,
            ProductCommand::MoveNodeQuestion(c) => &c.project_id,
            ProductCommand::DeleteNodeQuestion(c) => &c.project_id,
            ProductCommand::ConfigureForecastPlan(c) => &c.project_id,
            ProductCommand::SetForecastMembership(c) => &c.project_id,
            ProductCommand::SetForecastBlocker(c) => &c.project_id,
            ProductCommand::CreateForecastScenario(c) => &c.project_id,
            ProductCommand::RemoveForecastScenario(c) => &c.project_id,
            ProductCommand::RestoreForecastScenario(c) => &c.project_id,
            ProductCommand::ReorderForecastFeatures(c) => &c.project_id,
            ProductCommand::SetForecastSequence(c) => &c.project_id,
            ProductCommand::SetForecastParallelGroups(c) => &c.project_id,
            ProductCommand::RestoreForecastScope(c) => &c.project_id,
            ProductCommand::SetForecastPlanningLevel(c) => &c.project_id,
            ProductCommand::RestoreForecastPlanningLevel(c) => &c.project_id,
            ProductCommand::RemoveForecastPlan(c) => &c.project_id,
            ProductCommand::AddForecastPerson(c) => &c.project_id,
            ProductCommand::UpdateForecastPerson(c) => &c.project_id,
            ProductCommand::RemoveForecastPerson(c) => &c.project_id,
            ProductCommand::RestoreForecastPerson(c) => &c.project_id,
            ProductCommand::SetForecastAssignments(c) => &c.project_id,
            ProductCommand::SetForecastPolicy(c) => &c.project_id,
            ProductCommand::MoveForecastFeature(c) => &c.project_id,
            ProductCommand::SetForecastAssignment(c) => &c.project_id,
        }
    }

    pub fn base_revision(&self) -> i64 {
        match self {
            ProductCommand::CreateProject(c) => c.base_revision,
            ProductCommand::RenameProject(c) => c.base_revision,
            ProductCommand::DeleteProject(c) => c.base_revision,
            ProductCommand::CreateNode(c) => c.base_revision,
            ProductCommand::SetNodeTitle(c) => c.base_revision,
            ProductCommand::SetNodeBodyText(c) => c.base_revision,
            ProductCommand::MoveNode(c) => c.base_revision,
            ProductCommand::DeleteSubtree(c) => c.base_revision,
            ProductCommand::DuplicateSubtree(c) => c.base_revision,
            ProductCommand::RestoreSubtree(c) => c.base_revision,
            ProductCommand::SetNodeType(c) => c.base_revision,
            ProductCommand::SetNodeCustomField(c) => c.base_revision,
            ProductCommand::PromoteFieldToTemplate(c) => c.base_revision,
            ProductCommand::SetNodeSchedule(c) => c.base_revision,
            ProductCommand::ToggleNodeCompleted(c) => c.base_revision,
            ProductCommand::SetNodeEffort(c) => c.base_revision,
            ProductCommand::SetNodeStatus(c) => c.base_revision,
            ProductCommand::SetThemeWeight(c) => c.base_revision,
            ProductCommand::CreatePhase(c) => c.base_revision,
            ProductCommand::RenamePhase(c) => c.base_revision,
            ProductCommand::ReorderPhases(c) => c.base_revision,
            ProductCommand::MovePhase(c) => c.base_revision,
            ProductCommand::AssignNodePhase(c) => c.base_revision,
            ProductCommand::DeletePhase(c) => c.base_revision,
            ProductCommand::RestorePhase(c) => c.base_revision,
            ProductCommand::CreateUnlockEdge(c) => c.base_revision,
            ProductCommand::DeleteUnlockEdge(c) => c.base_revision,
            ProductCommand::DismissFinding(c) => c.base_revision,
            ProductCommand::UndismissFinding(c) => c.base_revision,
            ProductCommand::RecordAffectedReasons(c) => c.base_revision,
            ProductCommand::AcknowledgeAffectedReason(c) => c.base_revision,
            ProductCommand::ClearNodeAffectedReasons(c) => c.base_revision,
            ProductCommand::AddNodeQuestion(c) => c.base_revision,
            ProductCommand::UpdateNodeQuestion(c) => c.base_revision,
            ProductCommand::ResolveNodeQuestion(c) => c.base_revision,
            ProductCommand::ReorderNodeQuestions(c) => c.base_revision,
            ProductCommand::MoveNodeQuestion(c) => c.base_revision,
            ProductCommand::DeleteNodeQuestion(c) => c.base_revision,
            ProductCommand::ConfigureForecastPlan(c) => c.base_revision,
            ProductCommand::SetForecastMembership(c) => c.base_revision,
            ProductCommand::SetForecastBlocker(c) => c.base_revision,
            ProductCommand::CreateForecastScenario(c) => c.base_revision,
            ProductCommand::RemoveForecastScenario(c) => c.base_revision,
            ProductCommand::RestoreForecastScenario(c) => c.base_revision,
            ProductCommand::ReorderForecastFeatures(c) => c.base_revision,
            ProductCommand::SetForecastSequence(c) => c.base_revision,
            ProductCommand::SetForecastParallelGroups(c) => c.base_revision,
            ProductCommand::RestoreForecastScope(c) => c.base_revision,
            ProductCommand::SetForecastPlanningLevel(c) => c.base_revision,
            ProductCommand::RestoreForecastPlanningLevel(c) => c.base_revision,
            ProductCommand::RemoveForecastPlan(c) => c.base_revision,
            ProductCommand::AddForecastPerson(c) => c.base_revision,
            ProductCommand::UpdateForecastPerson(c) => c.base_revision,
            ProductCommand::RemoveForecastPerson(c) => c.base_revision,
            ProductCommand::RestoreForecastPerson(c) => c.base_revision,
            ProductCommand::SetForecastAssignments(c) => c.base_revision,
            ProductCommand::SetForecastPolicy(c) => c.base_revision,
            ProductCommand::MoveForecastFeature(c) => c.base_revision,
            ProductCommand::SetForecastAssignment(c) => c.base_revision,
        }
    }

    pub fn expected_revision(&self) -> i64 {
        match self {
            ProductCommand::CreateProject(c) => c.expected_revision,
            ProductCommand::RenameProject(c) => c.expected_revision,
            ProductCommand::DeleteProject(c) => c.expected_revision,
            ProductCommand::CreateNode(c) => c.expected_revision,
            ProductCommand::SetNodeTitle(c) => c.expected_revision,
            ProductCommand::SetNodeBodyText(c) => c.expected_revision,
            ProductCommand::MoveNode(c) => c.expected_revision,
            ProductCommand::DeleteSubtree(c) => c.expected_revision,
            ProductCommand::DuplicateSubtree(c) => c.expected_revision,
            ProductCommand::RestoreSubtree(c) => c.expected_revision,
            ProductCommand::SetNodeType(c) => c.expected_revision,
            ProductCommand::SetNodeCustomField(c) => c.expected_revision,
            ProductCommand::PromoteFieldToTemplate(c) => c.expected_revision,
            ProductCommand::SetNodeSchedule(c) => c.expected_revision,
            ProductCommand::ToggleNodeCompleted(c) => c.expected_revision,
            ProductCommand::SetNodeEffort(c) => c.expected_revision,
            ProductCommand::SetNodeStatus(c) => c.expected_revision,
            ProductCommand::SetThemeWeight(c) => c.expected_revision,
            ProductCommand::CreatePhase(c) => c.expected_revision,
            ProductCommand::RenamePhase(c) => c.expected_revision,
            ProductCommand::ReorderPhases(c) => c.expected_revision,
            ProductCommand::MovePhase(c) => c.expected_revision,
            ProductCommand::AssignNodePhase(c) => c.expected_revision,
            ProductCommand::DeletePhase(c) => c.expected_revision,
            ProductCommand::RestorePhase(c) => c.expected_revision,
            ProductCommand::CreateUnlockEdge(c) => c.expected_revision,
            ProductCommand::DeleteUnlockEdge(c) => c.expected_revision,
            ProductCommand::DismissFinding(c) => c.expected_revision,
            ProductCommand::UndismissFinding(c) => c.expected_revision,
            ProductCommand::RecordAffectedReasons(c) => c.expected_revision,
            ProductCommand::AcknowledgeAffectedReason(c) => c.expected_revision,
            ProductCommand::ClearNodeAffectedReasons(c) => c.expected_revision,
            ProductCommand::AddNodeQuestion(c) => c.expected_revision,
            ProductCommand::UpdateNodeQuestion(c) => c.expected_revision,
            ProductCommand::ResolveNodeQuestion(c) => c.expected_revision,
            ProductCommand::ReorderNodeQuestions(c) => c.expected_revision,
            ProductCommand::MoveNodeQuestion(c) => c.expected_revision,
            ProductCommand::DeleteNodeQuestion(c) => c.expected_revision,
            ProductCommand::ConfigureForecastPlan(c) => c.expected_revision,
            ProductCommand::SetForecastMembership(c) => c.expected_revision,
            ProductCommand::SetForecastBlocker(c) => c.expected_revision,
            ProductCommand::CreateForecastScenario(c) => c.expected_revision,
            ProductCommand::RemoveForecastScenario(c) => c.expected_revision,
            ProductCommand::RestoreForecastScenario(c) => c.expected_revision,
            ProductCommand::ReorderForecastFeatures(c) => c.expected_revision,
            ProductCommand::SetForecastSequence(c) => c.expected_revision,
            ProductCommand::SetForecastParallelGroups(c) => c.expected_revision,
            ProductCommand::RestoreForecastScope(c) => c.expected_revision,
            ProductCommand::SetForecastPlanningLevel(c) => c.expected_revision,
            ProductCommand::RestoreForecastPlanningLevel(c) => c.expected_revision,
            ProductCommand::RemoveForecastPlan(c) => c.expected_revision,
            ProductCommand::AddForecastPerson(c) => c.expected_revision,
            ProductCommand::UpdateForecastPerson(c) => c.expected_revision,
            ProductCommand::RemoveForecastPerson(c) => c.expected_revision,
            ProductCommand::RestoreForecastPerson(c) => c.expected_revision,
            ProductCommand::SetForecastAssignments(c) => c.expected_revision,
            ProductCommand::SetForecastPolicy(c) => c.expected_revision,
            ProductCommand::MoveForecastFeature(c) => c.expected_revision,
            ProductCommand::SetForecastAssignment(c) => c.expected_revision,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            ProductCommand::CreateProject(_) => "CreateProject",
            ProductCommand::RenameProject(_) => "RenameProject",
            ProductCommand::DeleteProject(_) => "DeleteProject",
            ProductCommand::CreateNode(_) => "CreateNode",
            ProductCommand::SetNodeTitle(_) => "SetNodeTitle",
            ProductCommand::SetNodeBodyText(_) => "SetNodeBodyText",
            ProductCommand::MoveNode(_) => "MoveNode",
            ProductCommand::DeleteSubtree(_) => "DeleteSubtree",
            ProductCommand::DuplicateSubtree(_) => "DuplicateSubtree",
            ProductCommand::RestoreSubtree(_) => "RestoreSubtree",
            ProductCommand::SetNodeType(_) => "SetNodeType",
            ProductCommand::SetNodeCustomField(_) => "SetNodeCustomField",
            ProductCommand::PromoteFieldToTemplate(_) => "PromoteFieldToTemplate",
            ProductCommand::SetNodeSchedule(_) => "SetNodeSchedule",
            ProductCommand::ToggleNodeCompleted(_) => "ToggleNodeCompleted",
            ProductCommand::SetNodeEffort(_) => "SetNodeEffort",
            ProductCommand::SetNodeStatus(_) => "SetNodeStatus",
            ProductCommand::SetThemeWeight(_) => "SetThemeWeight",
            ProductCommand::CreatePhase(_) => "CreatePhase",
            ProductCommand::RenamePhase(_) => "RenamePhase",
            ProductCommand::ReorderPhases(_) => "ReorderPhases",
            ProductCommand::MovePhase(_) => "MovePhase",
            ProductCommand::AssignNodePhase(_) => "AssignNodePhase",
            ProductCommand::DeletePhase(_) => "DeletePhase",
            ProductCommand::RestorePhase(_) => "RestorePhase",
            ProductCommand::CreateUnlockEdge(_) => "CreateUnlockEdge",
            ProductCommand::DeleteUnlockEdge(_) => "DeleteUnlockEdge",
            ProductCommand::DismissFinding(_) => "DismissFinding",
            ProductCommand::UndismissFinding(_) => "UndismissFinding",
            ProductCommand::RecordAffectedReasons(_) => "RecordAffectedReasons",
            ProductCommand::AcknowledgeAffectedReason(_) => "AcknowledgeAffectedReason",
            ProductCommand::ClearNodeAffectedReasons(_) => "ClearNodeAffectedReasons",
            ProductCommand::AddNodeQuestion(_) => "AddNodeQuestion",
            ProductCommand::UpdateNodeQuestion(_) => "UpdateNodeQuestion",
            ProductCommand::ResolveNodeQuestion(_) => "ResolveNodeQuestion",
            ProductCommand::ReorderNodeQuestions(_) => "ReorderNodeQuestions",
            ProductCommand::MoveNodeQuestion(_) => "MoveNodeQuestion",
            ProductCommand::DeleteNodeQuestion(_) => "DeleteNodeQuestion",
            ProductCommand::ConfigureForecastPlan(_) => "ConfigureForecastPlan",
            ProductCommand::SetForecastMembership(_) => "SetForecastMembership",
            ProductCommand::SetForecastBlocker(_) => "SetForecastBlocker",
            ProductCommand::CreateForecastScenario(_) => "CreateForecastScenario",
            ProductCommand::RemoveForecastScenario(_) => "RemoveForecastScenario",
            ProductCommand::RestoreForecastScenario(_) => "RestoreForecastScenario",
            ProductCommand::ReorderForecastFeatures(_) => "ReorderForecastFeatures",
            ProductCommand::SetForecastSequence(_) => "SetForecastSequence",
            ProductCommand::SetForecastParallelGroups(_) => "SetForecastParallelGroups",
            ProductCommand::RestoreForecastScope(_) => "RestoreForecastScope",
            ProductCommand::SetForecastPlanningLevel(_) => "SetForecastPlanningLevel",
            ProductCommand::RestoreForecastPlanningLevel(_) => "RestoreForecastPlanningLevel",
            ProductCommand::RemoveForecastPlan(_) => "RemoveForecastPlan",
            ProductCommand::AddForecastPerson(_) => "AddForecastPerson",
            ProductCommand::UpdateForecastPerson(_) => "UpdateForecastPerson",
            ProductCommand::RemoveForecastPerson(_) => "RemoveForecastPerson",
            ProductCommand::RestoreForecastPerson(_) => "RestoreForecastPerson",
            ProductCommand::SetForecastAssignments(_) => "SetForecastAssignments",
            ProductCommand::SetForecastPolicy(_) => "SetForecastPolicy",
            ProductCommand::MoveForecastFeature(_) => "MoveForecastFeature",
            ProductCommand::SetForecastAssignment(_) => "SetForecastAssignment",
        }
    }

    pub fn protocol_version(&self) -> &str {
        match self {
            ProductCommand::CreateProject(c) => &c.protocol_version,
            ProductCommand::RenameProject(c) => &c.protocol_version,
            ProductCommand::DeleteProject(c) => &c.protocol_version,
            ProductCommand::CreateNode(c) => &c.protocol_version,
            ProductCommand::SetNodeTitle(c) => &c.protocol_version,
            ProductCommand::SetNodeBodyText(c) => &c.protocol_version,
            ProductCommand::MoveNode(c) => &c.protocol_version,
            ProductCommand::DeleteSubtree(c) => &c.protocol_version,
            ProductCommand::DuplicateSubtree(c) => &c.protocol_version,
            ProductCommand::RestoreSubtree(c) => &c.protocol_version,
            ProductCommand::SetNodeType(c) => &c.protocol_version,
            ProductCommand::SetNodeCustomField(c) => &c.protocol_version,
            ProductCommand::PromoteFieldToTemplate(c) => &c.protocol_version,
            ProductCommand::SetNodeSchedule(c) => &c.protocol_version,
            ProductCommand::ToggleNodeCompleted(c) => &c.protocol_version,
            ProductCommand::SetNodeEffort(c) => &c.protocol_version,
            ProductCommand::SetNodeStatus(c) => &c.protocol_version,
            ProductCommand::SetThemeWeight(c) => &c.protocol_version,
            ProductCommand::CreatePhase(c) => &c.protocol_version,
            ProductCommand::RenamePhase(c) => &c.protocol_version,
            ProductCommand::ReorderPhases(c) => &c.protocol_version,
            ProductCommand::MovePhase(c) => &c.protocol_version,
            ProductCommand::AssignNodePhase(c) => &c.protocol_version,
            ProductCommand::DeletePhase(c) => &c.protocol_version,
            ProductCommand::RestorePhase(c) => &c.protocol_version,
            ProductCommand::CreateUnlockEdge(c) => &c.protocol_version,
            ProductCommand::DeleteUnlockEdge(c) => &c.protocol_version,
            ProductCommand::DismissFinding(c) => &c.protocol_version,
            ProductCommand::UndismissFinding(c) => &c.protocol_version,
            ProductCommand::RecordAffectedReasons(c) => &c.protocol_version,
            ProductCommand::AcknowledgeAffectedReason(c) => &c.protocol_version,
            ProductCommand::ClearNodeAffectedReasons(c) => &c.protocol_version,
            ProductCommand::AddNodeQuestion(c) => &c.protocol_version,
            ProductCommand::UpdateNodeQuestion(c) => &c.protocol_version,
            ProductCommand::ResolveNodeQuestion(c) => &c.protocol_version,
            ProductCommand::ReorderNodeQuestions(c) => &c.protocol_version,
            ProductCommand::MoveNodeQuestion(c) => &c.protocol_version,
            ProductCommand::DeleteNodeQuestion(c) => &c.protocol_version,
            ProductCommand::ConfigureForecastPlan(c) => &c.protocol_version,
            ProductCommand::SetForecastMembership(c) => &c.protocol_version,
            ProductCommand::SetForecastBlocker(c) => &c.protocol_version,
            ProductCommand::CreateForecastScenario(c) => &c.protocol_version,
            ProductCommand::RemoveForecastScenario(c) => &c.protocol_version,
            ProductCommand::RestoreForecastScenario(c) => &c.protocol_version,
            ProductCommand::ReorderForecastFeatures(c) => &c.protocol_version,
            ProductCommand::SetForecastSequence(c) => &c.protocol_version,
            ProductCommand::SetForecastParallelGroups(c) => &c.protocol_version,
            ProductCommand::RestoreForecastScope(c) => &c.protocol_version,
            ProductCommand::SetForecastPlanningLevel(c) => &c.protocol_version,
            ProductCommand::RestoreForecastPlanningLevel(c) => &c.protocol_version,
            ProductCommand::RemoveForecastPlan(c) => &c.protocol_version,
            ProductCommand::AddForecastPerson(c) => &c.protocol_version,
            ProductCommand::UpdateForecastPerson(c) => &c.protocol_version,
            ProductCommand::RemoveForecastPerson(c) => &c.protocol_version,
            ProductCommand::RestoreForecastPerson(c) => &c.protocol_version,
            ProductCommand::SetForecastAssignments(c) => &c.protocol_version,
            ProductCommand::SetForecastPolicy(c) => &c.protocol_version,
            ProductCommand::MoveForecastFeature(c) => &c.protocol_version,
            ProductCommand::SetForecastAssignment(c) => &c.protocol_version,
        }
    }
}

impl ProductCommandResult {
    /// Marks a replayed receipt result as `StoredResultReturned` (Story 9.2 AC 3).
    pub fn set_disposition_stored(&mut self) {
        if let ProductCommandResult::ProductCommandApplied(applied) = self {
            applied.disposition = "StoredResultReturned".to_string();
        }
    }
}

/// Body-free revision invalidation event (E9-AR7).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionInvalidated {
    pub project_id: String,
    pub revision: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserializes_create_project_command_camel_case() {
        let json = serde_json::json!({
            "type": "CreateProject",
            "protocolVersion": "1.0.0",
            "commandId": "0198a000-0000-7000-8000-000000000001",
            "projectId": "0198a000-0000-7000-8000-000000000002",
            "baseRevision": 0,
            "expectedRevision": 1,
            "name": "Test"
        });
        let cmd: ProductCommand = serde_json::from_value(json).unwrap();
        assert!(matches!(cmd, ProductCommand::CreateProject(_)));
    }

    #[test]
    fn serializes_applied_result_matching_ts_contract() {
        let result = ProductCommandResult::ProductCommandApplied(ProductCommandApplied {
            result_type: "ProductCommandApplied".to_string(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            command_id: "0198a000-0000-7000-8000-000000000001".to_string(),
            project_id: "0198a000-0000-7000-8000-000000000002".to_string(),
            base_revision: 0,
            target_revision: 1,
            outcome: "VfsCommitAccepted".to_string(),
            disposition: "NewCommit".to_string(),
            change_set: None,
        });
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["type"], "ProductCommandApplied");
        assert_eq!(json["outcome"], "VfsCommitAccepted");
        assert_eq!(json["disposition"], "NewCommit");
    }

    #[test]
    fn serializes_node_changes_matching_ts_contract() {
        let change = NodeChange::SubtreeDeleted {
            deletion_bundle: None,
            root_node_id: "0198a000-0000-7000-8000-000000000003".to_string(),
            nodes: Vec::new(),
        };

        let json = serde_json::to_value(change).unwrap();
        assert_eq!(json["type"], "SubtreeDeleted");
        assert_eq!(
            json["rootNodeId"],
            "0198a000-0000-7000-8000-000000000003"
        );
        assert!(json.get("root_node_id").is_none());
    }

    #[test]
    fn set_node_status_command_round_trips_camel_case() {
        let json = serde_json::json!({
            "type": "SetNodeStatus",
            "protocolVersion": "1.0.0",
            "commandId": "0198a000-0000-7000-8000-000000000001",
            "projectId": "0198a000-0000-7000-8000-000000000002",
            "baseRevision": 4,
            "expectedRevision": 5,
            "nodeId": "0198a000-0000-7000-8000-000000000003",
            "deliveryStatus": "in_progress"
        });
        let cmd: ProductCommand = serde_json::from_value(json).unwrap();
        match &cmd {
            ProductCommand::SetNodeStatus(c) => {
                assert_eq!(c.delivery_status, "in_progress");
                assert_eq!(c.node_id, "0198a000-0000-7000-8000-000000000003");
            }
            _ => panic!("expected SetNodeStatus"),
        }
        assert_eq!(cmd.kind(), "SetNodeStatus");
    }

    #[test]
    fn node_status_set_change_serializes_camel_case() {
        let change = NodeChange::NodeStatusSet {
            node_id: "0198a000-0000-7000-8000-000000000003".to_string(),
            delivery_status: "delivered".to_string(),
            prior_delivery_status: "in_progress".to_string(),
        };
        let json = serde_json::to_value(change).unwrap();
        assert_eq!(json["type"], "NodeStatusSet");
        assert_eq!(json["deliveryStatus"], "delivered");
        assert_eq!(json["priorDeliveryStatus"], "in_progress");
        assert!(json.get("delivery_status").is_none());
    }
}
