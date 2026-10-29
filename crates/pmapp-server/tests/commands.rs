//! Story 27.5 command routes: an authenticated editor submits once in order;
//! bootstrap returns the contiguous suffix; unauthenticated/non-member/viewer
//! callers are refused (H01/H06).

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use pmapp_server::auth::sha256_hex;
use pmapp_server::command_routes::{command_router, CommandState};
use pmapp_server::membership::Role;
use tower::ServiceExt;

const P: &str = "019ff300-0000-7000-8000-000000000001";
const NOW: &str = "2026-09-30T00:00:00Z";

const EDITOR: &str = "dev-editor";
const EDITOR_BEARER: &str = "editor-secret";

fn state() -> CommandState {
    let s = CommandState::in_memory();
    {
        let m = s.membership.lock().unwrap();
        m.upsert_device(EDITOR, P, "actor-editor", "Milo", Role::Editor, true, "bearerHash", &sha256_hex(EDITOR_BEARER.as_bytes()), NOW).unwrap();
        m.upsert_device("dev-viewer", P, "actor-viewer", "Sam", Role::Viewer, true, "bearerHash", &sha256_hex(b"viewer-secret"), NOW).unwrap();
    }
    // Bootstrap the project server-side (project creation is not a remotely
    // admissible command, H03).
    s.ensure_project_for_test(P);
    s
}

fn create_project_command(cmd_id: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "CreateProject", "protocolVersion": "1.0.0", "commandId": cmd_id,
        "projectId": P, "baseRevision": 0, "expectedRevision": 1, "name": "Shared"
    })
}

fn create_node_command(cmd_id: &str, node_id: &str, base: i64) -> serde_json::Value {
    serde_json::json!({
        "type": "CreateNode", "protocolVersion": "1.0.0", "commandId": cmd_id,
        "projectId": P, "baseRevision": base, "expectedRevision": base + 1,
        "nodeId": node_id, "parentId": null, "position": "4294967296", "title": "A"
    })
}

async fn post_as(app: axum::Router, uri: &str, device: &str, bearer: &str, mut body: serde_json::Value) -> (StatusCode, serde_json::Value) {
    if let Some(object) = body.as_object_mut() {
        object.entry("recoveryVersion").or_insert(serde_json::json!(1));
        object.entry("streamEpoch").or_insert(serde_json::json!(1));
    }
    let response = app
        .oneshot(
            Request::builder().method("POST").uri(uri)
                .header("content-type", "application/json")
                .header("x-pmapp-device", device)
                .header("x-pmapp-bearer", bearer)
                .header("x-pmapp-protocol-version", "1.0.0")
                .header("x-pmapp-schema-version", pmapp_server::handshake::CURRENT_SCHEMA_VERSION.to_string())
                .body(Body::from(body.to_string())).unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null))
}

#[tokio::test]
async fn editor_submits_commands_that_apply_in_order() {
    let app = command_router(state());
    // The project was bootstrapped server-side; the editor now submits a node.
    let (status, body) = post_as(
        app.clone(),
        &format!("/projects/{P}/commands"),
        EDITOR,
        EDITOR_BEARER,
        serde_json::json!({ "command": create_node_command("019ff300-0000-7000-8000-0000000000c1", "019ff300-0000-7000-8000-0000000000a1", 1) }),
    ).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["revision"], 2);

    let (status, body) = post_as(
        app.clone(),
        &format!("/projects/{P}/commands"),
        EDITOR,
        EDITOR_BEARER,
        serde_json::json!({ "command": create_node_command("019ff300-0000-7000-8000-0000000000c2", "019ff300-0000-7000-8000-0000000000a2", 2) }),
    ).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["revision"], 3);

    // Bootstrap from revision 1 returns the two node commands; authenticated member.
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/projects/{P}/bootstrap?recovery_version=1&stream_epoch=1&protocol_version=1.0.0&schema_version=17&since=1&device_id={EDITOR}&bearer={EDITOR_BEARER}"))
                .body(Body::empty()).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json["serverRevision"], 3);
    assert_eq!(json["commands"].as_array().unwrap().len(), 2);
    assert_eq!(json["resyncRequired"], false);
}

