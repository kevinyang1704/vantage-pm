//! Story 27.4/27.5 HTTP integration tests: the authenticated authorization
//! boundary (H01/H06) and the invite → join → approve → deny → replace
//! lifecycle over real requests.

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use pmapp_server::membership::Role;
use pmapp_server::membership_store::MembershipStore;
use pmapp_server::routes::{register_bearer_device, router, AppState};
use tower::ServiceExt;

const P: &str = "019ff500-0000-7000-8000-000000000001";
const NOW: &str = "2026-09-30T00:00:00Z";

/// Owner device with bearer `owner-secret`.
const OWNER: &str = "dev-owner";
const OWNER_BEARER: &str = "owner-secret";

fn state() -> AppState {
    let store = MembershipStore::open_in_memory().unwrap();
    register_bearer_device(&store, OWNER, P, "actor-owner", "Hera", Role::Owner, true, OWNER_BEARER).unwrap();
    AppState {
        store: std::sync::Arc::new(std::sync::Mutex::new(store)),
        project_logs: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        data_dir: None,
        nonces: std::sync::Arc::new(pmapp_server::auth::NonceCache::default()),
        rate_limiter: std::sync::Arc::new(pmapp_server::rate_limit::RateLimiter::new()),
    }
}

async fn body_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

/// An authenticated owner request builder.
fn owner_request(uri: &str, body: serde_json::Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .header("x-pmapp-device", OWNER)
        .header("x-pmapp-bearer", OWNER_BEARER)
        .body(Body::from(body.to_string()))
        .unwrap()
}

#[tokio::test]
async fn healthz_reports_ok() {
    let app = router(state());
    let response = app
        .oneshot(Request::builder().uri("/healthz").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await["status"], "ok");
}

#[tokio::test]
async fn handshake_accepts_current_and_refuses_unsupported() {
    let app = router(state());
    let current = serde_json::json!({ "protocolVersion": "1.0.0", "schemaVersion": pmapp_server::handshake::CURRENT_SCHEMA_VERSION });
    let response = app
        .clone()
        .oneshot(
            Request::builder().method("POST").uri("/handshake")
                .header("content-type", "application/json")
                .body(Body::from(current.to_string())).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await["kind"], "accepted");

    let unsupported = serde_json::json!({ "protocolVersion": "1.0.0", "schemaVersion": 1 });
    let response = app
        .oneshot(
            Request::builder().method("POST").uri("/handshake")
                .header("content-type", "application/json")
                .body(Body::from(unsupported.to_string())).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await["kind"], "updateRequired");
}

