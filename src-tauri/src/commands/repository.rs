//! Narrow typed Tauri command boundary (E9-FR4, E9-FR5).
//!
//! Commands accept only validated closed tagged types; results are sanitized
//! unions. No raw SQL, table names, connection strings, unrestricted
//! filesystem operations, or arbitrary post-open paths are exposed.

use tauri::{AppHandle, Emitter, State};

use crate::db::runtime::RepositoryRuntime;
use crate::events::{emit_revision_invalidated, EVENT_FILE_OPEN_INTENT};
use crate::protocol::commands::{
    ProductCommand, ProductCommandResult, RepositoryOpenResult,
};
use crate::protocol::errors::RepositoryError;

/// Resolves the runtime from Tauri managed state.
pub fn runtime(state: &State<RepositoryRuntime>) -> RepositoryRuntime {
    state.inner().clone()
}

/// `repository_open` — opens the native SQLite database on the OS local-data
/// path, validates application identity, and returns read-write readiness.
#[tauri::command]
pub async fn repository_open(
    state: State<'_, RepositoryRuntime>,
    project_id: Option<String>,
) -> Result<RepositoryOpenResult, RepositoryError> {
    let runtime = runtime(&state);
    let mut result = runtime.open().await?;
    if let Some(pid) = project_id {
        result.project_id = pid;
    }
    Ok(result)
}

/// `repository_apply` — applies one command serially with atomic receipts.
#[tauri::command]
pub async fn repository_apply(
    app: AppHandle,
    state: State<'_, RepositoryRuntime>,
    command: ProductCommand,
) -> Result<ProductCommandResult, RepositoryError> {
    let runtime = runtime(&state);
    let project_id = command.project_id().to_string();
    let result = runtime.apply(command).await?;

    // Body-free advisory invalidation for the project that just mutated.
    if let ProductCommandResult::ProductCommandApplied(applied) = &result {
        emit_revision_invalidated(&app, &project_id, applied.target_revision);
    }
    Ok(result)
}

/// `repository_close` — drains, checkpoints, and closes SQLite.
#[tauri::command]
pub async fn repository_close(
    state: State<'_, RepositoryRuntime>,
) -> Result<(), RepositoryError> {
    runtime(&state).close().await
}

/// `repository_pause_intake` — halts command intake (shutdown lifecycle).
#[tauri::command]
pub async fn repository_pause_intake(
    state: State<'_, RepositoryRuntime>,
) -> Result<(), RepositoryError> {
    runtime(&state).pause_intake().await
}

/// `repository_resume_intake` — resumes command intake.
#[tauri::command]
pub async fn repository_resume_intake(
    state: State<'_, RepositoryRuntime>,
) -> Result<(), RepositoryError> {
    runtime(&state).resume_intake().await
}

/// `repository_storage_status` — body-free storage status for the status line.
#[tauri::command]
pub fn repository_storage_status(
    state: State<'_, RepositoryRuntime>,
) -> Result<serde_json::Value, RepositoryError> {
    let runtime = state.inner();
    Ok(serde_json::json!({
        "nativeStorage": true,
        "open": runtime.is_open(),
        "intakePaused": runtime.is_intake_paused(),
    }))
}

/// `app_file_open_intent` — forwards a file-open intent received from a
/// secondary launch to the webview (E9-FR12).
#[tauri::command]
pub fn app_file_open_intent(app: AppHandle, path: String) -> Result<(), RepositoryError> {
    app.emit(EVENT_FILE_OPEN_INTENT, serde_json::json!({ "path": path }))
        .map_err(|_| RepositoryError::Internal)
}

// ── Query commands (raw row surfaces; the TS domain projects them) ─────────

/// `repository_query_projects` — lists projects ordered by name.
#[tauri::command]
pub async fn repository_query_projects(
    state: State<'_, RepositoryRuntime>,
) -> Result<Vec<crate::db::runtime::ProjectRow>, RepositoryError> {
    runtime(&state).query_projects().await
}

/// `repository_query_project_snapshot` — raw rows for one project.
#[tauri::command]
pub async fn repository_query_project_snapshot(
    state: State<'_, RepositoryRuntime>,
    project_id: String,
) -> Result<crate::db::runtime::ProjectSnapshotRows, RepositoryError> {
    runtime(&state).query_project_snapshot(project_id).await
}

