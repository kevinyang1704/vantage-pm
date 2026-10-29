//! Atomic authoritative recovery. No caller-owned connection or nested BEGIN.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use crate::protocol::{ProductCommand, ProductCommandResult, RepositoryError};
use crate::protocol::recovery::{ImmutableCommand, RecoveryEnvelope, payload_digest};
use super::{collaboration as journal, recovery_graph};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub revision: i64,
    pub recovery_required: bool,
}

/// Preserve original SQL cell types in archives, including malformed metadata.
fn raw_table(conn: &Connection, table: &str, project: &str) -> Result<Value, RepositoryError> {
    let mut statement = conn.prepare(&format!("SELECT * FROM {table} WHERE project_id = ?1"))
        .map_err(journal::storage)?;
    let names = statement.column_names().iter().map(|name| name.to_string()).collect::<Vec<_>>();
    let rows = statement.query_map([project], |row| {
        let mut fields = serde_json::Map::new();
        for (index, name) in names.iter().enumerate() {
            let value = match row.get_ref(index)? {
                rusqlite::types::ValueRef::Null => Value::Null,
                rusqlite::types::ValueRef::Integer(value) => json!({ "sqliteInteger": value.to_string() }),
                rusqlite::types::ValueRef::Real(value) => json!({ "sqliteRealBits": value.to_bits().to_string() }),
                rusqlite::types::ValueRef::Text(value) => json!({ "sqliteTextBytes": hex::encode(value) }),
                rusqlite::types::ValueRef::Blob(value) => json!({ "sqliteBlob": hex::encode(value) }),
            };
            fields.insert(name.clone(), value);
        }
        Ok(Value::Object(fields))
    }).map_err(journal::storage)?.collect::<rusqlite::Result<Vec<_>>>().map_err(journal::storage)?;
    Ok(Value::Array(rows))
}

fn terminal_matches(
    pending: &str,
    authoritative: &ImmutableCommand,
    availability: &str,
    actor: Option<&str>,
) -> Result<bool, RepositoryError> {
    let pending: ImmutableCommand = serde_json::from_str(pending).map_err(|_| RepositoryError::IntegrityFailed)?;
    crate::protocol::recovery::immutable_wire_identity_matches(&pending, authoritative, availability, actor)
}

