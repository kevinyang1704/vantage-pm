//! Server command routes + WebSocket stream (Story 27.5, AC 27.5-1/-3/-4).
//!
//! Commands for one project apply one at a time (D3), reusing `pmapp-core`.
//! A WebSocket subscriber receives each committed command in order; a dropped
//! connection resumes from its last acknowledged revision via the catch-up
//! suffix. Bootstrap uses the snapshot+suffix rule (AC 27.5-3).

use axum::{
    body::Bytes,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

use crate::auth::NonceCache;
use crate::membership_store::MembershipStore;
use crate::principal::principal_for_project;
use crate::project_log::{RecoveryCut, ProjectLog};
use pmapp_core::protocol::recovery::ConfirmedHistoryEntry;

const MAX_RECOVERY_WIRE_BYTES: usize = 16 * 1024 * 1024;
fn recovery_wire_fits(bytes: usize) -> bool { bytes <= MAX_RECOVERY_WIRE_BYTES }

async fn send_recovery_frame(socket: &mut WebSocket, frame: serde_json::Value) -> Result<(), ()> {
    let text = frame.to_string();
    if !recovery_wire_fits(text.len()) {
        let refusal = serde_json::json!({ "type": "ResyncRequired", "reason": "RECOVERY_PAYLOAD_TOO_LARGE" });
        let _ = socket.send(Message::Text(refusal.to_string().into())).await;
        return Err(());
    }
    socket.send(Message::Text(text.into())).await.map_err(|_| ())
}

/// A committed command broadcast to stream subscribers, in server order.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastCommand {
    pub stream_epoch: i64,
    pub server_revision: i64,
    pub command: serde_json::Value,
    pub applied_command_ids: Vec<String>,
    pub history_entry: ConfirmedHistoryEntry,
}

/// Shared service state for the command routes.
#[derive(Clone)]
pub struct CommandState {
    pub membership: Arc<Mutex<MembershipStore>>,
    /// One open project log per project, serialized by a mutex.
    pub logs: Arc<Mutex<HashMap<String, Arc<Mutex<ProjectLog>>>>>,
    /// Per-project live broadcast of committed commands (AC 27.5-4).
    pub broadcast: Arc<Mutex<HashMap<String, broadcast::Sender<BroadcastCommand>>>>,
    /// The data directory holding one SQLite file per project (D3). `None` uses
    /// an in-memory database (tests only); production sets a real path so state
    /// survives a restart/redeploy.
    pub data_dir: Option<std::path::PathBuf>,
    /// Browser nonce replay guard (R6, H01).
    pub nonces: Arc<NonceCache>,
    /// Ephemeral, authorized presence (27.8).
    pub presence: Arc<crate::presence::PresenceRegistry>,
}

impl CommandState {
    pub fn in_memory() -> Self {
        Self {
            membership: Arc::new(Mutex::new(MembershipStore::open_in_memory().expect("membership"))),
            logs: Arc::new(Mutex::new(HashMap::new())),
            broadcast: Arc::new(Mutex::new(HashMap::new())),
            data_dir: None,
            nonces: Arc::new(NonceCache::default()),
            presence: Arc::new(crate::presence::PresenceRegistry::new()),
        }
    }

    fn sender_for(&self, project_id: &str) -> broadcast::Sender<BroadcastCommand> {
        let mut map = self.broadcast.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(project_id.to_string())
            .or_insert_with(|| broadcast::channel(256).0)
            .clone()
    }

    fn log_for(&self, project_id: &str) -> Result<Arc<Mutex<ProjectLog>>, StatusCode> {
        // Reject a project id that is not a UUID-shaped token before it can reach
        // a filesystem path (H-review). This is a 404-class input error.
        if !crate::project_log::is_safe_project_id(project_id) {
            return Err(StatusCode::BAD_REQUEST);
        }
        let mut logs = self.logs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(log) = logs.get(project_id) {
            return Ok(log.clone());
        }
        // One SQLite file per project under the data dir (D3); tests use memory.
        let log = match &self.data_dir {
            Some(dir) => {
                let path = crate::project_log::project_db_path(dir, project_id);
                ProjectLog::open(&path, project_id)
            }
            None => ProjectLog::open_in_memory(project_id),
        }
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let arc = Arc::new(Mutex::new(log));
        logs.insert(project_id.to_string(), arc.clone());
        Ok(arc)
    }

