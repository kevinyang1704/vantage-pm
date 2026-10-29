//! Real local WebSocket framing over the authenticated Axum routes.
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;
use pmapp_server::command_routes::{command_router, CommandState};
use pmapp_server::membership::Role;

const P: &str = "019ff310-0000-7000-8000-000000000001";
const DEVICE: &str = "synthetic-editor";
const TOKEN: &str = "synthetic-stream-secret";

fn fixture() -> CommandState {
    let state = CommandState::in_memory();
    state.membership.lock().unwrap().upsert_device(DEVICE, P, "actor-stream", "Synthetic", Role::Editor,
        true, "bearerHash", &pmapp_server::auth::sha256_hex(TOKEN.as_bytes()), "2026-10-06T00:00:00Z").unwrap();
    state.ensure_project_for_test(P);
    state
}

async fn server(state: CommandState) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, command_router(state)).await.unwrap(); });
    (addr, task)
}

fn connect(addr: std::net::SocketAddr, suffix: &str) -> TcpStream {
    let mut stream = TcpStream::connect(addr).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let path = format!("/projects/{P}/stream?protocol_version=1.0.0&schema_version={}&recovery_version=1&device_id={DEVICE}&bearer={TOKEN}&{suffix}",
        pmapp_server::handshake::CURRENT_SCHEMA_VERSION);
    write!(stream, "GET {path} HTTP/1.1\r\nHost: {addr}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n").unwrap();
    let mut headers = Vec::new();
    while !headers.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        headers.push(byte[0]);
        assert!(headers.len() < 8192);
    }
    assert!(String::from_utf8(headers).unwrap().starts_with("HTTP/1.1 101"));
    stream
}