#[tokio::test]
async fn a_remote_lifecycle_command_is_not_admissible() {
    let app = command_router(state());
    // DeleteProject is a local owner action, never a remote editor request.
    let delete = serde_json::json!({
        "type": "DeleteProject", "protocolVersion": "1.0.0",
        "commandId": "019ff300-0000-7000-8000-0000000000c9", "projectId": P,
        "baseRevision": 1, "expectedRevision": 2
    });
    let (status, _) = post_as(
        app,
        &format!("/projects/{P}/commands"),
        EDITOR,
        EDITOR_BEARER,
        serde_json::json!({ "command": delete }),
    ).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn an_unauthenticated_bootstrap_is_refused() {
    let app = command_router(state());
    let response = app
        .oneshot(
            Request::builder().uri(format!("/projects/{P}/bootstrap?recovery_version=1&stream_epoch=1&protocol_version=1.0.0&schema_version=17&since=0&device_id={EDITOR}"))
                .body(Body::empty()).unwrap(),
        )
        .await
        .unwrap();
    // No bearer → 401.
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_non_member_cannot_bootstrap() {
    let app = command_router(state());
    let response = app
        .oneshot(
            Request::builder().uri(format!("/projects/{P}/bootstrap?recovery_version=1&stream_epoch=1&protocol_version=1.0.0&schema_version=17&since=0&device_id=dev-stranger&bearer=x"))
                .body(Body::empty()).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn viewer_cannot_submit() {
    let app = command_router(state());
    let (status, _) = post_as(
        app,
        &format!("/projects/{P}/commands"),
        "dev-viewer",
        "viewer-secret",
        serde_json::json!({ "command": create_project_command("019ff300-0000-7000-8000-0000000000c0") }),
    ).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn an_unauthenticated_submit_is_refused() {
    let app = command_router(state());
    let response = app
        .oneshot(
            Request::builder().method("POST").uri(format!("/projects/{P}/commands"))
                .header("content-type", "application/json")
                .body(Body::from(serde_json::json!({ "command": create_project_command("019ff300-0000-7000-8000-0000000000c0") }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn command_without_handshake_is_refused_without_commit() {
    let state = state();
    let app = command_router(state.clone());
    let response = app.oneshot(Request::builder().method("POST").uri(format!("/projects/{P}/commands"))
        .header("x-pmapp-device", EDITOR).header("x-pmapp-bearer", EDITOR_BEARER)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::json!({"command": create_node_command("019ff300-0000-7000-8000-0000000000c9", "019ff300-0000-7000-8000-0000000000a9", 1)}).to_string())).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::UPGRADE_REQUIRED);
    let revision = state.logs.lock().unwrap().get(P).unwrap().lock().unwrap().revision().unwrap();
    assert_eq!(revision, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_commits_publish_in_revision_order() {
    let state = state();
    let (sender, mut rx) = tokio::sync::broadcast::channel(64);
    state.broadcast.lock().unwrap().insert(P.to_string(), sender);
    let app = command_router(state.clone());
    let mut tasks = Vec::new();
    for i in 1..=16 {
        let app = app.clone();
        tasks.push(tokio::spawn(async move {
            post_as(app, &format!("/projects/{P}/commands"), EDITOR, EDITOR_BEARER,
                serde_json::json!({"command":create_node_command(&format!("019ff300-0000-7000-8000-{i:012x}"), &format!("019ff301-0000-7000-8000-{i:012x}"), 1)})).await.0
        }));
    }
    for task in tasks { assert_eq!(task.await.unwrap(), StatusCode::OK); }
    for revision in 2..=17 {
        let frame = rx.try_recv().unwrap();
        assert_eq!(frame.server_revision, revision);
        assert_eq!(frame.stream_epoch, 1);
        assert_eq!(frame.history_entry.server_revision, revision);
        assert_eq!(frame.history_entry.command.wire, frame.command);
    }
}

async fn bootstrap_as(app: axum::Router, suffix: &str) -> (StatusCode, serde_json::Value) {
    let response = app.oneshot(Request::builder().uri(format!(
        "/projects/{P}/bootstrap?protocol_version=1.0.0&schema_version={}&device_id={EDITOR}&bearer={EDITOR_BEARER}&{suffix}",
        pmapp_server::handshake::CURRENT_SCHEMA_VERSION,
    )).body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null))
}

#[tokio::test]
async fn recovery_capability_and_epoch_are_required_before_command_admission() {
    let state = state();
    let app = command_router(state.clone());
    let command = create_node_command("019ff300-0000-7000-8000-0000000000d1", "019ff300-0000-7000-8000-0000000000b1", 1);
    for (body, expected, kind) in [
        (serde_json::json!({"command":command,"recoveryVersion":null}), StatusCode::UPGRADE_REQUIRED, "UpdateRequired"),
        (serde_json::json!({"command":command,"streamEpoch":null}), StatusCode::CONFLICT, "ResyncRequired"),
        (serde_json::json!({"command":command,"streamEpoch":2}), StatusCode::CONFLICT, "ResyncRequired"),
    ] {
        let (status, response) = post_as(app.clone(), &format!("/projects/{P}/commands"), EDITOR, EDITOR_BEARER, body).await;
        assert_eq!(status, expected);
        assert_eq!(response["kind"], kind);
    }
    assert_eq!(state.logs.lock().unwrap().get(P).unwrap().lock().unwrap().revision().unwrap(), 1);
    assert_eq!(bootstrap_as(app, "since=1&stream_epoch=1").await.0, StatusCode::UPGRADE_REQUIRED);
}

#[tokio::test]
async fn unknown_or_changed_epoch_bootstraps_even_at_the_same_revision() {
    let state = state();
    let app = command_router(state.clone());
    for suffix in ["recovery_version=1&since=1", "recovery_version=1&since=1&stream_epoch=2", "recovery_version=1&since=20&stream_epoch=1"] {
        let (status, cut) = bootstrap_as(app.clone(), suffix).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(cut["streamEpoch"], 1);
        assert_eq!(cut["serverRevision"], 1);
        assert_eq!(cut["resyncRequired"], true);
        assert!(cut["envelope"].is_object());
        assert!(cut["commands"].as_array().unwrap().is_empty());
    }
    let (status, cut) = bootstrap_as(app, "recovery_version=1&since=1&stream_epoch=1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cut["resyncRequired"], false);
    assert!(cut["envelope"].is_null());
}

#[tokio::test]
async fn cached_outcome_is_epoch_bound_and_never_rebroadcast() {
    let state = state();
    let (sender, mut rx) = tokio::sync::broadcast::channel(8);
    state.broadcast.lock().unwrap().insert(P.into(), sender);
    let app = command_router(state.clone());
    let command = create_node_command("019ff300-0000-7000-8000-0000000000d2", "019ff300-0000-7000-8000-0000000000b2", 1);
    for _ in 0..2 {
        let (status, result) = post_as(app.clone(), &format!("/projects/{P}/commands"), EDITOR, EDITOR_BEARER, serde_json::json!({"command":command})).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(result["streamEpoch"], 1);
        assert_eq!(result["revision"], 2);
    }
    assert_eq!(rx.try_recv().unwrap().server_revision, 2);
    assert!(rx.try_recv().is_err());
    state.logs.lock().unwrap().get(P).unwrap().lock().unwrap().rotate_restored_epoch(10).unwrap();
    let (status, refusal) = post_as(app.clone(), &format!("/projects/{P}/commands"), EDITOR, EDITOR_BEARER, serde_json::json!({"command":command})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(refusal, serde_json::json!({"kind":"ResyncRequired","reason":"STREAM_EPOCH_MISMATCH"}));
    let (_, cut) = bootstrap_as(app, "recovery_version=1&since=2&stream_epoch=1").await;
    assert_eq!(cut["streamEpoch"], 11);
    assert_eq!(cut["serverRevision"], 2);
    assert_eq!(cut["resyncRequired"], true);
}

#[tokio::test]
async fn stopped_members_cannot_read_recovery_or_cached_outcomes() {
    let state = state();
    let app = command_router(state.clone());
    state.membership.lock().unwrap().upsert_share(P, "stop-fixture", "stopped", NOW).unwrap();
    assert_eq!(bootstrap_as(app.clone(), "recovery_version=1&since=1&stream_epoch=1").await.0, StatusCode::FORBIDDEN);
    let (status, _) = post_as(app, &format!("/projects/{P}/commands"), EDITOR, EDITOR_BEARER,
        serde_json::json!({"command":create_node_command("019ff300-0000-7000-8000-0000000000d3", "019ff300-0000-7000-8000-0000000000b3",1)})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn recovery_history_preserves_original_omission_and_authoritative_actor_binding() {
    let app = command_router(state());
    let mut wire = create_node_command("019ff300-0000-7000-8000-0000000000d4", "019ff300-0000-7000-8000-0000000000b4", 1);
    wire.as_object_mut().unwrap().insert("actorId".into(), serde_json::json!("spoofed-actor"));
    let (status, _) = post_as(app.clone(), &format!("/projects/{P}/commands"), EDITOR, EDITOR_BEARER, serde_json::json!({"command":wire})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    wire.as_object_mut().unwrap().remove("actorId");
    let (status, _) = post_as(app.clone(), &format!("/projects/{P}/commands"), EDITOR, EDITOR_BEARER, serde_json::json!({"command":wire})).await;
    assert_eq!(status, StatusCode::OK);
    let (_, cut) = bootstrap_as(app, "recovery_version=1&since=1&stream_epoch=1").await;
    let entry = &cut["commands"][0];
    assert_eq!(entry["command"], wire);
    assert!(entry["command"].get("bodyText").is_none());
    assert!(entry["command"].get("actorId").is_none());
    assert_eq!(entry["command"]["parentId"], serde_json::Value::Null);
    assert_eq!(entry["actorId"], "actor-editor");
    assert_eq!(entry["result"]["commandId"], wire["commandId"]);
}

#[tokio::test]
async fn cached_original_wire_cannot_be_reused_by_another_authenticated_actor() {
    let state = state();
    state.membership.lock().unwrap().upsert_device("second-editor", P, "actor-second", "Synthetic", Role::Editor,
        true, "bearerHash", &sha256_hex(b"second-secret"), NOW).unwrap();
    let app = command_router(state.clone());
    let wire = create_node_command("019ff300-0000-7000-8000-0000000000d5", "019ff300-0000-7000-8000-0000000000b5", 1);
    assert_eq!(post_as(app.clone(), &format!("/projects/{P}/commands"), EDITOR, EDITOR_BEARER, serde_json::json!({"command":wire})).await.0, StatusCode::OK);
    let (status, refusal) = post_as(app, &format!("/projects/{P}/commands"), "second-editor", "second-secret", serde_json::json!({"command":wire})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(refusal, serde_json::json!({"kind":"Error","reason":"COMMAND_IDENTITY_CONFLICT"}));
    assert_eq!(state.logs.lock().unwrap().get(P).unwrap().lock().unwrap().revision().unwrap(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bootstrap_holds_membership_admission_until_the_project_read_cut() {
    let state = state();
    let app = command_router(state.clone());
    let log = state.logs.lock().unwrap().get(P).unwrap().clone();
    let project_guard = log.lock().unwrap();
    let request = tokio::spawn(bootstrap_as(app, "recovery_version=1&since=1&stream_epoch=1"));
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        match state.membership.try_lock() {
            Err(std::sync::TryLockError::WouldBlock) => break,
            Err(std::sync::TryLockError::Poisoned(_)) => panic!("membership poisoned"),
            Ok(guard) => drop(guard),
        }
        assert!(tokio::time::Instant::now() < deadline, "Bootstrap released membership before acquiring the project cut");
        tokio::task::yield_now().await;
    }
    // A manager cannot revoke this admission between authentication and cut.
    assert!(state.membership.try_lock().is_err());
    drop(project_guard);
    let (status, cut) = request.await.unwrap();
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cut["serverRevision"], 1);
    assert!(state.membership.try_lock().is_ok());
}

#[tokio::test]
async fn heartbeat_returns_who_is_here_and_refuses_non_members() {
    let app = command_router(state());
    let (status, editor_view) = post_as(app.clone(), &format!("/projects/{P}/presence"), EDITOR, EDITOR_BEARER, serde_json::json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(editor_view, serde_json::json!([{ "actorId": "actor-editor", "displayName": "Milo" }]));
    let (status, viewer_view) = post_as(app.clone(), &format!("/projects/{P}/presence"), "dev-viewer", "viewer-secret", serde_json::json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let mut names: Vec<String> = viewer_view.as_array().unwrap().iter().map(|v| v["displayName"].as_str().unwrap().to_string()).collect();
    names.sort();
    assert_eq!(names, vec!["Milo", "Sam"]);
    let (status, _) = post_as(app, &format!("/projects/{P}/presence"), "dev-stranger", "nope", serde_json::json!({})).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_viewer_edit_is_a_durable_terminal_rejection_not_a_bare_403() {
    let state = state();
    let app = command_router(state.clone());
    let edit = create_node_command("019ff300-0000-7000-8000-0000000000e1", "019ff300-0000-7000-8000-0000000000f1", 1);
    let (status, body) = post_as(app.clone(), &format!("/projects/{P}/commands"), "dev-viewer", "viewer-secret", serde_json::json!({ "command": edit })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["result"]["type"], "ProductCommandRejected");
    assert_eq!(body["result"]["code"], "VIEWER_CANNOT_WRITE");
    // Nothing was applied, and an identical retry replays the same outcome.
    let revision_before = body["revision"].clone();
    let (_, again) = post_as(app.clone(), &format!("/projects/{P}/commands"), "dev-viewer", "viewer-secret", serde_json::json!({ "command": edit })).await;
    assert_eq!(again["result"]["code"], "VIEWER_CANNOT_WRITE");
    assert_eq!(again["revision"], revision_before);
    // The recovery snapshot carries it as a terminal rejection.
    let envelope = state.logs.lock().unwrap().get(P).unwrap().lock().unwrap().recovery_envelope().unwrap();
    assert!(envelope.terminal_rejections.iter().any(|r| r.command.typed.command_id() == "019ff300-0000-7000-8000-0000000000e1"));
    assert!(envelope.graph.nodes.is_empty());
}

#[tokio::test]
async fn a_command_group_commits_atomically_and_broadcasts_each_member_in_order() {
    let state = state();
    let (sender, mut rx) = tokio::sync::broadcast::channel(16);
    state.broadcast.lock().unwrap().insert(P.to_string(), sender);
    let app = command_router(state.clone());
    let group = serde_json::json!({ "commands": [
        create_node_command("019ff300-0000-7000-8000-0000000000c1", "019ff300-0000-7000-8000-0000000000a1", 1),
        create_node_command("019ff300-0000-7000-8000-0000000000c2", "019ff300-0000-7000-8000-0000000000a2", 2),
    ]});
    let (status, body) = post_as(app.clone(), &format!("/projects/{P}/command-group"), EDITOR, EDITOR_BEARER, group.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["revision"], 3);
    assert_eq!(body["results"].as_array().unwrap().len(), 2);
    assert!(body["results"].as_array().unwrap().iter().all(|r| r["type"] == "ProductCommandApplied"));
    for (revision, command_id) in [(2, "019ff300-0000-7000-8000-0000000000c1"), (3, "019ff300-0000-7000-8000-0000000000c2")] {
        let frame = rx.try_recv().unwrap();
        assert_eq!(frame.server_revision, revision);
        assert_eq!(frame.command["commandId"], command_id);
        assert_eq!(frame.history_entry.server_revision, revision);
    }
    // A retry replays stored results and broadcasts nothing new.
    let (status, again) = post_as(app.clone(), &format!("/projects/{P}/command-group"), EDITOR, EDITOR_BEARER, group).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["revision"], 3);
    assert!(rx.try_recv().is_err());
}

#[tokio::test]
async fn a_refused_group_commits_nothing_and_a_viewer_group_is_terminal() {
    let state = state();
    let app = command_router(state.clone());
    let missing_parent = serde_json::json!({
        "type": "CreateNode", "protocolVersion": "1.0.0", "commandId": "019ff300-0000-7000-8000-0000000000c2",
        "projectId": P, "baseRevision": 2, "expectedRevision": 3,
        "nodeId": "019ff300-0000-7000-8000-0000000000a2", "parentId": "019ff300-0000-7000-8000-0000000000ff",
        "position": "4294967296", "title": "B"
    });
    let (status, body) = post_as(app.clone(), &format!("/projects/{P}/command-group"), EDITOR, EDITOR_BEARER, serde_json::json!({ "commands": [
        create_node_command("019ff300-0000-7000-8000-0000000000c1", "019ff300-0000-7000-8000-0000000000a1", 1), missing_parent,
    ]})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["revision"], 1, "nothing from the refused group committed");
    assert_eq!(body["results"][0]["code"], "ATOMIC_GROUP_REJECTED");
    assert_eq!(body["results"][1]["type"], "ProductCommandRejected");

    let (status, viewer) = post_as(app, &format!("/projects/{P}/command-group"), "dev-viewer", "viewer-secret", serde_json::json!({ "commands": [
        create_node_command("019ff300-0000-7000-8000-0000000000c3", "019ff300-0000-7000-8000-0000000000a3", 1),
    ]})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(viewer["results"][0]["code"], "VIEWER_CANNOT_WRITE");
    assert_eq!(viewer["revision"], 1);
}