    /// Test helper: ensure a project row exists in the log so subsequent remote
    /// commands have a home (project creation is not remotely admissible, H03).
    pub fn ensure_project_for_test(&self, project_id: &str) {
        self.membership.lock().unwrap_or_else(|e| e.into_inner())
            .upsert_share(project_id, "synthetic-fixture", "shared", &crate::now_iso()).expect("fixture activation");
        if let Ok(log) = self.log_for(project_id) {
            let mut guard = log.lock().unwrap_or_else(|e| e.into_inner());
            let fixture_command_id = format!("{}ffffffffffff", &project_id[..24]);
            let _ = guard.ensure_project("Shared", &fixture_command_id);
        }
    }
}

pub fn command_router(state: CommandState) -> Router {
    Router::new()
        .route("/projects/{project_id}/commands", post(submit_command))
        .route("/projects/{project_id}/command-group", post(submit_command_group))
        .route("/projects/{project_id}/bootstrap", get(bootstrap))
        .route("/projects/{project_id}/stream", get(stream))
        .route("/projects/{project_id}/presence", post(heartbeat).get(present))
        .with_state(state)
}

#[derive(Deserialize)]
pub struct SubmitBody {
    #[serde(rename = "recoveryVersion")]
    pub recovery_version: Option<i64>,
    #[serde(rename = "streamEpoch")]
    pub stream_epoch: Option<i64>,
    /// The full product command.
    pub command: serde_json::Value,
}

/// A composite gesture's commands, applied all-or-nothing (Story 27.2).
#[derive(Deserialize)]
pub struct SubmitGroupBody {
    #[serde(rename = "recoveryVersion")]
    pub recovery_version: Option<i64>,
    #[serde(rename = "streamEpoch")]
    pub stream_epoch: Option<i64>,
    pub commands: Vec<serde_json::Value>,
}

#[derive(Serialize)]
struct SubmitGroupResponse {
    #[serde(rename = "streamEpoch")]
    stream_epoch: i64,
    revision: i64,
    results: Vec<serde_json::Value>,
}

#[derive(Serialize)]
struct SubmitResponse {
    #[serde(rename = "streamEpoch")]
    stream_epoch: i64,
    revision: i64,
    result: serde_json::Value,
}

struct CommandError(StatusCode, String);
impl From<(StatusCode, String)> for CommandError {
    fn from(value: (StatusCode, String)) -> Self { Self(value.0, value.1) }
}
impl IntoResponse for CommandError {
    fn into_response(self) -> axum::response::Response {
        let body = match self.1.as_str() {
            "RESYNC_REQUIRED" => serde_json::json!({ "kind": "ResyncRequired", "reason": "STREAM_EPOCH_MISMATCH" }),
            "UPDATE_REQUIRED" => serde_json::json!({ "kind": "UpdateRequired", "reason": "RECOVERY_CAPABILITY_REQUIRED" }),
            "RECOVERY_PAYLOAD_TOO_LARGE" => serde_json::json!({ "kind": "RecoveryRequired", "reason": "RECOVERY_PAYLOAD_TOO_LARGE" }),
            reason => serde_json::json!({ "kind": "Error", "reason": reason }),
        };
        (self.0, Json(body)).into_response()
    }
}