#[tokio::test]
async fn an_unauthenticated_invite_creation_is_refused() {
    let app = router(state());
    let body = serde_json::json!({
        "role": "editor", "single_use": true, "expires_at_iso": null,
        "token": "tok", "invite_id": "inv1"
    });
    let response = app
        .oneshot(
            Request::builder().method("POST").uri(format!("/projects/{P}/invites"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string())).unwrap(),
        )
        .await
        .unwrap();
    // No credential → 401.
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_spoofed_device_id_without_a_credential_is_refused() {
    let app = router(state());
    let body = serde_json::json!({
        "role": "editor", "single_use": true, "expires_at_iso": null,
        "token": "tok", "invite_id": "inv1"
    });
    let response = app
        .oneshot(
            Request::builder().method("POST").uri(format!("/projects/{P}/invites"))
                .header("content-type", "application/json")
                // Claims to be the owner but presents the wrong bearer.
                .header("x-pmapp-device", OWNER)
                .header("x-pmapp-bearer", "wrong")
                .body(Body::from(body.to_string())).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn invite_join_approve_lifecycle_over_http() {
    let state = state();
    // Owner (authenticated) creates an editor invite.
    let app = router(state.clone());
    let create = serde_json::json!({
        "role": "editor", "single_use": true, "expires_at_iso": null,
        "token": "tok-1", "invite_id": "inv1"
    });
    let response = app
        .oneshot(owner_request(&format!("/projects/{P}/invites"), create))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    // A joiner redeems it with the plaintext token (pre-membership: the token is
    // the credential).
    let app = router(state.clone());
    let milo_verifier = pmapp_server::auth::sha256_hex(b"milo-secret");
    let redeem = serde_json::json!({
        "token": "tok-1", "request_id": "req1", "actor_id": "actor-milo",
        "display_name": "Milo", "device_id": "dev-milo",
        "verifier_kind": "bearerHash", "verifier": milo_verifier
    });
    let response = app
        .oneshot(
            Request::builder().method("POST").uri("/invites/redeem")
                .header("content-type", "application/json")
                .body(Body::from(redeem.to_string())).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["project_id"], P);
    assert_eq!(json["role"], "editor");
    assert_eq!(json["approved"], false);

    // The joiner cannot write before approval.
    {
        let s = state.store.lock().unwrap();
        assert!(!s.can_write("dev-milo", P).unwrap());
    }

    // Owner (authenticated) approves, binding the exact device.
    let app = router(state.clone());
    let approve = serde_json::json!({
        "joiner_device_id": "dev-milo",
        "verifier_kind": "bearerHash", "verifier": milo_verifier
    });
    let response = app
        .oneshot(owner_request(&format!("/projects/{P}/join-requests/req1/approve"), approve))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await["role"], "editor");

    {
        let s = state.store.lock().unwrap();
        assert!(s.can_write("dev-milo", P).unwrap());
        assert!(!s.can_manage("dev-milo", P).unwrap());
    }
}

#[tokio::test]
async fn replacing_a_link_invalidates_the_old_one() {
    let state = state();
    {
        let s = state.store.lock().unwrap();
        s.insert_invite("inv1", P, Role::Editor, true, None, &pmapp_server::membership::bearer_verifier("old"), NOW).unwrap();
        s.insert_invite("inv2", P, Role::Editor, true, None, &pmapp_server::membership::bearer_verifier("new"), NOW).unwrap();
        s.replace_invite("inv1").unwrap();
    }
    let app = router(state.clone());
    let redeem_old = serde_json::json!({ "token": "old", "request_id": "r1", "actor_id": "a", "display_name": "A" });
    let response = app
        .oneshot(
            Request::builder().method("POST").uri("/invites/redeem")
                .header("content-type", "application/json")
                .body(Body::from(redeem_old.to_string())).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::GONE);
}

#[tokio::test]
async fn share_is_owner_only_idempotent_and_stops() {
    let state = state();
    let share = serde_json::json!({
        "operationId": "op-1", "snapshot": {
            "projectId": P, "projectName": "Shared graph", "projectRevision": 9,
            "phases": [], "nodes": [{
                "id": "019ff500-0000-7000-8000-0000000000a1", "parentId": null,
                "title": "Authored content", "bodyText": "Synthetic body", "position": "4294967296", "completed": false
            }], "nodeCustomFields": [], "typeTemplateFields": [],
            "unlockEdges": [], "findingDismissals": [], "affectedReasons": [], "openQuestions": []
        }, "recoveryVerifier": "ab".repeat(32)
    });
    let app = router(state.clone());
    let response = app
        .oneshot(owner_request(&format!("/projects/{P}/share"), share.clone()))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await["status"], "shared");

    // Activation is backed by the real imported graph used by command routes.
    let bootstrap = router(state.clone()).oneshot(Request::builder()
        .uri(format!("/projects/{P}/bootstrap?recovery_version=1&since=-1&device_id={OWNER}&bearer={OWNER_BEARER}&protocol_version=1.0.0&schema_version={}", pmapp_server::handshake::CURRENT_SCHEMA_VERSION))
        .body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(bootstrap.status(), StatusCode::OK);
    let bootstrap = body_json(bootstrap).await;
    assert_eq!(bootstrap["envelope"]["graph"]["nodes"][0]["title"], "Authored content");
    // The stream continues from the owner's snapshot revision (no regression).
    assert_eq!(bootstrap["envelope"]["serverRevision"], 9);

    // Idempotent: the same operation id returns shared, not a second project.
    let app = router(state.clone());
    let again = app
        .oneshot(owner_request(&format!("/projects/{P}/share"), share))
        .await
        .unwrap();
    assert_eq!(again.status(), StatusCode::OK);
    assert_eq!(body_json(again).await["operationId"], "op-1");

    // A different operation id on an already-shared project is refused.
    let app = router(state.clone());
    let other = serde_json::json!({ "operationId": "op-2", "snapshot": {} });
    let conflict = app
        .oneshot(owner_request(&format!("/projects/{P}/share"), other))
        .await
        .unwrap();
    assert_eq!(conflict.status(), StatusCode::CONFLICT);

    let changed = serde_json::json!({"operationId": "op-1", "snapshot": {
        "projectId": P, "projectName": "Changed", "projectRevision": 9,
        "phases": [], "nodes": [], "nodeCustomFields": [], "typeTemplateFields": [],
        "unlockEdges": [], "findingDismissals": [], "affectedReasons": [], "openQuestions": []
    }});
    let changed = router(state.clone()).oneshot(owner_request(&format!("/projects/{P}/share"), changed)).await.unwrap();
    assert_eq!(changed.status(), StatusCode::CONFLICT);
    assert!(matches!(state.store.lock().unwrap().share_record(P).unwrap().unwrap().status, pmapp_server::share_routes::ShareStatus::Shared));

    // Stop sharing returns to local.
    let app = router(state.clone());
    let stop = app
        .oneshot(owner_request(&format!("/projects/{P}/share/stop"), serde_json::json!({})))
        .await
        .unwrap();
    assert_eq!(stop.status(), StatusCode::NO_CONTENT);
    let status = {
        let s = state.store.lock().unwrap();
        s.share_record(P).unwrap().unwrap().status
    };
    assert!(matches!(status, pmapp_server::share_routes::ShareStatus::Local));
    let after_stop = router(state.clone()).oneshot(Request::builder()
        .uri(format!("/projects/{P}/bootstrap?recovery_version=1&since=-1&device_id={OWNER}&bearer={OWNER_BEARER}&protocol_version=1.0.0&schema_version={}", pmapp_server::handshake::CURRENT_SCHEMA_VERSION))
        .body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(after_stop.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn malformed_share_never_activates() {
    let state = state();
    let response = router(state.clone()).oneshot(owner_request(&format!("/projects/{P}/share"),
        serde_json::json!({"operationId":"bad-op", "snapshot": {"nodes": []}}))).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(state.store.lock().unwrap().share_record(P).unwrap().is_none());
}


fn claim(project: &str, body: serde_json::Value, address: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(format!("/projects/{project}/owner"))
        .header("content-type", "application/json")
        .header("x-real-ip", address)
        .body(Body::from(body.to_string()))
        .unwrap()
}

const FRESH: &str = "019ff500-0000-7000-8000-0000000000f1";
const FRESH_BEARER: &str = "synthetic-owner-bearer-0123456789abcdef";

fn claim_body(device: &str, bearer: &str) -> serde_json::Value {
    serde_json::json!({ "deviceId": device, "actorId": "019ff500-0000-7000-8000-0000000000a1", "displayName": "Hera",
        "credential": { "kind": "bearer", "bearer": bearer } })
}

#[tokio::test]
async fn first_owner_claim_registers_once_and_then_authenticates() {
    let app = router(state());
    let response = app.clone().oneshot(claim(FRESH, claim_body("dev-fresh", FRESH_BEARER), "10.0.0.1")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await["role"], "owner");
    // Identical retry is idempotent.
    assert_eq!(app.clone().oneshot(claim(FRESH, claim_body("dev-fresh", FRESH_BEARER), "10.0.0.1")).await.unwrap().status(), StatusCode::OK);
    // Nobody else can claim it, and the existing project P is already claimed.
    assert_eq!(app.clone().oneshot(claim(FRESH, claim_body("dev-mallory", "mallory-bearer-0123456789abcdefghijkl"), "10.0.0.2")).await.unwrap().status(), StatusCode::CONFLICT);
    assert_eq!(app.clone().oneshot(claim(P, claim_body("dev-mallory", "mallory-bearer-0123456789abcdefghijkl"), "10.0.0.2")).await.unwrap().status(), StatusCode::CONFLICT);
    // The registered bearer now authorizes an owner-only operation.
    let invite = Request::builder().method("POST").uri(format!("/projects/{FRESH}/invites"))
        .header("content-type", "application/json").header("x-pmapp-device", "dev-fresh").header("x-pmapp-bearer", FRESH_BEARER)
        .body(Body::from(serde_json::json!({"role":"editor","single_use":true,"expires_at_iso":null,"token":"tok-fresh","invite_id":"inv-fresh"}).to_string())).unwrap();
    assert_eq!(app.oneshot(invite).await.unwrap().status(), StatusCode::OK);
}

#[tokio::test]
async fn first_share_retry_after_a_lost_response_completes() {
    // The owner's claim and share both landed, but the client never saw the
    // share response (network drop, redeploy). Retrying the whole first-share
    // flow must finish, not report the project as claimed by someone else.
    let app = router(state());
    let share_request = || Request::builder().method("POST").uri(format!("/projects/{FRESH}/share"))
        .header("content-type", "application/json").header("x-pmapp-device", "dev-fresh").header("x-pmapp-bearer", FRESH_BEARER)
        .body(Body::from(serde_json::json!({ "operationId": "op-fresh", "snapshot": {
            "projectId": FRESH, "projectName": "My Project", "projectRevision": 2,
            "phases": [], "nodes": [], "nodeCustomFields": [], "typeTemplateFields": [],
            "unlockEdges": [], "findingDismissals": [], "affectedReasons": [], "openQuestions": []
        }}).to_string())).unwrap();
    assert_eq!(app.clone().oneshot(claim(FRESH, claim_body("dev-fresh", FRESH_BEARER), "10.0.0.1")).await.unwrap().status(), StatusCode::OK);
    assert_eq!(app.clone().oneshot(share_request()).await.unwrap().status(), StatusCode::OK);
    // Retry: claim again (same owner) and share again (same operation).
    assert_eq!(app.clone().oneshot(claim(FRESH, claim_body("dev-fresh", FRESH_BEARER), "10.0.0.1")).await.unwrap().status(), StatusCode::OK);
    let again = app.clone().oneshot(share_request()).await.unwrap();
    assert_eq!(again.status(), StatusCode::OK);
    assert_eq!(body_json(again).await["status"], "shared");
    // Still nobody else.
    assert_eq!(app.oneshot(claim(FRESH, claim_body("dev-mallory", "mallory-bearer-0123456789abcdefghijkl"), "10.0.0.2")).await.unwrap().status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn owner_claim_refuses_weak_malformed_and_unproven_credentials() {
    let app = router(state());
    let weak = app.clone().oneshot(claim(FRESH, claim_body("dev-fresh", "short"), "10.0.0.3")).await.unwrap();
    assert_eq!(weak.status(), StatusCode::BAD_REQUEST);
    let mut unknown = claim_body("dev-fresh", FRESH_BEARER);
    unknown["role"] = serde_json::json!("owner");
    assert_eq!(app.clone().oneshot(claim(FRESH, unknown, "10.0.0.3")).await.unwrap().status(), StatusCode::BAD_REQUEST);
    assert_eq!(app.clone().oneshot(claim("not-a-uuid", claim_body("dev-fresh", FRESH_BEARER), "10.0.0.3")).await.unwrap().status(), StatusCode::BAD_REQUEST);
    let mut bad_device = claim_body("../dev", FRESH_BEARER);
    bad_device["deviceId"] = serde_json::json!("../dev");
    assert_eq!(app.clone().oneshot(claim(FRESH, bad_device, "10.0.0.3")).await.unwrap().status(), StatusCode::BAD_REQUEST);
    // A public key without a matching proof of possession is refused.
    let key = serde_json::json!({ "deviceId": "dev-browser", "actorId": "019ff500-0000-7000-8000-0000000000a2", "displayName": "Ada",
        "credential": { "kind": "publicKey", "publicKeyB64": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE" } });
    assert_eq!(app.clone().oneshot(claim(FRESH, key, "10.0.0.3")).await.unwrap().status(), StatusCode::UNAUTHORIZED);
    // None of the refusals claimed the project.
    assert_eq!(app.oneshot(claim(FRESH, claim_body("dev-fresh", FRESH_BEARER), "10.0.0.4")).await.unwrap().status(), StatusCode::OK);
}

#[tokio::test]
async fn owner_claim_is_rate_limited_per_address() {
    let app = router(state());
    let mut limited = false;
    for n in 0..12 {
        let project = format!("019ff500-0000-7000-8000-{:012x}", 0x100 + n);
        let status = app.clone().oneshot(claim(&project, claim_body(&format!("dev-{n}"), FRESH_BEARER), "10.9.9.9")).await.unwrap().status();
        if status == StatusCode::TOO_MANY_REQUESTS { limited = true; break; }
        assert_eq!(status, StatusCode::OK);
    }
    assert!(limited, "registration must be rate limited");
    // Another address is unaffected.
    assert_eq!(app.oneshot(claim("019ff500-0000-7000-8000-000000000fff", claim_body("dev-other", FRESH_BEARER), "10.9.9.10")).await.unwrap().status(), StatusCode::OK);
}

#[tokio::test]
async fn browser_owner_claim_requires_possession_of_the_registered_key() {
    use base64::Engine;
    use p256::ecdsa::signature::Signer;
    use p256::ecdsa::{Signature, SigningKey};
    use p256::pkcs8::EncodePublicKey;
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let key = SigningKey::random(&mut rand::rngs::OsRng);
    let other = SigningKey::random(&mut rand::rngs::OsRng);
    let spki = b64.encode(key.verifying_key().to_public_key_der().unwrap().as_bytes());
    let body = serde_json::json!({ "deviceId": "dev-browser", "actorId": "019ff500-0000-7000-8000-0000000000a2", "displayName": "Ada",
        "credential": { "kind": "publicKey", "publicKeyB64": spki } }).to_string();
    let path = format!("/projects/{FRESH}/owner");
    let signed = |signer: &SigningKey, nonce: &str| {
        let timestamp = pmapp_server::now_iso();
        let payload = pmapp_server::auth::signing_payload("POST", &path, &pmapp_server::auth::sha256_hex(body.as_bytes()), nonce, &timestamp);
        let signature: Signature = signer.sign(payload.as_bytes());
        Request::builder().method("POST").uri(&path).header("content-type", "application/json").header("x-real-ip", "10.1.1.1")
            .header("x-pmapp-nonce", nonce).header("x-pmapp-timestamp", timestamp)
            .header("x-pmapp-signature", b64.encode(signature.to_der().as_bytes()))
            .body(Body::from(body.clone())).unwrap()
    };
    let app = router(state());
    // Signed by a different key: refused, and nothing is claimed.
    assert_eq!(app.clone().oneshot(signed(&other, "nonce-1")).await.unwrap().status(), StatusCode::UNAUTHORIZED);
    assert_eq!(app.clone().oneshot(signed(&key, "nonce-2")).await.unwrap().status(), StatusCode::OK);
    // A replayed proof is refused even though the claim itself would be idempotent.
    assert_eq!(app.oneshot(signed(&key, "nonce-2")).await.unwrap().status(), StatusCode::UNAUTHORIZED);
}


#[tokio::test]
async fn joiner_binds_its_own_credential_and_learns_approval() {
    let state = state();
    let app = router(state.clone());
    let invite = owner_request(&format!("/projects/{P}/invites"), serde_json::json!({"role":"editor","single_use":true,"expires_at_iso":null,"token":"tok-join","invite_id":"inv-join"}));
    assert_eq!(app.clone().oneshot(invite).await.unwrap().status(), StatusCode::OK);
    let joiner_bearer = "synthetic-joiner-bearer-0123456789abcdef";
    let verifier = pmapp_server::auth::sha256_hex(joiner_bearer.as_bytes());
    let redeem = Request::builder().method("POST").uri("/invites/redeem").header("content-type", "application/json").header("x-real-ip", "10.2.2.2")
        .body(Body::from(serde_json::json!({"token":"tok-join","request_id":"req-join","actor_id":"019ff500-0000-7000-8000-0000000000b9","display_name":"Milo",
            "device_id":"dev-joiner","verifier_kind":"bearerHash","verifier":verifier}).to_string())).unwrap();
    let redeemed = app.clone().oneshot(redeem).await.unwrap();
    assert_eq!(redeemed.status(), StatusCode::OK);
    assert_eq!(body_json(redeemed).await["approved"], false);
    let status = |bearer: &str| Request::builder().uri("/join-requests/req-join").header("x-pmapp-device", "dev-joiner").header("x-pmapp-bearer", bearer).body(Body::empty()).unwrap();
    // Pending, and only the bound credential can ask.
    let pending = app.clone().oneshot(status(joiner_bearer)).await.unwrap();
    assert_eq!(pending.status(), StatusCode::OK);
    assert_eq!(body_json(pending).await["status"], "pending");
    assert_eq!(app.clone().oneshot(status("wrong-bearer-0123456789abcdef0123456789")).await.unwrap().status(), StatusCode::UNAUTHORIZED);
    // The owner lists the request and approves with an empty body.
    let list = Request::builder().uri(format!("/projects/{P}/members")).header("x-pmapp-device", OWNER).header("x-pmapp-bearer", OWNER_BEARER).body(Body::empty()).unwrap();
    let listed = body_json(app.clone().oneshot(list).await.unwrap()).await;
    assert_eq!(listed["requests"][0]["requestId"], "req-join");
    assert_eq!(listed["requests"][0]["displayName"], "Milo");
    let approve = owner_request(&format!("/projects/{P}/join-requests/req-join/approve"), serde_json::json!({}));
    assert_eq!(app.clone().oneshot(approve).await.unwrap().status(), StatusCode::OK);
    assert_eq!(body_json(app.clone().oneshot(status(joiner_bearer)).await.unwrap()).await["status"], "approved");
    // The joiner's own bearer now authenticates as an editor; a non-owner cannot list members.
    let as_joiner = Request::builder().uri(format!("/projects/{P}/members")).header("x-pmapp-device", "dev-joiner").header("x-pmapp-bearer", joiner_bearer).body(Body::empty()).unwrap();
    assert_eq!(app.oneshot(as_joiner).await.unwrap().status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn browser_joiner_must_prove_the_key_it_binds() {
    let app = router(state());
    let invite = owner_request(&format!("/projects/{P}/invites"), serde_json::json!({"role":"viewer","single_use":true,"expires_at_iso":null,"token":"tok-key","invite_id":"inv-key"}));
    assert_eq!(app.clone().oneshot(invite).await.unwrap().status(), StatusCode::OK);
    let redeem = Request::builder().method("POST").uri("/invites/redeem").header("content-type", "application/json").header("x-real-ip", "10.2.2.3")
        .body(Body::from(serde_json::json!({"token":"tok-key","request_id":"req-key","actor_id":"019ff500-0000-7000-8000-0000000000ba","display_name":"Ada",
            "device_id":"dev-key","verifier_kind":"publicKey","verifier":"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE"}).to_string())).unwrap();
    assert_eq!(app.clone().oneshot(redeem).await.unwrap().status(), StatusCode::UNAUTHORIZED);
    // The unproven attempt did not consume the single-use invite.
    let bad_kind = Request::builder().method("POST").uri("/invites/redeem").header("content-type", "application/json").header("x-real-ip", "10.2.2.3")
        .body(Body::from(serde_json::json!({"token":"tok-key","request_id":"req-key2","actor_id":"019ff500-0000-7000-8000-0000000000ba","display_name":"Ada",
            "device_id":"dev-key","verifier_kind":"bearerHash","verifier":"not-a-hash"}).to_string())).unwrap();
    assert_eq!(app.clone().oneshot(bad_kind).await.unwrap().status(), StatusCode::BAD_REQUEST);
}


#[tokio::test]
async fn replacing_over_http_retires_the_old_link_within_the_project_only() {
    let state = state();
    let app = router(state.clone());
    let create = |token: &str, id: &str, replaces: Option<&str>| owner_request(&format!("/projects/{P}/invites"),
        serde_json::json!({"role":"editor","single_use":true,"expires_at_iso":null,"token":token,"invite_id":id,"replaces_invite_id":replaces}));
    assert_eq!(app.clone().oneshot(create("tok-old", "inv-old", None)).await.unwrap().status(), StatusCode::OK);
    assert_eq!(app.clone().oneshot(create("tok-new", "inv-new", Some("inv-old"))).await.unwrap().status(), StatusCode::OK);
    let redeem = |token: &str, request: &str| Request::builder().method("POST").uri("/invites/redeem").header("content-type", "application/json").header("x-real-ip", "10.3.3.3")
        .body(Body::from(serde_json::json!({"token":token,"request_id":request,"actor_id":"019ff500-0000-7000-8000-0000000000c9","display_name":"Ada"}).to_string())).unwrap();
    assert_eq!(app.clone().oneshot(redeem("tok-old", "r-old")).await.unwrap().status(), StatusCode::GONE);
    assert_eq!(app.clone().oneshot(redeem("tok-new", "r-new")).await.unwrap().status(), StatusCode::OK);
    // A foreign or unknown invite id cannot be replaced.
    assert_eq!(app.oneshot(create("tok-x", "inv-x", Some("inv-unknown"))).await.unwrap().status(), StatusCode::NOT_FOUND);
}


#[tokio::test]
async fn any_member_resolves_people_names_and_strangers_cannot() {
    let state = state();
    {
        let s = state.store.lock().unwrap();
        register_bearer_device(&s, "dev-viewer", P, "actor-viewer", "Sam", Role::Viewer, true, "viewer-secret-0123456789abcdefghij").unwrap();
    }
    let app = router(state);
    let people = |device: &str, bearer: &str| Request::builder().uri(format!("/projects/{P}/people")).header("x-pmapp-device", device).header("x-pmapp-bearer", bearer).body(Body::empty()).unwrap();
    let response = app.clone().oneshot(people("dev-viewer", "viewer-secret-0123456789abcdefghij")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    let names: Vec<&str> = body.as_array().unwrap().iter().map(|p| p["displayName"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["Hera", "Sam"]);
    assert!(body[0].get("deviceId").is_none() && body[0].get("role").is_none());
    assert_eq!(app.oneshot(people("dev-stranger", "nope")).await.unwrap().status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn recovery_binds_a_validated_credential_once() {
    let state = state();
    {
        let s = state.store.lock().unwrap();
        s.set_recovery(P, &pmapp_server::membership::recovery_code_verifier("SYNTHETIC-RECOVERY")).unwrap();
    }
    let app = router(state.clone());
    let recover = |body: serde_json::Value| Request::builder().method("POST").uri(format!("/projects/{P}/recovery")).header("content-type", "application/json").header("x-real-ip", "10.4.4.4")
        .body(Body::from(body.to_string())).unwrap();
    let base = |kind: &str, verifier: &str| serde_json::json!({"code":"SYNTHETIC-RECOVERY","device_id":"dev-recovered","actor_id":"019ff500-0000-7000-8000-0000000000d1","display_name":"Hera","verifier_kind":kind,"verifier":verifier});
    // Malformed or unproven credentials never consume the single-use code.
    assert_eq!(app.clone().oneshot(recover(base("bearerHash", "plain-secret"))).await.unwrap().status(), StatusCode::BAD_REQUEST);
    assert_eq!(app.clone().oneshot(recover(base("publicKey", "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE"))).await.unwrap().status(), StatusCode::UNAUTHORIZED);
    let bearer = "synthetic-recovered-bearer-0123456789ab";
    let ok = app.clone().oneshot(recover(base("bearerHash", &pmapp_server::auth::sha256_hex(bearer.as_bytes())))).await.unwrap();
    assert_eq!(ok.status(), StatusCode::OK);
    assert_eq!(body_json(ok).await["role"], "owner");
    {
        let s = state.store.lock().unwrap();
        assert!(s.can_manage("dev-recovered", P).unwrap());
    }
    // Replay is refused.
    assert_eq!(app.oneshot(recover(base("bearerHash", &pmapp_server::auth::sha256_hex(bearer.as_bytes())))).await.unwrap().status(), StatusCode::NOT_FOUND);
}


#[tokio::test]
async fn owner_can_turn_approval_off_durably_and_joins_then_activate_immediately() {
    let state = state();
    let app = router(state.clone());
    let set = |required: bool| owner_request(&format!("/projects/{P}/approval"), serde_json::json!({ "required": required }));
    // Only an owner may change it.
    let as_stranger = Request::builder().method("POST").uri(format!("/projects/{P}/approval")).header("content-type", "application/json")
        .header("x-pmapp-device", "dev-x").header("x-pmapp-bearer", "nope").body(Body::from("{\"required\":false}")).unwrap();
    assert_eq!(app.clone().oneshot(as_stranger).await.unwrap().status(), StatusCode::UNAUTHORIZED);
    assert_eq!(app.clone().oneshot(set(false)).await.unwrap().status(), StatusCode::NO_CONTENT);
    let list = Request::builder().uri(format!("/projects/{P}/members")).header("x-pmapp-device", OWNER).header("x-pmapp-bearer", OWNER_BEARER).body(Body::empty()).unwrap();
    assert_eq!(body_json(app.clone().oneshot(list).await.unwrap()).await["approvalRequired"], false);
    let invite = owner_request(&format!("/projects/{P}/invites"), serde_json::json!({"role":"editor","single_use":true,"expires_at_iso":null,"token":"tok-open","invite_id":"inv-open"}));
    assert_eq!(app.clone().oneshot(invite).await.unwrap().status(), StatusCode::OK);
    let bearer = "synthetic-open-joiner-0123456789abcdef";
    let redeem = Request::builder().method("POST").uri("/invites/redeem").header("content-type", "application/json").header("x-real-ip", "10.5.5.5")
        .body(Body::from(serde_json::json!({"token":"tok-open","request_id":"req-open","actor_id":"019ff500-0000-7000-8000-0000000000e1","display_name":"Ada",
            "device_id":"dev-open","verifier_kind":"bearerHash","verifier":pmapp_server::auth::sha256_hex(bearer.as_bytes())}).to_string())).unwrap();
    let redeemed = app.clone().oneshot(redeem).await.unwrap();
    assert_eq!(body_json(redeemed).await["approved"], true);
    {
        let s = state.store.lock().unwrap();
        assert!(s.can_write("dev-open", P).unwrap());
        assert!(!s.approval_required(P).unwrap());
    }
    assert_eq!(app.oneshot(set(true)).await.unwrap().status(), StatusCode::NO_CONTENT);
    assert!(state.store.lock().unwrap().approval_required(P).unwrap());
}


#[tokio::test]
async fn a_member_may_leave_but_not_remove_others() {
    let state = state();
    {
        let s = state.store.lock().unwrap();
        register_bearer_device(&s, "dev-editor", P, "actor-editor", "Milo", Role::Editor, true, "editor-secret-0123456789abcdefghij").unwrap();
        register_bearer_device(&s, "dev-viewer", P, "actor-viewer", "Sam", Role::Viewer, true, "viewer-secret-0123456789abcdefghij").unwrap();
    }
    let app = router(state.clone());
    let delete = |target: &str, device: &str, bearer: &str| Request::builder().method("DELETE").uri(format!("/projects/{P}/members/{target}"))
        .header("x-pmapp-device", device).header("x-pmapp-bearer", bearer).body(Body::empty()).unwrap();
    assert_eq!(app.clone().oneshot(delete("dev-viewer", "dev-editor", "editor-secret-0123456789abcdefghij")).await.unwrap().status(), StatusCode::FORBIDDEN);
    assert_eq!(app.clone().oneshot(delete("dev-editor", "dev-editor", "editor-secret-0123456789abcdefghij")).await.unwrap().status(), StatusCode::NO_CONTENT);
    assert!(state.store.lock().unwrap().auth_context("dev-editor", P).unwrap().is_none());
    // The last owner cannot leave.
    assert_ne!(app.oneshot(delete(OWNER, OWNER, OWNER_BEARER)).await.unwrap().status(), StatusCode::NO_CONTENT);
}