/// `repository_query_workspace_registry` — workspaces + project counts +
/// the active workspace pointer (Epic 17).
#[tauri::command]
pub async fn repository_query_workspace_registry(
    state: State<'_, RepositoryRuntime>,
) -> Result<crate::db::workspace::WorkspaceRegistry, RepositoryError> {
    runtime(&state).query_workspace_registry().await
}

/// `repository_mutate_workspace` — create/rename/delete/set-active/move.
///
/// The mutation is re-validated in `db::workspace` rather than trusted from
/// the webview, so name rules and delete eligibility hold identically to the
/// browser composition.
#[tauri::command]
pub async fn repository_mutate_workspace(
    state: State<'_, RepositoryRuntime>,
    mutation: crate::db::workspace::WorkspaceMutation,
) -> Result<crate::db::workspace::WorkspaceMutationResult, RepositoryError> {
    runtime(&state).mutate_workspace(mutation).await
}

/// `repository_query_view_state` — one view-state row (isolated lane).
#[tauri::command]
pub async fn repository_query_view_state(
    state: State<'_, RepositoryRuntime>,
    project_id: String,
    view_id: String,
) -> Result<Option<crate::db::runtime::ViewStateRow>, RepositoryError> {
    runtime(&state).query_view_state(project_id, view_id).await
}

/// `repository_upsert_view_state` — writes one view-state row.
#[tauri::command]
pub async fn repository_upsert_view_state(
    state: State<'_, RepositoryRuntime>,
    project_id: String,
    view_id: String,
    row: crate::db::runtime::ViewStateRow,
) -> Result<(), RepositoryError> {
    runtime(&state).upsert_view_state(project_id, view_id, row).await
}

/// `repository_startup_state` — adjudicates the read-only recovery state
/// after open (E9-FR11, E9-UX2). Body-free; causes are plain language.
#[tauri::command]
pub fn repository_startup_state(
    state: State<'_, RepositoryRuntime>,
) -> Result<crate::migration::runner::StartupState, RepositoryError> {
    let runtime = state.inner();
    if !runtime.is_open() {
        return Ok(crate::migration::runner::StartupState::ReadOnlyRecovery {
            cause: "The repository could not be opened. No verified store is available.".to_string(),
        });
    }
    Ok(crate::migration::runner::StartupState::Ready)
}

/// `repository_batch_import_portable` — atomically imports a validated
/// portable snapshot (E13 Task 4). One transaction; any failure rolls back
/// and leaves existing projects unchanged.
#[tauri::command]
pub async fn repository_batch_import_portable(
    state: State<'_, RepositoryRuntime>,
    snapshot: crate::db::runtime::PortableImportSnapshot,
    local_file_state_json: Option<String>,
) -> Result<serde_json::Value, RepositoryError> {
    runtime(&state).batch_import_portable_with_state(snapshot,local_file_state_json).await
}

// Typed collaboration operations use the same serialized repository actor.
#[tauri::command]
pub async fn repository_read_outbox(
    state: State<'_, RepositoryRuntime>, project_id: String,
) -> Result<crate::db::collaboration::OutboxState, RepositoryError> {
    runtime(&state).read_outbox(project_id).await
}

#[tauri::command]
pub async fn repository_read_collaboration_history(
    state: State<'_, RepositoryRuntime>, project_id: String, before: Option<i64>, limit: i64,
) -> Result<Vec<pmapp_core::db::collaboration::HistoryRow>, RepositoryError> {
    runtime(&state).read_history(project_id, before, limit).await
}

#[tauri::command]
pub async fn repository_forget_collaboration(
    state: State<'_, RepositoryRuntime>, project_id: String,
) -> Result<(), RepositoryError> {
    runtime(&state).forget_collaboration(project_id).await
}

#[tauri::command]
pub async fn repository_discard_outbox(
    state: State<'_, RepositoryRuntime>, project_id: String, command_id: String,
) -> Result<(), RepositoryError> {
    runtime(&state).discard_outbox(project_id, command_id).await
}

#[tauri::command]
pub async fn repository_commit_with_outbox(
    app: AppHandle, state: State<'_, RepositoryRuntime>, project_id: String,
    command: ProductCommand, entry: crate::db::collaboration::OutboxEntry,
) -> Result<ProductCommandResult, RepositoryError> {
    let result = runtime(&state).commit_with_outbox(project_id.clone(), command, entry).await?;
    if let ProductCommandResult::ProductCommandApplied(applied) = &result {
        emit_revision_invalidated(&app, &project_id, applied.target_revision);
    }
    Ok(result)
}