async fn submit_command(
    State(state): State<CommandState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<SubmitResponse>, CommandError> {
    // Authenticate from the verified credential and derive the actor (H01).
    // A non-member, unapproved member, viewer, or spoofed device is refused.
    let membership_guard = state.membership.lock().unwrap_or_else(|e| e.into_inner());
    let ctx = {
        let m = &membership_guard;
        principal_for_project(
            &m,
            &state.nonces,
            &headers,
            "POST",
            &format!("/projects/{project_id}/commands"),
            &body,
            &project_id,
        )
        .map_err(|_| (StatusCode::UNAUTHORIZED, "UNAUTHENTICATED".to_string()))?
    };
    if !ctx.approved || !membership_guard.project_is_active(&project_id).unwrap_or(false) {
        return Err((StatusCode::FORBIDDEN, "NOT_A_MEMBER".into()).into());
    }
    // An approved member without write permission gets a durable terminal
    // rejection below (never applied), so queued edits made before a role
    // change are retained and rolled back by recovery instead of stuck.
    let may_write = ctx.role.can_write();

    require_command_version(&headers).map_err(|s| (s, "UPDATE_REQUIRED".to_string()))?;
    let parsed: SubmitBody = serde_json::from_slice(&body)
        .map_err(|_| (StatusCode::BAD_REQUEST, "INVALID_BODY".to_string()))?;
    if parsed.recovery_version != Some(1) {
        return Err((StatusCode::UPGRADE_REQUIRED, "UPDATE_REQUIRED".into()).into());
    }
    let requested_epoch = parsed.stream_epoch.filter(|epoch| *epoch > 0 && *epoch <= 9_007_199_254_740_991)
        .ok_or((StatusCode::CONFLICT, "RESYNC_REQUIRED".to_string()))?;
    // Preserve original wire omission/null facts for identity binding. Trusted
    // attribution is passed separately to the log; explicit spoofing is refused.
    let command_value = parsed.command;
    if let Some(actor) = command_value.get("actorId").filter(|actor| !actor.is_null()) {
        if actor.as_str() != Some(ctx.actor_id.as_str()) {
            return Err((StatusCode::FORBIDDEN, "ACTOR_MISMATCH".into()).into());
        }
    }
    let command: pmapp_core::protocol::ProductCommand = serde_json::from_value(command_value.clone())
        .map_err(|_| (StatusCode::BAD_REQUEST, "INVALID_COMMAND".to_string()))?;
    if command.project_id() != project_id {
        return Err((StatusCode::BAD_REQUEST, "PROJECT_MISMATCH".into()).into());
    }
    // Admissibility: a remote member may not submit project-lifecycle or
    // administrative/local-only commands (R2/D8, H03).
    if !pmapp_core::db::handler::is_remotely_admissible(command.kind()) {
        return Err((StatusCode::FORBIDDEN, "REMOTE_COMMAND_NOT_ADMISSIBLE".into()).into());
    }

    let log = state.log_for(&project_id).map_err(|s| (s, "LOG_ERROR".to_string()))?;
    let command_id = command.command_id().to_string();
    let (result, revision, stream_epoch) = {
        let mut guard = log.lock().unwrap_or_else(|e| e.into_inner());
        let stream_epoch = guard.stream_epoch().map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "EPOCH_ERROR".into()))?;
        if requested_epoch != stream_epoch { return Err((StatusCode::CONFLICT, "RESYNC_REQUIRED".into()).into()); }
        let before_revision = guard.revision().map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "REVISION_ERROR".to_string()))?;
        let submitted = if may_write {
            guard.submit_wire_as_actor_in_epoch(command_value.clone(), requested_epoch, &ctx.actor_id)
        } else {
            guard.reject_without_write_in_epoch(command_value.clone(), requested_epoch, &ctx.actor_id, "VIEWER_CANNOT_WRITE")
        };
        let result = submitted
            .map_err(|error| match error {
                pmapp_core::protocol::RepositoryError::CommandIdentityConflict => (StatusCode::CONFLICT, "COMMAND_IDENTITY_CONFLICT".to_string()),
                pmapp_core::protocol::RepositoryError::ResyncRequired => (StatusCode::CONFLICT, "RESYNC_REQUIRED".to_string()),
                _ => (StatusCode::INTERNAL_SERVER_ERROR, "APPLY_ERROR".to_string()),
            })?;
        // A revision read failure must not silently broadcast/ack revision 0,
        // which would corrupt every subscriber's cursor (H-review). Only a
        // genuinely new commit needs a revision; a duplicate returns the stored
        // result without advancing.
        let revision = guard
            .revision()
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "REVISION_ERROR".to_string()))?;
        // Publication shares the commit serialization point: concurrent requests
        // cannot publish revision n+1 before n.
        if let pmapp_core::protocol::ProductCommandResult::ProductCommandApplied(applied) = &result {
            if applied.disposition == "NewCommit" && revision > before_revision {
                let history_entry = guard.history_entry(revision)
                    .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "HISTORY_ERROR".to_string()))?;
                let _ = state.sender_for(&project_id).send(BroadcastCommand {
                    stream_epoch,
                    server_revision: revision,
                    command: command_value,
                    applied_command_ids: vec![command_id],
                    history_entry,
                });
            }
        }
        (result, revision, stream_epoch)
    };
    drop(membership_guard);
    let result_json = serde_json::to_value(&result).map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "SERIALIZE".to_string()))?;
    Ok(Json(SubmitResponse { stream_epoch, revision, result: result_json }))
}

