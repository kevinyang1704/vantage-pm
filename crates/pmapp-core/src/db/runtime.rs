//! Native SQLite repository runtime (E9-FR2, E9-FR3, E9-FR6, E9-AR3, E9-AR4).
//!
//! The `RepositoryRuntime` owns the single SQLite connection and applies
//! commands strictly serially through a Tokio actor queue. Writes are
//! serialized FIFO in arrival order (E9-FR12); the actor holds the write
//! connection exclusively.

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};

use crate::protocol::commands::{ProductCommand, ProductCommandResult, RepositoryOpenResult};
use crate::protocol::errors::RepositoryError;

use crate::db::handler;
use crate::db::collaboration::{self, OutboxEntry, OutboxState, RemoteCommand, Rejection, RebaseOutcome};
use crate::db::schema::{CURRENT_SCHEMA_VERSION, PMAPP_APPLICATION_ID};
use crate::db::workspace::{
    self, WorkspaceMutation, WorkspaceMutationResult, WorkspaceRegistry,
};

/// App-managed data directory layout (E9-FR6):
/// - production: `<app-data>/pmapp.sqlite`
/// - development: `<app-data>/pmapp-dev.sqlite`
pub const PRODUCTION_DB_FILE: &str = "pmapp.sqlite";
pub const DEVELOPMENT_DB_FILE: &str = "pmapp-dev.sqlite";

