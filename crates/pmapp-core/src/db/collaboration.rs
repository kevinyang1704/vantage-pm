//! Project-scoped collaboration sidecars. Every mutation uses the actor's connection.
use std::collections::{BTreeMap, HashSet};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::protocol::{commands::{ProductCommand, ProductCommandResult}, errors::RepositoryError};
use super::handler::{self, RevisionMode};

pub const JOURNAL_DDL: &str  =  "
CREATE TABLE IF NOT EXISTS collaboration_outbox(project_id TEXT NOT NULL, command_id TEXT NOT NULL, command_json TEXT NOT NULL, commit_attempt_id INTEGER NOT NULL, queued_at_iso TEXT NOT NULL, group_id TEXT, group_index INTEGER, PRIMARY KEY(project_id,command_id));
CREATE TABLE IF NOT EXISTS collaboration_cursor(project_id TEXT PRIMARY KEY,cursor INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS collaboration_outbox_quarantine(project_id TEXT NOT NULL,command_id TEXT NOT NULL,raw_json TEXT,quarantined_at_iso TEXT NOT NULL,PRIMARY KEY(project_id,command_id));
CREATE TABLE IF NOT EXISTS collaboration_confirmed_state(project_id TEXT PRIMARY KEY,snapshot_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS collaboration_attempt_receipt(project_id TEXT NOT NULL,command_id TEXT NOT NULL,commit_attempt_id INTEGER NOT NULL,command_json TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(project_id,command_id,commit_attempt_id));
CREATE TABLE IF NOT EXISTS collaboration_rejections(project_id TEXT NOT NULL,command_id TEXT NOT NULL,command_json TEXT NOT NULL,commit_attempt_id INTEGER NOT NULL,queued_at_iso TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(project_id,command_id));
CREATE TABLE IF NOT EXISTS collaboration_quarantine_metadata(recovery_id INTEGER PRIMARY KEY,project_id TEXT NOT NULL,command_id TEXT NOT NULL,metadata_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS collaboration_rejections_by_project ON collaboration_rejections(project_id);";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutboxEntry {
    pub command_id: String,
    pub command: ProductCommand,
    pub commit_attempt_id: i64, #[serde(rename = "queuedAtISO", alias = "queuedAtIso")] pub queued_at_iso: String,
    /// Members of one composite gesture share a group id (Story 27.2): they
    /// commit, sync and are refused together. Absent for a single edit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    /// Position within the gesture (0-based); set with `group_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_index: Option<i64>,
}

/// Queue order: commit time, with a composite gesture's members kept together
/// and in gesture order (UUIDv7 ids are not ordered within one millisecond).
pub(crate) const OUTBOX_ORDER: &str = "queued_at_iso, COALESCE(group_id, command_id), COALESCE(group_index, 0), command_id";
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rejection {
    pub command_id: String,
    pub reason: String
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteCommand {
    pub command: ProductCommand,
    pub own_echo: bool,
    pub server_revision: i64,
    pub stream_epoch: i64,
    pub history_entry: crate::protocol::recovery::ConfirmedHistoryEntry,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetainedRejection {
    #[serde(flatten)]
    pub entry: OutboxEntry,
    pub reason: String
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxState {
    pub entries: Vec<OutboxEntry>,
    pub cursor: i64,
    pub stream_epoch: Option<i64>,
    pub recovery_required: bool,
    pub recovery_reason: Option<String>,
    pub resync_required: bool,
    pub corrupt: Vec<String>,
    pub rejected: Vec<RetainedRejection>
}

pub struct RebaseOutcome {
    pub result: Option<ProductCommandResult>,
    pub revision: i64
}

pub(crate) fn storage(error: rusqlite::Error) -> RepositoryError {
    if matches!(error, rusqlite::Error::SqliteFailure(ref e, _) if e.code == rusqlite::ErrorCode::DiskFull) {
        RepositoryError::StorageFull
    } else {
        RepositoryError::Internal
    }
}
fn json<T: Serialize>(v: &T) -> Result<String, RepositoryError> {
    serde_json::to_string(v).map_err(|_| RepositoryError::InvalidRequest)
}
fn valid_entry(project: &str, entry: &OutboxEntry) -> Result<(), RepositoryError> {
    handler::validate_command(&entry.command)?;
    if !crate::protocol::uuid_v7::is_uuid_v7(project) || !crate::protocol::uuid_v7::is_uuid_v7(&entry.command_id) || entry.command.project_id() != project || entry.command.command_id() != entry.command_id || entry.commit_attempt_id<1 || entry.commit_attempt_id>9_007_199_254_740_991 || !valid_date(&entry.queued_at_iso) {
        return Err(RepositoryError::InvalidRequest);
    }
    match (&entry.group_id, entry.group_index) {
        (None, None) => {}
        (Some(group), Some(index)) if !group.is_empty() && group.len() <= 128 && (0..=9_007_199_254_740_991).contains(&index) => {}
        _ => return Err(RepositoryError::InvalidRequest),
    }
    Ok(())
}
// Validate the complete ISO-8601 calendar/time, including supported offsets.
fn valid_date(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value).is_ok()
}
pub(crate) fn record(tx: &Transaction, project: &str, entry: &OutboxEntry, result: &Value) -> Result<(), RepositoryError> {
    tx.execute("INSERT INTO collaboration_attempt_receipt VALUES(?1,?2,?3,?4,?5) ON CONFLICT(project_id,command_id,commit_attempt_id) DO NOTHING", params![project, entry.command_id, entry.commit_attempt_id, json(&entry.command)?, json(result)?]).map_err(storage)?;
    Ok(())
}
fn queue(tx: &Transaction, project: &str, entry: &OutboxEntry) -> Result<(), RepositoryError> {
    tx.execute("INSERT INTO collaboration_outbox(project_id,command_id,command_json,commit_attempt_id,queued_at_iso,group_id,group_index) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(project_id,command_id) DO UPDATE SET command_json=excluded.command_json,commit_attempt_id=excluded.commit_attempt_id,queued_at_iso=excluded.queued_at_iso", params![project, entry.command_id, json(&entry.command)?, entry.commit_attempt_id, entry.queued_at_iso, entry.group_id, entry.group_index]).map_err(storage)?;
    Ok(())
}
pub(crate) fn active(conn: &Connection, project: &str) -> Result<Vec<(String, String, i64, String)>, RepositoryError> {
    let mut stmt = conn.prepare(&format!("SELECT command_id,command_json,commit_attempt_id,queued_at_iso FROM collaboration_outbox WHERE project_id=?1 ORDER BY {OUTBOX_ORDER}")).map_err(storage)?;
    let result = stmt.query_map([project], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).map_err(storage)?.collect::<rusqlite::Result<Vec<_>>>().map_err(storage)?;
    Ok(result)
}
/// Composite-gesture membership of the pending rows: command id -> (group, index).
pub(crate) fn active_groups(conn: &Connection, project: &str) -> Result<std::collections::HashMap<String, (String, i64)>, RepositoryError> {
    let mut stmt = conn.prepare("SELECT command_id,group_id,group_index FROM collaboration_outbox WHERE project_id=?1 AND group_id IS NOT NULL").map_err(storage)?;
    let rows = stmt.query_map([project], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))).map_err(storage)?
        .collect::<rusqlite::Result<Vec<_>>>().map_err(storage)?;
    Ok(rows.into_iter().map(|(id, group, index)| (id, (group, index))).collect())
}
fn raw_rows(conn: &Connection, table: &str, project: &str) -> Result<Vec<Vec<rusqlite::types::Value>>, RepositoryError> {
    let (columns, order)  =  if table == "collaboration_rejections" {
        ("command_id,command_json,commit_attempt_id,queued_at_iso,reason", "queued_at_iso,command_id")
    } else { ("command_id,command_json,commit_attempt_id,queued_at_iso,group_id,group_index", OUTBOX_ORDER) };
    let mut stmt  =  conn.prepare(&format!("SELECT {columns} FROM {table} WHERE project_id=?1 ORDER BY {order}")).map_err(storage)?;
    let count  =  stmt.column_count();
    let result  =  stmt.query_map([project], |row| (0..count).map(|i| row.get(i)).collect::<rusqlite::Result<Vec<_>>>()).map_err(storage)?.collect::<rusqlite::Result<Vec<_>>>().map_err(storage)?;
    Ok(result)
}
fn stored_entry(project: &str, row: &[rusqlite::types::Value]) -> Option<OutboxEntry> {
    use rusqlite::types::Value as SqlValue;
    let [SqlValue::Text(id), SqlValue::Text(raw), SqlValue::Integer(attempt), SqlValue::Text(date), ..]  =  row else { return None; };
    // Outbox rows carry the optional group columns at 4/5; rejection rows carry a reason there.
    let (group_id, group_index) = match (row.get(4), row.get(5)) {
        (Some(SqlValue::Text(group)), Some(SqlValue::Integer(index))) => (Some(group.clone()), Some(*index)),
        (Some(SqlValue::Null), Some(SqlValue::Null)) | (Some(SqlValue::Text(_)), None) | (None, None) => (None, None),
        _ => return None,
    };
    let entry  =  OutboxEntry {
        command_id: id.clone(), command: serde_json::from_str(raw).ok()?, commit_attempt_id: *attempt, queued_at_iso: date.clone(), group_id, group_index, };
    valid_entry(project, &entry).ok()?;
    Some(entry)
}
fn metadata_value(value: &rusqlite::types::Value) -> Value {
    use rusqlite::types::Value as SqlValue;
    match value {
        SqlValue::Null => Value::Null, SqlValue::Integer(n) => Value::from(*n), SqlValue::Real(n) => Value::from(*n), SqlValue::Text(s) => Value::from(s.clone()), SqlValue::Blob(bytes) => serde_json::json!({ "blob": bytes }), }
}
fn quarantine(tx: &Transaction, project: &str, table: &str, row: &[rusqlite::types::Value]) -> Result<(), RepositoryError> {
    use rusqlite::types::Value as SqlValue;
    let id  =  match &row[0] {
        SqlValue::Text(id) => id.clone(), SqlValue::Blob(bytes) => format!("invalid-blob:{}", hex::encode(bytes)), value => format!("invalid-value:{}", metadata_value(value)), };
    let raw  =  match &row[1] { SqlValue::Text(raw) => raw.clone(), value => metadata_value(value).to_string() };
    let metadata  =  serde_json::json!({ "source": table, "projectId": project, "commandId": metadata_value(&row[0]), "commandJson": metadata_value(&row[1]), "commitAttemptId": metadata_value(&row[2]), "queuedAtISO": metadata_value(&row[3]), "reason": row.get(4).map(metadata_value) });
    tx.execute("INSERT OR REPLACE INTO collaboration_outbox_quarantine VALUES(?1,?2,?3,strftime('%Y-%m-%dT%H:%M:%fZ','now'))", params![project, id, raw]).map_err(storage)?;
    tx.execute("INSERT INTO collaboration_quarantine_metadata(project_id,command_id,metadata_json) VALUES(?1,?2,?3)", params![project, id, json(&metadata)?]).map_err(storage)?;
    tx.execute(&format!("DELETE FROM {table} WHERE project_id=?1 AND command_id IS ?2"), params![project, row[0]]).map_err(storage)?;
    Ok(())
}
pub fn read(conn: &mut Connection, project: &str) -> Result<OutboxState, RepositoryError> {
    let tx  =  conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(storage)?;
    let mut entries  =  Vec::new();
    let mut rejected  =  Vec::new();
    for row in raw_rows(&tx, "collaboration_outbox", project)? {
        if let Some(entry)  =  stored_entry(project, &row) { entries.push(entry); }
        else { quarantine(&tx, project, "collaboration_outbox", &row)?; }
    }
    for row in raw_rows(&tx, "collaboration_rejections", project)? {
        let entry  =  stored_entry(project, &row);
        let reason  =  match &row[4] { rusqlite::types::Value::Text(reason) if !reason.is_empty() && reason.len() <= 256 => Some(reason), _ => None };
        if let (Some(entry), Some(reason))  =  (entry, reason) { rejected.push(RetainedRejection { entry, reason: reason.clone() }); }
        else { quarantine(&tx, project, "collaboration_rejections", &row)?; }
    }
    let cursor  =  tx.query_row("SELECT cursor FROM collaboration_cursor WHERE project_id=?1", [project], |r| r.get(0)).optional().map_err(storage)?.unwrap_or(0);
    let mut stmt  =  tx.prepare("SELECT command_id FROM collaboration_outbox_quarantine WHERE project_id=?1 ORDER BY command_id").map_err(storage)?;
    let corrupt  =  stmt.query_map([project], |r| r.get(0)).map_err(storage)?.collect::<rusqlite::Result<Vec<_>>>().map_err(storage)?;
    drop(stmt);
    let (stream_epoch, recovery_required, recovery_reason): (Option<i64>, bool, Option<String>) = tx.query_row(
        "SELECT stream_epoch, recovery_required, recovery_reason FROM collaboration_cursor WHERE project_id = ?1",
        [project], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(storage)?.unwrap_or((None, false, None));
    tx.commit().map_err(storage)?;
    Ok(OutboxState { entries, cursor, stream_epoch, recovery_required, recovery_reason, resync_required: stream_epoch.is_none() || recovery_required, corrupt, rejected })
}
/// One confirmed authoritative history row for activity/attribution (27.8).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRow {
    pub server_revision: i64,
    pub stream_epoch: i64,
    pub entry: Value,
}

/// Newest-first confirmed history in the CURRENT stream epoch, bounded and
/// paged by server revision. Archived epochs never mix into activity.
pub fn read_history(conn: &Connection, project: &str, before: Option<i64>, limit: i64) -> Result<Vec<HistoryRow>, RepositoryError> {
    if !(1..=200).contains(&limit) || before.is_some_and(|b| b < 1) { return Err(RepositoryError::InvalidRequest); }
    let epoch: Option<i64> = conn.query_row("SELECT stream_epoch FROM collaboration_cursor WHERE project_id=?1", [project], |r| r.get(0))
        .optional().map_err(storage)?.flatten();
    let Some(epoch) = epoch else { return Ok(Vec::new()) };
    let mut stmt = conn.prepare(
        "SELECT server_revision, entry_json FROM collaboration_authoritative_history
         WHERE project_id=?1 AND stream_epoch=?2 AND server_revision < ?3 ORDER BY server_revision DESC LIMIT ?4",
    ).map_err(storage)?;
    let rows = stmt.query_map(params![project, epoch, before.unwrap_or(i64::MAX), limit], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(storage)?.collect::<rusqlite::Result<Vec<_>>>().map_err(storage)?;
    // A malformed row is skipped rather than failing the whole page.
    Ok(rows.into_iter().filter_map(|(revision, json)| serde_json::from_str(&json).ok().map(|entry| HistoryRow { server_revision: revision, stream_epoch: epoch, entry })).collect())
}

/// The project is local again (owner stopped sharing): drop the sync state
/// in one transaction so local-only behaviour (e.g. atomic composite
/// gestures) returns. Retained rejected work, quarantined rows and recovery
/// archives are user content and are kept.
pub fn forget(conn: &mut Connection, project: &str) -> Result<(), RepositoryError> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(storage)?;
    for table in ["collaboration_cursor", "collaboration_outbox", "collaboration_confirmed_state", "collaboration_attempt_receipt", "collaboration_authoritative_history", "collaboration_recovery_envelope"] {
        tx.execute(&format!("DELETE FROM {table} WHERE project_id = ?1"), [project]).map_err(storage)?;
    }
    tx.commit().map_err(storage)
}

pub fn discard(conn: &mut Connection, project: &str, id: &str) -> Result<(), RepositoryError> {
    let tx = conn.transaction().map_err(storage)?;
    // Active optimistic effects require rebase; discard is only for rejected work.
    if tx.query_row("SELECT EXISTS(SELECT 1 FROM collaboration_outbox WHERE project_id=?1 AND command_id=?2)", params![project, id], |r|r.get::<_, bool>(0)).map_err(storage)? {
        return Err(RepositoryError::InvalidRequest);
    }
    tx.execute("DELETE FROM collaboration_rejections WHERE project_id=?1 AND command_id=?2", params![project, id]).map_err(storage)?;
    tx.execute("DELETE FROM collaboration_outbox_quarantine WHERE project_id=?1 AND command_id=?2", params![project, id]).map_err(storage)?;
    tx.execute("DELETE FROM collaboration_quarantine_metadata WHERE project_id=?1 AND command_id=?2", params![project, id]).map_err(storage)?;
    tx.commit().map_err(storage)
}

type Snapshot = BTreeMap<String, Vec<BTreeMap<String, Value>>>;
fn tables() -> Vec<&'static str> {
    super::schema::PRODUCT_SCHEMA_DDL.iter().filter_map(|ddl|ddl.strip_prefix("CREATE TABLE IF NOT EXISTS ").and_then(|s|s.split('(').next())).filter(|t|!matches!(*t, "workspaces"|"app_settings"|"view_state")).collect()
}
pub(crate) fn capture(tx: &Transaction, project: &str) -> Result<(), RepositoryError> {
    let mut snapshot = Snapshot::new();
    for table in tables() {
        let mut stmt = tx.prepare(&format!("SELECT * FROM {table} WHERE {}=?1", if table == "projects" {
            "id"
        } else {
            "project_id"
        })).map_err(storage)?;
        let names = stmt.column_names().iter().map(|s|s.to_string()).collect::<Vec<_>>();
        let data = stmt.query_map([project], |r| {
            let mut row = BTreeMap::new();
            for (i, name) in names.iter().enumerate() {
                let v = match r.get_ref(i)? {
                    rusqlite::types::ValueRef::Null => Value::Null, rusqlite::types::ValueRef::Integer(n) => Value::from(n), rusqlite::types::ValueRef::Real(n) => Value::from(n), rusqlite::types::ValueRef::Text(s) => Value::from(String::from_utf8_lossy(s).as_ref()), _ => return Err(rusqlite::Error::InvalidQuery)
                };
                row.insert(name.clone(), v);
            }
            Ok(row)
        }).map_err(storage)?.collect::<rusqlite::Result<Vec<_>>>().map_err(storage)?;
        snapshot.insert(table.to_string(), data);
    }
    if snapshot.get("projects").map_or(true, |r|r.len() != 1) {
        return Err(RepositoryError::ProjectNotFound)
    }
    tx.execute("INSERT INTO collaboration_confirmed_state VALUES(?1,?2) ON CONFLICT(project_id) DO UPDATE SET snapshot_json=excluded.snapshot_json", params![project, json(&snapshot)?]).map_err(storage)?;
    Ok(())
}
fn sql_value(v: &Value) -> Result<rusqlite::types::Value, RepositoryError> {
    Ok(match v {
        Value::Null => rusqlite::types::Value::Null, Value::String(s) => rusqlite::types::Value::Text(s.clone()), Value::Number(n) => if let Some(i) = n.as_i64() {
            rusqlite::types::Value::Integer(i)
        } else {
            rusqlite::types::Value::Real(n.as_f64().ok_or(RepositoryError::IntegrityFailed)?)
        }, _ => return Err(RepositoryError::IntegrityFailed)
    })
}
fn restore(tx: &Transaction, project: &str) -> Result<bool, RepositoryError> {
    let raw: Option<String >= tx.query_row("SELECT snapshot_json FROM collaboration_confirmed_state WHERE project_id=?1", [project], |r|r.get(0)).optional().map_err(storage)?;
    let Some(raw) = raw else {
        return Ok(false)
    };
    let snapshot: Snapshot = serde_json::from_str(&raw).map_err(|_|RepositoryError::IntegrityFailed)?;
    let tables = tables();
    if snapshot.get("projects").map_or(true, |r|r.len() != 1) {
        return Err(RepositoryError::IntegrityFailed)
    }
    if snapshot.len() != tables.len() || tables.iter().any(|t|!snapshot.contains_key(*t)) {
        return Err(RepositoryError::IntegrityFailed)
    }
    tx.execute_batch("PRAGMA defer_foreign_keys=ON").map_err(storage)?;
    for table in tables.iter().rev().filter(|t|**t != "projects") {
        tx.execute(&format!("DELETE FROM {table} WHERE project_id=?1"), [project]).map_err(storage)?;
    }
    for table in tables {
        let mut stmt = tx.prepare(&format!("PRAGMA table_info({table})")).map_err(storage)?;
        let columns = stmt.query_map([], |r|r.get::<_, String>(1)).map_err(storage)?.collect::<rusqlite::Result<HashSet<_>>>().map_err(storage)?;
        for row in &snapshot[table] {
            if row.len() != columns.len() || row.keys().any(|c|!columns.contains(c)) || row.get(if table == "projects" {
                "id"
            } else {
                "project_id"
            }) != Some(&Value::from(project)) {
                return Err(RepositoryError::IntegrityFailed)
            }
            let names = row.keys().filter(|c|table != "projects" || (c.as_str() != "id" && c.as_str() != "workspace_id")).cloned().collect::<Vec<_>>();
            let mut values = names.iter().map(|c|sql_value(&row[c])).collect::<Result<Vec<_>, _>>()?;
            let sql = if table == "projects" {
                values.push(rusqlite::types::Value::Text(project.into()));
                format!("UPDATE projects SET {} WHERE id=?", names.iter().map(|c|format!("{c}=?")).collect::<Vec<_>>().join(","))
            } else {
                format!("INSERT INTO {table}({}) VALUES({})", names.join(","), vec!["?";
                names.len()].join(","))
            };
            tx.execute(&sql, rusqlite::params_from_iter(values)).map_err(storage)?;
        }
    }
    Ok(true)
}
pub(crate) fn apply(tx: &mut Transaction, command: ProductCommand) -> Result<ProductCommandResult, RepositoryError> {
    handler::apply_in_transaction(tx, command, RevisionMode::Local, |_, _, _|Ok(()))
}
pub(crate) fn echo_matches(pending: &ProductCommand, echoed: &ProductCommand) -> Result<bool, RepositoryError> {
    let pending  =  serde_json::to_value(pending).map_err(|_| RepositoryError::InvalidRequest)?;
    let mut echoed  =  serde_json::to_value(echoed).map_err(|_| RepositoryError::InvalidRequest)?;
    // Only the authenticated server may enrich attribution omitted by the sender.
    if pending.get("actorId").is_none() {
        echoed.as_object_mut().ok_or(RepositoryError::InvalidRequest)?.remove("actorId");
    }
    Ok(pending == echoed)
}
pub(crate) fn at_revision(command: &ProductCommand, revision: i64) -> Result<ProductCommand, RepositoryError> {
    let mut v = serde_json::to_value(command).map_err(|_|RepositoryError::InvalidRequest)?;
    v["baseRevision"] = Value::from(revision);
    v["expectedRevision"] = Value::from(revision+1);
    serde_json::from_value(v).map_err(|_|RepositoryError::InvalidRequest)
}
fn revision(tx: &Transaction, project: &str) -> Result<i64, RepositoryError> {
    tx.query_row("SELECT revision FROM projects WHERE id=?1", [project], |r|r.get(0)).map_err(storage)
}
fn cleanup(tx: &Transaction, project: &str) -> Result<(), RepositoryError> {
    if active(tx, project)?.is_empty() {
        tx.execute("DELETE FROM collaboration_confirmed_state WHERE project_id=?1", [project]).map_err(storage)?;
    }
    Ok(())
}
pub fn commit(conn: &mut Connection, project: &str, command: ProductCommand, entry: OutboxEntry) -> Result<ProductCommandResult, RepositoryError> {
    valid_entry(project, &entry)?;
    if command != entry.command {
        return Err(RepositoryError::InvalidRequest)
    }
    let mut tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(storage)?;
    let prior: Option<(String, String) >= tx.query_row("SELECT command_json,result_json FROM collaboration_attempt_receipt WHERE project_id=?1 AND command_id=?2 AND commit_attempt_id=?3", params![project, entry.command_id, entry.commit_attempt_id], |r|Ok((r.get(0)?, r.get(1)?))).optional().map_err(storage)?;
    if let Some((raw, result)) = prior {
        if serde_json::from_str::<ProductCommand>(&raw).map_err(|_|RepositoryError::IntegrityFailed)? != command {
            return Err(RepositoryError::CommandIdentityConflict)
        }
        return serde_json::from_str(&result).map_err(|_|RepositoryError::CommandIdentityConflict)
    }
    let latest: Option<i64 >= tx.query_row("SELECT MAX(commit_attempt_id) FROM collaboration_attempt_receipt WHERE project_id=?1 AND command_id=?2", params![project, entry.command_id], |r|r.get(0)).map_err(storage)?;
    if latest.is_some() {
        return Err(RepositoryError::CommandIdentityConflict)
    }
    if active(&tx, project)?.is_empty() {
        capture(&tx, project)?;
    }
    let result = apply(&mut tx, command)?;
    record(&tx, project, &entry, &serde_json::to_value(&result).map_err(|_|RepositoryError::Internal)?)?;
    if matches!(result, ProductCommandResult::ProductCommandApplied(_)) {
        queue(&tx, project, &entry)?;
    }
    cleanup(&tx, project)?;
    tx.commit().map_err(storage)?;
    Ok(result)
}
/// A composite gesture on a shared project (Story 27.2): apply every member
/// and queue every outbox entry (one group id) in ONE transaction. A refused
/// member commits nothing and is returned alone, like `apply_batch`.
pub fn commit_group(conn: &mut Connection, project: &str, entries: Vec<OutboxEntry>) -> Result<Vec<ProductCommandResult>, RepositoryError> {
    if entries.is_empty() { return Ok(Vec::new()); }
    let group = entries[0].group_id.clone().ok_or(RepositoryError::InvalidRequest)?;
    let mut ids = HashSet::new();
    for (index, entry) in entries.iter().enumerate() {
        valid_entry(project, entry)?;
        if entry.group_id.as_deref() != Some(group.as_str()) || entry.group_index != Some(index as i64)
            || entry.commit_attempt_id != 1 || !ids.insert(entry.command_id.clone()) {
            return Err(RepositoryError::InvalidRequest);
        }
    }
    let mut tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(storage)?;
    for entry in &entries {
        let seen: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM collaboration_attempt_receipt WHERE project_id=?1 AND command_id=?2)", params![project, entry.command_id], |r| r.get(0)).map_err(storage)?;
        if seen { return Err(RepositoryError::CommandIdentityConflict); }
    }
    if active(&tx, project)?.is_empty() { capture(&tx, project)?; }
    let mut results = Vec::with_capacity(entries.len());
    for entry in &entries {
        let result = apply(&mut tx, entry.command.clone())?;
        if !matches!(result, ProductCommandResult::ProductCommandApplied(_)) {
            // Dropping the transaction commits nothing from the gesture.
            return Ok(vec![result]);
        }
        record(&tx, project, entry, &serde_json::to_value(&result).map_err(|_| RepositoryError::Internal)?)?;
        queue(&tx, project, entry)?;
        results.push(result);
    }
    tx.commit().map_err(storage)?;
    Ok(results)
}

