//! Share lifecycle endpoints (Story 27.6, R7, TC-FR2, H07).
//!
//! Sharing spans a local project and the server and is not one transaction. It
//! uses an idempotent **share-operation id** and a durable intent, provisions a
//! server project with an initial snapshot, and activates it. A retry reuses the
//! operation id (never a second project); after a timeout the client reconciles
//! status rather than falsely claiming local or shared.

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::principal::principal_for_project;
use crate::routes::AppState;

/// Per-project share state (durable in the membership database conceptually;
/// held in the membership DB's `share_state` table here).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShareStatus {
    /// Provisioned but not yet activated (invitees cannot access).
    Provisioning,
    /// Activated: members can open it.
    Shared,
    /// Stopped: the owner keeps a normal local project; members go read-only.
    Local,
}

/// A share record persisted in the membership database.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareRecord {
    pub project_id: String,
    pub operation_id: String,
    pub status: ShareStatus,
    pub created_at_iso: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareRequest {
    /// The idempotent share-operation id (reused on retry, never a second project).
    pub operation_id: String,
    /// The first snapshot to upload (opaque portable snapshot JSON).
    pub snapshot: serde_json::Value,
    /// The one-time owner recovery code verifier (hash), shown once to the owner.
    #[serde(default)]
    pub recovery_verifier: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareResponse {
    pub project_id: String,
    pub status: ShareStatus,
    pub operation_id: String,
}

fn internal<E>(err: E) -> (StatusCode, String) {
    let _ = err;
    (StatusCode::INTERNAL_SERVER_ERROR, "STORE_ERROR".into())
}

/// Provision or activate a share. Idempotent on `operation_id`: a retry with the
/// same id returns the same state and never creates a second project (R7).
pub async fn share_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<ShareResponse>, (StatusCode, String)> {
    let store = state.store.lock().unwrap_or_else(|e| e.into_inner());
    let ctx = {
        principal_for_project(
            &store,
            &state.nonces,
            &headers,
            "POST",
            &format!("/projects/{project_id}/share"),
            &body,
            &project_id,
        )
        .map_err(|_| (StatusCode::UNAUTHORIZED, "UNAUTHENTICATED".to_string()))?
    };
    if !ctx.approved || !ctx.role.can_manage() {
        return Err((StatusCode::FORBIDDEN, "NOT_AN_OWNER".into()));
    }
    let request: ShareRequest = serde_json::from_slice(&body)
        .map_err(|_| (StatusCode::BAD_REQUEST, "INVALID_BODY".to_string()))?;

    // Idempotent: an existing ACTIVE share for this operation id is returned
    // as-is after checking its immutable snapshot binding. Re-sharing a stopped
    // graph remains gated on the epoch/install protocol.
    let existing = {
        store.share_record(&project_id).map_err(internal)?
    };
    let already_shared = existing.as_ref().map(|r| r.status == ShareStatus::Shared).unwrap_or(false);
    if let Some(record) = existing {
        if record.status == ShareStatus::Local {
            return Err((StatusCode::CONFLICT, "RESHARE_REQUIRES_NEW_EPOCH".into()));
        } else if record.operation_id == request.operation_id {
            // Verify the immutable operation/snapshot binding below.
        } else {
            // A different operation id for an already-active share is refused;
            // stop sharing first (never a second project).
            return Err((StatusCode::CONFLICT, "ALREADY_SHARED".into()));
        }
    }

    if !crate::project_log::is_safe_project_id(&project_id) {
        return Err((StatusCode::BAD_REQUEST, "INVALID_PROJECT_ID".into()));
    }
    let snapshot: pmapp_core::db::runtime::PortableImportSnapshot = serde_json::from_value(request.snapshot.clone())
        .map_err(|_| (StatusCode::BAD_REQUEST, "INVALID_SNAPSHOT".into()))?;
    if snapshot.project_id != project_id { return Err((StatusCode::BAD_REQUEST, "PROJECT_MISMATCH".into())); }
    if request.recovery_verifier.as_ref().map(|v| v.len() != 64 || !v.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).unwrap_or(false) {
        return Err((StatusCode::BAD_REQUEST, "INVALID_RECOVERY_VERIFIER".into()));
    }
    let now = crate::now_iso();
    // Membership serialization excludes writes/permission changes until the
    // durable graph is installed and activation becomes visible.
    if !already_shared { store.upsert_share(&project_id, &request.operation_id, "provisioning", &now).map_err(internal)?; }
    let mut logs = state.project_logs.lock().unwrap_or_else(|e| e.into_inner());
    if !logs.contains_key(&project_id) {
        let log = match &state.data_dir {
            Some(dir) => crate::project_log::ProjectLog::open(&crate::project_log::project_db_path(dir, &project_id), &project_id),
            None => crate::project_log::ProjectLog::open_in_memory(&project_id),
        }.map_err(internal)?;
        logs.insert(project_id.clone(), std::sync::Arc::new(std::sync::Mutex::new(log)));
    }
    let log = logs.get(&project_id).expect("inserted project log").clone();
    drop(logs);
    log.lock().unwrap_or_else(|e| e.into_inner()).provision_snapshot(&request.operation_id, &snapshot)
        .map_err(|_| (StatusCode::CONFLICT, "SNAPSHOT_PROVISION_FAILED".into()))?;
    if !already_shared {
        if let Some(verifier) = &request.recovery_verifier { store.set_recovery(&project_id, verifier).map_err(internal)?; }
    }
    store.upsert_share(&project_id, &request.operation_id, "shared", &now).map_err(internal)?;
    Ok(Json(ShareResponse {
        project_id,
        status: ShareStatus::Shared,
        operation_id: request.operation_id,
    }))
}

/// Reconcile the share status (R7): after a timeout/crash the client asks
/// whether the operation actually activated.
pub async fn share_status(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<crate::command_routes::BootstrapQuery>,
) -> Result<Json<ShareResponse>, (StatusCode, String)> {
    crate::routes::authenticate_query_app(
        &state,
        &project_id,
        query.device_id.as_deref(),
        query.bearer.as_deref(),
    )
    .map_err(|s| (s, "UNAUTHENTICATED".to_string()))?;
    let store = state.store.lock().unwrap_or_else(|e| e.into_inner());
    match store.share_record(&project_id).map_err(internal)? {
        Some(record) => Ok(Json(ShareResponse {
            project_id,
            status: record.status,
            operation_id: record.operation_id,
        })),
        None => Ok(Json(ShareResponse {
            project_id,
            status: ShareStatus::Local,
            operation_id: String::new(),
        })),
    }
}

/// Stop sharing: the owner keeps a normal local project; members lose access
/// (R7). A distinct owner operation from member leave.
pub async fn stop_sharing(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, (StatusCode, String)> {
    let store = state.store.lock().unwrap_or_else(|e| e.into_inner());
    let ctx = {
        principal_for_project(
            &store,
            &state.nonces,
            &headers,
            "POST",
            &format!("/projects/{project_id}/share/stop"),
            &body,
            &project_id,
        )
        .map_err(|_| (StatusCode::UNAUTHORIZED, "UNAUTHENTICATED".to_string()))?
    };
    if !ctx.approved || !ctx.role.can_manage() {
        return Err((StatusCode::FORBIDDEN, "NOT_AN_OWNER".into()));
    }
    store
        .upsert_share(&project_id, "", "local", &crate::now_iso())
        .map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}