/// Submit a composite gesture atomically: every member commits at consecutive
/// server revisions (each broadcast in order), or the whole group is refused
/// with a durable terminal rejection per member. Same authentication,
/// attribution, admissibility and epoch rules as a single command.
async fn submit_command_group(
    State(state): State<CommandState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<SubmitGroupResponse>, CommandError> {
    let membership_guard = state.membership.lock().unwrap_or_else(|e| e.into_inner());
    let ctx = principal_for_project(
        &membership_guard,
        &state.nonces,
        &headers,
        "POST",
        &format!("/projects/{project_id}/command-group"),
        &body,
        &project_id,
    )
    .map_err(|_| (StatusCode::UNAUTHORIZED, "UNAUTHENTICATED".to_string()))?;
    if !ctx.approved || !membership_guard.project_is_active(&project_id).unwrap_or(false) {
        return Err((StatusCode::FORBIDDEN, "NOT_A_MEMBER".into()).into());
    }
    let may_write = ctx.role.can_write();
    require_command_version(&headers).map_err(|s| (s, "UPDATE_REQUIRED".to_string()))?;
    let parsed: SubmitGroupBody = serde_json::from_slice(&body)
        .map_err(|_| (StatusCode::BAD_REQUEST, "INVALID_BODY".to_string()))?;
    if parsed.recovery_version != Some(1) {
        return Err((StatusCode::UPGRADE_REQUIRED, "UPDATE_REQUIRED".into()).into());
    }
    let requested_epoch = parsed.stream_epoch.filter(|epoch| *epoch > 0 && *epoch <= 9_007_199_254_740_991)
        .ok_or((StatusCode::CONFLICT, "RESYNC_REQUIRED".to_string()))?;
    if parsed.commands.is_empty() || parsed.commands.len() > crate::project_log::MAX_GROUP_MEMBERS {
        return Err((StatusCode::BAD_REQUEST, "INVALID_GROUP".into()).into());
    }
    for command_value in &parsed.commands {
        if let Some(actor) = command_value.get("actorId").filter(|actor| !actor.is_null()) {
            if actor.as_str() != Some(ctx.actor_id.as_str()) {
                return Err((StatusCode::FORBIDDEN, "ACTOR_MISMATCH".into()).into());
            }
        }
        let command: pmapp_core::protocol::ProductCommand = serde_json::from_value(command_value.clone())
            .map_err(|_| (StatusCode::BAD_REQUEST, "INVALID_COMMAND".to_string()))?;
        if command.project_id() != project_id {
            return Err((StatusCode::BAD_REQUEST, "PROJECT_MISMATCH".into()).into());
        }
        if !pmapp_core::db::handler::is_remotely_admissible(command.kind()) {
            return Err((StatusCode::FORBIDDEN, "REMOTE_COMMAND_NOT_ADMISSIBLE".into()).into());
        }
    }

    let log = state.log_for(&project_id).map_err(|s| (s, "LOG_ERROR".to_string()))?;
    let map_error = |error| match error {
        pmapp_core::protocol::RepositoryError::CommandIdentityConflict => (StatusCode::CONFLICT, "COMMAND_IDENTITY_CONFLICT".to_string()),
        pmapp_core::protocol::RepositoryError::ResyncRequired => (StatusCode::CONFLICT, "RESYNC_REQUIRED".to_string()),
        pmapp_core::protocol::RepositoryError::InvalidRequest => (StatusCode::BAD_REQUEST, "INVALID_GROUP".to_string()),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, "APPLY_ERROR".to_string()),
    };
    let (results, revision, stream_epoch) = {
        let mut guard = log.lock().unwrap_or_else(|e| e.into_inner());
        let stream_epoch = guard.stream_epoch().map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "EPOCH_ERROR".into()))?;
        if requested_epoch != stream_epoch { return Err((StatusCode::CONFLICT, "RESYNC_REQUIRED".into()).into()); }
        let results = if may_write {
            guard.submit_group_as_actor_in_epoch(parsed.commands.clone(), requested_epoch, &ctx.actor_id).map_err(map_error)?
        } else {
            // A viewer's queued group: every member becomes a durable terminal rejection.
            let mut rejected = Vec::with_capacity(parsed.commands.len());
            for wire in &parsed.commands {
                rejected.push(guard.reject_without_write_in_epoch(wire.clone(), requested_epoch, &ctx.actor_id, "VIEWER_CANNOT_WRITE").map_err(map_error)?);
            }
            rejected
        };
        let revision = guard.revision().map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "REVISION_ERROR".to_string()))?;
        // Publish each newly committed member in revision order, under the same
        // serialization point as the commit.
        for (result, command_value) in results.iter().zip(parsed.commands.iter()) {
            if let pmapp_core::protocol::ProductCommandResult::ProductCommandApplied(applied) = result {
                if applied.disposition == "NewCommit" {
                    let member_revision = applied.target_revision;
                    let history_entry = guard.history_entry(member_revision)
                        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "HISTORY_ERROR".to_string()))?;
                    let command_id = command_value.get("commandId").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                    let _ = state.sender_for(&project_id).send(BroadcastCommand {
                        stream_epoch,
                        server_revision: member_revision,
                        command: command_value.clone(),
                        applied_command_ids: vec![command_id],
                        history_entry,
                    });
                }
            }
        }
        (results, revision, stream_epoch)
    };
    drop(membership_guard);
    let results = results.iter().map(serde_json::to_value).collect::<Result<Vec<_>, _>>()
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "SERIALIZE".to_string()))?;
    Ok(Json(SubmitGroupResponse { stream_epoch, revision, results }))
}