fn frame(stream: &mut TcpStream) -> serde_json::Value {
    let mut header = [0; 2];
    stream.read_exact(&mut header).unwrap();
    assert_eq!(header[0] & 0x0f, 1, "Expected a complete JSON text frame");
    assert_eq!(header[1] & 0x80, 0, "Server frames must not be masked");
    let size = match header[1] & 0x7f {
        126 => { let mut bytes = [0; 2]; stream.read_exact(&mut bytes).unwrap(); u16::from_be_bytes(bytes) as usize },
        127 => { let mut bytes = [0; 8]; stream.read_exact(&mut bytes).unwrap(); u64::from_be_bytes(bytes) as usize },
        size => size as usize,
    };
    assert!(size <= 16 * 1024 * 1024);
    let mut bytes = vec![0; size];
    stream.read_exact(&mut bytes).unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

async fn submit(addr: std::net::SocketAddr, index: u64) -> serde_json::Value {
    let command = serde_json::json!({
        "type":"CreateNode","protocolVersion":"1.0.0",
        "commandId":format!("019ff311-0000-7000-8000-{index:012x}"),
        "nodeId":format!("019ff312-0000-7000-8000-{index:012x}"),
        "projectId":P,"baseRevision":1,"expectedRevision":2,"parentId":null,"position":"4294967296","title":"Synthetic",
    });
    let response = reqwest::Client::new().post(format!("http://{addr}/projects/{P}/commands"))
        .header("x-pmapp-device", DEVICE).header("x-pmapp-bearer", TOKEN)
        .header("x-pmapp-protocol-version", "1.0.0")
        .header("x-pmapp-schema-version", pmapp_server::handshake::CURRENT_SCHEMA_VERSION)
        .header("content-type", "application/json")
        .body(serde_json::json!({"recoveryVersion":1,"streamEpoch":1,"command":command}).to_string())
        .send().await.unwrap();
    assert!(response.status().is_success());
    serde_json::from_slice(&response.bytes().await.unwrap()).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn subscribed_cut_and_concurrent_live_suffix_are_contiguous_and_epoch_bound() {
    let state = fixture();
    let (addr, task) = server(state.clone()).await;
    let mut socket = connect(addr, "since=1"); // Unknown epoch always snapshots.
    let mut submissions = Vec::new();
    for index in 1..=16 { submissions.push(tokio::spawn(submit(addr, index))); }
    let snapshot = frame(&mut socket);
    assert_eq!(snapshot["type"], "Snapshot");
    let cut = snapshot["envelope"]["serverRevision"].as_i64().unwrap();
    assert_eq!(snapshot["envelope"]["streamEpoch"], 1);
    assert_eq!(snapshot["envelope"]["graph"]["nodes"].as_array().unwrap().len() as i64, cut - 1);
    let ready = frame(&mut socket);
    assert_eq!(ready, serde_json::json!({"type":"CatchUpReady","streamEpoch":1,"serverRevision":cut}));
    for submission in submissions { assert_eq!(submission.await.unwrap()["streamEpoch"], 1); }
    for revision in cut + 1..=17 {
        let next = frame(&mut socket);
        assert_eq!(next["type"], "Command");
        assert_eq!(next["streamEpoch"], 1);
        assert_eq!(next["serverRevision"], revision);
        assert_eq!(next["historyEntry"]["serverRevision"], revision);
        assert_eq!(next["historyEntry"]["command"], next["command"]);
        assert_eq!(next["historyEntry"]["actorId"], "actor-stream");
    }
    state.membership.lock().unwrap().upsert_share(P, "stop", "stopped", "2026-10-06T00:00:00Z").unwrap();
    assert_eq!(frame(&mut socket)["type"], "AccessRevoked");
    task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn known_epoch_gets_authoritative_suffix_and_idle_epoch_rotation_closes_stream() {
    let state = fixture();
    let (addr, task) = server(state.clone()).await;
    submit(addr, 1).await;
    let mut socket = connect(addr, "since=1&stream_epoch=1");
    let command = frame(&mut socket);
    assert_eq!(command["type"], "Command");
    assert_eq!(command["streamEpoch"], 1);
    assert_eq!(command["serverRevision"], 2);
    assert_eq!(command["historyEntry"]["command"], command["command"]);
    assert_eq!(frame(&mut socket), serde_json::json!({"type":"CatchUpReady","streamEpoch":1,"serverRevision":2}));
    state.logs.lock().unwrap().get(P).unwrap().lock().unwrap().rotate_restored_epoch(10).unwrap();
    let refusal = frame(&mut socket);
    assert_eq!(refusal["type"], "ResyncRequired");
    assert_eq!(refusal["streamEpoch"], 11);
    let mut restored = connect(addr, "since=2&stream_epoch=1");
    let snapshot = frame(&mut restored);
    assert_eq!(snapshot["type"], "Snapshot");
    assert_eq!(snapshot["envelope"]["streamEpoch"], 11);
    assert_eq!(snapshot["envelope"]["serverRevision"], 2);
    task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn oversized_recovery_refuses_without_snapshot_or_readiness() {
    let state = fixture();
    let log = state.logs.lock().unwrap().get(P).unwrap().clone();
    {
        let mut log = log.lock().unwrap();
        let node = "019ff312-0000-7000-8000-000000000001";
        log.submit_wire_in_epoch(serde_json::json!({
            "type":"CreateNode","protocolVersion":"1.0.0","commandId":"019ff311-0000-7000-8000-000000000001",
            "projectId":P,"baseRevision":1,"expectedRevision":2,"nodeId":node,"parentId":null,"position":"4294967296","title":"Synthetic",
        }), 1).unwrap();
        for index in 2..=8 {
            let body = format!("{index}{}", "x".repeat(1024 * 1024));
            log.submit_wire_in_epoch(serde_json::json!({
                "type":"SetNodeBodyText","protocolVersion":"1.0.0",
                "commandId":format!("019ff311-0000-7000-8000-{index:012x}"),
                "projectId":P,"baseRevision":index,"expectedRevision":index+1,"nodeId":node,"bodyText":body,
            }), 1).unwrap();
        }
    }
    let (addr, task) = server(state).await;
    let mut socket = connect(addr, "since=0");
    let refusal = frame(&mut socket);
    assert_eq!(refusal, serde_json::json!({"type":"ResyncRequired","reason":"RECOVERY_PAYLOAD_TOO_LARGE"}));
    let mut next = [0; 2];
    let count = socket.read(&mut next).unwrap();
    assert!(count == 0 || next[0] & 0x0f == 8, "An oversized bootstrap must not emit CatchUpReady");
    let response = reqwest::Client::new().get(format!(
        "http://{addr}/projects/{P}/bootstrap?protocol_version=1.0.0&schema_version={}&recovery_version=1&device_id={DEVICE}&bearer={TOKEN}",
        pmapp_server::handshake::CURRENT_SCHEMA_VERSION,
    )).send().await.unwrap();
    assert_eq!(response.status().as_u16(), 413);
    let body: serde_json::Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
    assert_eq!(body, serde_json::json!({"kind":"RecoveryRequired","reason":"RECOVERY_PAYLOAD_TOO_LARGE"}));
    task.abort();
}