pub fn install(
    conn: &mut Connection,
    project: &str,
    envelope: RecoveryEnvelope,
    archived_at_iso: &str,
) -> Result<InstallOutcome, RepositoryError> {
    envelope.validate(project)?;
    if chrono::DateTime::parse_from_rfc3339(archived_at_iso).is_err() { return Err(RepositoryError::InvalidRequest); }
    let mut tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(journal::storage)?;
    let (prior_epoch, prior_cursor, prior_required): (Option<i64>, i64, bool) = tx.query_row(
        "SELECT stream_epoch, cursor, recovery_required FROM collaboration_cursor WHERE project_id = ?1",
        [project], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(journal::storage)?.unwrap_or((None, 0, false));
    let pending = journal::active(&tx, project)?;
    let same_verified_history = prior_epoch == Some(envelope.stream_epoch)
        && prior_cursor <= envelope.server_revision && prior_cursor >= envelope.history_floor
        && envelope.dedup_coverage == "complete" && !prior_required;
    let mut matched = std::collections::HashMap::new();
    let mut uncertain_terminal = std::collections::HashSet::new();
    for (id, raw, _, _) in &pending {
        let terminal = envelope.confirmed_history.iter().find(|entry| entry.command.typed.command_id() == id)
            .map(|entry| (&entry.command, &entry.result, entry.wire_identity_availability.as_str(), entry.actor_id.as_deref()))
            .or_else(|| envelope.terminal_rejections.iter().find(|entry| entry.command.typed.command_id() == id).map(|entry| (&entry.command, &entry.result, entry.wire_identity_availability.as_str(), entry.actor_id.as_deref())));
        if let Some((command, result, availability, actor)) = terminal {
            if availability == "legacy-admitted-wire" && actor.is_none() { uncertain_terminal.insert(id.clone()); continue; }
            if !terminal_matches(raw, command, availability, actor)? { return Err(RepositoryError::CommandIdentityConflict); }
            matched.insert(id.clone(), result.clone());
        }
    }
    let ambiguous = pending.iter().any(|(id, raw, _, _)| {
        !matched.contains_key(id) && (uncertain_terminal.contains(id) || !same_verified_history || serde_json::from_str::<ProductCommand>(raw)
            .map_or(true, |command| command.base_revision() < envelope.history_floor))
    });
    let confirmed_ahead = prior_cursor > envelope.server_revision;
    let epoch_changed = prior_epoch.is_some() && prior_epoch != Some(envelope.stream_epoch);
    let recovery_required = prior_required || ambiguous || confirmed_ahead || epoch_changed;
    // The archive is append-only, includes portable dismissals/reasons and all
    // original raw sidecars; no speculative effect is silently overlaid later.
    let mut archive = serde_json::Map::new();
    archive.insert("graph".into(), serde_json::to_value(recovery_graph::capture_graph(&tx, project)?).map_err(|_| RepositoryError::Internal)?);
    for table in ["collaboration_outbox", "collaboration_cursor", "collaboration_confirmed_state",
        "collaboration_attempt_receipt", "collaboration_rejections", "collaboration_outbox_quarantine",
        "collaboration_quarantine_metadata", "collaboration_authoritative_history", "collaboration_recovery_envelope",
        "product_command_receipt"] {
        archive.insert(table.into(), raw_table(&tx, table, project)?);
    }
    let reason = if confirmed_ahead { "CONFIRMED_AHEAD" } else if ambiguous { "RECOVERY_IDENTITY_UNAVAILABLE" }
        else if prior_epoch != Some(envelope.stream_epoch) { "STREAM_EPOCH_CHANGED" } else { "AUTHORITATIVE_REPLACEMENT" };
    tx.execute(
        "INSERT INTO collaboration_recovery_archive(project_id, prior_epoch, prior_cursor, reason, archive_json, created_at_iso) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        params![project, prior_epoch, prior_cursor, reason, Value::Object(archive).to_string(), archived_at_iso],
    ).map_err(journal::storage)?;
    recovery_graph::replace_graph(&tx, &envelope.graph, project)?;
    tx.execute("DELETE FROM product_command_receipt WHERE project_id = ?1", [project]).map_err(journal::storage)?;
    tx.execute("DELETE FROM collaboration_authoritative_history WHERE project_id = ?1", [project]).map_err(journal::storage)?;
    for entry in &envelope.confirmed_history {
        tx.execute("INSERT INTO collaboration_authoritative_history(project_id, stream_epoch, server_revision, entry_json) VALUES(?1, ?2, ?3, ?4)",
            params![project, envelope.stream_epoch, entry.server_revision, serde_json::to_string(entry).map_err(|_| RepositoryError::Internal)?]).map_err(journal::storage)?;
    }
    tx.execute("INSERT INTO collaboration_recovery_envelope(project_id, envelope_json) VALUES(?1, ?2) ON CONFLICT(project_id) DO UPDATE SET envelope_json = excluded.envelope_json",
        params![project, serde_json::to_string(&envelope).map_err(|_| RepositoryError::Internal)?]).map_err(journal::storage)?;
    for (id, raw, attempt, queued_at) in &pending {
        if let Some(result) = matched.get(id) {
            let command = serde_json::from_str(raw).map_err(|_| RepositoryError::IntegrityFailed)?;
            let entry = journal::OutboxEntry { command_id: id.clone(), command, commit_attempt_id: *attempt, queued_at_iso: queued_at.clone(), group_id: None, group_index: None };
            match result {
                ProductCommandResult::ProductCommandApplied(_) => { tx.execute("DELETE FROM collaboration_outbox WHERE project_id = ?1 AND command_id = ?2", params![project, id]).map_err(journal::storage)?; },
                ProductCommandResult::ProductCommandRejected(rejected) => journal::reject(&tx, project, &entry, &rejected.code)?,
            }
        }
    }
    journal::capture(&tx, project)?;
    if same_verified_history && !recovery_required {
        // Unsent work replays at the authoritative cut; a composite gesture
        // re-applies whole or is retained whole as rejected work.
        let groups = journal::active_groups(&tx, project)?;
        let mut unsent = Vec::new();
        for (id, raw, attempt, queued_at) in &pending {
            if matched.contains_key(id) { continue; }
            let command: ProductCommand = serde_json::from_str(raw).map_err(|_| RepositoryError::IntegrityFailed)?;
            let next_attempt = attempt.checked_add(1).filter(|n| *n <= 9_007_199_254_740_991).ok_or(RepositoryError::InvalidRequest)?;
            let (group_id, group_index) = groups.get(id).cloned().map_or((None, None), |(g, i)| (Some(g), Some(i)));
            unsent.push(journal::OutboxEntry { command_id: id.clone(), command, commit_attempt_id: next_attempt, queued_at_iso: queued_at.clone(), group_id, group_index });
        }
        journal::replay_atomically(&mut tx, project, unsent, |tx, entry| {
            // Original wire bytes remain immutable under the stable ID.
            tx.execute("UPDATE collaboration_outbox SET commit_attempt_id = ?1 WHERE project_id = ?2 AND command_id = ?3", params![entry.commit_attempt_id, project, entry.command_id]).map_err(journal::storage)?;
            Ok(())
        })?;
    }
    tx.execute("INSERT INTO collaboration_cursor(project_id, cursor, stream_epoch, recovery_required, recovery_reason) VALUES(?1, ?2, ?3, ?4, ?5) ON CONFLICT(project_id) DO UPDATE SET cursor = excluded.cursor, stream_epoch = excluded.stream_epoch, recovery_required = excluded.recovery_required, recovery_reason = excluded.recovery_reason",
        params![project, envelope.server_revision, envelope.stream_epoch, recovery_required, if recovery_required { Some(reason) } else { None }]).map_err(journal::storage)?;
    let revision = tx.query_row("SELECT revision FROM projects WHERE id = ?1", [project], |row| row.get(0)).map_err(journal::storage)?;
    tx.commit().map_err(journal::storage)?;
    Ok(InstallOutcome { revision, recovery_required })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::handler;
    use crate::protocol::recovery::{ConfirmedHistoryEntry, RecoveryFootprints};

    const PROJECT: &str = "0198a000-0000-7000-8000-000000000002";
    const CREATE: &str = "0198a000-0000-7000-8000-000000000001";
    const EDIT: &str = "0198a000-0000-7000-8000-000000000004";
    const NODE: &str = "0198a000-0000-7000-8000-000000000003";
    const AT: &str = "2026-10-06T00:00:00Z";

    fn project_command() -> ProductCommand {
        serde_json::from_value(json!({"type":"CreateProject", "protocolVersion":"1.0.0", "commandId":CREATE,
            "projectId":PROJECT, "baseRevision":0, "expectedRevision":1, "name":"Synthetic recovery", "actorId":null})).unwrap()
    }
    fn pending_command() -> ProductCommand {
        serde_json::from_value(json!({"type":"CreateNode", "protocolVersion":"1.0.0", "commandId":EDIT,
            "projectId":PROJECT, "baseRevision":1, "expectedRevision":2, "nodeId":NODE,
            "parentId":null, "position":"4294967296", "title":"Synthetic pending", "actorId":null})).unwrap()
    }
    fn history(command: ProductCommand, result: ProductCommandResult, revision: i64) -> ConfirmedHistoryEntry {
        let command = ImmutableCommand::from_wire(serde_json::to_value(command).unwrap()).unwrap();
        ConfirmedHistoryEntry {
            payload_digest: payload_digest(&command).unwrap(), wire_identity_availability:"original".into(), actor_id: None,
            protocol_version: "1.0.0".into(), server_revision: revision,
            receipt_revision_availability: "authoritative".into(), recorded_at_iso: None, label: None,
            command_footprint: RecoveryFootprints { availability:"unavailable".into(), known_targets:vec![], reason:Some("SYNTHETIC_LEGACY_METADATA".into()) },
            effect_footprint: RecoveryFootprints { availability:"unavailable".into(), known_targets:vec![], reason:Some("SYNTHETIC_LEGACY_METADATA".into()) },
            deletion_metadata: "not-applicable".into(), command, result,
        }
    }
    fn state() -> (Connection, RecoveryEnvelope, String) {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        handler::initialize_schema(&conn).unwrap();
        let create_result = handler::apply(&mut conn, project_command()).unwrap();
        let envelope = RecoveryEnvelope {
            version:1, protocol_version:"1.0.0".into(), project_id:PROJECT.into(), stream_epoch:1,
            server_revision:1, history_floor:0, dedup_coverage:"complete".into(),
            graph:recovery_graph::capture_graph(&conn,PROJECT).unwrap(),
            confirmed_history:vec![history(project_command(),create_result,1)], terminal_rejections:vec![],
        };
        conn.execute("INSERT INTO collaboration_cursor(project_id,cursor,stream_epoch) VALUES(?1,1,1)", [PROJECT]).unwrap();
        let command = pending_command();
        let entry = journal::OutboxEntry { command_id:EDIT.into(), command:command.clone(), commit_attempt_id:1, queued_at_iso:AT.into(), group_id:None, group_index:None };
        journal::commit(&mut conn,PROJECT,command,entry).unwrap();
        let raw = conn.query_row("SELECT command_json FROM collaboration_outbox WHERE command_id=?1",[EDIT],|row|row.get(0)).unwrap();
        (conn,envelope,raw)
    }

    #[test]
    fn same_verified_epoch_replays_only_local_attempt_and_preserves_wire() {
        let (mut conn,envelope,wire) = state();
        let outcome = install(&mut conn,PROJECT,envelope,AT).unwrap();
        assert_eq!(outcome.revision,2);
        assert!(!outcome.recovery_required);
        let (raw,attempt):(String,i64) = conn.query_row("SELECT command_json,commit_attempt_id FROM collaboration_outbox WHERE command_id=?1",[EDIT],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(raw,wire);
        assert_eq!(attempt,2);
        let state=journal::read(&mut conn,PROJECT).unwrap();
        assert_eq!(state.stream_epoch,Some(1));
        assert_eq!(state.cursor,1);
        assert!(!state.recovery_required);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM collaboration_recovery_archive",[],|row|row.get::<_,i64>(0)).unwrap(),1);
    }

    #[test]
    fn changed_epoch_retains_and_blocks_ambiguous_pending_across_restart_read() {
        let (mut conn,mut envelope,wire) = state();
        envelope.stream_epoch=2;
        let outcome=install(&mut conn,PROJECT,envelope,AT).unwrap();
        assert!(outcome.recovery_required);
        assert_eq!(outcome.revision,1);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM nodes WHERE project_id=?1",[PROJECT],|row|row.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(conn.query_row("SELECT command_json FROM collaboration_outbox WHERE command_id=?1",[EDIT],|row|row.get::<_,String>(0)).unwrap(),wire);
        for _ in 0..2 {
            let state=journal::read(&mut conn,PROJECT).unwrap();
            assert!(state.recovery_required && state.resync_required);
            assert_eq!(state.recovery_reason.as_deref(),Some("RECOVERY_IDENTITY_UNAVAILABLE"));
            assert_eq!(state.entries[0].commit_attempt_id,1);
        }
        let archive:String=conn.query_row("SELECT archive_json FROM collaboration_recovery_archive",[],|row|row.get(0)).unwrap();
        let archive:Value=serde_json::from_str(&archive).unwrap();
        assert_eq!(archive["graph"]["nodes"].as_array().unwrap().len(),1);
        assert_eq!(archive["collaboration_outbox"].as_array().unwrap().len(),1);
        assert_eq!(archive["product_command_receipt"].as_array().unwrap().len(),2);
    }

    #[test]
    fn confirmed_ahead_archives_before_replacement_and_never_reports_synced() {
        let (mut conn,envelope,wire) = state();
        conn.execute("UPDATE collaboration_cursor SET cursor=5 WHERE project_id=?1",[PROJECT]).unwrap();
        let outcome=install(&mut conn,PROJECT,envelope,AT).unwrap();
        assert!(outcome.recovery_required);
        let state=journal::read(&mut conn,PROJECT).unwrap();
        assert!(state.recovery_required && state.resync_required);
        assert_eq!(state.recovery_reason.as_deref(),Some("CONFIRMED_AHEAD"));
        assert_eq!(state.cursor,1, "cursor follows the authoritative cut, never MAX across restore");
        assert_eq!(conn.query_row("SELECT command_json FROM collaboration_outbox WHERE command_id=?1",[EDIT],|row|row.get::<_,String>(0)).unwrap(),wire);
        let (prior,reason):(i64,String)=conn.query_row("SELECT prior_cursor,reason FROM collaboration_recovery_archive",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!((prior,reason.as_str()),(5,"CONFIRMED_AHEAD"));
    }

    #[test]
    fn sql_failure_rolls_back_graph_archives_and_journals() {
        let (mut conn,envelope,wire)=state();
        conn.execute_batch("CREATE TRIGGER fail_recovery BEFORE INSERT ON collaboration_recovery_envelope BEGIN SELECT RAISE(ABORT,'synthetic'); END").unwrap();
        assert!(install(&mut conn,PROJECT,envelope.clone(),AT).is_err());
        assert_eq!(conn.query_row("SELECT revision FROM projects WHERE id=?1",[PROJECT],|row|row.get::<_,i64>(0)).unwrap(),2);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM collaboration_recovery_archive",[],|row|row.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(conn.query_row("SELECT command_json FROM collaboration_outbox WHERE command_id=?1",[EDIT],|row|row.get::<_,String>(0)).unwrap(),wire);
        conn.execute_batch("DROP TRIGGER fail_recovery").unwrap();
        install(&mut conn,PROJECT,envelope,AT).unwrap();
    }
}