#[derive(Deserialize)]
pub struct BootstrapQuery {
    pub recovery_version: Option<i64>,
    pub stream_epoch: Option<i64>,
    pub since: Option<i64>,
    /// The requesting device id (paired with a verified credential).
    pub device_id: Option<String>,
    /// A bearer credential for the device (browsers cannot set WS headers, so a
    /// query token authenticates the stream). Verified against the stored hash.
    pub bearer: Option<String>,
    /// Browser proof-of-possession (H01): the signed
    /// `GET path bodyDigest nonce timestamp` payload, carried as query params
    /// because a browser cannot set WebSocket headers. Present instead of
    /// `bearer` for public-key devices.
    pub nonce: Option<String>,
    pub timestamp: Option<String>,
    pub signature: Option<String>,
    /// The client's protocol version (handshake admission, 27.9/H11).
    pub protocol_version: Option<String>,
    /// The client's product schema version (handshake admission, 27.9/H11).
    pub schema_version: Option<i64>,
}

/// Enforce the version handshake before admitting a read/stream (27.9/H11).
/// A client whose versions this service cannot serve is refused with 426
/// Upgrade Required so it shows "Update to keep syncing" and keeps working
/// locally. Missing versions are refused; omission cannot bypass admission.
fn require_supported_version(query: &BootstrapQuery) -> Result<(), StatusCode> {
    if query.recovery_version != Some(1) { return Err(StatusCode::UPGRADE_REQUIRED); }
    let (Some(protocol), Some(schema)) = (&query.protocol_version, query.schema_version) else {
        return Err(StatusCode::UPGRADE_REQUIRED);
    };
    let request = crate::handshake::HandshakeRequest {
        protocol_version: protocol.clone(),
        schema_version: schema,
    };
    match crate::handshake::decide_handshake(&request, &crate::now_iso()) {
        crate::handshake::HandshakeDecision::Accepted { .. } => Ok(()),
        crate::handshake::HandshakeDecision::UpdateRequired { .. } => Err(StatusCode::from_u16(426).unwrap_or(StatusCode::UPGRADE_REQUIRED)),
    }
}

fn require_command_version(headers: &HeaderMap) -> Result<(), StatusCode> {
    let protocol = headers.get("x-pmapp-protocol-version").and_then(|v| v.to_str().ok());
    let schema = headers.get("x-pmapp-schema-version").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok());
    let (Some(protocol), Some(schema)) = (protocol, schema) else { return Err(StatusCode::UPGRADE_REQUIRED); };
    let request = crate::handshake::HandshakeRequest { protocol_version: protocol.to_string(), schema_version: schema };
    match crate::handshake::decide_handshake(&request, &crate::now_iso()) {
        crate::handshake::HandshakeDecision::Accepted { .. } => Ok(()),
        _ => Err(StatusCode::UPGRADE_REQUIRED),
    }
}

