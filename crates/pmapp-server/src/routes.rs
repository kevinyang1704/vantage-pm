//! HTTP routes (Story 27.4, R6, H01/H06).
//!
//! Every route authenticates the caller from a verified credential and derives
//! the actor/role from the membership row — never from a body/query `device_id`.
//! Permission admission (`can_write`/`can_manage`) is checked against the same
//! authenticated principal, in the same critical section, as the operation.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

use crate::auth::{AuthError, NonceCache};
use crate::handshake::{decide_handshake, HandshakeDecision, HandshakeRequest};
use crate::membership::{bearer_verifier, recovery_code_verifier, CredentialVerifier, Invite, JoinRefusal, Role};
use crate::membership_store::MembershipStore;
use crate::principal::principal_for_project;

/// Shared service state. In production the membership DB and the project files
/// live under `data_dir` on the Railway volume.
#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Mutex<MembershipStore>>,
    pub project_logs: Arc<Mutex<std::collections::HashMap<String, Arc<Mutex<crate::project_log::ProjectLog>>>>>,
    /// The data directory holding one SQLite file per project (D3). `None`
    /// (tests) uses in-memory databases.
    pub data_dir: Option<std::path::PathBuf>,
    /// Browser nonce replay guard (R6, H01).
    pub nonces: Arc<NonceCache>,
    /// Abuse rate limiter for registration/invite/recovery (R6, C/27.4).
    pub rate_limiter: Arc<crate::rate_limit::RateLimiter>,
}

impl AppState {
    pub fn in_memory() -> Self {
        Self {
            store: Arc::new(Mutex::new(MembershipStore::open_in_memory().expect("membership schema"))),
            project_logs: Arc::new(Mutex::new(std::collections::HashMap::new())),
            data_dir: None,
            nonces: Arc::new(NonceCache::default()),
            rate_limiter: Arc::new(crate::rate_limit::RateLimiter::new()),
        }
    }

    /// Production state rooted at `data_dir` on the persistent volume.
    pub fn with_data_dir(data_dir: &std::path::Path) -> Self {
        let membership_path = data_dir.join("membership.sqlite");
        Self {
            store: Arc::new(Mutex::new(
                MembershipStore::open(&membership_path).expect("membership database"),
            )),
            project_logs: Arc::new(Mutex::new(std::collections::HashMap::new())),
            data_dir: Some(data_dir.to_path_buf()),
            nonces: Arc::new(NonceCache::default()),
            rate_limiter: Arc::new(crate::rate_limit::RateLimiter::new()),
        }
    }

    /// The live handles a coherent backup capture must exclude (Story 27.5).
    /// Panics if called on an in-memory state (no data directory to back up).
    pub fn capture_sources(&self) -> crate::backup_capture::CaptureSources {
        crate::backup_capture::CaptureSources {
            membership: self.store.clone(),
            logs: self.project_logs.clone(),
            data_dir: self.data_dir.clone().expect("capture requires a data directory"),
        }
    }

    /// Whether owner approval is required for a project (default true,
    /// durable in the membership database; AC 27.4-4).
    pub fn approval_required(&self, project_id: &str) -> bool {
        self.store.lock().unwrap_or_else(|e| e.into_inner()).approval_required(project_id).unwrap_or(true)
    }
}

pub fn router(state: AppState) -> Router {
    let commands = crate::command_routes::command_router(crate::command_routes::CommandState {
        membership: state.store.clone(),
        logs: state.project_logs.clone(),
        broadcast: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        data_dir: state.data_dir.clone(),
        nonces: state.nonces.clone(),
        presence: std::sync::Arc::new(crate::presence::PresenceRegistry::new()),
    });
    Router::new()
        .route("/healthz", get(healthz))
        .route("/handshake", post(handshake))
        .route("/projects/{project_id}/owner", post(claim_owner))
        .route("/projects/{project_id}/invites", post(create_invite))
        .route("/invites/redeem", post(redeem_invite))
        .route("/projects/{project_id}/members", get(list_members))
        .route("/projects/{project_id}/people", get(list_people))
        .route("/projects/{project_id}/approval", post(set_approval))
        .route("/join-requests/{request_id}", get(join_request_status))
        .route("/projects/{project_id}/join-requests/{request_id}/approve", post(approve_join))
        .route("/projects/{project_id}/join-requests/{request_id}/deny", post(deny_join))
        .route("/projects/{project_id}/members/{device_id}/role", post(set_role))
        .route("/projects/{project_id}/members/{device_id}", axum::routing::delete(remove_member))
        .route("/projects/{project_id}/recovery", post(redeem_recovery))
        .route("/projects/{project_id}/share", post(crate::share_routes::share_project).get(crate::share_routes::share_status))
        .route("/projects/{project_id}/share/stop", post(crate::share_routes::stop_sharing))
        .with_state(state)
        .merge(commands)
}