// ── Read models (raw row surfaces; the TS domain projects them) ────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
    pub revision: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRow {
    pub id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub body_text: Option<String>,
    pub position: i64,
    pub node_type: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub duration_days: Option<i64>,
    pub schedule_source_mode: Option<String>,
    pub completed: bool,
    pub effort_points: Option<i64>,
    /// Story 26.5: points done; appended after `effort_points` so migrated
    /// and fresh databases read the same column order.
    pub effort_points_done: Option<i64>,
    pub strategic_weight: Option<i64>,
    pub phase_id: Option<String>,
    pub delivery_status: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseRow {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub position: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockEdgeRow {
    pub id: String,
    pub project_id: String,
    pub source_node_id: String,
    pub target_node_id: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomFieldRow {
    pub node_id: String,
    pub field_key: String,
    pub field_value: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DismissalRow {
    pub project_id: String,
    pub finding_id: String,
    pub finding_kind: String,
    pub target_id: String,
    pub fingerprint: String,
    pub dismissed_at: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AffectedReasonRow {
    pub id: String,
    pub project_id: String,
    pub affected_node_id: String,
    pub causal_node_id: String,
    pub causal_node_title: String,
    pub delta_days: i64,
    pub causal_date_summary: String,
    pub created_at: String,
    pub acknowledged_at: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeOpenQuestionRow {
    pub id: String,
    pub project_id: String,
    pub node_id: String,
    pub question_text: String,
    pub status: String,
    pub decision_text: Option<String>,
    pub position: i64,
    #[serde(rename = "resolvedAtISO", alias = "resolvedAtIso")]
    pub resolved_at_iso: Option<String>,
    #[serde(rename = "createdAtISO", alias = "createdAtIso")]
    pub created_at_iso: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewStateRow {
    pub project_id: String,
    pub view_id: String,
    pub view_state_revision: i64,
    pub collapsed_node_ids: String,
    pub zoom_root_id: Option<String>,
    pub scroll_top: f64,
    pub focused_theme_id: Option<String>,
    pub date_window_start: Option<String>,
    pub date_window_end: Option<String>,
    pub granularity: Option<String>,
    /// Visual-tree viewport pan offset (E10-AR9).
    pub pan_x: f64,
    /// Visual-tree viewport pan offset (E10-AR9).
    pub pan_y: f64,
    /// Visual-tree viewport scale (E10-AR9).
    pub scale: f64,
    /// Side-navigation collapsed presentation, per project + view (E15-AR2).
    pub nav_collapsed: bool,
}

/// Everything the webview needs to project an `OutlineReadModel` /
/// `AnalysisSnapshotRequest` for one project.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshotRows {
    pub project_id: String,
    pub project_name: String,
    pub revision: i64,
    pub nodes: Vec<NodeRow>,
    pub phases: Vec<PhaseRow>,
    pub unlock_edges: Vec<UnlockEdgeRow>,
    pub custom_fields: Vec<CustomFieldRow>,
    pub type_template_fields: Vec<TypeTemplateFieldRow>,
    pub dismissals: Vec<DismissalRow>,
    pub affected_reasons: Vec<AffectedReasonRow>,
    pub open_questions: Vec<NodeOpenQuestionRow>,
    /// Optional project-owned forecast plan (Epic 18, Story 18.2). None when the
    /// project has no plan; carried so the native build has full parity with
    /// the browser `queryAnalysisSnapshot` / portable snapshot.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forecast_plan: Option<ForecastPlanRow>,
    /// Set when the stored plan exists but a cell cannot be read (corrupt
    /// JSON or a shape the DTOs reject). The plan is then omitted — never
    /// read as an empty plan or an empty roster — and the rest of the
    /// snapshot stays usable, so coherence analysis keeps running. Mirrors
    /// the browser's `forecastPlanError` (`FORECAST_PLAN_CORRUPT: <column>`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forecast_plan_error: Option<String>,
    /// Saved historical trade-off scenarios (Epic 20, Story 20.4). Opaque
    /// validated JSON records — inputs only, reproduced verbatim.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub forecast_scenarios: Vec<serde_json::Value>,
}

/// A parallel group as stored in `forecast_plans.parallel_groups` JSON.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastParallelGroupDto {
    pub feature_ids: Vec<String>,
}

/// The project-owned forecast plan, flattened for the webview (mirrors the
/// TS native snapshot `forecastPlan` shape). Epic 18, Story 18.2.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastPlanRow {
    pub selected_feature_ids: Vec<String>,
    pub parallel_groups: Vec<ForecastParallelGroupDto>,
    /// Forecast-owned explicitly-blocked Feature IDs (Epic 20, Story 20.1).
    #[serde(default)]
    pub blocked_feature_ids: Vec<String>,
    pub points_per_sprint: Option<i64>,
    pub sprint_length_days: Option<i64>,
    pub cadence: String,
    pub start_sprint_ordinal: Option<i64>,
    pub start_date: Option<String>,
    pub policy_version: String,
    /// The node hierarchy level this plan operates at (Epic 21, Story 21.7).
    /// Missing/unparseable values normalize to `"Feature"` on read.
    #[serde(default = "default_planning_level")]
    pub planning_level: String,
    #[serde(default)]
    pub roster: Vec<crate::protocol::commands::ForecastPersonDto>,
    #[serde(default)]
    pub assignments: std::collections::HashMap<String, Vec<String>>,
}

fn default_planning_level() -> String {
    "Feature".to_string()
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeTemplateFieldRow {
    pub node_type: String,
    pub field_key: String,
    pub field_label: String,
    pub position: i64,
}

/// Validated portable snapshot for atomic batch import (E13 Task 4).
/// Mirrors the TS `PortableProjectSnapshot` collections.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableImportSnapshot {
    pub project_id: String,
    pub project_name: String,
    pub project_revision: i64,
    pub phases: Vec<PortablePhaseDto>,
    pub nodes: Vec<PortableNodeDto>,
    pub node_custom_fields: Vec<PortableCustomFieldDto>,
    pub type_template_fields: Vec<PortableTypeTemplateDto>,
    pub unlock_edges: Vec<PortableUnlockEdgeDto>,
    pub finding_dismissals: Vec<PortableDismissalDto>,
    pub affected_reasons: Vec<PortableAffectedReasonDto>,
    pub open_questions: Vec<PortableNodeOpenQuestionDto>,
    /// Optional forecast plan (Epic 18, Story 18.2). Validated by the webview
    /// before dispatch; written inside the one import transaction.
    #[serde(default)]
    pub forecast_plan: Option<ForecastPlanRow>,
    /// Saved historical scenarios (Epic 20, Story 20.4). Validated by the
    /// webview; written inside the one import transaction.
    #[serde(default)]
    pub forecast_scenarios: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortablePhaseDto {
    pub id: String,
    pub name: String,
    pub position: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableNodeDto {
    pub id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub body_text: Option<String>,
    pub position: String,
    pub node_type: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub duration_days: Option<i64>,
    pub schedule_source_mode: Option<String>,
    pub completed: bool,
    pub effort_points: Option<i64>,
    /// Story 26.5, portable v9: absent in older files; `#[serde(default)]`
    /// reads it back as None ("not recorded").
    #[serde(default)]
    pub effort_points_done: Option<i64>,
    pub strategic_weight: Option<i64>,
    pub phase_id: Option<String>,
    pub delivery_status: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableCustomFieldDto {
    pub node_id: String,
    pub field_key: String,
    pub field_value: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableTypeTemplateDto {
    pub node_type: String,
    pub field_key: String,
    pub field_label: String,
    pub position: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableUnlockEdgeDto {
    pub id: String,
    pub source_node_id: String,
    pub target_node_id: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableDismissalDto {
    pub finding_id: String,
    pub finding_kind: String,
    pub target_id: String,
    pub fingerprint: String,
    pub dismissed_at: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableAffectedReasonDto {
    pub id: String,
    pub affected_node_id: String,
    pub causal_node_id: String,
    pub causal_node_title: String,
    pub delta_days: i64,
    pub causal_date_summary: String,
    pub created_at: String,
    pub acknowledged_at: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableNodeOpenQuestionDto {
    pub id: String,
    pub node_id: String,
    pub question_text: String,
    pub status: String,
    pub decision_text: Option<String>,
    pub position: String,
    #[serde(rename = "resolvedAtISO", alias = "resolvedAtIso")]
    pub resolved_at_iso: Option<String>,
    #[serde(rename = "createdAtISO", alias = "createdAtIso")]
    pub created_at_iso: String,
}

/// Messages flowing through the single-writer actor queue.
enum ActorCommand {
    LocalFile { operation: String, input: serde_json::Value, reply: oneshot::Sender<Result<serde_json::Value,RepositoryError>> },
    Apply {
        command: ProductCommand,
        reply: oneshot::Sender<Result<ProductCommandResult, RepositoryError>>,
    },
    Open {
        reply: oneshot::Sender<Result<RepositoryOpenResult, RepositoryError>>,
    },
    Close {
        reply: oneshot::Sender<Result<(), RepositoryError>>,
    },
    PauseIntake {
        reply: oneshot::Sender<Result<(), RepositoryError>>,
    },
    ResumeIntake {
        reply: oneshot::Sender<Result<(), RepositoryError>>,
    },
    QueryProjects {
        reply: oneshot::Sender<Result<Vec<ProjectRow>, RepositoryError>>,
    },
    QueryProjectSnapshot {
        project_id: String,
        reply: oneshot::Sender<Result<ProjectSnapshotRows, RepositoryError>>,
    },
    QueryViewState {
        project_id: String,
        view_id: String,
        reply: oneshot::Sender<Result<Option<ViewStateRow>, RepositoryError>>,
    },
    UpsertViewState {
        project_id: String,
        view_id: String,
        row: ViewStateRow,
        reply: oneshot::Sender<Result<(), RepositoryError>>,
    },
    BatchImportPortable {
        snapshot: PortableImportSnapshot,
        local_file_state_json: Option<String>,
        reply: oneshot::Sender<Result<serde_json::Value, RepositoryError>>,
    },
    // ── Epic 17: workspace registry ────────────────────────────────
    ApplyProductCommandBatch {
        commands: Vec<ProductCommand>,
        reply: oneshot::Sender<Result<Vec<ProductCommandResult>, RepositoryError>>,
    },
    InstallCollaborationSnapshot {
        project_id: String,
        envelope: crate::protocol::recovery::RecoveryEnvelope,
        archived_at_iso: String,
        reply: oneshot::Sender<Result<super::recovery_install::InstallOutcome, RepositoryError>>,
    },
    ReadOutbox { project_id: String, reply: oneshot::Sender<Result<OutboxState, RepositoryError>> },
    ReadHistory { project_id: String, before: Option<i64>, limit: i64, reply: oneshot::Sender<Result<Vec<collaboration::HistoryRow>, RepositoryError>> },
    ForgetCollaboration { project_id: String, reply: oneshot::Sender<Result<(), RepositoryError>> },
    DiscardOutbox { project_id: String, command_id: String, reply: oneshot::Sender<Result<(), RepositoryError>> },
    CommitWithOutbox { project_id: String, command: ProductCommand, entry: OutboxEntry, reply: oneshot::Sender<Result<ProductCommandResult, RepositoryError>> },
    CommitGroup { project_id: String, entries: Vec<OutboxEntry>, reply: oneshot::Sender<Result<Vec<ProductCommandResult>, RepositoryError>> },
    Rebase { project_id: String, remote: RemoteCommand, survivors: Vec<OutboxEntry>, rejected: Vec<Rejection>, reply: oneshot::Sender<Result<RebaseOutcome, RepositoryError>> },
    QueryWorkspaceRegistry {
        reply: oneshot::Sender<Result<WorkspaceRegistry, RepositoryError>>,
    },
    MutateWorkspace {
        mutation: WorkspaceMutation,
        reply: oneshot::Sender<Result<WorkspaceMutationResult, RepositoryError>>,
    },
}

/// The native repository actor handle. Clonable; sends commands to the queue.
#[derive(Clone)]
pub struct RepositoryRuntime {
    sender: mpsc::Sender<ActorCommand>,
    open: Arc<AtomicBool>,
    intake_paused: Arc<AtomicBool>,
}

impl RepositoryRuntime {
    /// Creates a runtime bound to the given database file path.
    pub fn new(db_path: PathBuf) -> Self {
        let (sender, receiver) = mpsc::channel(256);
        let open = Arc::new(AtomicBool::new(false));
        let intake_paused = Arc::new(AtomicBool::new(false));

        // Spawn the actor on the ambient Tokio runtime. The desktop composition
        // hosts a multi-threaded reactor (Tauri's async runtime), so the actor
        // shares the app-lifetime reactor; `pmapp-core` itself stays free of any
        // Tauri dependency.
        tokio::spawn(run_actor(receiver, db_path, open.clone(), intake_paused.clone()));

        RepositoryRuntime {
            sender,
            open,
            intake_paused,
        }
    }

    pub async fn local_file_operation(&self, operation:String, input:serde_json::Value)->Result<serde_json::Value,RepositoryError>{
        let(reply,rx)=oneshot::channel();self.sender.send(ActorCommand::LocalFile{operation,input,reply}).await.map_err(|_|RepositoryError::Internal)?;rx.await.map_err(|_|RepositoryError::Internal)?
    }
    pub async fn apply_product_command_batch(
        &self,
        commands: Vec<ProductCommand>,
    ) -> Result<Vec<ProductCommandResult>, RepositoryError> {
        let (reply, rx) = oneshot::channel();
        self.sender.send(ActorCommand::ApplyProductCommandBatch { commands, reply })
            .await.map_err(|_| RepositoryError::Internal)?;
        rx.await.map_err(|_| RepositoryError::Internal)?
    }

    pub async fn install_collaboration_snapshot(
        &self,
        project_id: String,
        envelope: crate::protocol::recovery::RecoveryEnvelope,
        archived_at_iso: String,
    ) -> Result<super::recovery_install::InstallOutcome, RepositoryError> {
        let (reply, rx) = oneshot::channel();
        self.sender.send(ActorCommand::InstallCollaborationSnapshot { project_id, envelope, archived_at_iso, reply })
            .await.map_err(|_| RepositoryError::Internal)?;
        rx.await.map_err(|_| RepositoryError::Internal)?
    }

    /// Reads and quarantines corrupt collaboration rows on the repository actor.
    pub async fn read_outbox(&self, project_id: String) -> Result<OutboxState, RepositoryError> {
        let (reply, rx) = oneshot::channel();
        self.sender.send(ActorCommand::ReadOutbox { project_id, reply })
            .await.map_err(|_| RepositoryError::Internal)?;
        rx.await.map_err(|_| RepositoryError::Internal)?
    }

    /// Confirmed activity history for the current stream epoch (27.8).
    pub async fn read_history(&self, project_id: String, before: Option<i64>, limit: i64) -> Result<Vec<collaboration::HistoryRow>, RepositoryError> {
        let (reply, rx) = oneshot::channel();
        self.sender.send(ActorCommand::ReadHistory { project_id, before, limit, reply })
            .await.map_err(|_| RepositoryError::Internal)?;
        rx.await.map_err(|_| RepositoryError::Internal)?
    }

    /// The owner stopped sharing: drop the project's sync state (keeps rejected work).
    pub async fn forget_collaboration(&self, project_id: String) -> Result<(), RepositoryError> {
        let (reply, rx) = oneshot::channel();
        self.sender.send(ActorCommand::ForgetCollaboration { project_id, reply })
            .await.map_err(|_| RepositoryError::Internal)?;
        rx.await.map_err(|_| RepositoryError::Internal)?
    }

    pub async fn discard_outbox(&self, project_id: String, command_id: String) -> Result<(), RepositoryError> {
        let (reply, rx) = oneshot::channel();
        self.sender.send(ActorCommand::DiscardOutbox { project_id, command_id, reply })
            .await.map_err(|_| RepositoryError::Internal)?;
        rx.await.map_err(|_| RepositoryError::Internal)?
    }

    pub async fn commit_with_outbox(
        &self, project_id: String, command: ProductCommand, entry: OutboxEntry,
    ) -> Result<ProductCommandResult, RepositoryError> {
        let (reply, rx) = oneshot::channel();
        self.sender.send(ActorCommand::CommitWithOutbox { project_id, command, entry, reply })
            .await.map_err(|_| RepositoryError::Internal)?;
        rx.await.map_err(|_| RepositoryError::Internal)?
    }

    /// A composite gesture's members + outbox entries in one actor transaction.
    pub async fn commit_group_with_outbox(&self, project_id: String, entries: Vec<OutboxEntry>) -> Result<Vec<ProductCommandResult>, RepositoryError> {
        let (reply, rx) = oneshot::channel();
        self.sender.send(ActorCommand::CommitGroup { project_id, entries, reply })
            .await.map_err(|_| RepositoryError::Internal)?;
        rx.await.map_err(|_| RepositoryError::Internal)?
    }

    pub async fn rebase(
        &self, project_id: String, remote: RemoteCommand,
        survivors: Vec<OutboxEntry>, rejected: Vec<Rejection>,
    ) -> Result<RebaseOutcome, RepositoryError> {
        let (reply, rx) = oneshot::channel();
        self.sender.send(ActorCommand::Rebase { project_id, remote, survivors, rejected, reply })
            .await.map_err(|_| RepositoryError::Internal)?;
        rx.await.map_err(|_| RepositoryError::Internal)?
    }

    /// Opens (or reopens) the SQLite database with the configured pragmas.
    pub async fn open(&self) -> Result<RepositoryOpenResult, RepositoryError> {
        let (reply, rx) = oneshot::channel();
        self.sender
            .send(ActorCommand::Open { reply })
            .await
            .map_err(|_| RepositoryError::Internal)?;
        rx.await.map_err(|_| RepositoryError::Internal)?
    }

    /// Applies a command serially (FIFO).
    pub async fn apply(&self, command: ProductCommand) -> Result<ProductCommandResult, RepositoryError> {
        let (reply, rx) = oneshot::channel();
        self.sender
            .send(ActorCommand::Apply { command, reply })
            .await
            .map_err(|_| RepositoryError::Internal)?;
        rx.await.map_err(|_| RepositoryError::Internal)?
    }

    /// Closes the connection after draining pending commands.
    pub async fn close(&self) -> Result<(), RepositoryError> {
        let (reply, rx) = oneshot::channel();
        self.sender
            .send(ActorCommand::Close { reply })
            .await
            .map_err(|_| RepositoryError::Internal)?;
        rx.await.map_err(|_| RepositoryError::Internal)?
    }

    /// Pauses command intake (shutdown lifecycle). Drains in-flight first.
    pub async fn pause_intake(&self) -> Result<(), RepositoryError> {
        let (reply, rx) = oneshot::channel();
        self.sender
            .send(ActorCommand::PauseIntake { reply })
            .await
            .map_err(|_| RepositoryError::Internal)?;
        rx.await.map_err(|_| RepositoryError::Internal)?
    }

    /// Resumes command intake.
    pub async fn resume_intake(&self) -> Result<(), RepositoryError> {
        let (reply, rx) = oneshot::channel();
        self.sender
            .send(ActorCommand::ResumeIntake { reply })
            .await
            .map_err(|_| RepositoryError::Internal)?;
        rx.await.map_err(|_| RepositoryError::Internal)?
    }

    pub fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    pub fn is_intake_paused(&self) -> bool {
        self.intake_paused.load(Ordering::SeqCst)
    }

    /// Atomically batch-imports a validated portable snapshot (E13 Task 4).
    /// One transaction; any failure rolls back and leaves existing projects
    /// unchanged. Returns the typed outcome matching the TS contract.
    pub async fn batch_import_portable(
        &self,
        snapshot: PortableImportSnapshot,
    ) -> Result<serde_json::Value, RepositoryError> {
        let (reply, rx) = oneshot::channel();
        self.sender
            .send(ActorCommand::BatchImportPortable { snapshot, local_file_state_json: None, reply })
            .await
            .map_err(|_| RepositoryError::Internal)?;
        rx.await.map_err(|_| RepositoryError::Internal)?
    }

    pub async fn batch_import_portable_with_state(&self,snapshot:PortableImportSnapshot,local_file_state_json:Option<String>)->Result<serde_json::Value,RepositoryError>{
       let(reply,rx)=oneshot::channel();self.sender.send(ActorCommand::BatchImportPortable{snapshot,local_file_state_json,reply}).await.map_err(|_|RepositoryError::Internal)?;rx.await.map_err(|_|RepositoryError::Internal)?
    }
    /// Lists projects (id, name, revision) ordered by name.
    pub async fn query_projects(&self) -> Result<Vec<ProjectRow>, RepositoryError> {
        let (reply, rx) = oneshot::channel();
        self.sender
            .send(ActorCommand::QueryProjects { reply })
            .await
            .map_err(|_| RepositoryError::Internal)?;
        rx.await.map_err(|_| RepositoryError::Internal)?
    }

    /// Reads all rows needed to project one project's read models.
    pub async fn query_project_snapshot(
        &self,
        project_id: String,
    ) -> Result<ProjectSnapshotRows, RepositoryError> {
        let (reply, rx) = oneshot::channel();
        self.sender
            .send(ActorCommand::QueryProjectSnapshot { project_id, reply })
            .await
            .map_err(|_| RepositoryError::Internal)?;
        rx.await.map_err(|_| RepositoryError::Internal)?
    }

    /// Reads one view-state row.
    pub async fn query_view_state(
        &self,
        project_id: String,
        view_id: String,
    ) -> Result<Option<ViewStateRow>, RepositoryError> {
        let (reply, rx) = oneshot::channel();
        self.sender
            .send(ActorCommand::QueryViewState { project_id, view_id, reply })
            .await
            .map_err(|_| RepositoryError::Internal)?;
        rx.await.map_err(|_| RepositoryError::Internal)?
    }

    /// Upserts a view-state row (view state lives on an isolated lane; it does
    /// not touch domain revisions).
    pub async fn upsert_view_state(
        &self,
        project_id: String,
        view_id: String,
        row: ViewStateRow,
    ) -> Result<(), RepositoryError> {
        let (reply, rx) = oneshot::channel();
        self.sender
            .send(ActorCommand::UpsertViewState { project_id, view_id, row, reply })
            .await
            .map_err(|_| RepositoryError::Internal)?;
        rx.await.map_err(|_| RepositoryError::Internal)?
    }

    /// Lists workspaces with project counts, plus the active workspace id.
    pub async fn query_workspace_registry(&self) -> Result<WorkspaceRegistry, RepositoryError> {
        let (reply, rx) = oneshot::channel();
        self.sender
            .send(ActorCommand::QueryWorkspaceRegistry { reply })
            .await
            .map_err(|_| RepositoryError::Internal)?;
        rx.await.map_err(|_| RepositoryError::Internal)?
    }

    /// Applies one workspace mutation. Goes through the same serial actor
    /// queue as product commands, so a workspace write can never interleave
    /// with a command that reads workspace membership.
    pub async fn mutate_workspace(
        &self,
        mutation: WorkspaceMutation,
    ) -> Result<WorkspaceMutationResult, RepositoryError> {
        let (reply, rx) = oneshot::channel();
        self.sender
            .send(ActorCommand::MutateWorkspace { mutation, reply })
            .await
            .map_err(|_| RepositoryError::Internal)?;
        rx.await.map_err(|_| RepositoryError::Internal)?
    }
}

async fn run_actor(
    mut receiver: mpsc::Receiver<ActorCommand>,
    db_path: PathBuf,
    open: Arc<AtomicBool>,
    intake_paused: Arc<AtomicBool>,
) {
    let mut conn: Option<Connection> = None;
    let mut paused = false;

    while let Some(msg) = receiver.recv().await {
        match msg {
            ActorCommand::Open { reply } => {
                let result = open_connection(&mut conn, &db_path);
                if result.is_ok() {
                    open.store(true, Ordering::SeqCst);
                }
                let _ = reply.send(result);
            }
            ActorCommand::Apply { command, reply } => {
                if paused {
                    let _ = reply.send(Err(RepositoryError::ShuttingDown));
                    continue;
                }
                let result = match &mut conn {
                    Some(c) => handler::apply(c, command),
                    None => Err(RepositoryError::StorageNotReady),
                };
                let _ = reply.send(result);
            }
            ActorCommand::ApplyProductCommandBatch { commands, reply } => {
                let result = if paused { Err(RepositoryError::ShuttingDown) } else {
                    match &mut conn {
                        Some(connection) => handler::apply_batch(connection, commands),
                        None => Err(RepositoryError::StorageNotReady),
                    }
                };
                let _ = reply.send(result);
            }
            ActorCommand::InstallCollaborationSnapshot { project_id, envelope, archived_at_iso, reply } => {
                let result = if paused { Err(RepositoryError::ShuttingDown) } else {
                    match &mut conn {
                        Some(connection) => super::recovery_install::install(connection, &project_id, envelope, &archived_at_iso),
                        None => Err(RepositoryError::StorageNotReady),
                    }
                };
                let _ = reply.send(result);
            }
            ActorCommand::ReadOutbox { project_id, reply } => {
                let result = if paused { Err(RepositoryError::ShuttingDown) } else {
                    match &mut conn {
                        Some(c) => collaboration::read(c, &project_id),
                        None => Err(RepositoryError::StorageNotReady),
                    }
                };
                let _ = reply.send(result);
            }
            ActorCommand::ReadHistory { project_id, before, limit, reply } => {
                let result = if paused { Err(RepositoryError::ShuttingDown) } else {
                    match &conn {
                        Some(c) => collaboration::read_history(c, &project_id, before, limit),
                        None => Err(RepositoryError::StorageNotReady),
                    }
                };
                let _ = reply.send(result);
            }
            ActorCommand::ForgetCollaboration { project_id, reply } => {
                let result = if paused { Err(RepositoryError::ShuttingDown) } else {
                    match &mut conn {
                        Some(c) => collaboration::forget(c, &project_id),
                        None => Err(RepositoryError::StorageNotReady),
                    }
                };
                let _ = reply.send(result);
            }
            ActorCommand::DiscardOutbox { project_id, command_id, reply } => {
                let result = if paused { Err(RepositoryError::ShuttingDown) } else {
                    match &mut conn {
                        Some(c) => collaboration::discard(c, &project_id, &command_id),
                        None => Err(RepositoryError::StorageNotReady),
                    }
                };
                let _ = reply.send(result);
            }
            ActorCommand::CommitWithOutbox { project_id, command, entry, reply } => {
                let result = if paused { Err(RepositoryError::ShuttingDown) } else {
                    match &mut conn {
                        Some(c) => collaboration::commit(c, &project_id, command, entry),
                        None => Err(RepositoryError::StorageNotReady),
                    }
                };
                let _ = reply.send(result);
            }
            ActorCommand::CommitGroup { project_id, entries, reply } => {
                let result = if paused { Err(RepositoryError::ShuttingDown) } else {
                    match &mut conn {
                        Some(c) => collaboration::commit_group(c, &project_id, entries),
                        None => Err(RepositoryError::StorageNotReady),
                    }
                };
                let _ = reply.send(result);
            }
            ActorCommand::Rebase { project_id, remote, survivors, rejected, reply } => {
                let result = if paused { Err(RepositoryError::ShuttingDown) } else {
                    match &mut conn {
                        Some(c) => collaboration::rebase(c, &project_id, remote, survivors, rejected),
                        None => Err(RepositoryError::StorageNotReady),
                    }
                };
                let _ = reply.send(result);
            }
            ActorCommand::PauseIntake { reply } => {
                paused = true;
                intake_paused.store(true, Ordering::SeqCst);
                let _ = reply.send(Ok(()));
            }
            ActorCommand::ResumeIntake { reply } => {
                paused = false;
                intake_paused.store(false, Ordering::SeqCst);
                let _ = reply.send(Ok(()));
            }
            ActorCommand::Close { reply } => {
                if let Some(c) = conn.take() {
                    // Checkpoint + close inside the actor (single-threaded).
                    let _ = c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
                    // Connection dropped here.
                }
                open.store(false, Ordering::SeqCst);
                let _ = reply.send(Ok(()));
            }
            ActorCommand::LocalFile { operation, input, reply } => {
                let result = if paused { Err(RepositoryError::StorageNotReady) } else {match &mut conn {Some(c)=>super::local_file::operate(c,&operation,input),None=>Err(RepositoryError::StorageNotReady)}};
                let _=reply.send(result);
            }
            ActorCommand::QueryProjects { reply } => {
                let result = match &conn {
                    Some(c) => query_projects(c),
                    None => Err(RepositoryError::StorageNotReady),
                };
                let _ = reply.send(result);
            }
            ActorCommand::QueryWorkspaceRegistry { reply } => {
                let result = match &conn {
                    Some(c) => workspace::query_workspace_registry(c),
                    None => Err(RepositoryError::StorageNotReady),
                };
                let _ = reply.send(result);
            }
            ActorCommand::MutateWorkspace { mutation, reply } => {
                let result = match &mut conn {
                    Some(c) => workspace::mutate_workspace(c, mutation),
                    None => Err(RepositoryError::StorageNotReady),
                };
                let _ = reply.send(result);
            }
            ActorCommand::QueryProjectSnapshot { project_id, reply } => {
                let result = match &conn {
                    Some(c) => query_project_snapshot(c, &project_id),
                    None => Err(RepositoryError::StorageNotReady),
                };
                let _ = reply.send(result);
            }
            ActorCommand::QueryViewState { project_id, view_id, reply } => {
                let result = match &conn {
                    Some(c) => query_view_state(c, &project_id, &view_id),
                    None => Err(RepositoryError::StorageNotReady),
                };
                let _ = reply.send(result);
            }
            ActorCommand::UpsertViewState { project_id, view_id, row, reply } => {
                let result = match &conn {
                    Some(c) => upsert_view_state(c, &project_id, &view_id, &row),
                    None => Err(RepositoryError::StorageNotReady),
                };
                let _ = reply.send(result);
            }
            ActorCommand::BatchImportPortable { snapshot, local_file_state_json, reply } => {
                let result = match &mut conn {
                    Some(c) => batch_import_portable_with_state(c, &snapshot, local_file_state_json.as_deref()),
                    None => Err(RepositoryError::StorageNotReady),
                };
                let _ = reply.send(result);
            }
        }
    }
}

pub(crate) fn open_connection(
    conn_slot: &mut Option<Connection>,
    db_path: &PathBuf,
) -> Result<RepositoryOpenResult, RepositoryError> {
    let mut conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE)
        .map_err(|_| RepositoryError::Internal)?;

    // Unsupported future schema: reject BEFORE any pragma that writes the
    // file (E9-FR11). `journal_mode` and `application_id` below rewrite the
    // header, so checking after them changed a newer writer's database — its
    // journal mode included — on the very path meant to leave it untouched
    // (Story 22.13, AC 22.13-4). Reading `user_version` does not write.
    let stored_version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|_| RepositoryError::Internal)?;
    if stored_version > CURRENT_SCHEMA_VERSION {
        return Err(RepositoryError::IntegrityFailed);
    }

    // Mandatory pragmas (E9-FR2, E9-NFR4).
    conn.pragma_update(None, "journal_mode", "WAL").map_err(|_| RepositoryError::Internal)?;
    conn.pragma_update(None, "synchronous", "FULL").map_err(|_| RepositoryError::Internal)?;
    conn.pragma_update(None, "foreign_keys", "ON").map_err(|_| RepositoryError::Internal)?;
    conn.pragma_update(None, "busy_timeout", 5000).map_err(|_| RepositoryError::Internal)?;
    // The node_type CHECK is baked into legacy databases and cannot be
    // ALTERed; the type vocabulary is enforced in the domain layer instead.
    conn.pragma_update(None, "ignore_check_constraints", "ON").map_err(|_| RepositoryError::Internal)?;

    // Application identity (E9-AR4).
    conn.pragma_update(None, "application_id", PMAPP_APPLICATION_ID).map_err(|_| RepositoryError::Internal)?;
    let user_version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|_| RepositoryError::Internal)?;

    if user_version == 0 {
        // Fresh database — initialize schema and set version.
        let tx=conn.transaction().map_err(|_|RepositoryError::Internal)?;
        handler::initialize_schema(&tx).map_err(|_| RepositoryError::Internal)?;
        tx.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION).map_err(|_| RepositoryError::Internal)?;
        tx.commit().map_err(|_|RepositoryError::Internal)?;
    } else if user_version < CURRENT_SCHEMA_VERSION {
        // Story 9.5: verified pre-migration snapshot first, then ordered
        // idempotent migration transactions (E9-FR11).
        let pre_migration = db_path.with_extension(format!("pre-migration-v{user_version}.sqlite"));
        crate::backup::snapshot_to(db_path, &pre_migration)?;
        let decision = crate::migration::runner::run_migrations(&mut conn)
            .map_err(|_| RepositoryError::IntegrityFailed)?;
        if matches!(
            decision,
            crate::migration::runner::RecoveryDecision::FutureSchemaVersionBlocked { .. }
        ) {
            return Err(RepositoryError::IntegrityFailed);
        }
    } else if user_version > CURRENT_SCHEMA_VERSION {
        // Unsupported future schema: reject without mutation (E9-FR11).
        return Err(RepositoryError::IntegrityFailed);
    }

    // Epic 17: the one-time backfill that gives every project a workspace,
    // plus the guarantee that at least one workspace exists and the active
    // pointer resolves. Runs after schema init/migration on every path.
    workspace::ensure_default_workspace(&conn)?;

    // Routine open checks (E9-FR10 / E9-AR4): quick_check + foreign_key_check.
    let quick: String = conn
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|_| RepositoryError::IntegrityFailed)?;
    if quick != "ok" {
        return Err(RepositoryError::IntegrityFailed);
    }
    let fk_count: i64 = conn
        .prepare("PRAGMA foreign_key_check")
        .map_err(|_| RepositoryError::IntegrityFailed)?
        .query_map([], |_| Ok(()))
        .map_err(|_| RepositoryError::IntegrityFailed)?
        .count() as i64;
    if fk_count > 0 {
        return Err(RepositoryError::IntegrityFailed);
    }

    let sqlite_version: String = conn
        .query_row("SELECT sqlite_version()", [], |row| row.get(0))
        .map_err(|_| RepositoryError::Internal)?;

    *conn_slot = Some(conn);
    Ok(RepositoryOpenResult {
        project_id: String::new(),
        sqlite_version,
        application_id: PMAPP_APPLICATION_ID,
        user_version: CURRENT_SCHEMA_VERSION,
        ready: true,
    })
}

// ── Read queries (raw row surfaces) ────────────────────────────────────────

/// Lists the projects in the ACTIVE workspace (Epic 17).
///
/// If the pointer cannot be resolved at all — only reachable on a store that
/// somehow has no workspaces despite ensure_default_workspace running at open
/// — this falls back to listing every project rather than returning an empty
/// list. Showing everything is a recoverable oddity; showing nothing looks
/// exactly like data loss.
fn query_projects(conn: &Connection) -> Result<Vec<ProjectRow>, RepositoryError> {
    let active = workspace::read_active_workspace_id(conn)?;

    let mut stmt = match &active {
        Some(_) => conn
            .prepare("SELECT id, name, revision FROM projects WHERE workspace_id = ?1 ORDER BY name ASC")
            .map_err(|_| RepositoryError::Internal)?,
        None => conn
            .prepare("SELECT id, name, revision FROM projects ORDER BY name ASC")
            .map_err(|_| RepositoryError::Internal)?,
    };

    let map_row = |r: &rusqlite::Row<'_>| {
        Ok(ProjectRow {
            id: r.get(0)?,
            name: r.get(1)?,
            revision: r.get(2)?,
        })
    };
    let rows = match &active {
        Some(id) => stmt
            .query_map([id], map_row)
            .map_err(|_| RepositoryError::Internal)?,
        None => stmt
            .query_map([], map_row)
            .map_err(|_| RepositoryError::Internal)?,
    };
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|_| RepositoryError::Internal)?);
    }
    Ok(out)
}

/// Parse one forecast-plan JSON cell. A failure yields the browser's marker
/// text (`FORECAST_PLAN_CORRUPT: <column>`, see `ForecastPlanCorruptError`)
/// instead of a default value, so a damaged or mis-keyed cell can never be
/// read as an empty scope, roster or assignment map.
fn parse_plan_cell<T: serde::de::DeserializeOwned + Default>(json: Option<&str>, column: &str) -> Result<T, String> {
    match json {
        None => Ok(T::default()),
        Some(s) => serde_json::from_str(s).map_err(|_| format!("FORECAST_PLAN_CORRUPT: {column}")),
    }
}

pub fn query_project_snapshot(conn: &Connection, project_id: &str) -> Result<ProjectSnapshotRows, RepositoryError> {
    let project: Option<(String, i64)> = conn
        .query_row(
            "SELECT name, revision FROM projects WHERE id = ?1",
            [project_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| RepositoryError::Internal)?;
    let (project_name, revision) = project.unwrap_or_else(|| (String::new(), 0));

    let mut nodes = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT id, parent_id, title, body_text, position, node_type, start_date, end_date,
                        duration_days, schedule_source_mode, completed, effort_points, effort_points_done,
                        strategic_weight, phase_id,
                        delivery_status
                 FROM nodes WHERE project_id = ?1 ORDER BY position ASC",
            )
            .map_err(|_| RepositoryError::Internal)?;
        let rows = stmt
            .query_map([project_id], |r| {
                Ok(NodeRow {
                    id: r.get(0)?,
                    parent_id: r.get(1)?,
                    title: r.get(2)?,
                    body_text: r.get(3)?,
                    position: r.get(4)?,
                    node_type: r.get(5)?,
                    start_date: r.get(6)?,
                    end_date: r.get(7)?,
                    duration_days: r.get(8)?,
                    schedule_source_mode: r.get(9)?,
                    completed: r.get::<_, i64>(10)? != 0,
                    effort_points: r.get(11)?,
                    effort_points_done: r.get(12)?,
                    strategic_weight: r.get(13)?,
                    phase_id: r.get(14)?,
                    delivery_status: r.get(15)?,
                })
            })
            .map_err(|_| RepositoryError::Internal)?;
        for row in rows {
            nodes.push(row.map_err(|_| RepositoryError::Internal)?);
        }
    }

    let mut phases = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, project_id, name, position FROM phases WHERE project_id = ?1 ORDER BY position ASC")
            .map_err(|_| RepositoryError::Internal)?;
        let rows = stmt
            .query_map([project_id], |r| {
                Ok(PhaseRow {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    name: r.get(2)?,
                    position: r.get(3)?,
                })
            })
            .map_err(|_| RepositoryError::Internal)?;
        for row in rows {
            phases.push(row.map_err(|_| RepositoryError::Internal)?);
        }
    }

    let mut unlock_edges = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, project_id, source_node_id, target_node_id FROM unlock_edges WHERE project_id = ?1")
            .map_err(|_| RepositoryError::Internal)?;
        let rows = stmt
            .query_map([project_id], |r| {
                Ok(UnlockEdgeRow {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    source_node_id: r.get(2)?,
                    target_node_id: r.get(3)?,
                })
            })
            .map_err(|_| RepositoryError::Internal)?;
        for row in rows {
            unlock_edges.push(row.map_err(|_| RepositoryError::Internal)?);
        }
    }

    let mut custom_fields = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT node_id, field_key, field_value FROM node_custom_fields WHERE project_id = ?1")
            .map_err(|_| RepositoryError::Internal)?;
        let rows = stmt
            .query_map([project_id], |r| {
                Ok(CustomFieldRow {
                    node_id: r.get(0)?,
                    field_key: r.get(1)?,
                    field_value: r.get(2)?,
                })
            })
            .map_err(|_| RepositoryError::Internal)?;
        for row in rows {
            custom_fields.push(row.map_err(|_| RepositoryError::Internal)?);
        }
    }

    let mut type_template_fields = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT node_type, field_key, field_label, position FROM type_template_fields WHERE project_id = ?1 ORDER BY position ASC")
            .map_err(|_| RepositoryError::Internal)?;
        let rows = stmt
            .query_map([project_id], |r| {
                Ok(TypeTemplateFieldRow {
                    node_type: r.get(0)?,
                    field_key: r.get(1)?,
                    field_label: r.get(2)?,
                    position: r.get(3)?,
                })
            })
            .map_err(|_| RepositoryError::Internal)?;
        for row in rows {
            type_template_fields.push(row.map_err(|_| RepositoryError::Internal)?);
        }
    }

    let mut dismissals = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT project_id, finding_id, finding_kind, target_id, fingerprint, dismissed_at FROM finding_dismissals WHERE project_id = ?1")
            .map_err(|_| RepositoryError::Internal)?;
        let rows = stmt
            .query_map([project_id], |r| {
                Ok(DismissalRow {
                    project_id: r.get(0)?,
                    finding_id: r.get(1)?,
                    finding_kind: r.get(2)?,
                    target_id: r.get(3)?,
                    fingerprint: r.get(4)?,
                    dismissed_at: r.get(5)?,
                })
            })
            .map_err(|_| RepositoryError::Internal)?;
        for row in rows {
            dismissals.push(row.map_err(|_| RepositoryError::Internal)?);
        }
    }

    let mut affected_reasons = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT id, project_id, affected_node_id, causal_node_id, causal_node_title, delta_days,
                        causal_date_summary, created_at, acknowledged_at
                 FROM affected_reasons WHERE project_id = ?1 ORDER BY created_at DESC",
            )
            .map_err(|_| RepositoryError::Internal)?;
        let rows = stmt
            .query_map([project_id], |r| {
                Ok(AffectedReasonRow {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    affected_node_id: r.get(2)?,
                    causal_node_id: r.get(3)?,
                    causal_node_title: r.get(4)?,
                    delta_days: r.get(5)?,
                    causal_date_summary: r.get(6)?,
                    created_at: r.get(7)?,
                    acknowledged_at: r.get(8)?,
                })
            })
            .map_err(|_| RepositoryError::Internal)?;
        for row in rows {
            affected_reasons.push(row.map_err(|_| RepositoryError::Internal)?);
        }
    }

    let mut open_questions = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT id, project_id, node_id, question_text, status, decision_text, position, resolved_at_iso, created_at_iso
                 FROM node_open_questions WHERE project_id = ?1 ORDER BY position ASC",
            )
            .map_err(|_| RepositoryError::Internal)?;
        let rows = stmt
            .query_map([project_id], |r| {
                Ok(NodeOpenQuestionRow {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    node_id: r.get(2)?,
                    question_text: r.get(3)?,
                    status: r.get(4)?,
                    decision_text: r.get(5)?,
                    position: r.get(6)?,
                    resolved_at_iso: r.get(7)?,
                    created_at_iso: r.get(8)?,
                })
            })
            .map_err(|_| RepositoryError::Internal)?;
        for row in rows {
            open_questions.push(row.map_err(|_| RepositoryError::Internal)?);
        }
    }

    // Epic 18, Story 18.2: the optional project-owned forecast plan. Its
    // scope, group, blocker and staffing columns are JSON TEXT. A corrupt
    // cell is never read as an empty plan or an empty roster: the plan is
    // omitted and `forecast_plan_error` names the column, exactly as the
    // browser's `queryAnalysisSnapshot` does, so the outline and coherence
    // analysis stay available while the forecast reports the damage.
    let mut forecast_plan_error: Option<String> = None;
    let forecast_plan: Option<ForecastPlanRow> = {
        let raw: Option<(
            Option<String>,
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<i64>,
            Option<String>,
            Option<i64>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        )> = conn
            .query_row(
                "SELECT selected_feature_ids, parallel_groups, blocked_feature_ids, points_per_sprint,
                        sprint_length_days, cadence, start_sprint_ordinal, start_date, policy_version, planning_level, roster, assignments
                 FROM forecast_plans WHERE project_id = ?1",
                [project_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?, r.get(11)?)),
            )
            .optional()
            .map_err(|_| RepositoryError::Internal)?;
        match raw {
            None => None,
            Some((ids_json, groups_json, blocked_json, pps, sld, cadence, sso, sd, policy, level, roster_json, assignments_json)) => {
                // Story 21.7 AC 6: a missing/unparseable planning_level
                // normalizes to "Feature" without panicking or interrupting
                // background coherence analysis.
                let level_str = level.unwrap_or_else(|| "Feature".to_string());
                let planning_level = if level_str == "Theme" || level_str == "Component" || level_str == "Feature" {
                    level_str
                } else {
                    "Feature".to_string()
                };
                let parsed = (|| -> Result<ForecastPlanRow, String> {
                    Ok(ForecastPlanRow {
                        selected_feature_ids: parse_plan_cell(ids_json.as_deref(), "selected_feature_ids")?,
                        parallel_groups: parse_plan_cell(groups_json.as_deref(), "parallel_groups")?,
                        blocked_feature_ids: parse_plan_cell(blocked_json.as_deref(), "blocked_feature_ids")?,
                        points_per_sprint: pps,
                        sprint_length_days: sld,
                        cadence: cadence.unwrap_or_else(|| "fixed-contiguous".to_string()),
                        start_sprint_ordinal: sso,
                        start_date: sd,
                        policy_version: policy.unwrap_or_else(|| "shared-capacity-v1".to_string()),
                        planning_level,
                        roster: parse_plan_cell(roster_json.as_deref(), "roster")?,
                        assignments: parse_plan_cell(assignments_json.as_deref(), "assignments")?,
                    })
                })();
                match parsed {
                    Ok(plan) => Some(plan),
                    Err(marker) => {
                        forecast_plan_error = Some(marker);
                        None
                    }
                }
            }
        }
    };

    // Epic 20, Story 20.4: saved historical scenarios, reproduced verbatim.
    let forecast_scenarios: Vec<serde_json::Value> = {
        let mut stmt = conn
            .prepare(
                "SELECT scenario_id, project_id, label, baseline_revision, baseline_fingerprint,
                        policy_version, created_at_iso, baseline_json, patch_json
                 FROM forecast_scenarios WHERE project_id = ?1 ORDER BY created_at_iso, scenario_id",
            )
            .map_err(|_| RepositoryError::Internal)?;
        let rows = stmt
            .query_map([project_id], |r| {
                let baseline: serde_json::Value =
                    serde_json::from_str(&r.get::<_, String>(7)?).unwrap_or(serde_json::Value::Null);
                let patch: serde_json::Value =
                    serde_json::from_str(&r.get::<_, String>(8)?).unwrap_or(serde_json::Value::Null);
                Ok(serde_json::json!({
                    "scenarioId": r.get::<_, String>(0)?,
                    "projectId": r.get::<_, String>(1)?,
                    "label": r.get::<_, String>(2)?,
                    "baselineRevision": r.get::<_, i64>(3)?,
                    "baselineFingerprint": r.get::<_, String>(4)?,
                    "policyVersion": r.get::<_, String>(5)?,
                    "createdAtISO": r.get::<_, String>(6)?,
                    "baseline": baseline,
                    "patch": patch,
                }))
            })
            .map_err(|_| RepositoryError::Internal)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|_| RepositoryError::Internal)?);
        }
        out
    };

    Ok(ProjectSnapshotRows {
        project_id: project_id.to_string(),
        project_name,
        revision,
        nodes,
        phases,
        unlock_edges,
        custom_fields,
        type_template_fields,
        dismissals,
        affected_reasons,
        open_questions,
        forecast_plan,
        forecast_plan_error,
        forecast_scenarios,
    })
}