/// Authenticate a member for read/stream operations (H01). Browsers cannot set
/// WebSocket headers, so the credential travels as query params: desktop sends
/// `device_id` + `bearer`; the browser sends `device_id` + a signed proof over
/// the canonical `GET path bodyDigest nonce timestamp` payload (empty body).
/// Returns the approved membership context, derived from the verified row.
fn authenticate_query(
    state: &CommandState,
    project_id: &str,
    path: &str,
    query: &BootstrapQuery,
) -> Result<crate::membership_store::AuthContext, StatusCode> {
    let store = state.membership.lock().unwrap_or_else(|e| e.into_inner());
    authenticate_query_locked(state, &store, project_id, path, query)
}

fn authenticate_query_locked(
    state: &CommandState,
    store: &MembershipStore,
    project_id: &str,
    path: &str,
    query: &BootstrapQuery,
) -> Result<crate::membership_store::AuthContext, StatusCode> {
    let device_id = query.device_id.as_deref().ok_or(StatusCode::UNAUTHORIZED)?;
    let verifier = store
        .device_verifier(device_id, project_id)
        .ok()
        .flatten()
        .ok_or(StatusCode::UNAUTHORIZED)?;
    match &verifier {
        crate::membership::CredentialVerifier::BearerHash { .. } => {
            let bearer = query.bearer.as_deref().ok_or(StatusCode::UNAUTHORIZED)?;
            crate::auth::verify_bearer(bearer, &verifier).map_err(|_| StatusCode::UNAUTHORIZED)?;
        }
        crate::membership::CredentialVerifier::PublicKey { .. } => {
            let nonce = query.nonce.as_deref().ok_or(StatusCode::UNAUTHORIZED)?;
            let timestamp = query.timestamp.as_deref().ok_or(StatusCode::UNAUTHORIZED)?;
            let signature = query.signature.as_deref().ok_or(StatusCode::UNAUTHORIZED)?;
            // A GET/WS carries no body: the digest is over the empty body.
            let digest = crate::auth::sha256_hex(b"");
            let now = chrono::Utc::now().timestamp();
            crate::auth::verify_browser_proof(&verifier, "GET", path, &digest, nonce, timestamp, signature, now, &state.nonces)
                .map_err(|_| StatusCode::UNAUTHORIZED)?;
        }
    }
    let ctx = store
        .auth_context(device_id, project_id)
        .ok()
        .flatten()
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !ctx.approved || !store.project_is_active(project_id).unwrap_or(false) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(ctx)
}

async fn bootstrap(
    State(state): State<CommandState>,
    axum::extract::Query(query): axum::extract::Query<BootstrapQuery>,
    Path(project_id): Path<String>,
) -> Result<Json<RecoveryCut>, CommandError> {
    // R6/H01: a non-member or unauthenticated caller must not read project data.
    require_supported_version(&query).map_err(|s| (s, "UPDATE_REQUIRED".to_string()))?;
    let membership = state.membership.lock().unwrap_or_else(|e| e.into_inner());
    authenticate_query_locked(&state, &membership, &project_id, &format!("/projects/{project_id}/bootstrap"), &query)
        .map_err(|s| (s, "UNAUTHENTICATED".to_string()))?;
    let log = state.log_for(&project_id).map_err(|s| (s, "LOG_ERROR".to_string()))?;
    let guard = log.lock().unwrap_or_else(|e| e.into_inner());
    let catch_up = guard
        .recovery_cut(query.since.unwrap_or(-1), query.stream_epoch)
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "CATCHUP_ERROR".to_string()))?;
    let size = serde_json::to_vec(&catch_up).map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "SERIALIZE".to_string()))?.len();
    if !recovery_wire_fits(size) { return Err((StatusCode::PAYLOAD_TOO_LARGE, "RECOVERY_PAYLOAD_TOO_LARGE".into()).into()); }
    Ok(Json(catch_up))
}

async fn stream(
    State(state): State<CommandState>,
    Path(project_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<BootstrapQuery>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if require_supported_version(&query).is_err() {
        return StatusCode::from_u16(426).unwrap_or(StatusCode::UPGRADE_REQUIRED).into_response();
    }
    // R6/H01: the stream carries authored content, so require an authenticated,
    // approved member before upgrading.
    if authenticate_query(&state, &project_id, &format!("/projects/{project_id}/stream"), &query).is_err() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let device_id = query.device_id.clone().unwrap_or_default();
    ws.max_frame_size(MAX_RECOVERY_WIRE_BYTES).max_message_size(MAX_RECOVERY_WIRE_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, state, project_id, query.since.unwrap_or(-1), query.stream_epoch, device_id))
}