#[tauri::command]
pub async fn repository_commit_group_with_outbox(
    app: AppHandle, state: State<'_, RepositoryRuntime>, project_id: String,
    group_id: String, entries: Vec<crate::db::collaboration::OutboxEntry>,
) -> Result<Vec<ProductCommandResult>, RepositoryError> {
    if entries.iter().any(|entry| entry.group_id.as_deref() != Some(group_id.as_str())) {
        return Err(RepositoryError::InvalidRequest);
    }
    let results = runtime(&state).commit_group_with_outbox(project_id.clone(), entries).await?;
    if let Some(ProductCommandResult::ProductCommandApplied(applied)) = results.last() {
        emit_revision_invalidated(&app, &project_id, applied.target_revision);
    }
    Ok(results)
}

#[tauri::command]
pub async fn repository_rebase(
    app: AppHandle, state: State<'_, RepositoryRuntime>, project_id: String,
    remote: crate::db::collaboration::RemoteCommand,
    survivors: Vec<crate::db::collaboration::OutboxEntry>,
    rejected: Vec<crate::db::collaboration::Rejection>,
) -> Result<Option<ProductCommandResult>, RepositoryError> {
    let outcome = runtime(&state).rebase(project_id.clone(), remote, survivors, rejected).await?;
    emit_revision_invalidated(&app, &project_id, outcome.revision);
    Ok(outcome.result)
}

/// Atomic recovery installation returns only an invalidation revision and gate.
#[tauri::command]
pub async fn repository_install_collaboration_snapshot(
    app: AppHandle,
    state: State<'_, RepositoryRuntime>,
    project_id: String,
    envelope: pmapp_core::protocol::recovery::RecoveryEnvelope,
    archived_at_iso: String,
) -> Result<pmapp_core::db::recovery_install::InstallOutcome, RepositoryError> {
    let outcome = runtime(&state).install_collaboration_snapshot(project_id.clone(), envelope, archived_at_iso).await?;
    emit_revision_invalidated(&app, &project_id, outcome.revision);
    Ok(outcome)
}

#[tauri::command]
pub async fn repository_apply_product_command_batch(
    app: AppHandle,
    state: State<'_, RepositoryRuntime>,
    commands: Vec<ProductCommand>,
) -> Result<Vec<ProductCommandResult>, RepositoryError> {
    let results = runtime(&state).apply_product_command_batch(commands).await?;
    if let Some(ProductCommandResult::ProductCommandApplied(applied)) = results.last() {
        emit_revision_invalidated(&app, &applied.project_id, applied.target_revision);
    }
    Ok(results)
}

#[tauri::command]
pub async fn repository_local_file_read(state:State<'_,RepositoryRuntime>,project_id:String)->Result<serde_json::Value,RepositoryError>{runtime(&state).local_file_operation("read".into(),serde_json::json!({"projectId":project_id})).await}
#[tauri::command]
pub async fn repository_local_file_write(state:State<'_,RepositoryRuntime>,project_id:String,expected_revision:i64,state_json:String)->Result<(),RepositoryError>{runtime(&state).local_file_operation("write".into(),serde_json::json!({"projectId":project_id,"expectedRevision":expected_revision,"stateJson":state_json})).await?;Ok(())}
#[tauri::command]
pub async fn repository_local_file_recovery(state:State<'_,RepositoryRuntime>,project_id:String)->Result<serde_json::Value,RepositoryError>{runtime(&state).local_file_operation("recovery".into(),serde_json::json!({"projectId":project_id})).await}
#[tauri::command]
pub async fn repository_local_file_apply(app:AppHandle,state:State<'_,RepositoryRuntime>,input:serde_json::Value)->Result<serde_json::Value,RepositoryError>{let project=input.get("projectId").and_then(serde_json::Value::as_str).ok_or(RepositoryError::InvalidRequest)?.to_string();let result=runtime(&state).local_file_operation("apply".into(),input).await?;emit_revision_invalidated(&app,&project,result["revision"].as_i64().ok_or(RepositoryError::Internal)?);Ok(result)}
#[tauri::command]
pub async fn repository_local_file_restore(app:AppHandle,state:State<'_,RepositoryRuntime>,project_id:String,expected_revision:i64,operation_id:String)->Result<serde_json::Value,RepositoryError>{let result=runtime(&state).local_file_operation("restore".into(),serde_json::json!({"projectId":project_id,"expectedRevision":expected_revision,"operationId":operation_id})).await?;emit_revision_invalidated(&app,&project_id,result["revision"].as_i64().ok_or(RepositoryError::Internal)?);Ok(result)}