fn query_view_state(conn: &Connection, project_id: &str, view_id: &str) -> Result<Option<ViewStateRow>, RepositoryError> {
    conn.query_row(
        "SELECT project_id, view_id, view_state_revision, collapsed_node_ids, zoom_root_id,
                scroll_top, focused_theme_id, date_window_start, date_window_end, granularity,
                pan_x, pan_y, scale, nav_collapsed
         FROM view_state WHERE project_id = ?1 AND view_id = ?2",
        rusqlite::params![project_id, view_id],
        |r| {
            Ok(ViewStateRow {
                project_id: r.get(0)?,
                view_id: r.get(1)?,
                view_state_revision: r.get(2)?,
                collapsed_node_ids: r.get(3)?,
                zoom_root_id: r.get(4)?,
                scroll_top: r.get(5)?,
                focused_theme_id: r.get(6)?,
                date_window_start: r.get(7)?,
                date_window_end: r.get(8)?,
                granularity: r.get(9)?,
                pan_x: r.get(10)?,
                pan_y: r.get(11)?,
                scale: r.get(12)?,
                nav_collapsed: r.get(13)?,
            })
        },
    )
    .optional()
    .map_err(|_| RepositoryError::Internal)
}

fn upsert_view_state(
    conn: &Connection,
    project_id: &str,
    view_id: &str,
    row: &ViewStateRow,
) -> Result<(), RepositoryError> {
    conn.execute(
        "INSERT INTO view_state(
            project_id, view_id, view_state_revision, collapsed_node_ids, zoom_root_id,
            scroll_top, focused_theme_id, date_window_start, date_window_end, granularity,
            pan_x, pan_y, scale, nav_collapsed
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(project_id, view_id) DO UPDATE SET
            view_state_revision = excluded.view_state_revision,
            collapsed_node_ids  = excluded.collapsed_node_ids,
            zoom_root_id        = excluded.zoom_root_id,
            scroll_top          = excluded.scroll_top,
            focused_theme_id    = excluded.focused_theme_id,
            date_window_start   = excluded.date_window_start,
            date_window_end     = excluded.date_window_end,
            granularity         = excluded.granularity,
            pan_x               = excluded.pan_x,
            pan_y               = excluded.pan_y,
            scale               = excluded.scale,
            nav_collapsed       = excluded.nav_collapsed",
        rusqlite::params![
            project_id,
            view_id,
            row.view_state_revision,
            row.collapsed_node_ids,
            row.zoom_root_id,
            row.scroll_top,
            row.focused_theme_id,
            row.date_window_start,
            row.date_window_end,
            row.granularity,
            row.pan_x,
            row.pan_y,
            row.scale,
            row.nav_collapsed
        ],
    )
    .map_err(|_| RepositoryError::Internal)?;
    Ok(())
}