/// Live stream: on connect, send the commands after the client's `since`
/// revision (or a full snapshot when it has no cursor), then stream each newly
/// committed command in order (AC 27.5-3/-4). A dropped socket simply closes;
/// the client reconnects with its last acknowledged revision.
async fn handle_socket(mut socket: WebSocket, state: CommandState, project_id: String, since: i64, epoch: Option<i64>, device_id: String) {
    // Subscribe FIRST, then catch up, so a command committed between catch-up
    // and subscribe is buffered by the channel rather than lost.
    let mut rx = state.sender_for(&project_id).subscribe();
    let cut = {
        // The upgrade callback can run after membership was removed; recheck
        // before materializing any initial authored content.
        let membership = state.membership.lock().unwrap_or_else(|e| e.into_inner());
        if !membership.auth_context(&device_id, &project_id).ok().flatten().map(|c| c.approved).unwrap_or(false)
            || !membership.project_is_active(&project_id).unwrap_or(false) { return; }
        let log = match state.log_for(&project_id) {
            Ok(log) => log,
            Err(_) => return,
        };
        let guard = log.lock().unwrap_or_else(|e| e.into_inner());
        match guard.recovery_cut(since, epoch) { Ok(value) => value, Err(_) => return }
    };
    let stream_epoch = cut.stream_epoch;
    let mut delivered_revision = cut.server_revision;
    if let Some(envelope) = cut.envelope {
        let frame = serde_json::json!({ "type": "Snapshot", "envelope": envelope });
        if send_recovery_frame(&mut socket, frame).await.is_err() { return; }
    }
    for logged in cut.commands {
        let authorized = {
            let m = state.membership.lock().unwrap_or_else(|e| e.into_inner());
            m.auth_context(&device_id, &project_id).ok().flatten().map(|c| c.approved).unwrap_or(false)
                && m.project_is_active(&project_id).unwrap_or(false)
        };
        if !authorized { return; }
        let frame = serde_json::json!({
            "type": "Command",
            "streamEpoch": stream_epoch,
            "serverRevision": logged.server_revision,
            "command": logged.command,
            "appliedCommandIds": logged.command.wire.get("commandId").and_then(|v| v.as_str()).map(|s| vec![s]).unwrap_or_default(),
            "historyEntry": logged,
        });
        if send_recovery_frame(&mut socket, frame).await.is_err() {
            return;
        }
    }
    let ready = serde_json::json!({ "type": "CatchUpReady", "streamEpoch": stream_epoch, "serverRevision": delivered_revision });
    if socket.send(Message::Text(ready.to_string().into())).await.is_err() { return; }
    let mut authorization_tick = tokio::time::interval(std::time::Duration::from_secs(1));
    loop {
        tokio::select! {
            _ = authorization_tick.tick() => {
                let (authorized, current_epoch) = {
                    let m = state.membership.lock().unwrap_or_else(|e| e.into_inner());
                    let authorized = m.auth_context(&device_id, &project_id).ok().flatten().map(|c| c.approved).unwrap_or(false)
                        && m.project_is_active(&project_id).unwrap_or(false);
                    let epoch = if authorized {
                        state.log_for(&project_id).ok().and_then(|log| log.lock().unwrap_or_else(|e| e.into_inner()).stream_epoch().ok())
                    } else { None };
                    (authorized, epoch)
                };
                if !authorized {
                    let frame = serde_json::json!({ "type": "AccessRevoked" });
                    let _ = socket.send(Message::Text(frame.to_string().into())).await;
                    break;
                }
                if current_epoch != Some(stream_epoch) {
                    let frame = serde_json::json!({ "type": "ResyncRequired", "streamEpoch": current_epoch });
                    let _ = socket.send(Message::Text(frame.to_string().into())).await;
                    break;
                }
            }
            broadcast = rx.recv() => {
                match broadcast {
                    Ok(command) => {
                        if command.stream_epoch != stream_epoch {
                            let frame = serde_json::json!({ "type": "ResyncRequired", "streamEpoch": command.stream_epoch });
                            let _ = socket.send(Message::Text(frame.to_string().into())).await;
                            break;
                        }
                        // Frames buffered during bootstrap may already be included
                        // in the snapshot/suffix. Never apply those twice.
                        if command.server_revision <= delivered_revision { continue; }
                        if command.server_revision != delivered_revision + 1 {
                            let frame = serde_json::json!({ "type": "ResyncRequired" });
                            let _ = socket.send(Message::Text(frame.to_string().into())).await;
                            break;
                        }
                        // Re-authorize on every delivered frame (R6, H06): a
                        // device removed or demoted while connected must stop
                        // receiving authored content immediately, not at the next
                        // reconnect.
                        let still_member = {
                            let m = state.membership.lock().unwrap_or_else(|e| e.into_inner());
                            m.auth_context(&device_id, &project_id)
                                .ok()
                                .flatten()
                                .map(|c| c.approved && m.project_is_active(&project_id).unwrap_or(false))
                                .unwrap_or(false)
                        };
                        if !still_member {
                            let frame = serde_json::json!({ "type": "AccessRevoked" });
                            let _ = socket.send(Message::Text(frame.to_string().into())).await;
                            break;
                        }
                        let frame = serde_json::json!({
                            "type": "Command",
                            "streamEpoch": command.stream_epoch,
                            "serverRevision": command.server_revision,
                            "command": command.command,
                            "appliedCommandIds": command.applied_command_ids,
                            "historyEntry": command.history_entry,
                        });
                        if send_recovery_frame(&mut socket, frame).await.is_err() {
                            break;
                        }
                        delivered_revision = command.server_revision;
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // The subscriber fell behind; ask it to resync rather than
                        // silently skip a committed command.
                        let frame = serde_json::json!({ "type": "ResyncRequired" });
                        let _ = socket.send(Message::Text(frame.to_string().into())).await;
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = socket.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PresenceView {
    actor_id: String,
    display_name: String,
}

/// Heartbeat: an authorized member records presence (27.8, D9). The actor and
/// name come from the verified membership row.
async fn heartbeat(
    State(state): State<CommandState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<(HeaderMap, Json<Vec<PresenceView>>), (StatusCode, String)> {
    let m = state.membership.lock().unwrap_or_else(|e| e.into_inner());
    let ctx = {
        principal_for_project(&m, &state.nonces, &headers, "POST", &format!("/projects/{project_id}/presence"), &body, &project_id)
            .map_err(|_| (StatusCode::UNAUTHORIZED, "UNAUTHENTICATED".to_string()))?
    };
    if !ctx.approved || !m.project_is_active(&project_id).unwrap_or(false) {
        return Err((StatusCode::FORBIDDEN, "NOT_A_MEMBER".into()));
    }
    let display_name = {
        m.display_name(&ctx.device_id, &project_id).unwrap_or(None).unwrap_or_else(|| "Member".to_string())
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    state.presence.heartbeat(&project_id, &ctx.device_id, &ctx.actor_id, &display_name, now_ms);
    // The same authenticated heartbeat returns who is here, so a browser needs
    // no separate signed read every 10 s (27.8), and the caller's CURRENT role
    // (a header, so older clients keep parsing the body), so a role change
    // reaches the member within one beat instead of at their next refused edit.
    let mut response_headers = HeaderMap::new();
    response_headers.insert("x-pmapp-role", axum::http::HeaderValue::from_static(ctx.role.as_str()));
    Ok((response_headers, Json(
        state.presence.present(&project_id, now_ms).into_iter()
            .map(|m| PresenceView { actor_id: m.actor_id, display_name: m.display_name })
            .collect(),
    )))
}

/// Who is here: the present members of a project (27.8), authorized.
async fn present(
    State(state): State<CommandState>,
    Path(project_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<BootstrapQuery>,
) -> Result<Json<Vec<PresenceView>>, (StatusCode, String)> {
    authenticate_query(&state, &project_id, &format!("/projects/{project_id}/presence"), &query).map_err(|s| (s, "UNAUTHENTICATED".to_string()))?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let members = state.presence.present(&project_id, now_ms);
    Ok(Json(
        members
            .into_iter()
            .map(|m| PresenceView { actor_id: m.actor_id, display_name: m.display_name })
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_router_builds() {
        let _ = command_router(CommandState::in_memory());
    }

    #[test]
    fn recovery_frame_byte_limit_includes_exact_boundary() {
        assert!(recovery_wire_fits(MAX_RECOVERY_WIRE_BYTES - 1));
        assert!(recovery_wire_fits(MAX_RECOVERY_WIRE_BYTES));
        assert!(!recovery_wire_fits(MAX_RECOVERY_WIRE_BYTES + 1));
    }
}