fn group_refusal(command: &ProductCommand) -> ProductCommandResult {
    ProductCommandResult::ProductCommandRejected(crate::protocol::commands::ProductCommandRejected {
        result_type: "ProductCommandRejected".to_string(),
        protocol_version: crate::protocol::PROTOCOL_VERSION.to_string(),
        command_id: command.command_id().to_string(),
        code: "ATOMIC_GROUP_REJECTED".to_string(),
        expected_revision: None,
        project_id: Some(command.project_id().to_string()),
        node_id: None,
        person_id: None,
        conflicting_feature_ids: None,
        feature_id: None,
        column: None,
    })
}

/// Re-apply pending work at the current revision, one unit at a time: a
/// single edit, or a composite gesture's consecutive members as ONE savepoint.
/// A refused member rolls its whole gesture back and retains every member as
/// rejected work (the refused one with its own code), so a gesture is never
/// left half re-applied. `keep` re-queues or updates a surviving entry.
pub(crate) fn replay_atomically<F>(tx: &mut Transaction, project: &str, entries: Vec<OutboxEntry>, mut keep: F) -> Result<(), RepositoryError>
where F: FnMut(&Transaction, &OutboxEntry) -> Result<(), RepositoryError> {
    let mut start = 0;
    while start < entries.len() {
        let mut end = start + 1;
        if let Some(group) = &entries[start].group_id {
            while end < entries.len() && entries[end].group_id.as_ref() == Some(group) { end += 1; }
        }
        let unit = &entries[start..end];
        start = end;
        tx.execute_batch("SAVEPOINT pm_replay_unit").map_err(storage)?;
        let mut results = Vec::with_capacity(unit.len());
        let mut refused: Option<usize> = None;
        for (index, entry) in unit.iter().enumerate() {
            let local = at_revision(&entry.command, revision(tx, project)?)?;
            let result = match apply(tx, local) {
                Ok(result) => result,
                Err(error) => { let _ = tx.execute_batch("ROLLBACK TO pm_replay_unit; RELEASE pm_replay_unit"); return Err(error); }
            };
            let applied = matches!(result, ProductCommandResult::ProductCommandApplied(_));
            results.push(result);
            if !applied { refused = Some(index); break; }
        }
        if let Some(refused) = refused {
            tx.execute_batch("ROLLBACK TO pm_replay_unit; RELEASE pm_replay_unit").map_err(storage)?;
            for (index, entry) in unit.iter().enumerate() {
                let result = if index == refused { results[index].clone() } else { group_refusal(&entry.command) };
                record(tx, project, entry, &serde_json::to_value(&result).map_err(|_| RepositoryError::Internal)?)?;
                let code = match &result { ProductCommandResult::ProductCommandRejected(r) => r.code.clone(), _ => "ATOMIC_GROUP_REJECTED".to_string() };
                reject(tx, project, entry, &code)?;
            }
            continue;
        }
        for (index, entry) in unit.iter().enumerate() {
            record(tx, project, entry, &serde_json::to_value(&results[index]).map_err(|_| RepositoryError::Internal)?)?;
            keep(tx, entry)?;
        }
        tx.execute_batch("RELEASE pm_replay_unit").map_err(storage)?;
    }
    Ok(())
}