/// Atomically batch-imports a validated portable snapshot (E13 Task 4).
/// One transaction: project, phases, nodes in containment-safe order,
/// custom/template fields, unlock edges, dismissals, affected reasons.
/// Rejects duplicate project identity; any failure rolls back completely.
/// Returns the typed outcome matching the TS contract.
pub fn batch_import_portable(conn:&mut Connection,snapshot:&PortableImportSnapshot)->Result<serde_json::Value,RepositoryError>{batch_import_portable_with_state(conn,snapshot,None)}
pub fn batch_import_portable_with_state(conn:&mut Connection,snapshot:&PortableImportSnapshot,local_file_state_json:Option<&str>)->Result<serde_json::Value,RepositoryError>{
    use rusqlite::TransactionBehavior;
    if local_file_state_json.is_some() {super::local_file::validate_snapshot(&serde_json::to_value(snapshot).map_err(|_|RepositoryError::InvalidRequest)?)?;}

    // Duplicate project identity is rejected without mutation.
    let existing: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM projects WHERE id = ?1",
            [&snapshot.project_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| RepositoryError::Internal)?;
    if existing.is_some() {
        return Ok(serde_json::json!({
            "ok": false,
            "code": "DUPLICATE_PROJECT_ID",
            "cause": snapshot.project_id,
        }));
    }

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| RepositoryError::Internal)?;

    let insert = |sql: &str, params: &[&dyn rusqlite::ToSql]| -> Result<(), RepositoryError> {
        tx.execute(sql, params).map(|_| ()).map_err(|_| RepositoryError::Internal)
    };

    // An imported project joins the active workspace, like CreateProject: the
    // shelf and overview list only that workspace, so a NULL workspace_id left
    // a successful import invisible.
    let workspace_id = crate::db::workspace::read_active_workspace_id(&tx)?;
    insert(
        "INSERT INTO projects(id, name, revision, workspace_id) VALUES(?1, ?2, 1, ?3)",
        &[&snapshot.project_id, &snapshot.project_name, &workspace_id],
    )?;

    for phase in &snapshot.phases {
        let position: i64 = phase.position.parse().unwrap_or(0);
        insert(
            "INSERT INTO phases(id, project_id, name, position) VALUES(?1, ?2, ?3, ?4)",
            &[&phase.id, &snapshot.project_id, &phase.name, &position],
        )?;
    }

    // Nodes in containment-safe order: parents before children (the validator
    // guarantees acyclicity; the webview sends pre-order rows).
    for node in &snapshot.nodes {
        let position: i64 = node.position.parse().unwrap_or(0);
        insert(
            "INSERT INTO nodes(
                id, project_id, parent_id, title, body_text, position, node_type, start_date, end_date,
                duration_days, schedule_source_mode, completed, effort_points, effort_points_done,
                strategic_weight, phase_id,
                delivery_status
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            &[
                &node.id,
                &snapshot.project_id,
                &node.parent_id,
                &node.title,
                &node.body_text,
                &position,
                &node.node_type,
                &node.start_date,
                &node.end_date,
                &node.duration_days,
                &node.schedule_source_mode,
                &(if node.completed { 1 } else { 0 }),
                &node.effort_points,
                &node.effort_points_done,
                &node.strategic_weight,
                &node.phase_id,
                &node.delivery_status,
            ],
        )?;
    }

    for field in &snapshot.node_custom_fields {
        insert(
            "INSERT INTO node_custom_fields(project_id, node_id, field_key, field_value) VALUES(?1, ?2, ?3, ?4)",
            &[&snapshot.project_id, &field.node_id, &field.field_key, &field.field_value],
        )?;
    }

    for template in &snapshot.type_template_fields {
        insert(
            "INSERT INTO type_template_fields(project_id, node_type, field_key, field_label, position) VALUES(?1, ?2, ?3, ?4, ?5)",
            &[&snapshot.project_id, &template.node_type, &template.field_key, &template.field_label, &template.position],
        )?;
    }

    for edge in &snapshot.unlock_edges {
        insert(
            "INSERT INTO unlock_edges(id, project_id, source_node_id, target_node_id) VALUES(?1, ?2, ?3, ?4)",
            &[&edge.id, &snapshot.project_id, &edge.source_node_id, &edge.target_node_id],
        )?;
    }

    for dismissal in &snapshot.finding_dismissals {
        insert(
            "INSERT INTO finding_dismissals(project_id, finding_id, finding_kind, target_id, fingerprint, dismissed_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            &[
                &snapshot.project_id,
                &dismissal.finding_id,
                &dismissal.finding_kind,
                &dismissal.target_id,
                &dismissal.fingerprint,
                &dismissal.dismissed_at,
            ],
        )?;
    }

    for reason in &snapshot.affected_reasons {
        insert(
            "INSERT INTO affected_reasons(
                id, project_id, affected_node_id, causal_node_id, causal_node_title, delta_days,
                causal_date_summary, created_at, acknowledged_at
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            &[
                &reason.id,
                &snapshot.project_id,
                &reason.affected_node_id,
                &reason.causal_node_id,
                &reason.causal_node_title,
                &reason.delta_days,
                &reason.causal_date_summary,
                &reason.created_at,
                &reason.acknowledged_at,
            ],
        )?;
    }

    for question in &snapshot.open_questions {
        let position: i64 = question.position.parse().unwrap_or(0);
        insert(
            "INSERT INTO node_open_questions(
                id, project_id, node_id, question_text, status, decision_text, position, resolved_at_iso, created_at_iso
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            &[
                &question.id,
                &snapshot.project_id,
                &question.node_id,
                &question.question_text,
                &question.status,
                &question.decision_text,
                &position,
                &question.resolved_at_iso,
                &question.created_at_iso,
            ],
        )?;
    }

    // Epic 18, Story 18.2: the optional forecast plan, inside the same import
    // transaction. Scope/groups are stored as JSON TEXT, matching the browser
    // `writeForecastPlan` shape.
    if let Some(plan) = &snapshot.forecast_plan {
        let ids_json =
            serde_json::to_string(&plan.selected_feature_ids).map_err(|_| RepositoryError::Internal)?;
        let groups_json =
            serde_json::to_string(&plan.parallel_groups).map_err(|_| RepositoryError::Internal)?;
        let blocked_json =
            serde_json::to_string(&plan.blocked_feature_ids).map_err(|_| RepositoryError::Internal)?;
        // Story 21.7 AC 7: the portable-import INSERT carries planning_level.
        // A v5 file has no level yet — normalize to the default (Story 21.8
        // will persist it in the v6 envelope).
        let planning_level = if plan.planning_level == "Theme" || plan.planning_level == "Component" || plan.planning_level == "Feature" {
            plan.planning_level.clone()
        } else {
            "Feature".to_string()
        };
        let roster_json =
            serde_json::to_string(&plan.roster).unwrap_or_else(|_| "[]".to_string());
        let assignments_json =
            serde_json::to_string(&plan.assignments).unwrap_or_else(|_| "{}".to_string());
        insert(
            "INSERT INTO forecast_plans(
                project_id, selected_feature_ids, parallel_groups, blocked_feature_ids, points_per_sprint,
                sprint_length_days, cadence, start_sprint_ordinal, start_date, policy_version, planning_level, roster, assignments
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            &[
                &snapshot.project_id,
                &ids_json,
                &groups_json,
                &blocked_json,
                &plan.points_per_sprint,
                &plan.sprint_length_days,
                &plan.cadence,
                &plan.start_sprint_ordinal,
                &plan.start_date,
                &plan.policy_version,
                &planning_level,
                &roster_json,
                &assignments_json,
            ],
        )?;
    }

    // Epic 20, Story 20.4: saved scenarios, inside the same import transaction.
    for scenario in &snapshot.forecast_scenarios {
        let baseline_json = serde_json::to_string(scenario.get("baseline").unwrap_or(&serde_json::Value::Null))
            .map_err(|_| RepositoryError::Internal)?;
        let patch_json = serde_json::to_string(scenario.get("patch").unwrap_or(&serde_json::Value::Null))
            .map_err(|_| RepositoryError::Internal)?;
        let scenario_id = scenario.get("scenarioId").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let label = scenario.get("label").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let baseline_revision = scenario.get("baselineRevision").and_then(|v| v.as_i64()).unwrap_or(0);
        let fingerprint = scenario.get("baselineFingerprint").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let policy = scenario.get("policyVersion").and_then(|v| v.as_str()).unwrap_or("shared-capacity-v1").to_string();
        let created = scenario.get("createdAtISO").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        insert(
            "INSERT INTO forecast_scenarios(scenario_id, project_id, label, baseline_revision, baseline_fingerprint, policy_version, created_at_iso, baseline_json, patch_json)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            &[
                &scenario_id,
                &snapshot.project_id,
                &label,
                &baseline_revision,
                &fingerprint,
                &policy,
                &created,
                &baseline_json,
                &patch_json,
            ],
        )?;
    }

    if let Some(raw)=local_file_state_json { super::local_file::validate_state(raw,&snapshot.project_id)?;tx.execute("INSERT INTO local_file_state(project_id,state_json) VALUES(?1,?2)",rusqlite::params![snapshot.project_id,raw]).map_err(|_|RepositoryError::Internal)?;}
    tx.commit().map_err(|_| RepositoryError::Internal)?;
    Ok(serde_json::json!({
        "ok": true,
        "projectId": snapshot.project_id,
        "revision": 1,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn portable_snapshot_fixture() -> PortableImportSnapshot {
        PortableImportSnapshot {
            project_id: "018f3a80-0000-7000-8000-000000000001".to_string(),
            project_name: "Test Project".to_string(),
            project_revision: 1,
            phases: vec![PortablePhaseDto {
                id: "018f3a80-0000-7000-8000-000000000010".to_string(),
                name: "Alpha".to_string(),
                position: "1".to_string(),
            }],
            nodes: vec![
                PortableNodeDto {
                    id: "018f3a80-0000-7000-8000-000000000020".to_string(),
                    parent_id: None,
                    title: "Vision".to_string(),
                    body_text: None,
                    position: "4294967296".to_string(),
                    node_type: Some("Vision".to_string()),
                    start_date: None,
                    end_date: None,
                    duration_days: None,
                    schedule_source_mode: None,
                    completed: false,
                    effort_points: None,
                    effort_points_done: None,
                    strategic_weight: None,
                    phase_id: None,
                    delivery_status: None,
                },
                PortableNodeDto {
                    id: "018f3a80-0000-7000-8000-000000000021".to_string(),
                    parent_id: Some("018f3a80-0000-7000-8000-000000000020".to_string()),
                    title: "Theme".to_string(),
                    body_text: None,
                    position: "8589934592".to_string(),
                    node_type: Some("Theme".to_string()),
                    start_date: Some("2026-01-01".to_string()),
                    end_date: Some("2026-06-30".to_string()),
                    duration_days: Some(180),
                    schedule_source_mode: Some("start_end".to_string()),
                    completed: false,
                    effort_points: Some(5),
                    effort_points_done: None,
                    strategic_weight: Some(3),
                    phase_id: Some("018f3a80-0000-7000-8000-000000000010".to_string()),
                    delivery_status: Some("in_progress".to_string()),
                },
            ],
            node_custom_fields: vec![PortableCustomFieldDto {
                node_id: "018f3a80-0000-7000-8000-000000000021".to_string(),
                field_key: "owner".to_string(),
                field_value: Some("Alex".to_string()),
            }],
            type_template_fields: vec![PortableTypeTemplateDto {
                node_type: "Theme".to_string(),
                field_key: "owner".to_string(),
                field_label: "Owner".to_string(),
                position: 1,
            }],
            unlock_edges: vec![PortableUnlockEdgeDto {
                id: "018f3a80-0000-7000-8000-000000000030".to_string(),
                source_node_id: "018f3a80-0000-7000-8000-000000000020".to_string(),
                target_node_id: "018f3a80-0000-7000-8000-000000000021".to_string(),
            }],
            finding_dismissals: vec![PortableDismissalDto {
                finding_id: "018f3a80-0000-7000-8000-000000000040".to_string(),
                finding_kind: "OrphanedFeature".to_string(),
                target_id: "018f3a80-0000-7000-8000-000000000021".to_string(),
                fingerprint: "fp".to_string(),
                dismissed_at: "2026-08-01T00:00:00.000Z".to_string(),
            }],
            affected_reasons: vec![PortableAffectedReasonDto {
                id: "018f3a80-0000-7000-8000-000000000050".to_string(),
                affected_node_id: "018f3a80-0000-7000-8000-000000000021".to_string(),
                causal_node_id: "018f3a80-0000-7000-8000-000000000020".to_string(),
                causal_node_title: "Vision".to_string(),
                delta_days: 7,
                causal_date_summary: "date changed".to_string(),
                created_at: "2026-08-01T00:00:00.000Z".to_string(),
                acknowledged_at: None,
            }],
            open_questions: vec![PortableNodeOpenQuestionDto {
                id: "018f3a80-0000-7000-8000-000000000060".to_string(),
                node_id: "018f3a80-0000-7000-8000-000000000021".to_string(),
                question_text: "Should we ship v1 without sync?".to_string(),
                status: "OPEN".to_string(),
                decision_text: None,
                position: "1".to_string(),
                resolved_at_iso: None,
                created_at_iso: "2026-08-01T00:00:00.000Z".to_string(),
            }],
            forecast_plan: Some(ForecastPlanRow {
                selected_feature_ids: vec!["018f3a80-0000-7000-8000-000000000021".to_string()],
                parallel_groups: vec![],
                blocked_feature_ids: vec![],
                points_per_sprint: Some(10),
                sprint_length_days: Some(14),
                cadence: "fixed-contiguous".to_string(),
                start_sprint_ordinal: Some(12),
                start_date: Some("2026-09-07".to_string()),
                policy_version: "shared-capacity-v1".to_string(),
                planning_level: "Feature".to_string(),
                roster: vec![],
                assignments: std::collections::HashMap::new(),
            }),
            forecast_scenarios: vec![],
        }
    }

    fn open_memory() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        for ddl in crate::db::schema::PRODUCT_SCHEMA_DDL.iter() {
            conn.execute_batch(ddl).unwrap();
        }
        conn
    }

    #[test]
    fn batch_import_joins_the_active_workspace() {
        let mut conn = open_memory();
        crate::db::workspace::ensure_default_workspace(&conn).unwrap();
        let active = crate::db::workspace::read_active_workspace_id(&conn).unwrap();
        assert!(active.is_some());
        let snapshot = portable_snapshot_fixture();
        let result = batch_import_portable(&mut conn, &snapshot).unwrap();
        assert_eq!(result["ok"], true);
        let workspace_id: Option<String> = conn
            .query_row(
                "SELECT workspace_id FROM projects WHERE id = ?1",
                [&snapshot.project_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(workspace_id, active);
    }

    #[test]
    fn batch_import_inserts_full_graph_atomically() {
        let mut conn = open_memory();
        let snapshot = portable_snapshot_fixture();
        let result = batch_import_portable(&mut conn, &snapshot).unwrap();
        assert_eq!(result["ok"], true);

        let node_count: i64 = conn
            .query_row("SELECT COUNT(1) FROM nodes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(node_count, 2);
        let phase_count: i64 = conn
            .query_row("SELECT COUNT(1) FROM phases", [], |r| r.get(0))
            .unwrap();
        assert_eq!(phase_count, 1);
        let edge_count: i64 = conn
            .query_row("SELECT COUNT(1) FROM unlock_edges", [], |r| r.get(0))
            .unwrap();
        assert_eq!(edge_count, 1);
        let field_count: i64 = conn
            .query_row("SELECT COUNT(1) FROM node_custom_fields", [], |r| r.get(0))
            .unwrap();
        assert_eq!(field_count, 1);
        let template_count: i64 = conn
            .query_row("SELECT COUNT(1) FROM type_template_fields", [], |r| r.get(0))
            .unwrap();
        assert_eq!(template_count, 1);
        let dismissal_count: i64 = conn
            .query_row("SELECT COUNT(1) FROM finding_dismissals", [], |r| r.get(0))
            .unwrap();
        assert_eq!(dismissal_count, 1);
        let reason_count: i64 = conn
            .query_row("SELECT COUNT(1) FROM affected_reasons", [], |r| r.get(0))
            .unwrap();
        assert_eq!(reason_count, 1);
        let question_count: i64 = conn
            .query_row("SELECT COUNT(1) FROM node_open_questions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(question_count, 1);

        // Epic 18: the forecast plan is written inside the same transaction.
        let (ids_json, policy): (String, String) = conn
            .query_row(
                "SELECT selected_feature_ids, policy_version FROM forecast_plans WHERE project_id = ?1",
                ["018f3a80-0000-7000-8000-000000000001"],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(policy, "shared-capacity-v1");
        assert!(ids_json.contains("018f3a80-0000-7000-8000-000000000021"));
    }

    #[test]
    fn query_project_snapshot_round_trips_the_forecast_plan() {
        let mut conn = open_memory();
        let snapshot = portable_snapshot_fixture();
        batch_import_portable(&mut conn, &snapshot).unwrap();

        let rows = query_project_snapshot(&conn, "018f3a80-0000-7000-8000-000000000001").unwrap();
        let plan = rows.forecast_plan.expect("native snapshot must carry the forecast plan");
        assert_eq!(plan.policy_version, "shared-capacity-v1");
        assert_eq!(plan.points_per_sprint, Some(10));
        assert_eq!(plan.sprint_length_days, Some(14));
        assert_eq!(plan.start_sprint_ordinal, Some(12));
        assert_eq!(plan.start_date.as_deref(), Some("2026-09-07"));
        assert_eq!(
            plan.selected_feature_ids,
            vec!["018f3a80-0000-7000-8000-000000000021".to_string()]
        );
        assert!(plan.parallel_groups.is_empty());
    }

    #[test]
    fn query_project_snapshot_has_no_forecast_plan_for_a_project_without_one() {
        let conn = open_memory();
        let rows = query_project_snapshot(&conn, "018f3a80-0000-7000-8000-0000000000fe").unwrap();
        assert!(rows.forecast_plan.is_none());
        assert!(rows.forecast_plan_error.is_none(), "no plan is not a corrupt plan");
    }

    // ── A corrupt plan cell is surfaced, never read as empty ────────────
    //
    // Parity with the browser's `queryAnalysisSnapshot`: the plan is omitted,
    // `forecast_plan_error` names the column, and the rest of the snapshot
    // (nodes, phases, edges) stays readable so coherence analysis keeps
    // running. Before this, roster/assignments fell back to empty with
    // `unwrap_or_default()` and the scope columns failed the whole snapshot.

    const PLAN_PROJECT: &str = "018f3a80-0000-7000-8000-000000000001";

    fn snapshot_with_plan_cell(column: &str, value: &str) -> ProjectSnapshotRows {
        let mut conn = open_memory();
        batch_import_portable(&mut conn, &portable_snapshot_fixture()).unwrap();
        conn.execute(
            &format!("UPDATE forecast_plans SET {column} = ?1 WHERE project_id = ?2"),
            rusqlite::params![value, PLAN_PROJECT],
        )
        .unwrap();
        query_project_snapshot(&conn, PLAN_PROJECT).expect("a corrupt plan cell must not fail the snapshot")
    }

    fn assert_corrupt_plan_surfaced(rows: &ProjectSnapshotRows, column: &str) {
        assert!(rows.forecast_plan.is_none(), "{column}: a corrupt plan must be omitted, not read as empty");
        assert_eq!(rows.forecast_plan_error.as_deref(), Some(format!("FORECAST_PLAN_CORRUPT: {column}").as_str()));
        assert!(!rows.nodes.is_empty(), "{column}: the rest of the snapshot must stay readable");
    }

    #[test]
    fn a_healthy_plan_carries_no_corruption_marker() {
        let mut conn = open_memory();
        batch_import_portable(&mut conn, &portable_snapshot_fixture()).unwrap();
        let rows = query_project_snapshot(&conn, PLAN_PROJECT).unwrap();
        assert!(rows.forecast_plan.is_some());
        assert!(rows.forecast_plan_error.is_none());
        let json = serde_json::to_value(&rows).unwrap();
        assert!(json.get("forecastPlanError").is_none(), "absent marker is not serialized");
    }

    #[test]
    fn a_corrupt_roster_cell_is_surfaced_not_read_as_an_empty_roster() {
        let rows = snapshot_with_plan_cell("roster", "not json at all");
        assert_corrupt_plan_surfaced(&rows, "roster");
        let json = serde_json::to_value(&rows).unwrap();
        assert_eq!(json["forecastPlanError"], "FORECAST_PLAN_CORRUPT: roster");
        assert!(json.get("forecastPlan").is_none());
    }

    #[test]
    fn a_mis_keyed_roster_is_corrupt_not_empty() {
        // The exact shape a Rust test fixture stored until Story 22.10:
        // `personId` instead of the `id` the DTO requires.
        let rows = snapshot_with_plan_cell(
            "roster",
            r#"[{"personId":"0198a000-0000-7000-8000-000000000004","name":"Alice","weightUnits":1000}]"#,
        );
        assert_corrupt_plan_surfaced(&rows, "roster");
    }

    #[test]
    fn a_corrupt_assignments_cell_is_surfaced_not_read_as_empty() {
        for value in ["{", r#"{"018f3a80-0000-7000-8000-000000000021":"not-an-array"}"#, "[]"] {
            let rows = snapshot_with_plan_cell("assignments", value);
            assert_corrupt_plan_surfaced(&rows, "assignments");
        }
    }

    #[test]
    fn a_corrupt_scope_cell_no_longer_fails_the_whole_snapshot() {
        // Previously `RepositoryError::Internal` for the entire project, which
        // also took down the native outline that reads the same snapshot.
        for column in ["selected_feature_ids", "parallel_groups", "blocked_feature_ids"] {
            let rows = snapshot_with_plan_cell(column, "{broken");
            assert_corrupt_plan_surfaced(&rows, column);
        }
    }

    #[test]
    fn batch_import_rejects_duplicate_project_without_mutation() {
        let mut conn = open_memory();
        let snapshot = portable_snapshot_fixture();
        let first = batch_import_portable(&mut conn, &snapshot).unwrap();
        assert_eq!(first["ok"], true);

        let second = batch_import_portable(&mut conn, &snapshot).unwrap();
        assert_eq!(second["ok"], false);
        assert_eq!(second["code"], "DUPLICATE_PROJECT_ID");

        let node_count: i64 = conn
            .query_row("SELECT COUNT(1) FROM nodes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(node_count, 2, "duplicate import must not double-insert");
    }

    #[test]
    fn batch_import_failure_rolls_back_and_leaves_existing_projects_unchanged() {
        let mut conn = open_memory();
        // Seed an existing project that must survive a failing import.
        conn.execute(
            "INSERT INTO projects(id, name, revision) VALUES('018f3a80-0000-7000-8000-0000000000ee', 'Existing', 1)",
            [],
        )
        .unwrap();

        let mut snapshot = portable_snapshot_fixture();
        // Force a foreign-key failure mid-import: a phase id that does not exist.
        snapshot.nodes[1].phase_id = Some("018f3a80-0000-7000-8000-00000000ffff".to_string());
        let result = batch_import_portable(&mut conn, &snapshot);
        assert!(result.is_err());

        let node_count: i64 = conn
            .query_row("SELECT COUNT(1) FROM nodes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(node_count, 0, "failed import must leave zero partial node rows");
        let project_count: i64 = conn
            .query_row("SELECT COUNT(1) FROM projects", [], |r| r.get(0))
            .unwrap();
        assert_eq!(project_count, 1, "existing project must be untouched");
    }

    #[test]
    fn batch_import_and_query_snapshot_round_trips_staffed_and_shared_scenarios() {
        let mut conn = open_memory();
        let mut snapshot = portable_snapshot_fixture();

        let shared_scenario = serde_json::json!({
            "scenarioId": "018f3a80-0000-7000-8000-000000000081",
            "label": "Shared History",
            "baselineRevision": 1,
            "baselineFingerprint": "fp1",
            "policyVersion": "shared-capacity-v1",
            "createdAtISO": "2026-09-01T00:00:00.000Z",
            "baseline": {
                "planningLevel": "Feature",
                "orderedScope": ["018f3a80-0000-7000-8000-000000000021"],
                "configuration": { "pointsPerSprint": 10, "sprintLengthDays": 14, "cadence": "fixed-contiguous", "startSprintOrdinal": 1, "startDate": "2026-09-07" },
                "parallelGroups": [],
                "blockedFeatureIds": [],
                "factMap": { "018f3a80-0000-7000-8000-000000000021": { "effortPoints": 5, "projectId": "018f3a80-0000-7000-8000-000000000001", "ancestorIds": [], "nodeType": "Feature" } }
            },
            "patch": { "pointsPerSprint": 15 }
        });

        let staffed_scenario = serde_json::json!({
            "scenarioId": "018f3a80-0000-7000-8000-000000000082",
            "label": "Staffed History with Idle Person",
            "baselineRevision": 1,
            "baselineFingerprint": "fp2",
            "policyVersion": "staffed-capacity-v1",
            "createdAtISO": "2026-09-02T00:00:00.000Z",
            "baseline": {
                "planningLevel": "Feature",
                "orderedScope": ["018f3a80-0000-7000-8000-000000000021"],
                "configuration": { "pointsPerSprint": 10, "sprintLengthDays": 14, "cadence": "fixed-contiguous", "startSprintOrdinal": 1, "startDate": "2026-09-07" },
                "parallelGroups": [],
                "blockedFeatureIds": [],
                "roster": [
                    { "id": "018f3a80-0000-7000-8000-0000000000b1", "name": "Alice", "weightUnits": 1000 },
                    { "id": "018f3a80-0000-7000-8000-0000000000b2", "name": "Bob", "weightUnits": 500 } // idle: no assignments
                ],
                "assignments": {
                    "018f3a80-0000-7000-8000-000000000021": ["018f3a80-0000-7000-8000-0000000000b1"]
                },
                "factMap": { "018f3a80-0000-7000-8000-000000000021": { "effortPoints": 5, "projectId": "018f3a80-0000-7000-8000-000000000001", "ancestorIds": [], "nodeType": "Feature" } }
            },
            "patch": {
                "weightOverrides": { "018f3a80-0000-7000-8000-0000000000b2": 1000 },
                "assignmentOverrides": { "018f3a80-0000-7000-8000-000000000021": ["018f3a80-0000-7000-8000-0000000000b2"] }
            }
        });

        snapshot.forecast_scenarios = vec![shared_scenario, staffed_scenario];

        let result = batch_import_portable(&mut conn, &snapshot).unwrap();
        assert_eq!(result["ok"], true);

        let rows = query_project_snapshot(&conn, "018f3a80-0000-7000-8000-000000000001").unwrap();
        assert_eq!(rows.forecast_scenarios.len(), 2);

        let s1 = &rows.forecast_scenarios[0];
        assert_eq!(s1["scenarioId"], "018f3a80-0000-7000-8000-000000000081");
        assert_eq!(s1["policyVersion"], "shared-capacity-v1");
        assert_eq!(s1["baseline"]["roster"], serde_json::Value::Null);

        let s2 = &rows.forecast_scenarios[1];
        assert_eq!(s2["scenarioId"], "018f3a80-0000-7000-8000-000000000082");
        assert_eq!(s2["policyVersion"], "staffed-capacity-v1");
        assert_eq!(s2["baseline"]["roster"].as_array().unwrap().len(), 2);
        assert_eq!(s2["baseline"]["roster"][1]["name"], "Bob");
        assert_eq!(s2["patch"]["weightOverrides"]["018f3a80-0000-7000-8000-0000000000b2"], 1000);
        assert_eq!(
            s2["patch"]["assignmentOverrides"]["018f3a80-0000-7000-8000-000000000021"][0],
            "018f3a80-0000-7000-8000-0000000000b2"
        );
    }
}