#[derive(Serialize)]
struct Health {
    status: &'static str,
}

/// Authenticate a device+bearer query pair against current membership for a
/// read/status operation on `AppState` (R6). Public so the share routes reuse it.
pub fn authenticate_query_app(
    state: &AppState,
    project_id: &str,
    device_id: Option<&str>,
    bearer: Option<&str>,
) -> Result<crate::membership_store::AuthContext, StatusCode> {
    let device_id = device_id.ok_or(StatusCode::UNAUTHORIZED)?;
    let bearer = bearer.ok_or(StatusCode::UNAUTHORIZED)?;
    let store = state.store.lock().unwrap_or_else(|e| e.into_inner());
    let verifier = store.device_verifier(device_id, project_id).ok().flatten().ok_or(StatusCode::UNAUTHORIZED)?;
    crate::auth::verify_bearer(bearer, &verifier).map_err(|_| StatusCode::UNAUTHORIZED)?;
    let ctx = store.auth_context(device_id, project_id).ok().flatten().ok_or(StatusCode::UNAUTHORIZED)?;
    if !ctx.approved {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(ctx)
}

async fn healthz() -> Json<Health> {
    Json(Health { status: "ok" })
}

/// Version/capabilities handshake (27.9, H11). No credentials required — it must
/// run before the client is admitted, and its answer is version-only.
async fn handshake(body: Bytes) -> Result<Json<HandshakeDecision>, (StatusCode, String)> {
    let request: HandshakeRequest = serde_json::from_slice(&body)
        .map_err(|_| (StatusCode::BAD_REQUEST, "INVALID_BODY".to_string()))?;
    Ok(Json(decide_handshake(&request, &crate::now_iso())))
}

/// Map an authentication error to a plain 401 (no factor disclosure).
fn auth_status(_err: AuthError) -> (StatusCode, String) {
    (StatusCode::UNAUTHORIZED, "UNAUTHENTICATED".into())
}

/// The rate-limit subject for an unauthenticated caller: the client address as
/// observed by the trusted edge proxy Railway runs in front of the service.
///
/// X-Forwarded-For is `client, proxy1, proxy2, ...`: each proxy APPENDS the peer
/// it saw. A client can inject arbitrary *left-most* entries, so we take the
/// RIGHT-most entry (the one the trusted edge appended). A single, edge-set
/// single-value header (cf-connecting-ip / x-real-ip) is preferred when present.
/// Falls back to a shared bucket ("unknown"). The global backstop remains the
/// hard ceiling if an address cannot be trusted (H-review/27.4).
fn client_subject(headers: &HeaderMap) -> String {
    // A single-value header set authoritatively by the edge (it overwrites any
    // client value) is the most reliable when present.
    for name in ["cf-connecting-ip", "x-real-ip"] {
        if let Some(value) = headers.get(name).and_then(|v| v.to_str().ok()) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    if let Some(value) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        // Right-most hop = the address the trusted edge observed.
        if let Some(last) = value.rsplit(',').next() {
            let trimmed = last.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    "unknown".to_string()
}

fn require_manage(
    store: &MembershipStore,
    state: &AppState,
    headers: &HeaderMap,
    path: &str,
    body: &Bytes,
    project_id: &str,
    method: &str,
) -> Result<crate::membership_store::AuthContext, (StatusCode, String)> {
    let ctx = principal_for_project(store, &state.nonces, headers, method, path, body, project_id).map_err(auth_status)?;
    if !ctx.approved || !ctx.role.can_manage() {
        return Err((StatusCode::FORBIDDEN, "NOT_AN_OWNER".into()));
    }
    Ok(ctx)
}

/// First-share owner registration credential. The desktop sends a
/// high-entropy bearer once over TLS (only its SHA-256 is stored); the browser
/// registers its non-exportable P-256 public key and proves possession by
/// signing this very request with it.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum OwnerCredential {
    Bearer { bearer: String },
    #[serde(rename_all = "camelCase")]
    PublicKey { public_key_b64: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaimOwnerBody {
    device_id: String,
    actor_id: String,
    display_name: String,
    credential: OwnerCredential,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaimOwnerResponse {
    project_id: String,
    device_id: String,
    actor_id: String,
    role: Role,
}

fn is_safe_device_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// Claim an unclaimed project for its first owner (Story 27.4/27.6, R6).
/// Unauthenticated by necessity (no member exists yet), so it is rate-limited
/// per edge address with a global backstop, and it can only ever create the
/// FIRST member: any project with a member or share record is refused.
async fn claim_owner(
    State(state): State<AppState>,
    axum::extract::Path(project_id): axum::extract::Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<ClaimOwnerResponse>, (StatusCode, String)> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    if !state.rate_limiter.check("registration", &client_subject(&headers), crate::rate_limit::REGISTRATION_LIMIT, now_ms)
        || !state.rate_limiter.check("registration_global", "global", crate::rate_limit::REGISTRATION_GLOBAL_LIMIT, now_ms) {
        return Err((StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED".into()));
    }
    if !crate::project_log::is_safe_project_id(&project_id) {
        return Err((StatusCode::BAD_REQUEST, "INVALID_PROJECT_ID".into()));
    }
    let parsed: ClaimOwnerBody = serde_json::from_slice(&body).map_err(|_| (StatusCode::BAD_REQUEST, "INVALID_BODY".to_string()))?;
    let name = parsed.display_name.trim();
    if !is_safe_device_id(&parsed.device_id) || !crate::project_log::is_safe_project_id(&parsed.actor_id)
        || name.is_empty() || name.chars().count() > 80 {
        return Err((StatusCode::BAD_REQUEST, "INVALID_IDENTITY".into()));
    }
    let path = format!("/projects/{project_id}/owner");
    let (kind, verifier) = match &parsed.credential {
        OwnerCredential::Bearer { bearer } => {
            if bearer.len() < 32 || bearer.len() > 512 { return Err((StatusCode::BAD_REQUEST, "WEAK_CREDENTIAL".into())); }
            ("bearerHash", bearer_verifier(bearer))
        }
        OwnerCredential::PublicKey { public_key_b64 } => {
            let candidate = CredentialVerifier::PublicKey { public_key_b64: public_key_b64.clone() };
            let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).ok_or((StatusCode::UNAUTHORIZED, "UNAUTHENTICATED".to_string()));
            crate::auth::verify_browser_proof(
                &candidate, "POST", &path, &crate::auth::sha256_hex(&body),
                header(crate::principal::H_NONCE)?, header(crate::principal::H_TIMESTAMP)?, header(crate::principal::H_SIGNATURE)?,
                chrono::Utc::now().timestamp(), &state.nonces,
            ).map_err(auth_status)?;
            ("publicKey", public_key_b64.clone())
        }
    };
    let mut store = state.store.lock().unwrap_or_else(|e| e.into_inner());
    let outcome = store
        .claim_project_owner(&project_id, &parsed.device_id, &parsed.actor_id, name, kind, &verifier, &crate::now_iso())
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "STORE_ERROR".to_string()))?;
    match outcome {
        crate::membership_store::ClaimOutcome::Claimed | crate::membership_store::ClaimOutcome::AlreadyOwner => Ok(Json(ClaimOwnerResponse {
            project_id, device_id: parsed.device_id, actor_id: parsed.actor_id, role: Role::Owner,
        })),
        crate::membership_store::ClaimOutcome::AlreadyClaimed => Err((StatusCode::CONFLICT, "PROJECT_ALREADY_CLAIMED".into())),
        crate::membership_store::ClaimOutcome::Unavailable => Err((StatusCode::SERVICE_UNAVAILABLE, "SERVICE_QUARANTINED".into())),
    }
}

#[derive(Deserialize)]
struct CreateInviteBody {
    role: String,
    single_use: bool,
    expires_at_iso: Option<String>,
    /// Plaintext token shown once; only its SHA-256 is stored.
    token: String,
    invite_id: String,
    /// Replace an existing link of THIS project (AC 27.4-5): the old link is
    /// refused from the moment the new one exists.
    #[serde(default)]
    replaces_invite_id: Option<String>,
}

#[derive(Serialize)]
struct InviteResponse {
    invite_id: String,
    project_id: String,
    role: Role,
    single_use: bool,
    expires_at_iso: Option<String>,
}

async fn create_invite(
    State(state): State<AppState>,
    axum::extract::Path(project_id): axum::extract::Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<InviteResponse>, (StatusCode, String)> {
    let parsed: CreateInviteBody = serde_json::from_slice(&body)
        .map_err(|_| (StatusCode::BAD_REQUEST, "INVALID_BODY".to_string()))?;
    let role = Role::parse(&parsed.role).ok_or((StatusCode::BAD_REQUEST, "INVALID_ROLE".into()))?;
    let path = format!("/projects/{project_id}/invites");
    // Owner-only, authenticated. `_ctx` carries the verified actor.
    let store = state.store.lock().unwrap_or_else(|e| e.into_inner());
    let ctx = require_manage(&store, &state, &headers, &path, &body, &project_id, "POST")?;
    // Abuse limit: invite creation is rate-limited per authenticated device, so a
    // compromised owner credential cannot mint invites without bound (R6/C/27.4).
    if !state.rate_limiter.check(
        "invite_create",
        &ctx.device_id,
        crate::rate_limit::INVITE_CREATE_LIMIT,
        chrono::Utc::now().timestamp_millis(),
    ) {
        return Err((StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED".into()));
    }
    let token_sha256 = bearer_verifier(&parsed.token);
    if let Some(old) = parsed.replaces_invite_id.as_deref() {
        if store.invite_project(old).map_err(internal)?.as_deref() != Some(project_id.as_str()) {
            return Err((StatusCode::NOT_FOUND, "INVITE_NOT_FOUND".into()));
        }
        store.replace_invite(old).map_err(internal)?;
    }
    store
        .insert_invite(
            &parsed.invite_id,
            &project_id,
            role,
            parsed.single_use,
            parsed.expires_at_iso.as_deref(),
            &token_sha256,
            &crate::now_iso(),
        )
        .map_err(internal)?;
    Ok(Json(InviteResponse {
        invite_id: parsed.invite_id,
        project_id,
        role,
        single_use: parsed.single_use,
        expires_at_iso: parsed.expires_at_iso,
    }))
}

#[derive(Deserialize)]
struct RedeemBody {
    token: String,
    request_id: String,
    actor_id: String,
    display_name: String,
    /// The joining device's id + verifier, registered on approval-off joins.
    #[serde(default)]
    device_id: String,
    #[serde(default)]
    verifier_kind: String,
    #[serde(default)]
    verifier: String,
}

#[derive(Serialize)]
struct RedeemResponse {
    project_id: String,
    role: Role,
    approved: bool,
}

/// Redeem an invite. This route is used *before* the caller is a member, so it
/// is authenticated by the invite token itself (a bearer secret) rather than a
/// project membership credential — that is the point of an invite.
async fn redeem_invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<RedeemResponse>, (StatusCode, String)> {
    let parsed: RedeemBody = serde_json::from_slice(&body)
        .map_err(|_| (StatusCode::BAD_REQUEST, "INVALID_BODY".to_string()))?;
    // Abuse limit: invite redemption is rate-limited per caller address, not on a
    // single global bucket, so one attacker cannot deny redemption to everyone
    // (R6/C/27.4). A coarse global backstop still bounds the instance.
    let now_ms = chrono::Utc::now().timestamp_millis();
    if !state.rate_limiter.check(
        "invite_redeem",
        &client_subject(&headers),
        crate::rate_limit::INVITE_REDEEM_LIMIT,
        now_ms,
    ) || !state.rate_limiter.check(
        "invite_redeem_global",
        "global",
        crate::rate_limit::INVITE_REDEEM_GLOBAL_LIMIT,
        now_ms,
    ) {
        return Err((StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED".into()));
    }
    let token_sha256 = bearer_verifier(&parsed.token);
    let now = crate::now_iso();
    // Story 27.4: bind the joiner's own credential at redemption. A browser
    // key must prove possession over this request; a desktop sends only its
    // bearer's SHA-256 (it later presents the bearer itself).
    let binding = if parsed.device_id.is_empty() {
        None
    } else {
        if !is_safe_device_id(&parsed.device_id) { return Err((StatusCode::BAD_REQUEST, "INVALID_IDENTITY".into())); }
        match parsed.verifier_kind.as_str() {
            "bearerHash" if parsed.verifier.len() == 64 && parsed.verifier.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) => {}
            "publicKey" => {
                let candidate = CredentialVerifier::PublicKey { public_key_b64: parsed.verifier.clone() };
                let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).ok_or((StatusCode::UNAUTHORIZED, "UNAUTHENTICATED".to_string()));
                crate::auth::verify_browser_proof(
                    &candidate, "POST", "/invites/redeem", &crate::auth::sha256_hex(&body),
                    header(crate::principal::H_NONCE)?, header(crate::principal::H_TIMESTAMP)?, header(crate::principal::H_SIGNATURE)?,
                    chrono::Utc::now().timestamp(), &state.nonces,
                ).map_err(auth_status)?;
            }
            _ => return Err((StatusCode::BAD_REQUEST, "INVALID_CREDENTIAL".into())),
        }
        Some((parsed.device_id.as_str(), parsed.verifier_kind.as_str(), parsed.verifier.as_str()))
    };
    let mut store = state.store.lock().unwrap_or_else(|e| e.into_inner());
    match store.redeem_invite_bound(&token_sha256, &parsed.request_id, &parsed.actor_id, &parsed.display_name, binding, &now) {
        Ok((project_id, role)) => {
            // Read under the same store lock as the redemption (fail safe: required).
            let approval_off = !store.approval_required(&project_id).unwrap_or(true);
            if approval_off {
                if parsed.device_id.is_empty() {
                    return Err((StatusCode::BAD_REQUEST, "DEVICE_REQUIRED".into()));
                }
                store
                    .approve_join(&parsed.request_id, &parsed.device_id, &parsed.verifier_kind, &parsed.verifier, &now)
                    .map_err(internal)?;
            }
            Ok(Json(RedeemResponse { project_id, role, approved: approval_off }))
        }
        Err(reason) => Err(refusal_status(reason)),
    }
}

#[derive(Deserialize, Default)]
struct ApproveBody {
    /// Legacy only: requests redeemed without a bound credential. A credential
    /// bound at redemption always takes precedence.
    #[serde(default)]
    joiner_device_id: String,
    #[serde(default)]
    verifier_kind: String,
    #[serde(default)]
    verifier: String,
}

#[derive(Serialize)]
struct ApproveResponse {
    role: Role,
}

async fn approve_join(
    State(state): State<AppState>,
    axum::extract::Path((project_id, request_id)): axum::extract::Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<ApproveResponse>, (StatusCode, String)> {
    let parsed: ApproveBody = serde_json::from_slice(&body)
        .map_err(|_| (StatusCode::BAD_REQUEST, "INVALID_BODY".to_string()))?;
    let path = format!("/projects/{project_id}/join-requests/{request_id}/approve");
    let store = state.store.lock().unwrap_or_else(|e| e.into_inner());
    let _ctx = require_manage(&store, &state, &headers, &path, &body, &project_id, "POST")?;
    // The request must belong to THIS project (project isolation).
    let request_project = store.join_request_project(&request_id).map_err(internal)?;
    if request_project.as_deref() != Some(project_id.as_str()) {
        return Err((StatusCode::NOT_FOUND, "REQUEST_NOT_FOUND".into()));
    }
    let now = crate::now_iso();
    match store.approve_join(&request_id, &parsed.joiner_device_id, &parsed.verifier_kind, &parsed.verifier, &now) {
        Ok(Some(role)) => Ok(Json(ApproveResponse { role })),
        Ok(None) => Err((StatusCode::NOT_FOUND, "REQUEST_NOT_FOUND".into())),
        Err(_) => Err((StatusCode::INTERNAL_SERVER_ERROR, "STORE_ERROR".into())),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MembersResponse {
    members: Vec<crate::membership_store::MemberRow>,
    requests: Vec<crate::membership_store::JoinRequestRow>,
    approval_required: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApprovalBody {
    required: bool,
}

/// Owner turns per-project approval on or off (AC 27.4-4). Durable.
async fn set_approval(
    State(state): State<AppState>,
    axum::extract::Path(project_id): axum::extract::Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, (StatusCode, String)> {
    let parsed: ApprovalBody = serde_json::from_slice(&body).map_err(|_| (StatusCode::BAD_REQUEST, "INVALID_BODY".to_string()))?;
    let path = format!("/projects/{project_id}/approval");
    let store = state.store.lock().unwrap_or_else(|e| e.into_inner());
    require_manage(&store, &state, &headers, &path, &body, &project_id, "POST")?;
    store.set_approval_required(&project_id, parsed.required).map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Owner-only membership listing for the Share dialog (Story 27.4/27.6).
async fn list_members(
    State(state): State<AppState>,
    axum::extract::Path(project_id): axum::extract::Path<String>,
    headers: HeaderMap,
) -> Result<Json<MembersResponse>, (StatusCode, String)> {
    let path = format!("/projects/{project_id}/members");
    let store = state.store.lock().unwrap_or_else(|e| e.into_inner());
    require_manage(&store, &state, &headers, &path, &Bytes::new(), &project_id, "GET")?;
    Ok(Json(MembersResponse {
        members: store.list_members(&project_id).map_err(internal)?,
        requests: store.list_pending_requests(&project_id).map_err(internal)?,
        approval_required: store.approval_required(&project_id).map_err(internal)?,
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PersonView {
    actor_id: String,
    display_name: String,
}

/// Names for attribution (Story 27.8): any approved member may resolve the
/// display names of the project's members (they already see them in presence
/// and activity). No devices, roles or credentials are exposed.
async fn list_people(
    State(state): State<AppState>,
    axum::extract::Path(project_id): axum::extract::Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<PersonView>>, (StatusCode, String)> {
    let path = format!("/projects/{project_id}/people");
    let store = state.store.lock().unwrap_or_else(|e| e.into_inner());
    let ctx = principal_for_project(&store, &state.nonces, &headers, "GET", &path, b"", &project_id).map_err(auth_status)?;
    if !ctx.approved { return Err((StatusCode::FORBIDDEN, "NOT_A_MEMBER".into())); }
    let people = store.people(&project_id).map_err(internal)?;
    Ok(Json(people.into_iter().map(|(actor_id, display_name)| PersonView { actor_id, display_name }).collect()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JoinStatusResponse {
    project_id: String,
    role: Role,
    status: &'static str,
}

/// A joiner checks their own request, authenticated by the credential bound
/// at redemption (bearer or browser proof). Reveals nothing to anyone else.
async fn join_request_status(
    State(state): State<AppState>,
    axum::extract::Path(request_id): axum::extract::Path<String>,
    headers: HeaderMap,
) -> Result<Json<JoinStatusResponse>, (StatusCode, String)> {
    let unauthenticated = || (StatusCode::UNAUTHORIZED, "UNAUTHENTICATED".to_string());
    let store = state.store.lock().unwrap_or_else(|e| e.into_inner());
    let request = store.join_request_state(&request_id).map_err(internal)?.ok_or_else(unauthenticated)?;
    let (Some(device), Some(verifier)) = (request.device_id.as_deref(), request.verifier.as_ref()) else { return Err(unauthenticated()) };
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    if header(crate::principal::H_DEVICE) != Some(device) { return Err(unauthenticated()); }
    match verifier {
        CredentialVerifier::BearerHash { .. } => {
            crate::auth::verify_bearer(header(crate::principal::H_BEARER).ok_or_else(unauthenticated)?, verifier).map_err(auth_status)?;
        }
        CredentialVerifier::PublicKey { .. } => {
            crate::auth::verify_browser_proof(
                verifier, "GET", &format!("/join-requests/{request_id}"), &crate::auth::sha256_hex(b""),
                header(crate::principal::H_NONCE).ok_or_else(unauthenticated)?, header(crate::principal::H_TIMESTAMP).ok_or_else(unauthenticated)?,
                header(crate::principal::H_SIGNATURE).ok_or_else(unauthenticated)?, chrono::Utc::now().timestamp(), &state.nonces,
            ).map_err(auth_status)?;
        }
    }
    let status = if request.approved { "approved" } else if request.denied { "denied" } else { "pending" };
    Ok(Json(JoinStatusResponse { project_id: request.project_id, role: request.role, status }))
}

async fn deny_join(
    State(state): State<AppState>,
    axum::extract::Path((project_id, request_id)): axum::extract::Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, (StatusCode, String)> {
    let path = format!("/projects/{project_id}/join-requests/{request_id}/deny");
    let store = state.store.lock().unwrap_or_else(|e| e.into_inner());
    let _ctx = require_manage(&store, &state, &headers, &path, &body, &project_id, "POST")?;
    let request_project = store.join_request_project(&request_id).map_err(internal)?;
    if request_project.as_deref() != Some(project_id.as_str()) {
        return Err((StatusCode::NOT_FOUND, "REQUEST_NOT_FOUND".into()));
    }
    store.deny_join(&request_id).map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct SetRoleBody {
    role: String,
}

async fn set_role(
    State(state): State<AppState>,
    axum::extract::Path((project_id, target_device_id)): axum::extract::Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, (StatusCode, String)> {
    let parsed: SetRoleBody = serde_json::from_slice(&body)
        .map_err(|_| (StatusCode::BAD_REQUEST, "INVALID_BODY".to_string()))?;
    let role = Role::parse(&parsed.role).ok_or((StatusCode::BAD_REQUEST, "INVALID_ROLE".into()))?;
    let path = format!("/projects/{project_id}/members/{target_device_id}/role");
    let store = state.store.lock().unwrap_or_else(|e| e.into_inner());
    let _ctx = require_manage(&store, &state, &headers, &path, &body, &project_id, "POST")?;
    match store.set_role(&target_device_id, &project_id, role) {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(reason) => Err(refusal_status(reason)),
    }
}

async fn remove_member(
    State(state): State<AppState>,
    axum::extract::Path((project_id, target_device_id)): axum::extract::Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, (StatusCode, String)> {
    let path = format!("/projects/{project_id}/members/{target_device_id}");
    let store = state.store.lock().unwrap_or_else(|e| e.into_inner());
    // An owner removes anyone; any approved member may remove only their own
    // device (leave, AC 27.6-5). The last owner still cannot leave.
    let ctx = principal_for_project(&store, &state.nonces, &headers, "DELETE", &path, &body, &project_id).map_err(auth_status)?;
    let leaving_self = ctx.approved && ctx.device_id == target_device_id;
    if !leaving_self && !(ctx.approved && ctx.role.can_manage()) {
        return Err((StatusCode::FORBIDDEN, "NOT_AN_OWNER".into()));
    }
    match store.remove_device(&target_device_id, &project_id) {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(reason) => Err(refusal_status(reason)),
    }
}

#[derive(Deserialize)]
struct RedeemRecoveryBody {
    /// The one-time owner recovery code (plaintext, verified against its hash).
    code: String,
    device_id: String,
    actor_id: String,
    display_name: String,
    verifier_kind: String,
    verifier: String,
}

#[derive(Serialize)]
struct RedeemRecoveryResponse {
    role: Role,
}

/// Redeem the one-time owner recovery code (R6 / AC 27.4-7): atomic, hashed at
/// rest, single-use and replay-resistant. Authenticated by the recovery code
/// itself (a bearer secret), like an invite.
async fn redeem_recovery(
    State(state): State<AppState>,
    axum::extract::Path(project_id): axum::extract::Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<RedeemRecoveryResponse>, (StatusCode, String)> {
    let parsed: RedeemRecoveryBody = serde_json::from_slice(&body)
        .map_err(|_| (StatusCode::BAD_REQUEST, "INVALID_BODY".to_string()))?;
    // Abuse limit: recovery redemption is rate-limited per caller address (R6/
    // C/27.4), so an attacker cannot create unlimited per-project buckets or
    // lock out a project for its legitimate owner.
    let now_ms = chrono::Utc::now().timestamp_millis();
    if !state.rate_limiter.check(
        "recovery",
        &client_subject(&headers),
        crate::rate_limit::RECOVERY_LIMIT,
        now_ms,
    ) {
        return Err((StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED".into()));
    }
    // Bind exactly the recovering device's credential (Story 27.4, R6): a
    // browser key proves possession over this request; a desktop sends its
    // bearer's SHA-256 only.
    if !is_safe_device_id(&parsed.device_id) || !crate::project_log::is_safe_project_id(&parsed.actor_id) {
        return Err((StatusCode::BAD_REQUEST, "INVALID_IDENTITY".into()));
    }
    match parsed.verifier_kind.as_str() {
        "bearerHash" if parsed.verifier.len() == 64 && parsed.verifier.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) => {}
        "publicKey" => {
            let candidate = CredentialVerifier::PublicKey { public_key_b64: parsed.verifier.clone() };
            let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).ok_or((StatusCode::UNAUTHORIZED, "UNAUTHENTICATED".to_string()));
            crate::auth::verify_browser_proof(
                &candidate, "POST", &format!("/projects/{project_id}/recovery"), &crate::auth::sha256_hex(&body),
                header(crate::principal::H_NONCE)?, header(crate::principal::H_TIMESTAMP)?, header(crate::principal::H_SIGNATURE)?,
                chrono::Utc::now().timestamp(), &state.nonces,
            ).map_err(auth_status)?;
        }
        _ => return Err((StatusCode::BAD_REQUEST, "INVALID_CREDENTIAL".into())),
    }
    let verifier = recovery_code_verifier(&parsed.code);
    let now = crate::now_iso();
    let mut store = state.store.lock().unwrap_or_else(|e| e.into_inner());
    match store.redeem_recovery(
        &project_id,
        &verifier,
        &parsed.device_id,
        &parsed.actor_id,
        &parsed.display_name,
        &parsed.verifier_kind,
        &parsed.verifier,
        &now,
    ) {
        Ok(role) => Ok(Json(RedeemRecoveryResponse { role })),
        Err(reason) => Err(refusal_status(reason)),
    }
}

fn internal<E: std::fmt::Display>(err: E) -> (StatusCode, String) {
    let _ = err;
    (StatusCode::INTERNAL_SERVER_ERROR, "STORE_ERROR".into())
}

fn refusal_status(reason: JoinRefusal) -> (StatusCode, String) {
    let code = format!("{reason:?}").to_uppercase();
    match reason {
        JoinRefusal::InviteExpired | JoinRefusal::InviteUsed | JoinRefusal::InviteReplaced => (StatusCode::GONE, code),
        JoinRefusal::InviteNotFound | JoinRefusal::NotAMember => (StatusCode::NOT_FOUND, code),
        JoinRefusal::ViewerCannotWrite | JoinRefusal::LastOwner | JoinRefusal::ApprovalRequired => {
            (StatusCode::FORBIDDEN, code)
        }
    }
}

/// The verifier-only recovery code helper, exposed for the share flow.
pub fn recovery_verifier(code: &str) -> String {
    recovery_code_verifier(code)
}

/// Inspect an invite (tests).
pub fn invite_by_token(state: &AppState, token: &str) -> Option<Invite> {
    let store = state.store.lock().unwrap_or_else(|e| e.into_inner());
    store.invite_by_token(&bearer_verifier(token)).ok().flatten()
}

/// Seed a device with a bearer verifier (tests and the share flow).
pub fn register_bearer_device(
    store: &MembershipStore,
    device_id: &str,
    project_id: &str,
    actor_id: &str,
    display_name: &str,
    role: Role,
    approved: bool,
    bearer: &str,
) -> rusqlite::Result<()> {
    store.upsert_device(
        device_id,
        project_id,
        actor_id,
        display_name,
        role,
        approved,
        "bearerHash",
        &bearer_verifier(bearer),
        &crate::now_iso(),
    )
}

/// A verifier value stored for a device (tests).
pub fn stored_verifier_kind(store: &MembershipStore, device_id: &str, project_id: &str) -> Option<CredentialVerifier> {
    store.device_verifier(device_id, project_id).ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn router_builds() {
        let _ = router(AppState::in_memory());
    }
}