pub(crate) fn reject(tx: &Transaction, project: &str, entry: &OutboxEntry, reason: &str) -> Result<(), RepositoryError> {
    tx.execute("INSERT INTO collaboration_rejections VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(project_id,command_id) DO NOTHING", params![project, entry.command_id, json(&entry.command)?, entry.commit_attempt_id, entry.queued_at_iso, reason]).map_err(storage)?;
    tx.execute("DELETE FROM collaboration_outbox WHERE project_id=?1 AND command_id=?2", params![project, entry.command_id]).map_err(storage)?;
    Ok(())
}
pub fn rebase(conn: &mut Connection, project: &str, remote: RemoteCommand, survivors: Vec<OutboxEntry>, rejected: Vec<Rejection>) -> Result<RebaseOutcome, RepositoryError> {
    handler::validate_command(&remote.command)?;
    crate::protocol::recovery::validate_history_entry(&remote.history_entry, project)?;
    if remote.history_entry.server_revision != remote.server_revision || remote.history_entry.command.typed != remote.command {
        return Err(RepositoryError::InvalidRequest);
    }
    if remote.command.project_id() != project || remote.server_revision<1 || remote.server_revision>9_007_199_254_740_991 {
        return Err(RepositoryError::InvalidRequest)
    }
    for entry in &survivors {
        valid_entry(project, entry)?;
    }
    let mut tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(storage)?;
    let pending = active(&tx, project)?;
    let (epoch, required): (Option<i64>, bool) = tx.query_row(
        "SELECT stream_epoch, recovery_required FROM collaboration_cursor WHERE project_id = ?1",
        [project], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(storage)?.unwrap_or((None, false));
    if required || epoch != Some(remote.stream_epoch) || remote.stream_epoch < 1 { return Err(RepositoryError::ResyncRequired); }
    let cursor: i64 = tx.query_row("SELECT cursor FROM collaboration_cursor WHERE project_id=?1", [project], |r|r.get(0)).optional().map_err(storage)?.unwrap_or(0);
    if remote.server_revision != cursor+1 || (remote.own_echo && !pending.iter().any(|(id, _, _, _)|id == remote.command.command_id())) {
        return Err(RepositoryError::InvalidRequest)
    }
    let mut handled = HashSet::new();
    for id in survivors.iter().map(|e|&e.command_id).chain(rejected.iter().map(|r|&r.command_id)) {
        if !handled.insert(id.as_str()) {
            return Err(RepositoryError::InvalidRequest)
        }
    }
    if remote.own_echo && !handled.insert(remote.command.command_id()) {
        return Err(RepositoryError::InvalidRequest)
    }
    if pending.iter().any(|(id, _, _, _)|!handled.contains(id.as_str())) {
        return Err(RepositoryError::InvalidRequest)
    }
    for survivor in &survivors {
        let Some((_, raw, attempt, _)) = pending.iter().find(|(id, _, _, _)|id == &survivor.command_id)else {
            return Err(RepositoryError::InvalidRequest)
        };
        let original: ProductCommand = serde_json::from_str(raw).map_err(|_|RepositoryError::IntegrityFailed)?;
        if survivor.commit_attempt_id != attempt+1 || original != survivor.command {
            return Err(RepositoryError::CommandIdentityConflict)
        }
    }
    if remote.own_echo {
        let (_, raw, _, _) = pending.iter().find(|(id, _, _, _)|id == remote.command.command_id()).ok_or(RepositoryError::InvalidRequest)?;
        let original: crate::protocol::recovery::ImmutableCommand = serde_json::from_str(raw).map_err(|_| RepositoryError::IntegrityFailed)?;
        if !crate::protocol::recovery::immutable_wire_identity_matches(
            &original, &remote.history_entry.command, &remote.history_entry.wire_identity_availability, remote.history_entry.actor_id.as_deref(),
        )? { return Err(RepositoryError::CommandIdentityConflict); }
    }
    for rejection in &rejected {
        if rejection.reason.is_empty() || rejection.reason.len()>256 || !pending.iter().any(|(id, _, _, _)|id == &rejection.command_id) {
            return Err(RepositoryError::InvalidRequest)
        }
    }
    let restored = restore(&tx, project)?;
    if !restored && !pending.is_empty() {
        return Err(RepositoryError::IntegrityFailed)
    }
    for r in rejected {
        if let Some((id, raw, attempt, date)) = pending.iter().find(|(id, _, _, _)|id == &r.command_id) {
            reject(&tx, project, &OutboxEntry {
                command_id: id.clone(), command: serde_json::from_str(raw).map_err(|_|RepositoryError::IntegrityFailed)?, commit_attempt_id: *attempt, queued_at_iso: date.clone(), group_id: None, group_index: None,
            }, &r.reason)?;
        }
    }
    if remote.own_echo {
        tx.execute("DELETE FROM collaboration_outbox WHERE project_id=?1 AND command_id=?2", params![project, remote.command.command_id()]).map_err(storage)?;
    }
    let result = if !remote.own_echo || restored {
        let command = at_revision(&remote.command, revision(&tx, project)?)?;
        let mut local_wire = serde_json::to_value(command).map_err(|_| RepositoryError::Internal)?;
        if let Some(actor) = &remote.history_entry.actor_id { local_wire["actorId"] = Value::String(actor.clone()); }
        let command = serde_json::from_value(local_wire).map_err(|_| RepositoryError::InvalidRequest)?;
        let result = apply(&mut tx, command)?;
        if !matches!(result, ProductCommandResult::ProductCommandApplied(_)) {
            return Err(RepositoryError::InvalidRequest)
        }
        Some(result)
    } else {
        None
    };
    tx.execute(
        "INSERT INTO collaboration_authoritative_history(project_id, stream_epoch, server_revision, entry_json) VALUES(?1, ?2, ?3, ?4)",
        params![project, remote.stream_epoch, remote.server_revision, json(&remote.history_entry)?],
    ).map_err(storage)?;
    capture(&tx, project)?;
    replay_atomically(&mut tx, project, survivors, |tx, entry| queue(tx, project, entry))?;
    cleanup(&tx, project)?;
    tx.execute("INSERT INTO collaboration_cursor(project_id,cursor) VALUES(?1,?2) ON CONFLICT(project_id) DO UPDATE SET cursor=excluded.cursor", params![project, remote.server_revision]).map_err(storage)?;
    let revision = revision(&tx, project)?;
    tx.commit().map_err(storage)?;
    Ok(RebaseOutcome {
        result: if remote.own_echo {
            None
        } else {
            result
        }, revision
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    const P: &str = "019ffe00-0000-7000-8000-000000000001";
    const N: &str = "019ffe00-0000-7000-8000-000000000002";
    const OTHER: &str = "019ffe00-0000-7000-8000-000000000003";
    fn id(n: u32) -> String {
        format!("019ffe00-0000-7000-8000-{n:012x}")
    }
    fn command(kind: &str, n: u32, base: i64) -> ProductCommand {
        serde_json::from_value(serde_json::json!( {
            "type": kind, "protocolVersion": "1.0.0", "commandId": id(n), "projectId": P, "baseRevision": base, "expectedRevision": base+1, "nodeId": N, "title": format!("Text {n}"), "name": "Synthetic", "bodyText": "Complete synthetic recoverable content", "completed": true
        })).unwrap()
    }
    fn setup(conn: &mut Connection) {
        conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        handler::initialize_schema(conn).unwrap();
        super::super::workspace::ensure_default_workspace(conn).unwrap();
        handler::apply(conn, command("CreateProject", 10, 0)).unwrap();
        conn.execute("INSERT INTO projects(id,name,revision) VALUES(?1,'Other',7)", [OTHER]).unwrap();
        conn.execute("INSERT INTO nodes(id,project_id,title,position) VALUES(?1,?2,'Confirmed',1000)", params![N, P]).unwrap();
        conn.execute("INSERT INTO collaboration_cursor(project_id,cursor,stream_epoch) VALUES(?1,1,1)", [P]).unwrap();
    }
    fn memory() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        setup(&mut conn);
        conn
    }
    fn entry(command: ProductCommand, attempt: i64) -> OutboxEntry {
        OutboxEntry { group_id: None, group_index: None,
            command_id: command.command_id().to_string(), command, commit_attempt_id: attempt, queued_at_iso: "2026-10-05T00:00:00Z".into()
        }
    }
    fn remote(command: ProductCommand, own_echo: bool, revision: i64) -> RemoteCommand {
        use crate::protocol::recovery::{ImmutableCommand, ConfirmedHistoryEntry, RecoveryFootprints, payload_digest};
        let immutable = ImmutableCommand::from_wire(serde_json::to_value(&command).unwrap()).unwrap();
        let result = serde_json::from_value(serde_json::json!({
            "type":"ProductCommandApplied", "protocolVersion":"1.0.0", "commandId":command.command_id(),
            "projectId":command.project_id(), "baseRevision":revision-1, "targetRevision":revision,
            "outcome":"VfsCommitAccepted", "disposition":"NewCommit"
        })).unwrap();
        let history_entry = ConfirmedHistoryEntry {
            payload_digest:payload_digest(&immutable).unwrap(), wire_identity_availability:"original".into(), actor_id:command.actor_id().map(str::to_owned),
            protocol_version:"1.0.0".into(), server_revision:revision, receipt_revision_availability:"authoritative".into(),
            recorded_at_iso:None,label:None,
            command_footprint:RecoveryFootprints {availability:"unavailable".into(),known_targets:vec![],reason:Some("SYNTHETIC_LEGACY".into())},
            effect_footprint:RecoveryFootprints {availability:"unavailable".into(),known_targets:vec![],reason:Some("SYNTHETIC_LEGACY".into())},
            deletion_metadata:"not-applicable".into(),command:immutable,result,
        };
        RemoteCommand { command, own_echo, server_revision: revision, stream_epoch:1, history_entry }
    }
    fn title(conn: &Connection) -> String {
        conn.query_row("SELECT title FROM nodes WHERE id=?1", [N], |r|r.get(0)).unwrap()
    }
    fn dump(conn: &Connection) -> String {
        let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").unwrap();
        let names = stmt.query_map([], |r|r.get::<_, String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
        let mut out = String::new();
        for table in names {
            let mut stmt = conn.prepare(&format!("SELECT * FROM {table} ORDER BY rowid")).unwrap();
            let n = stmt.column_count();
            let data = stmt.query_map([], |r|(0..n).map(|i|r.get::<_, rusqlite::types::Value>(i)).collect::<rusqlite::Result<Vec<_>>>()).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
            out.push_str(&format!("{table}:{data:?}\n"));
        }
        out
    }
    const M: &str = "019ffe00-0000-7000-8000-000000000004";
    fn title_on(node: &str, n: u32, base: i64) -> ProductCommand {
        serde_json::from_value(serde_json::json!({
            "type": "SetNodeTitle", "protocolVersion": "1.0.0", "commandId": id(n), "projectId": P,
            "baseRevision": base, "expectedRevision": base + 1, "nodeId": node, "title": format!("Grouped {n}")
        })).unwrap()
    }
    fn member(command: ProductCommand, group: &str, index: i64) -> OutboxEntry {
        OutboxEntry { group_id: Some(group.into()), group_index: Some(index), ..entry(command, 1) }
    }
    fn titles(conn: &Connection) -> Vec<(String, String)> {
        let mut stmt = conn.prepare("SELECT id,title FROM nodes WHERE project_id=?1 ORDER BY id").unwrap();
        stmt.query_map([P], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
    }

    #[test]
    fn a_group_commits_every_member_with_tagged_outbox_rows_or_nothing() {
        let mut conn = memory();
        conn.execute("INSERT INTO nodes(id,project_id,title,position) VALUES(?1,?2,'Second',2000)", params![M, P]).unwrap();
        let group = id(11);
        let results = commit_group(&mut conn, P, vec![member(title_on(N, 11, 1), &group, 0), member(title_on(M, 12, 2), &group, 1)]).unwrap();
        assert_eq!(results.len(), 2);
        let state = read(&mut conn, P).unwrap();
        assert_eq!(state.entries.iter().map(|e| (e.group_id.clone(), e.group_index)).collect::<Vec<_>>(),
            vec![(Some(group.clone()), Some(0)), (Some(group.clone()), Some(1))]);
        // A refused member leaves no trace of the gesture.
        let before = titles(&conn);
        let refused_group = id(13);
        let refused = commit_group(&mut conn, P, vec![member(title_on(N, 13, 3), &refused_group, 0), member(title_on(&id(0x99), 14, 4), &refused_group, 1)]).unwrap();
        assert_eq!(refused.len(), 1);
        assert!(matches!(&refused[0], ProductCommandResult::ProductCommandRejected(r) if r.command_id == id(14)));
        assert_eq!(titles(&conn), before);
        assert_eq!(read(&mut conn, P).unwrap().entries.len(), 2);
        // Malformed membership is refused before any write.
        assert!(matches!(commit_group(&mut conn, P, vec![member(title_on(N, 15, 3), &refused_group, 1)]), Err(RepositoryError::InvalidRequest)));
    }

    #[test]
    fn a_rebase_refuses_or_re_applies_a_whole_group() {
        let mut conn = memory();
        conn.execute("INSERT INTO nodes(id,project_id,title,position) VALUES(?1,?2,'Second',2000)", params![M, P]).unwrap();
        let group = id(11);
        let members = vec![member(title_on(M, 11, 1), &group, 0), member(title_on(N, 12, 2), &group, 1)];
        commit_group(&mut conn, P, members.clone()).unwrap();
        // A teammate deleted N first: member two cannot re-apply, so member one must not either.
        let delete: ProductCommand = serde_json::from_value(serde_json::json!({
            "type": "DeleteSubtree", "protocolVersion": "1.0.0", "commandId": id(30), "projectId": P,
            "baseRevision": 1, "expectedRevision": 2, "nodeId": N
        })).unwrap();
        let survivors = members.iter().map(|m| OutboxEntry { commit_attempt_id: 2, ..m.clone() }).collect();
        rebase(&mut conn, P, remote(delete, false, 2), survivors, vec![]).unwrap();
        let state = read(&mut conn, P).unwrap();
        assert!(state.entries.is_empty());
        let mut reasons = state.rejected.iter().map(|r| (r.entry.command_id.clone(), r.reason.clone())).collect::<Vec<_>>();
        reasons.sort();
        assert_eq!(reasons, vec![(id(11), "ATOMIC_GROUP_REJECTED".into()), (id(12), "NODE_NOT_FOUND".into())]);
        assert_eq!(titles(&conn), vec![(M.to_string(), "Second".to_string())]);
    }

    #[test]
    fn acknowledged_queue_and_inverse_survive_real_reopen() {
        let path = std::env::temp_dir().join(format!("pmapp-sync-{}-{}.sqlite", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let command = command("SetNodeBodyText", 11, 1);
        {
            let mut conn = Connection::open(&path).unwrap();
            setup(&mut conn);
            let result = commit(&mut conn, P, command.clone(), entry(command.clone(), 1)).unwrap();
            assert!(matches!(result, ProductCommandResult::ProductCommandApplied(_)));
        }
        {
            let mut conn = Connection::open(&path).unwrap();
            let state = read(&mut conn, P).unwrap();
            assert_eq!(state.entries[0].command, command);
            assert_eq!(state.entries[0].commit_attempt_id, 1);
            let receipt: String = conn.query_row("SELECT result_json FROM product_command_receipt WHERE command_id=?1", [command.command_id()], |r|r.get(0)).unwrap();
            assert!(receipt.contains("changeSet"));
        }
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn every_local_journal_failure_rolls_back_graph_receipts_and_queue() {
        for table in ["collaboration_confirmed_state", "product_command_receipt", "collaboration_attempt_receipt", "collaboration_outbox"] {
            let mut conn = memory();
            let before = dump(&conn);
            conn.execute_batch(&format!("CREATE TRIGGER fail BEFORE INSERT ON {table} BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")).unwrap();
            let c = command("SetNodeTitle", 11, 1);
            assert!(commit(&mut conn, P, c.clone(), entry(c, 1)).is_err(), "{table}");
            assert_eq!(dump(&conn), before, "{table}");
        }
    }
    #[test]
    fn survivor_replay_preserves_wire_identity_and_old_attempt_does_not_requeue() {
        let mut conn = memory();
        let c = command("SetNodeTitle", 11, 1);
        let original = entry(c.clone(), 1);
        let first = commit(&mut conn, P, c.clone(), original.clone()).unwrap();
        rebase(&mut conn, P, remote(command("SetNodeTitle", 12, 1), false, 2), vec![entry(c.clone(), 2)], vec![]).unwrap();
        let state = read(&mut conn, P).unwrap();
        assert_eq!(state.entries[0].command, c);
        assert_eq!(state.entries[0].commit_attempt_id, 2);
        assert_eq!(title(&conn), "Text 11");
        let before = dump(&conn);
        assert_eq!(json(&commit(&mut conn, P, c.clone(), original).unwrap()).unwrap(), json(&first).unwrap());
        assert_eq!(dump(&conn), before);
        let mut changed = entry(c.clone(), 2);
        changed.command = command("SetNodeTitle", 11, 3);
        assert!(commit(&mut conn, P, changed.command.clone(), changed).is_err());
        assert_eq!(dump(&conn), before);
        rebase(&mut conn, P, remote(c, true, 3), vec![], vec![]).unwrap();
        assert!(read(&mut conn, P).unwrap().entries.is_empty());
        assert_eq!(title(&conn), "Text 11");
    }
    #[test]
    fn echo_rolls_back_toggle_before_replay_exactly_once() {
        let mut conn = memory();
        let c = command("ToggleNodeCompleted", 11, 1);
        commit(&mut conn, P, c.clone(), entry(c.clone(), 1)).unwrap();
        rebase(&mut conn, P, remote(c, true, 2), vec![], vec![]).unwrap();
        let completed: bool = conn.query_row("SELECT completed FROM nodes WHERE id=?1", [N], |r|r.get(0)).unwrap();
        assert!(completed);
        assert!(read(&mut conn, P).unwrap().entries.is_empty());
    }
    #[test]
    fn rebase_failure_at_each_write_boundary_restores_complete_optimistic_state() {
        for table in ["product_command_receipt", "collaboration_confirmed_state", "collaboration_attempt_receipt", "collaboration_outbox", "collaboration_cursor", "collaboration_rejections"] {
            let mut conn = memory();
            let c = command("SetNodeTitle", 11, 1);
            commit(&mut conn, P, c.clone(), entry(c.clone(), 1)).unwrap();
            let before = dump(&conn);
            conn.execute_batch(&format!("CREATE TRIGGER fail BEFORE INSERT ON {table} BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")).unwrap();
            let (survivors, rejected) = if table == "collaboration_rejections" {
                (vec![], vec![Rejection {
                    command_id: c.command_id().into(), reason: "TargetDeleted".into()
                }
                ])
            } else {
                (vec![entry(c, 2)], vec![])
            };
            assert!(rebase(&mut conn, P, remote(command("SetNodeTitle", 12, 1), false, 2), survivors, rejected).is_err(), "{table}");
            assert_eq!(dump(&conn), before, "{table}");
        }
    }
    #[test]
    fn rejection_retains_complete_content_and_original_typed_attempt() {
        let mut conn = memory();
        let c = command("SetNodeBodyText", 11, 1);
        let original = entry(c.clone(), 1);
        let result = commit(&mut conn, P, c.clone(), original.clone()).unwrap();
        rebase(&mut conn, P, remote(command("DeleteSubtree", 12, 1), false, 2), vec![], vec![Rejection {
            command_id: c.command_id().into(), reason: "TargetDeleted".into()
        }
        ]).unwrap();
        let state = read(&mut conn, P).unwrap();
        assert!(state.entries.is_empty());
        assert_eq!(state.rejected[0].entry.command, c);
        assert_eq!(state.rejected[0].reason, "TargetDeleted");
        let before = dump(&conn);
        assert_eq!(json(&commit(&mut conn, P, c.clone(), original).unwrap()).unwrap(), json(&result).unwrap());
        assert_eq!(dump(&conn), before);
        discard(&mut conn, P, c.command_id()).unwrap();
        assert!(read(&mut conn, P).unwrap().rejected.is_empty());
    }
    #[test]
    fn optimistic_subtree_delete_restores_confirmed_parent_before_remote_title() {
        let mut conn = memory();
        let child = id(20);
        conn.execute("INSERT INTO nodes(id,project_id,parent_id,title,position) VALUES(?1,?2,?3,'Child',1000)", params![child, P, N]).unwrap();
        let c = command("DeleteSubtree", 11, 1);
        commit(&mut conn, P, c.clone(), entry(c.clone(), 1)).unwrap();
        rebase(&mut conn, P, remote(command("SetNodeTitle", 12, 1), false, 2), vec![], vec![Rejection {
            command_id: c.command_id().into(), reason: "Rejected".into()
        }
        ]).unwrap();
        assert_eq!(title(&conn), "Text 12");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM nodes WHERE project_id=?1", [P], |r|r.get::<_, i64>(0)).unwrap(), 2);
    }
    #[test]
    fn domain_rejected_survivor_retains_typed_rejection_and_body() {
        let mut conn = memory();
        let c = command("SetNodeBodyText", 11, 1);
        commit(&mut conn, P, c.clone(), entry(c.clone(), 1)).unwrap();
        rebase(&mut conn, P, remote(command("DeleteSubtree", 12, 1), false, 2), vec![entry(c.clone(), 2)], vec![]).unwrap();
        let state = read(&mut conn, P).unwrap();
        assert_eq!(state.rejected[0].entry.command, c);
        let cached = commit(&mut conn, P, c.clone(), entry(c, 2)).unwrap();
        assert!(matches!(cached, ProductCommandResult::ProductCommandRejected(_)));
        assert!(read(&mut conn, P).unwrap().entries.is_empty());
    }
    #[test]
    fn project_local_view_and_workspace_are_isolated() {
        let mut conn = memory();
        conn.execute("INSERT INTO view_state(project_id,view_id,scroll_top,pan_x) VALUES(?1,'outline',17,29)", [P]).unwrap();
        let c = command("SetNodeTitle", 11, 1);
        commit(&mut conn, P, c.clone(), entry(c.clone(), 1)).unwrap();
        let workspace: String = conn.query_row("SELECT workspace_id FROM projects WHERE id=?1", [P], |r|r.get(0)).unwrap();
        rebase(&mut conn, P, remote(command("SetNodeTitle", 12, 1), false, 2), vec![entry(c, 2)], vec![]).unwrap();
        assert_eq!(conn.query_row("SELECT revision FROM projects WHERE id=?1", [OTHER], |r|r.get::<_, i64>(0)).unwrap(), 7);
        assert_eq!(conn.query_row("SELECT scroll_top FROM view_state WHERE project_id=?1", [P], |r|r.get::<_, f64>(0)).unwrap(), 17.0);
        assert_eq!(conn.query_row("SELECT workspace_id FROM projects WHERE id=?1", [P], |r|r.get::<_, String>(0)).unwrap(), workspace);
    }
    #[test]
    fn malformed_queue_rows_are_quarantined_and_stay_visible() {
        for invalid in ["json", "id", "project", "attempt", "date"] {
            let mut conn = memory();
            let c = command("SetNodeTitle", 11, 1);
            let raw = if invalid == "json" {
                "{".to_string()
            } else {
                json(&c).unwrap()
            };
            let pid = if invalid == "project" {
                OTHER
            } else {
                P
            };
            let row_id = if invalid == "id" {
                id(12)
            } else {
                id(11)
            };
            conn.execute("INSERT INTO collaboration_outbox(project_id,command_id,command_json,commit_attempt_id,queued_at_iso) VALUES(?1,?2,?3,?4,?5)", params![pid, row_id, raw, if invalid == "attempt" {
                0
            } else {
                1
            }, if invalid == "date" {
                "2026-02-30T00:00:00Z"
            } else {
                "2026-10-05T00:00:00Z"
            }
            ]).unwrap();
            let state = read(&mut conn, pid).unwrap();
            assert!(state.entries.is_empty(), "{invalid}");
            assert_eq!(state.corrupt, vec![row_id.clone()]);
            assert_eq!(read(&mut conn, pid).unwrap().corrupt, vec![row_id]);
        }
        assert!(valid_date("2026-10-05T12:00:00-04:00"));
        assert!(!valid_date("2026-02-30T00:00:00Z"));
    }
    #[test]
    fn invalid_bindings_gaps_and_echo_payloads_are_refused_without_mutation() {
        let mut conn = memory();
        let c = command("SetNodeTitle", 11, 1);
        commit(&mut conn, P, c.clone(), entry(c.clone(), 1)).unwrap();
        let before = dump(&conn);
        for revision in [1, 3] {
            assert!(rebase(&mut conn, P, remote(command("SetNodeTitle", 12, 1), false, revision), vec![entry(c.clone(), 2)], vec![]).is_err());
            assert_eq!(dump(&conn), before);
        }
        assert!(rebase(&mut conn, P, remote(command("SetNodeTitle", 12, 1), true, 2), vec![entry(c.clone(), 2)], vec![]).is_err());
        assert!(rebase(&mut conn, P, remote(command("SetNodeTitle", 11, 2), true, 2), vec![], vec![]).is_err());
        assert!(rebase(&mut conn, P, remote(command("SetNodeTitle", 12, 1), false, 2), vec![entry(c.clone(), 2)], vec![Rejection {
            command_id: id(50), reason: "Unknown".into()
        }
        ]).is_err());
        assert!(commit(&mut conn, OTHER, c.clone(), entry(c, 1)).is_err());
        assert_eq!(dump(&conn), before);
    }
    #[test]
    fn direct_higher_attempt_cannot_reapply_or_change_stable_command_identity() {
        let mut conn  =  memory();
        let command  =  command("SetNodeTitle", 11, 1);
        commit(&mut conn, P, command.clone(), entry(command.clone(), 1)).unwrap();
        let before  =  dump(&conn);
        assert!(commit(&mut conn, P, command.clone(), entry(command.clone(), 2)).is_err());
        let changed  =  at_revision(&command, 2).unwrap();
        assert!(commit(&mut conn, P, changed.clone(), entry(changed, 3)).is_err());
        assert_eq!(dump(&conn), before);
    }
    #[test]
    fn forget_returns_a_project_to_local_while_keeping_rejected_work() {
        let mut conn = memory();
        let pending = command("SetNodeTitle", 11, 1);
        commit(&mut conn, P, pending.clone(), entry(pending, 1)).unwrap();
        conn.execute("INSERT INTO collaboration_rejections(project_id,command_id,command_json,commit_attempt_id,queued_at_iso,reason) VALUES(?1,'r1','{}',1,'2026-10-07T00:00:00Z','X')", [P]).unwrap();
        forget(&mut conn, P).unwrap();
        for table in ["collaboration_cursor", "collaboration_outbox", "collaboration_confirmed_state", "collaboration_attempt_receipt"] {
            let n: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {table} WHERE project_id=?1"), [P], |r| r.get(0)).unwrap();
            assert_eq!(n, 0, "{table}");
        }
        let kept: i64 = conn.query_row("SELECT COUNT(*) FROM collaboration_rejections WHERE project_id=?1", [P], |r| r.get(0)).unwrap();
        assert_eq!(kept, 1);
        // Local composites work again: apply_batch no longer sees a synced project.
        let batch = handler::apply_batch(&mut conn, vec![command("SetNodeTitle", 12, 2)]).unwrap();
        assert!(matches!(batch[0], ProductCommandResult::ProductCommandApplied(_)));
    }

    #[test]
    fn history_reads_current_epoch_newest_first_and_pages() {
        let conn = memory();
        for (epoch, revision) in [(1, 1), (1, 2), (1, 3), (2, 1)] {
            conn.execute("INSERT INTO collaboration_authoritative_history(project_id,stream_epoch,server_revision,entry_json) VALUES(?1,?2,?3,?4)",
                params![P, epoch, revision, format!("{{\"serverRevision\":{revision}}}")]).unwrap();
        }
        conn.execute("INSERT INTO collaboration_authoritative_history(project_id,stream_epoch,server_revision,entry_json) VALUES(?1,1,4,'not json')", [P]).unwrap();
        let page = read_history(&conn, P, None, 2).unwrap();
        // The malformed newest row is skipped; epoch 2 never mixes in.
        assert_eq!(page.iter().map(|r| r.server_revision).collect::<Vec<_>>(), vec![3]);
        let all = read_history(&conn, P, None, 200).unwrap();
        assert_eq!(all.iter().map(|r| r.server_revision).collect::<Vec<_>>(), vec![3, 2, 1]);
        assert_eq!(read_history(&conn, P, Some(3), 200).unwrap().iter().map(|r| r.server_revision).collect::<Vec<_>>(), vec![2, 1]);
        assert!(read_history(&conn, P, None, 0).is_err() && read_history(&conn, P, None, 201).is_err());
        assert!(read_history(&conn, "019ff000-0000-7000-8000-00000000ffff", None, 10).unwrap().is_empty());
    }

    #[test]
    fn own_echo_accepts_only_server_attribution_enrichment() {
        let mut conn  =  memory();
        let pending  =  command("SetNodeTitle", 11, 1);
        commit(&mut conn, P, pending.clone(), entry(pending.clone(), 1)).unwrap();
        let mut value  =  serde_json::to_value(&pending).unwrap();
        value["actorId"]  =  Value::from(id(99));
        let echoed: ProductCommand  =  serde_json::from_value(value).unwrap();
        // Server-side actor enrichment of the wire body is only tolerated for
        // legacy admitted history; original history binds exact bytes.
        let legacy = |command, revision| { let mut r = remote(command, true, revision); r.history_entry.wire_identity_availability = "legacy-admitted-wire".into(); r };
        let mut exact = remote(echoed.clone(), true, 2);
        assert!(rebase(&mut conn, P, { exact.history_entry.wire_identity_availability = "original".into(); exact }, vec![], vec![]).is_err());
        rebase(&mut conn, P, legacy(echoed, 2), vec![], vec![]).unwrap();
        assert!(read(&mut conn, P).unwrap().entries.is_empty());
        let mut attributed  =  serde_json::to_value(command("SetNodeTitle", 12, 2)).unwrap();
        attributed["actorId"]  =  Value::from(id(98));
        let pending: ProductCommand  =  serde_json::from_value(attributed.clone()).unwrap();
        commit(&mut conn, P, pending.clone(), entry(pending, 1)).unwrap();
        attributed["actorId"]  =  Value::from(id(99));
        let mismatched: ProductCommand  =  serde_json::from_value(attributed).unwrap();
        let before  =  dump(&conn);
        assert!(rebase(&mut conn, P, legacy(mismatched, 3), vec![], vec![]).is_err());
        assert_eq!(dump(&conn), before);
    }
    #[test]
    fn malformed_sqlite_metadata_and_rejections_do_not_block_valid_work() {
        let mut conn  =  memory();
        let valid  =  command("SetNodeTitle", 11, 1);
        commit(&mut conn, P, valid.clone(), entry(valid.clone(), 1)).unwrap();
        for table in ["collaboration_outbox", "collaboration_rejections"] {
            for (index, invalid) in ["attempt-text", "attempt-blob", "json", "wrong-id", "wrong-project", "date"].iter().enumerate() {
                let row_id  =  id(30 + index as u32 + if table == "collaboration_rejections" { 10 } else { 0 });
                let mut value  =  serde_json::to_value(command("SetNodeTitle", 12, 1)).unwrap();
                value["commandId"]  =  Value::from(if *invalid == "wrong-id" { id(999) } else { row_id.clone() });
                if *invalid == "wrong-project" { value["projectId"]  =  Value::from(OTHER); }
                let raw  =  if *invalid == "json" { "{".into() } else { value.to_string() };
                let attempt  =  match *invalid { "attempt-text" => rusqlite::types::Value::Text("invalid-attempt".into()), "attempt-blob" => rusqlite::types::Value::Blob(vec![1, 2, 3]), _ => rusqlite::types::Value::Integer(1) };
                let date  =  if *invalid == "date" { "2026-02-30T00:00:00Z" } else { "2026-10-05T00:00:00Z" };
                let sql  =  if table == "collaboration_rejections" { "INSERT INTO collaboration_rejections VALUES(?1,?2,?3,?4,?5,'TargetDeleted')" } else { "INSERT INTO collaboration_outbox(project_id,command_id,command_json,commit_attempt_id,queued_at_iso) VALUES(?1,?2,?3,?4,?5)" };
                conn.execute(sql, params![P, row_id, raw, attempt, date]).unwrap();
            }
        }
        let state  =  read(&mut conn, P).unwrap();
        assert_eq!(state.entries.len(), 1);
        assert_eq!(state.entries[0].command, valid);
        assert_eq!(state.corrupt.len(), 12);
        assert!(state.rejected.is_empty());
        let metadata: String  =  conn.query_row("SELECT metadata_json FROM collaboration_quarantine_metadata WHERE command_id=?1", [id(30)], |r|r.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&metadata).unwrap()["commitAttemptId"], "invalid-attempt");
        let metadata: String  =  conn.query_row("SELECT metadata_json FROM collaboration_quarantine_metadata WHERE command_id=?1", [id(31)], |r|r.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&metadata).unwrap()["commitAttemptId"]["blob"], serde_json::json!([1, 2, 3]));
        assert_eq!(read(&mut conn, P).unwrap().corrupt, state.corrupt);
    }
    #[test]
    fn quarantine_metadata_is_append_only_when_sources_and_later_rows_share_identity() {
        let mut conn = memory();
        let id = id(30);
        conn.execute("INSERT INTO collaboration_outbox(project_id,command_id,command_json,commit_attempt_id,queued_at_iso) VALUES(?1,?2,'active original','bad-attempt','bad-date')",params![P,id]).unwrap();
        conn.execute("INSERT INTO collaboration_rejections VALUES(?1,?2,'rejected original','bad-attempt','bad-date','TargetDeleted')",params![P,id]).unwrap();
        assert_eq!(read(&mut conn,P).unwrap().corrupt,vec![id.clone()]);
        conn.execute("INSERT INTO collaboration_outbox(project_id,command_id,command_json,commit_attempt_id,queued_at_iso) VALUES(?1,?2,'later original','bad-attempt','bad-date')",params![P,id]).unwrap();
        read(&mut conn,P).unwrap();
        let mut stmt=conn.prepare("SELECT metadata_json FROM collaboration_quarantine_metadata WHERE command_id=?1 ORDER BY recovery_id").unwrap();
        let records=stmt.query_map([&id],|r|r.get::<_,String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
        assert_eq!(records.len(),3);
        let contents=records.iter().map(|raw|serde_json::from_str::<Value>(raw).unwrap()["commandJson"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(contents,vec!["active original","rejected original","later original"]);
    }
    #[test]
    fn real_sqlite_storage_exhaustion_is_sanitized_without_false_acknowledgement() {
        let mut conn  =  memory();
        let pages: i64  =  conn.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
        conn.pragma_update(None, "max_page_count", pages).unwrap();
        let before  =  dump(&conn);
        let mut payload  =  serde_json::to_value(command("SetNodeBodyText", 11, 1)).unwrap();
        payload["bodyText"]  =  Value::from("Synthetic ".repeat(20_000));
        let command: ProductCommand  =  serde_json::from_value(payload).unwrap();
        assert!(matches!(commit(&mut conn, P, command.clone(), entry(command, 1)), Err(RepositoryError::StorageFull)));
        assert_eq!(dump(&conn), before);
    }
    #[test]
    fn failed_fresh_setup_leaves_no_partial_schema_or_marker() {
        let mut conn  =  Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE VIEW collaboration_rejections AS SELECT 1").unwrap();
        assert!(crate::migration::runner::run_migrations(&mut conn).is_err());
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }
    #[test]
    fn journal_upgrade_is_atomic_and_preserves_legacy_lazy_queue() {
        let mut conn = memory();
        conn.pragma_update(None, "user_version", 17).unwrap();
        let c = command("SetNodeTitle", 11, 1);
        commit(&mut conn, P, c.clone(), entry(c.clone(), 1)).unwrap();
        conn.execute_batch("DROP TABLE collaboration_rejections").unwrap();
        // Reconstruct the real lazy v17/v18 cursor shape instead of tagging
        // a fully initialized v19 schema as an older database.
        conn.execute_batch("ALTER TABLE collaboration_cursor DROP COLUMN stream_epoch; ALTER TABLE collaboration_cursor DROP COLUMN recovery_required; ALTER TABLE collaboration_cursor DROP COLUMN recovery_reason; ALTER TABLE forecast_plans DROP COLUMN sprint_plan").unwrap();
        crate::migration::runner::run_migrations(&mut conn).unwrap();
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r|r.get::<_, i64>(0)).unwrap(), crate::db::schema::CURRENT_SCHEMA_VERSION);
        assert_eq!(read(&mut conn, P).unwrap().entries[0].command, c);
        let mut broken = memory();
        broken.pragma_update(None, "user_version", 17).unwrap();
        broken.execute_batch("DROP TABLE collaboration_cursor;DROP TABLE collaboration_rejections;CREATE VIEW collaboration_rejections AS SELECT 1").unwrap();
        let before = dump(&broken);
        assert!(crate::migration::runner::run_migrations(&mut broken).is_err());
        assert_eq!(dump(&broken), before);
        assert_eq!(broken.query_row("PRAGMA user_version", [], |r|r.get::<_, i64>(0)).unwrap(), 17);
        let exists: bool = broken.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='collaboration_cursor')", [], |r|r.get(0)).unwrap();
        assert!(!exists);
    }
    #[tokio::test]
    async fn actor_obeys_readiness_and_shutdown_intake() {
        let path = std::env::temp_dir().join(format!("pmapp-actor-{}-{}.sqlite", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let rt = super::super::runtime::RepositoryRuntime::new(path.clone());
        assert!(matches!(rt.read_outbox(P.into()).await, Err(RepositoryError::StorageNotReady)));
        rt.open().await.unwrap();
        rt.pause_intake().await.unwrap();
        assert!(matches!(rt.read_outbox(P.into()).await, Err(RepositoryError::ShuttingDown)));
        assert!(matches!(rt.commit_with_outbox(P.into(), command("SetNodeTitle", 11, 1), entry(command("SetNodeTitle", 11, 1), 1)).await, Err(RepositoryError::ShuttingDown)));
        rt.resume_intake().await.unwrap();
        assert!(rt.read_outbox(P.into()).await.unwrap().entries.is_empty());
        rt.close().await.unwrap();
        std::fs::remove_file(path).unwrap();
    }
}
