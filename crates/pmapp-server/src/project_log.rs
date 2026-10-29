//! Per-project command log (Story 27.5, D1/D3, AC 27.5-1/-2/-3).
//!
//! Each shared project is one SQLite file. Commands are applied with the
//! **same `pmapp-core` handler the desktop app runs** (one transaction per
//! command: mutation + receipt + revision), so the service never holds a second
//! copy of the domain rules (D2). The receipt table is the server order: each
//! committed command records `target_revision`, and revisions are contiguous.
//!
//! Snapshot/catch-up: a client at server revision `r` receives the commands
//! whose `target_revision > r`; otherwise it receives a fresh snapshot plus the
//! suffix. This mirrors the worker protocol's gap → resync rule.
//!
//! 27.5 also adds WebSocket streaming + Railway deploy + object-storage backup;
//! the deployment/backup parts need external accounts and are recorded BLOCKED.
//! This module is the local, testable core.

use std::path::{Path, PathBuf};

use pmapp_core::db::handler;
use pmapp_core::protocol::{
    ProductCommand, ProductCommandResult, RepositoryError,
};
use rusqlite::{Connection, OptionalExtension};
use pmapp_core::protocol::recovery::{
    ImmutableCommand, payload_digest, ConfirmedHistoryEntry, RecoveryGraph, RecoveryProjectRow,
    deletion_metadata, RecoveryEnvelope, RecoveryFootprints, TerminalRejection,
};
use pmapp_core::db::recovery_graph::{capture_graph, cut_footprints};

/// Snapshot + suffix catch-up result (AC 27.5-3).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatchUp {
    /// Current server revision after applying the suffix.
    pub revision: i64,
    /// The commands strictly after the client's revision, in order, each with
    /// the server revision it committed at.
    pub commands: Vec<LoggedCommand>,
    /// True when the client's revision was unknown/too old and a fresh
    /// snapshot is required first.
    pub resync_required: bool,
    /// The canonical project snapshot (JSON), present when a resync is needed.
    pub snapshot: Option<serde_json::Value>,
}

/// One committed command in server order.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoggedCommand {
    pub server_revision: i64,
    pub command: serde_json::Value,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCut {
    pub stream_epoch: i64,
    pub server_revision: i64,
    pub resync_required: bool,
    pub envelope: Option<RecoveryEnvelope>,
    pub commands: Vec<ConfirmedHistoryEntry>,
}

pub struct ProjectLog {
    conn: Connection,
    project_id: String,
}

/// The server-side command log: the canonical order, separate from the
/// `pmapp-core` receipt table (which stores results, not commands). One row per
/// committed command, keyed by the contiguous server revision (D3).
pub const SERVER_LOG_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS server_command_log(
  project_id      TEXT NOT NULL,
  server_revision INTEGER NOT NULL,
  command_id      TEXT NOT NULL,
  command_json    TEXT NOT NULL,
  PRIMARY KEY (project_id, server_revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS server_command_log_by_command
  ON server_command_log(project_id, command_id);

CREATE TABLE IF NOT EXISTS server_stream_state(
  project_id TEXT PRIMARY KEY,
  stream_epoch INTEGER NOT NULL CHECK(stream_epoch > 0 AND stream_epoch <= 9007199254740991),
  verified_high_water INTEGER NOT NULL CHECK(verified_high_water >= stream_epoch),
  history_floor INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS server_command_actor(
  project_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  actor_id TEXT,
  PRIMARY KEY(project_id, command_id)
);
CREATE TABLE IF NOT EXISTS server_recovery_history(
  project_id TEXT NOT NULL,
  server_revision INTEGER NOT NULL,
  entry_json TEXT NOT NULL,
  PRIMARY KEY(project_id, server_revision)
);

CREATE TABLE IF NOT EXISTS server_share_intent(
  project_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  complete INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS server_rejection_log(
  project_id  TEXT NOT NULL,
  command_id  TEXT NOT NULL,
  command_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (project_id, command_id)
);
"#;

impl ProjectLog {
    /// Open (creating) the project's SQLite file with the shared schema.
    pub fn open(path: &Path, project_id: &str) -> Result<Self, RepositoryError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| RepositoryError::IntegrityFailed)?;
        }
        let conn = Connection::open(path).map_err(|_| RepositoryError::IntegrityFailed)?;
        conn.execute_batch("PRAGMA foreign_keys = ON;").map_err(|_| RepositoryError::IntegrityFailed)?;
        // Story 28.3: serve only this release's data version. Older files are
        // migrated at startup before the listener binds; newer ones (written
        // by a later release) are never guessed at.
        let version = crate::server_migration::data_version(&conn).map_err(|_| RepositoryError::IntegrityFailed)?;
        if version != 0 && version != crate::server_migration::SERVER_DATA_VERSION {
            return Err(RepositoryError::IntegrityFailed);
        }
        handler::initialize_schema(&conn).map_err(|_| RepositoryError::IntegrityFailed)?;
        conn.execute_batch(SERVER_LOG_SCHEMA).map_err(|_| RepositoryError::IntegrityFailed)?;
        if version == 0 {
            crate::server_migration::initialize_current(&conn).map_err(|_| RepositoryError::IntegrityFailed)?;
        }
        conn.execute(
            "INSERT OR IGNORE INTO server_stream_state(project_id, stream_epoch, verified_high_water) VALUES(?1, 1, 1)",
            [project_id],
        ).map_err(|_| RepositoryError::IntegrityFailed)?;
        Ok(Self { conn, project_id: project_id.to_string() })
    }

    pub fn open_in_memory(project_id: &str) -> Result<Self, RepositoryError> {
        let conn = Connection::open_in_memory().map_err(|_| RepositoryError::IntegrityFailed)?;
        conn.execute_batch("PRAGMA foreign_keys = ON;").map_err(|_| RepositoryError::IntegrityFailed)?;
        handler::initialize_schema(&conn).map_err(|_| RepositoryError::IntegrityFailed)?;
        conn.execute_batch(SERVER_LOG_SCHEMA).map_err(|_| RepositoryError::IntegrityFailed)?;
        crate::server_migration::initialize_current(&conn).map_err(|_| RepositoryError::IntegrityFailed)?;
        conn.execute(
            "INSERT OR IGNORE INTO server_stream_state(project_id, stream_epoch, verified_high_water) VALUES(?1, 1, 1)",
            [project_id],
        ).map_err(|_| RepositoryError::IntegrityFailed)?;
        Ok(Self { conn, project_id: project_id.to_string() })
    }

    /// Copy this project database to `dest` through the held connection with
    /// SQLite's online backup API. Callers hold this log's lock (and the cache
    /// lock), so no command can commit mid-copy (Story 27.5 coherent cut).
    pub fn backup_to(&self, dest: &Path) -> Result<(), RepositoryError> {
        let mut target = Connection::open(dest).map_err(|_| RepositoryError::IntegrityFailed)?;
        let backup = rusqlite::backup::Backup::new(&self.conn, &mut target).map_err(|_| RepositoryError::IntegrityFailed)?;
        backup.run_to_completion(256, std::time::Duration::from_millis(0), None).map_err(|_| RepositoryError::IntegrityFailed)
    }

    /// The project's current server revision (0 before the first command).
    pub fn revision(&self) -> Result<i64, RepositoryError> {
        self.conn
            .query_row(
                "SELECT revision FROM projects WHERE id = ?1",
                [&self.project_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| RepositoryError::IntegrityFailed)
            .map(|opt| opt.unwrap_or(0))
    }

    /// Apply one command in arrival order and assign its server revision.
    /// Exactly-once: `pmapp-core` returns the recorded result for a duplicate
    /// `commandId` without applying twice (AC 27.5-1, R2). The state mutation,
    /// receipt, revision and the server command-log row commit in ONE
    /// transaction (H02, AC 27.5-2): a crash can never leave an acknowledged
    /// state that the log cannot replay.
    pub fn submit(&mut self, command: ProductCommand) -> Result<ProductCommandResult, RepositoryError> {
        let epoch = self.stream_epoch()?;
        let wire = serde_json::to_value(command).map_err(|_| RepositoryError::InvalidRequest)?;
        self.submit_wire_in_epoch(wire, epoch)
    }

    pub fn stream_epoch(&self) -> Result<i64, RepositoryError> {
        self.conn.query_row(
            "SELECT stream_epoch FROM server_stream_state WHERE project_id = ?1",
            [&self.project_id], |row| row.get(0),
        ).map_err(|_| RepositoryError::IntegrityFailed)
    }

    /// Only an externally verified high-water permits a restored stream to rotate.
    /// This internal operation has no public HTTP route.
    pub fn rotate_restored_epoch(&mut self, verified_high_water: i64) -> Result<i64, RepositoryError> {
        let tx = self.conn.transaction().map_err(|_| RepositoryError::Internal)?;
        let (epoch, retained_high_water): (i64, i64) = tx.query_row(
            "SELECT stream_epoch, verified_high_water FROM server_stream_state WHERE project_id = ?1",
            [&self.project_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|_| RepositoryError::IntegrityFailed)?;
        if verified_high_water <= epoch || verified_high_water <= retained_high_water
            || verified_high_water >= 9_007_199_254_740_991 {
            return Err(RepositoryError::InvalidRequest);
        }
        let next = verified_high_water + 1;
        tx.execute(
            "UPDATE server_stream_state SET stream_epoch = ?1, verified_high_water = ?1 WHERE project_id = ?2",
            rusqlite::params![next, self.project_id],
        ).map_err(|_| RepositoryError::Internal)?;
        tx.commit().map_err(|_| RepositoryError::Internal)?;
        Ok(next)
    }

    pub fn submit_wire_in_epoch(
        &mut self,
        wire: serde_json::Value,
        epoch: i64,
    ) -> Result<ProductCommandResult, RepositoryError> {
        self.submit_wire_bound(wire, epoch, None)
    }

    pub fn submit_wire_as_actor_in_epoch(
        &mut self,
        wire: serde_json::Value,
        epoch: i64,
        actor_id: &str,
    ) -> Result<ProductCommandResult, RepositoryError> {
        self.submit_wire_bound(wire, epoch, Some(actor_id))
    }

    /// An authenticated member without write permission (e.g. demoted to
    /// viewer while edits were queued): the command is recorded as a durable
    /// terminal rejection instead of a bare 403, so the client's recovery
    /// snapshot retains and rolls back the edit (gate 5). A command id that is
    /// already in the server log returns its stored result unchanged.
    pub fn reject_without_write_in_epoch(
        &mut self,
        wire: serde_json::Value,
        epoch: i64,
        actor_id: &str,
        code: &str,
    ) -> Result<ProductCommandResult, RepositoryError> {
        self.submit_wire_bound_inner(wire, epoch, Some(actor_id), Some(code))
    }

    fn submit_wire_bound(
        &mut self,
        wire: serde_json::Value,
        epoch: i64,
        trusted_actor: Option<&str>,
    ) -> Result<ProductCommandResult, RepositoryError> {
        self.submit_wire_bound_inner(wire, epoch, trusted_actor, None)
    }

    /// Validate one wire command against the epoch, attribution and the
    /// durable logs. `Done` carries a final answer (a replayed terminal
    /// rejection or an identity conflict); `Fresh` is ready to apply (a command
    /// already in the server log replays its stored receipt when applied).
    fn prepare_wire(
        &mut self,
        wire: serde_json::Value,
        epoch: i64,
        trusted_actor: Option<&str>,
    ) -> Result<Prepared, RepositoryError> {
        // Epoch mismatch cannot reveal a cached private outcome or mutate state.
        if epoch != self.stream_epoch()? { return Err(RepositoryError::ResyncRequired); }
        let immutable = ImmutableCommand::from_wire(wire)?;
        if let Some(actor) = trusted_actor {
            if immutable.typed.actor_id().is_some_and(|authored| authored != actor) {
                return Err(RepositoryError::InvalidRequest);
            }
        }
        let actor_binding = trusted_actor.or(immutable.typed.actor_id()).map(str::to_owned);
        let mut apply_wire = immutable.wire.clone();
        if let Some(actor) = &actor_binding {
            apply_wire.as_object_mut().ok_or(RepositoryError::InvalidRequest)?.insert("actorId".into(), serde_json::Value::String(actor.clone()));
        }
        let command: ProductCommand = serde_json::from_value(apply_wire).map_err(|_| RepositoryError::InvalidRequest)?;
        if command.project_id() != self.project_id { return Err(RepositoryError::InvalidRequest); }
        let command_id = command.command_id().to_string();
        let command_json = serde_json::to_string(&immutable).map_err(|_| RepositoryError::IntegrityFailed)?;
        let project_id = self.project_id.clone();
        let retained_actor: Option<Option<String>> = self.conn.query_row(
            "SELECT actor_id FROM server_command_actor WHERE project_id = ?1 AND command_id = ?2",
            rusqlite::params![project_id, command_id], |row| row.get(0),
        ).optional().map_err(|_| RepositoryError::IntegrityFailed)?;
        let original_wire_binding = retained_actor.is_some();
        if retained_actor.as_ref().is_some_and(|actor| actor != &actor_binding) { return Err(RepositoryError::CommandIdentityConflict); }

        // Exactly-once for a durable terminal rejection (R2/H03): a retry of the
        // SAME command (same id, same type, same payload) returns the recorded
        // rejection. A command id reused with a different payload is refused, so
        // a rejected id cannot poison a later valid command.
        if let Some((result_json, stored_command_json)) = self
            .conn
            .query_row(
                "SELECT result_json, command_json FROM server_rejection_log
                 WHERE project_id = ?1 AND command_id = ?2",
                rusqlite::params![&self.project_id, &command_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|_| RepositoryError::IntegrityFailed)?
        {
            // Compare the incoming command to the recorded one by canonical JSON.
            let stored: ImmutableCommand = serde_json::from_str(&stored_command_json)
                .map_err(|_| RepositoryError::IntegrityFailed)?;
            let same = pmapp_core::protocol::recovery::immutable_wire_identity_matches(
                &immutable, &stored, if original_wire_binding { "original" } else { "legacy-admitted-wire" }, actor_binding.as_deref(),
            )?;
            if same {
                if let Ok(mut result) = serde_json::from_str::<ProductCommandResult>(&result_json) {
                    result.set_disposition_stored();
                    return Ok(Prepared::Done(result));
                }
            }
            // Different payload reusing a rejected id: refuse explicitly.
            return Ok(Prepared::Done(identity_conflict_result(&command_id, &self.project_id)));
        }


        // Exact command identity (R2/H03): a command id already in the server log
        // must carry the SAME payload. A changed payload reusing an id is refused
        // rather than silently replaying the stored result. (Exact JSON compare;
        // our command structs serialize with stable field order.)
        if let Some(stored) = self
            .conn
            .query_row(
                "SELECT command_json FROM server_command_log WHERE project_id = ?1 AND command_id = ?2",
                rusqlite::params![&self.project_id, &command_id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| RepositoryError::IntegrityFailed)?
        {
            let stored: ImmutableCommand = serde_json::from_str(&stored)
                .map_err(|_| RepositoryError::IntegrityFailed)?;
            if !pmapp_core::protocol::recovery::immutable_wire_identity_matches(
                &immutable, &stored, if original_wire_binding { "original" } else { "legacy-admitted-wire" }, actor_binding.as_deref(),
            )? {
                return Ok(Prepared::Done(identity_conflict_result(&command_id, &self.project_id)));
            }
        } else if let Some(stored_digest) = self
            .conn
            .query_row(
                "SELECT command_sha256 FROM server_compacted_command WHERE project_id = ?1 AND command_id = ?2",
                rusqlite::params![&self.project_id, &command_id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| RepositoryError::IntegrityFailed)?
        {
            // Story 28.3: the command was committed and later compacted out of
            // the log. Its digest still pins the payload; the retained receipt
            // replays the original result below (exactly-once survives).
            if stored_digest != command_sha256(&command_json) {
                return Ok(Prepared::Done(identity_conflict_result(&command_id, &self.project_id)));
            }
        }
        Ok(Prepared::Fresh(FreshCommand { command, immutable, command_id, command_json, actor_binding }))
    }

    fn submit_wire_bound_inner(
        &mut self,
        wire: serde_json::Value,
        epoch: i64,
        trusted_actor: Option<&str>,
        forced_rejection: Option<&str>,
    ) -> Result<ProductCommandResult, RepositoryError> {
        let fresh = match self.prepare_wire(wire, epoch, trusted_actor)? {
            Prepared::Done(result) => return Ok(result),
            Prepared::Fresh(fresh) => fresh,
        };
        if let Some(code) = forced_rejection {
            if !self.in_server_log(&fresh.command_id)? {
                let result = rejected_result(&fresh.command_id, &self.project_id, code);
                self.record_rejection(&fresh.command_id, &fresh.command_json, &fresh.actor_binding, &result)?;
                return Ok(result);
            }
        }
        let FreshCommand { command, immutable, command_id, command_json, actor_binding } = fresh;
        let (rejection_id, rejection_json, rejection_actor) = (command_id.clone(), command_json.clone(), actor_binding.clone());
        let project_id = self.project_id.clone();
        let before_project = project_id.clone();
        let result = handler::apply_shared_with_capture(
            &mut self.conn,
            command,
            move |tx| capture_before(tx, &before_project),
            move |tx, before, _command_id, revision| {
                record_applied(tx, before, &project_id, &command_id, &command_json, immutable, actor_binding, revision)
            },
        )?;
        // Persist a terminal rejection durably so a retry replays it (H03). A
        // rejection consumes no revision and is not in the server order.
        if matches!(result, ProductCommandResult::ProductCommandRejected(_)) {
            self.record_rejection(&rejection_id, &rejection_json, &rejection_actor, &result)?;
        }
        Ok(result)
    }

    /// Apply a composite gesture's commands atomically (Story 27.2 on shared
    /// projects): all members commit at consecutive server revisions, or none
    /// does. A refused group records a durable terminal rejection for EVERY
    /// member (the refused one with its own code, the rest with
    /// `ATOMIC_GROUP_REJECTED`), so a retry replays it and recovery retains the
    /// whole gesture as rejected work instead of resubmitting parts of it.
    pub fn submit_group_as_actor_in_epoch(
        &mut self,
        wires: Vec<serde_json::Value>,
        epoch: i64,
        actor_id: &str,
    ) -> Result<Vec<ProductCommandResult>, RepositoryError> {
        if wires.is_empty() || wires.len() > MAX_GROUP_MEMBERS { return Err(RepositoryError::InvalidRequest); }
        let mut prepared = Vec::with_capacity(wires.len());
        for wire in wires { prepared.push(self.prepare_wire(wire, epoch, Some(actor_id))?); }
        let mut seen = std::collections::BTreeSet::new();
        for member in &prepared {
            let id = match member {
                Prepared::Fresh(fresh) => fresh.command_id.clone(),
                Prepared::Done(result) => result_command_id(result),
            };
            if !seen.insert(id) { return Err(RepositoryError::InvalidRequest); }
        }
        let done = prepared.iter().filter(|m| matches!(m, Prepared::Done(_))).count();
        if done == prepared.len() {
            // A retried refused group: every member replays its stored answer.
            return Ok(prepared.into_iter().map(|m| match m { Prepared::Done(r) => r, Prepared::Fresh(_) => unreachable!() }).collect());
        }
        if done > 0 { return Err(RepositoryError::CommandIdentityConflict); }
        let fresh: Vec<FreshCommand> = prepared.into_iter().map(|m| match m { Prepared::Fresh(f) => f, Prepared::Done(_) => unreachable!() }).collect();
        // A group is atomic: either none of it is in the log (new) or all of it
        // is (a retry of a committed group). A partial overlap is not a group.
        let mut logged = 0;
        for member in &fresh { if self.in_server_log(&member.command_id)? { logged += 1; } }
        if logged != 0 && logged != fresh.len() { return Err(RepositoryError::CommandIdentityConflict); }

        let meta: Vec<(String, String, Option<String>)> = fresh.iter()
            .map(|f| (f.command_id.clone(), f.command_json.clone(), f.actor_binding.clone())).collect();
        let mut members: Vec<handler::SharedGroupMember<Option<RecoveryGraph>>> = Vec::with_capacity(fresh.len());
        for FreshCommand { command, immutable, command_id, command_json, actor_binding } in fresh {
            let before_project = self.project_id.clone();
            let project_id = self.project_id.clone();
            members.push((
                command,
                Box::new(move |tx| capture_before(tx, &before_project)),
                Box::new(move |tx, before, _command_id, revision| {
                    record_applied(tx, before, &project_id, &command_id, &command_json, immutable, actor_binding, revision)
                }),
            ));
        }
        match handler::apply_shared_group_with_capture(&mut self.conn, members)? {
            handler::SharedGroupOutcome::Applied(results) => Ok(results),
            handler::SharedGroupOutcome::Rejected { index, result } => {
                let mut results = Vec::with_capacity(meta.len());
                for (i, (command_id, command_json, actor)) in meta.iter().enumerate() {
                    let member_result = if i == index { result.clone() } else { rejected_result(command_id, &self.project_id, "ATOMIC_GROUP_REJECTED") };
                    self.record_rejection(command_id, command_json, actor, &member_result)?;
                    results.push(member_result);
                }
                Ok(results)
            }
        }
    }

    fn in_server_log(&self, command_id: &str) -> Result<bool, RepositoryError> {
        // A compacted command is still a committed one.
        Ok(self.conn.query_row(
            "SELECT 1 FROM server_command_log WHERE project_id = ?1 AND command_id = ?2
             UNION ALL SELECT 1 FROM server_compacted_command WHERE project_id = ?1 AND command_id = ?2",
            rusqlite::params![&self.project_id, command_id], |_| Ok(()),
        ).optional().map_err(|_| RepositoryError::IntegrityFailed)?.is_some())
    }

    /// Story 28.3 (AC 27.8-6, R5/R9): trim confirmed history older than
    /// `cutoff_iso`, always keeping the newest `keep_latest` commands. The
    /// history floor rises to the last trimmed revision, so bootstrap delivers
    /// the snapshot plus the retained suffix and a client older than the floor
    /// takes the existing safe-resync path (pending work preserved). Each
    /// trimmed command keeps its id and payload digest (exactly-once for late
    /// retries); receipts, actors and terminal rejections are kept. Stops at
    /// the first entry without a readable record time. One transaction.
    pub fn compact(&mut self, cutoff_iso: &str, keep_latest: i64) -> Result<CompactionReport, RepositoryError> {
        let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|_| RepositoryError::Internal)?;
        let floor: i64 = tx.query_row("SELECT history_floor FROM server_stream_state WHERE project_id = ?1", [&self.project_id], |r| r.get(0))
            .map_err(|_| RepositoryError::IntegrityFailed)?;
        let revision: i64 = tx.query_row("SELECT revision FROM projects WHERE id = ?1", [&self.project_id], |r| r.get(0))
            .optional().map_err(|_| RepositoryError::IntegrityFailed)?.unwrap_or(0);
        let ceiling = revision - keep_latest.max(0);
        let mut trimmed: Vec<(i64, String, String)> = Vec::new();
        {
            let mut statement = tx.prepare(
                "SELECT l.server_revision, l.command_id, l.command_json, h.entry_json
                 FROM server_command_log l
                 LEFT JOIN server_recovery_history h ON h.project_id = l.project_id AND h.server_revision = l.server_revision
                 WHERE l.project_id = ?1 AND l.server_revision > ?2 AND l.server_revision <= ?3 ORDER BY l.server_revision",
            ).map_err(|_| RepositoryError::IntegrityFailed)?;
            let rows = statement.query_map(rusqlite::params![self.project_id, floor, ceiling], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?))
            }).map_err(|_| RepositoryError::IntegrityFailed)?;
            let mut expected = floor + 1;
            for row in rows {
                let (server_revision, command_id, command_json, entry_json) = row.map_err(|_| RepositoryError::IntegrityFailed)?;
                if server_revision != expected { break; }
                let recorded = entry_json
                    .and_then(|json| serde_json::from_str::<ConfirmedHistoryEntry>(&json).ok())
                    .and_then(|entry| entry.recorded_at_iso);
                match recorded {
                    Some(at) if at.as_str() < cutoff_iso => {}
                    _ => break,
                }
                trimmed.push((server_revision, command_id, command_sha256(&command_json)));
                expected += 1;
            }
        }
        let Some(&(new_floor, _, _)) = trimmed.last() else {
            return Ok(CompactionReport { previous_floor: floor, history_floor: floor, trimmed: 0 });
        };
        for (server_revision, command_id, digest) in &trimmed {
            tx.execute(
                "INSERT INTO server_compacted_command(project_id, command_id, server_revision, command_sha256) VALUES(?1, ?2, ?3, ?4)",
                rusqlite::params![self.project_id, command_id, server_revision, digest],
            ).map_err(|_| RepositoryError::IntegrityFailed)?;
        }
        tx.execute("DELETE FROM server_command_log WHERE project_id = ?1 AND server_revision <= ?2", rusqlite::params![self.project_id, new_floor])
            .map_err(|_| RepositoryError::IntegrityFailed)?;
        tx.execute("DELETE FROM server_recovery_history WHERE project_id = ?1 AND server_revision <= ?2", rusqlite::params![self.project_id, new_floor])
            .map_err(|_| RepositoryError::IntegrityFailed)?;
        tx.execute("UPDATE server_stream_state SET history_floor = ?1 WHERE project_id = ?2", rusqlite::params![new_floor, self.project_id])
            .map_err(|_| RepositoryError::IntegrityFailed)?;
        tx.commit().map_err(|_| RepositoryError::IntegrityFailed)?;
        Ok(CompactionReport { previous_floor: floor, history_floor: new_floor, trimmed: trimmed.len() })
    }

    fn record_rejection(
        &mut self,
        command_id: &str,
        command_json: &str,
        actor: &Option<String>,
        result: &ProductCommandResult,
    ) -> Result<(), RepositoryError> {
        let result_json = serde_json::to_string(result).map_err(|_| RepositoryError::IntegrityFailed)?;
        let tx = self.conn.transaction().map_err(|_| RepositoryError::Internal)?;
        tx.execute(
            "INSERT OR IGNORE INTO server_rejection_log(project_id, command_id, command_json, result_json) VALUES(?1, ?2, ?3, ?4)",
            rusqlite::params![self.project_id, command_id, command_json, result_json],
        ).map_err(|_| RepositoryError::IntegrityFailed)?;
        tx.execute("INSERT OR IGNORE INTO server_command_actor(project_id, command_id, actor_id) VALUES(?1, ?2, ?3)",
            rusqlite::params![self.project_id, command_id, actor]).map_err(|_| RepositoryError::IntegrityFailed)?;
        tx.commit().map_err(|_| RepositoryError::Internal)
    }

    /// Graph, epoch, original command identities and typed terminal outcomes
    /// are read from one SQLite snapshot. The route retains membership and the
    /// project mutex while this cut is taken.
    pub fn recovery_envelope(&self) -> Result<RecoveryEnvelope, RepositoryError> {
        let tx = self.conn.unchecked_transaction().map_err(|_| RepositoryError::Internal)?;
        let (stream_epoch, history_floor): (i64, i64) = tx.query_row(
            "SELECT stream_epoch, history_floor FROM server_stream_state WHERE project_id = ?1",
            [&self.project_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|_| RepositoryError::IntegrityFailed)?;
        let graph = capture_graph(&tx, &self.project_id)?;
        let mut confirmed_history = Vec::new();
        {
            let mut statement = tx.prepare(
                "SELECT l.server_revision, l.command_json, r.result_json, h.entry_json, r.target_revision, r.base_revision, r.actor_id, a.command_id
                 FROM server_command_log l
                 LEFT JOIN product_command_receipt r ON r.project_id = l.project_id AND r.command_id = l.command_id
                 LEFT JOIN server_recovery_history h ON h.project_id = l.project_id AND h.server_revision = l.server_revision
                 LEFT JOIN server_command_actor a ON a.project_id = l.project_id AND a.command_id = l.command_id
                 WHERE l.project_id = ?1 AND l.server_revision > ?2 ORDER BY l.server_revision",
            ).map_err(|_| RepositoryError::IntegrityFailed)?;
            let rows = statement.query_map(rusqlite::params![self.project_id, history_floor], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, Option<i64>>(4)?, row.get::<_, Option<i64>>(5)?, row.get::<_, Option<String>>(6)?, row.get::<_, Option<String>>(7)?))
            }).map_err(|_| RepositoryError::IntegrityFailed)?;
            for row in rows {
                let (revision, wire_json, result_json, entry_json, receipt_target, receipt_base, receipt_actor, original_binding) = row.map_err(|_| RepositoryError::IntegrityFailed)?;
                let command: ImmutableCommand = serde_json::from_str(&wire_json).map_err(|_| RepositoryError::IntegrityFailed)?;
                if receipt_target != Some(revision) || receipt_base != Some(command.typed.base_revision()) {
                    return Err(RepositoryError::IntegrityFailed);
                }
                let result: ProductCommandResult = serde_json::from_str(&result_json.ok_or(RepositoryError::IntegrityFailed)?)
                    .map_err(|_| RepositoryError::IntegrityFailed)?;
                let entry = if let Some(entry_json) = entry_json {
                    let entry: ConfirmedHistoryEntry = serde_json::from_str(&entry_json).map_err(|_| RepositoryError::IntegrityFailed)?;
                    if entry.command.wire != command.wire || entry.result != result { return Err(RepositoryError::IntegrityFailed); }
                    entry
                } else {
                    // Historic receipts are retained byte-for-byte. Missing
                    // removed descendants/IDs/prior assignments are unavailable,
                    // never converted to an empty complete footprint.
                    let known_targets = pmapp_core::db::recovery_graph::known_targets(&command.wire).into_values().collect::<Vec<_>>();
                    let footprint = RecoveryFootprints {
                        availability: "unavailable".into(), known_targets,
                        reason: Some("HISTORICAL_TRANSACTION_FOOTPRINT_UNAVAILABLE".into()),
                    };
                    ConfirmedHistoryEntry {
                        payload_digest: payload_digest(&command)?, actor_id: receipt_actor,
                        wire_identity_availability: if original_binding.is_some() { "original" } else { "legacy-admitted-wire" }.into(),
                        protocol_version: pmapp_core::protocol::PROTOCOL_VERSION.into(), server_revision: revision,
                        receipt_revision_availability: match &result {
                            ProductCommandResult::ProductCommandApplied(applied) if applied.target_revision == revision => "authoritative",
                            _ => "legacy-client-revision",
                        }.into(),
                        recorded_at_iso: None, label: None, command_footprint: footprint.clone(), effect_footprint: footprint,
                        deletion_metadata: deletion_metadata(&result), command, result,
                    }
                };
                confirmed_history.push(entry);
            }
        }
        let mut terminal_rejections = Vec::new();
        {
            let mut statement = tx.prepare(
                "SELECT r.command_json, r.result_json, a.actor_id, a.command_id FROM server_rejection_log r LEFT JOIN server_command_actor a ON a.project_id = r.project_id AND a.command_id = r.command_id WHERE r.project_id = ?1 ORDER BY r.command_id",
            ).map_err(|_| RepositoryError::IntegrityFailed)?;
            let rows = statement.query_map([&self.project_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, Option<String>>(3)?)))
                .map_err(|_| RepositoryError::IntegrityFailed)?;
            for row in rows {
                let (wire_json, result_json, actor, original_binding) = row.map_err(|_| RepositoryError::IntegrityFailed)?;
                let command: ImmutableCommand = serde_json::from_str(&wire_json).map_err(|_| RepositoryError::IntegrityFailed)?;
                let result = serde_json::from_str(&result_json).map_err(|_| RepositoryError::IntegrityFailed)?;
                terminal_rejections.push(TerminalRejection {
                    wire_identity_availability: if original_binding.is_some() { "original" } else { "legacy-admitted-wire" }.into(),
                    payload_digest: payload_digest(&command)?, actor_id: actor.or_else(|| command.typed.actor_id().map(str::to_owned)),
                    protocol_version: pmapp_core::protocol::PROTOCOL_VERSION.into(), command, result,
                });
            }
        }
        let envelope = RecoveryEnvelope {
            version: 1, protocol_version: pmapp_core::protocol::PROTOCOL_VERSION.into(), project_id: self.project_id.clone(),
            stream_epoch, server_revision: graph.project.revision, history_floor, dedup_coverage: "complete".into(),
            graph, confirmed_history, terminal_rejections,
        };
        envelope.validate(&self.project_id).map_err(|_| RepositoryError::IntegrityFailed)?;
        tx.commit().map_err(|_| RepositoryError::Internal)?;
        Ok(envelope)
    }

    pub fn recovery_cut(&self, since: i64, epoch: Option<i64>) -> Result<RecoveryCut, RepositoryError> {
        // One read transaction gives a coherent graph/history/epoch cut. A
        // caller must never combine graph from this cut with another revision.
        let envelope = self.recovery_envelope()?;
        let resync_required = epoch != Some(envelope.stream_epoch) || since < envelope.history_floor
            || since > envelope.server_revision || since < 0;
        let stream_epoch = envelope.stream_epoch;
        let server_revision = envelope.server_revision;
        if resync_required {
            Ok(RecoveryCut { stream_epoch, server_revision, resync_required: true, envelope: Some(envelope), commands: vec![] })
        } else {
            let commands = envelope.confirmed_history.into_iter().filter(|entry| entry.server_revision > since).collect();
            Ok(RecoveryCut { stream_epoch, server_revision, resync_required: false, envelope: None, commands })
        }
    }

    pub fn history_entry(&self, revision: i64) -> Result<ConfirmedHistoryEntry, RepositoryError> {
        self.recovery_envelope()?.confirmed_history.into_iter().find(|entry| entry.server_revision == revision)
            .ok_or(RepositoryError::IntegrityFailed)
    }

    /// Catch a client up: the committed commands after `since_revision`, or a
    /// resync signal with a snapshot when the revision is unknown/too old.
    /// A gap (a revision not in the retained log) triggers `resync_required`.
    pub fn catch_up(&self, since_revision: i64) -> Result<CatchUp, RepositoryError> {
        let current = self.revision()?;
        if since_revision > current || since_revision < 0 {
            // Unknown/future revision → require a snapshot.
            return Ok(CatchUp {
                revision: current,
                commands: Vec::new(),
                resync_required: true,
                snapshot: Some(self.snapshot()?),
            });
        }
        if since_revision == current {
            return Ok(CatchUp { revision: current, commands: Vec::new(), resync_required: false, snapshot: None });
        }

        // Contiguous suffix: every logged command with server_revision in
        // (since_revision, current]. A missing revision in that range is a gap.
        let mut stmt = self
            .conn
            .prepare(
                "SELECT server_revision, command_json FROM server_command_log
                 WHERE project_id = ?1 AND server_revision > ?2 ORDER BY server_revision ASC",
            )
            .map_err(|_| RepositoryError::IntegrityFailed)?;
        let rows = stmt
            .query_map(rusqlite::params![self.project_id, since_revision], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|_| RepositoryError::IntegrityFailed)?;

        let mut commands = Vec::new();
        let mut expected = since_revision + 1;
        for row in rows {
            let (target, command_json) = row.map_err(|_| RepositoryError::IntegrityFailed)?;
            if target != expected {
                // A gap: the retained log cannot bridge it → resync.
                return Ok(CatchUp {
                    revision: current,
                    commands: Vec::new(),
                    resync_required: true,
                    snapshot: Some(self.snapshot()?),
                });
            }
            expected += 1;
            match serde_json::from_str(&command_json) {
                Ok(command) => commands.push(LoggedCommand { server_revision: target, command }),
                Err(_) => {
                    // A corrupt log row cannot be replayed; resync with a
                    // snapshot rather than failing the whole catch-up.
                    return Ok(CatchUp {
                        revision: current,
                        commands: Vec::new(),
                        resync_required: true,
                        snapshot: Some(self.snapshot()?),
                    });
                }
            }
        }
        if expected != current + 1 {
            return Ok(CatchUp { revision: current, commands: Vec::new(), resync_required: true, snapshot: Some(self.snapshot()?) });
        }
        Ok(CatchUp { revision: current, commands, resync_required: false, snapshot: None })
    }

    /// A complete canonical snapshot for resync: the full portable graph
    /// (nodes, phases, edges, custom fields, questions, forecast plan and
    /// scenarios) plus the project revision, taken at one serialization point
    /// (H07, R5). Reuses the same core read path the desktop uses, so the
    /// server and client agree on the graph.
    pub fn snapshot(&self) -> Result<serde_json::Value, RepositoryError> {
        let rows = pmapp_core::db::runtime::query_project_snapshot(&self.conn, &self.project_id)?;
        if rows.forecast_plan_error.is_some() { return Err(RepositoryError::IntegrityFailed); }
        let mut value = serde_json::to_value(&rows).map_err(|_| RepositoryError::IntegrityFailed)?;
        // Carry the server revision alongside the graph so the client can seed
        // its cursor from the snapshot (R5).
        if let Some(obj) = value.as_object_mut() {
            obj.insert("serverRevision".to_string(), serde_json::json!(self.revision()?));
        }
        Ok(value)
    }

    /// Persist the immutable share intent before the atomic graph import.
    /// A restart between import and activation can finish this exact operation;
    /// it cannot import a second graph or substitute a changed snapshot.
    pub fn provision_snapshot(&mut self, operation_id: &str, snapshot: &pmapp_core::db::runtime::PortableImportSnapshot) -> Result<(), RepositoryError> {
        if snapshot.project_id != self.project_id || operation_id.is_empty() || operation_id.len() > 128 {
            return Err(RepositoryError::IntegrityFailed);
        }
        for position in snapshot.phases.iter().map(|p| &p.position).chain(snapshot.nodes.iter().map(|n| &n.position)) {
            position.parse::<i64>().map_err(|_| RepositoryError::IntegrityFailed)?;
        }
        let snapshot_json = serde_json::to_string(snapshot).map_err(|_| RepositoryError::IntegrityFailed)?;
        let intent: Option<(String, String, bool)> = self.conn.query_row(
            "SELECT operation_id, snapshot_json, complete FROM server_share_intent WHERE project_id = ?1", [&self.project_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).optional().map_err(|_| RepositoryError::IntegrityFailed)?;
        if let Some((stored_id, stored_json, complete)) = intent {
            if stored_id != operation_id || stored_json != snapshot_json { return Err(RepositoryError::IntegrityFailed); }
            if complete { return Ok(()); }
        } else {
            // Re-sharing an existing graph requires a new stream epoch/rebase
            // protocol; refuse instead of silently replacing committed state.
            if self.revision()? != 0 { return Err(RepositoryError::IntegrityFailed); }
            self.conn.execute("INSERT INTO server_share_intent(project_id, operation_id, snapshot_json) VALUES(?1, ?2, ?3)",
                rusqlite::params![self.project_id, operation_id, snapshot_json]).map_err(|_| RepositoryError::IntegrityFailed)?;
        }
        if self.revision()? == 0 {
            let result = pmapp_core::db::runtime::batch_import_portable(&mut self.conn, snapshot)?;
            if result.get("ok").and_then(|v| v.as_bool()) != Some(true) { return Err(RepositoryError::IntegrityFailed); }
        }
        // The owner's copy keeps its revision: portable import restarts at 1,
        // but a shared stream must never move the sharing client backwards
        // (its read model and command queue already sit at the snapshot's
        // revision). Adopted in the completion transaction, before any command
        // can be admitted, so a crash-retry converges to the same revision.
        let imported_revision = self.revision()?.max(snapshot.project_revision);
        let tx = self.conn.transaction().map_err(|_| RepositoryError::Internal)?;
        tx.execute("UPDATE projects SET revision = ?1 WHERE id = ?2 AND revision < ?1", rusqlite::params![imported_revision, self.project_id])
            .map_err(|_| RepositoryError::IntegrityFailed)?;
        tx.execute("UPDATE server_stream_state SET history_floor = ?1 WHERE project_id = ?2", rusqlite::params![imported_revision, self.project_id])
            .map_err(|_| RepositoryError::IntegrityFailed)?;
        tx.execute("UPDATE server_share_intent SET complete = 1 WHERE project_id = ?1", [&self.project_id]).map_err(|_| RepositoryError::IntegrityFailed)?;
        tx.commit().map_err(|_| RepositoryError::Internal)?;

        Ok(())
    }

    /// Register the project row so the first command has a home. (The core
    /// `CreateProject` command does this; this is the service bootstrap.)
    pub fn ensure_project(&mut self, name: &str, command_id: &str) -> Result<i64, RepositoryError> {
        if self.revision()? > 0 {
            return self.revision();
        }
        let cmd = ProductCommand::CreateProject(pmapp_core::protocol::CreateProjectCommand {
            type_name: String::new(),
            protocol_version: pmapp_core::protocol::PROTOCOL_VERSION.to_string(),
            command_id: command_id.to_string(),
            project_id: self.project_id.clone(),
            base_revision: 0,
            expected_revision: 1,
            name: name.to_string(),
            actor_id: None,
        });
        // Route through submit so the project-creation command is logged in the
        // same transaction as its state/receipt/revision (H02).
        self.submit(cmd)?;
        self.revision()
    }
}

/// Path helper: one file per project under the data dir (D3).
///
/// `project_id` is URL-supplied. It is validated as a UUIDv7-shaped token before
/// touching the filesystem, so a crafted id can never traverse out of
/// `data_dir` (`..`, separators, absolute paths) (H-review).
pub fn project_db_path(data_dir: &Path, project_id: &str) -> PathBuf {
    debug_assert!(is_safe_project_id(project_id), "unsafe project id reached project_db_path");
    let safe = if is_safe_project_id(project_id) { project_id } else { "invalid" };
    data_dir.join(format!("project-{safe}.sqlite"))
}

/// True when `value` is 36 ASCII chars of the UUID alphabet (`0-9a-f-`) with no
/// path separators or dots. Cheap, allocation-free, and stricter than needed so
/// the filesystem is only ever given a safe token.
pub fn is_safe_project_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}


/// The most commands one composite gesture may carry.
pub const MAX_GROUP_MEMBERS: usize = 200;

/// A command that passed admission and is ready to apply.
struct FreshCommand {
    command: ProductCommand,
    immutable: ImmutableCommand,
    command_id: String,
    command_json: String,
    actor_binding: Option<String>,
}

enum Prepared {
    Done(ProductCommandResult),
    Fresh(FreshCommand),
}

fn rejected_result(command_id: &str, project_id: &str, code: &str) -> ProductCommandResult {
    ProductCommandResult::ProductCommandRejected(pmapp_core::protocol::ProductCommandRejected {
        result_type: "ProductCommandRejected".to_string(),
        protocol_version: pmapp_core::protocol::PROTOCOL_VERSION.to_string(),
        command_id: command_id.to_string(),
        code: code.to_string(),
        expected_revision: None,
        project_id: Some(project_id.to_string()),
        node_id: None,
        person_id: None,
        conflicting_feature_ids: None,
        feature_id: None,
        column: None,
    })
}

/// What one compaction pass did (Story 28.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionReport {
    pub previous_floor: i64,
    pub history_floor: i64,
    pub trimmed: usize,
}

/// Lowercase hex SHA-256 of a stored command serialization.
fn command_sha256(command_json: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(command_json.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn identity_conflict_result(command_id: &str, project_id: &str) -> ProductCommandResult {
    rejected_result(command_id, project_id, "COMMAND_IDENTITY_CONFLICT")
}

fn result_command_id(result: &ProductCommandResult) -> String {
    serde_json::to_value(result).ok()
        .and_then(|v| v.get("commandId").and_then(|id| id.as_str()).map(str::to_owned))
        .unwrap_or_default()
}

fn capture_before(tx: &rusqlite::Transaction, project_id: &str) -> Result<Option<RecoveryGraph>, RepositoryError> {
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
        [project_id], |row| row.get(0),
    ).map_err(|_| RepositoryError::IntegrityFailed)?;
    if exists { capture_graph(tx, project_id).map(Some) } else { Ok(None) }
}

/// Append the server log, actor binding and recovery history rows for one
/// applied command inside the applying transaction.
#[allow(clippy::too_many_arguments)]
fn record_applied(
    tx: &rusqlite::Transaction,
    before: Option<RecoveryGraph>,
    project_id: &str,
    command_id: &str,
    command_json: &str,
    history_command: ImmutableCommand,
    history_actor: Option<String>,
    revision: i64,
) -> Result<(), RepositoryError> {
    let project_id = project_id.to_string();
        tx.execute(
            "INSERT INTO server_command_log(project_id, server_revision, command_id, command_json)
             VALUES(?1, ?2, ?3, ?4)",
            rusqlite::params![project_id, revision, command_id, command_json],
        ).map_err(|_| RepositoryError::IntegrityFailed)?;
        tx.execute("INSERT INTO server_command_actor(project_id, command_id, actor_id) VALUES(?1, ?2, ?3)",
            rusqlite::params![project_id, command_id, history_actor]).map_err(|_| RepositoryError::IntegrityFailed)?;
        let after = capture_graph(tx, &project_id)?;
        let before = before.unwrap_or_else(|| RecoveryGraph {
            project: RecoveryProjectRow { id: project_id.clone(), name: String::new(), revision: 0 },
            phases: vec![], nodes: vec![], custom_fields: vec![], type_template_fields: vec![],
            unlock_edges: vec![], dismissals: vec![], affected_reasons: vec![], open_questions: vec![],
            forecast_plans: vec![], forecast_scenarios: vec![],
        });
        let result_json: String = tx.query_row(
            "SELECT result_json FROM product_command_receipt WHERE command_id = ?1 AND project_id = ?2",
            rusqlite::params![command_id, project_id], |row| row.get(0),
        ).map_err(|_| RepositoryError::IntegrityFailed)?;
        let result: ProductCommandResult = serde_json::from_str(&result_json)
            .map_err(|_| RepositoryError::IntegrityFailed)?;
        let (command_footprint, effect_footprint) = cut_footprints(&history_command, &before, &after)?;
        let entry = ConfirmedHistoryEntry {
            payload_digest: payload_digest(&history_command)?,
            wire_identity_availability: "original".into(),
            actor_id: history_actor,
            protocol_version: pmapp_core::protocol::PROTOCOL_VERSION.into(),
            server_revision: revision,
            receipt_revision_availability: "authoritative".into(),
            recorded_at_iso: Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
            label: None,
            command_footprint,
            effect_footprint,
            deletion_metadata: deletion_metadata(&result),
            command: history_command,
            result,
        };
        tx.execute(
            "INSERT INTO server_recovery_history(project_id, server_revision, entry_json) VALUES(?1, ?2, ?3)",
            rusqlite::params![project_id, revision, serde_json::to_string(&entry).map_err(|_| RepositoryError::IntegrityFailed)?],
        ).map_err(|_| RepositoryError::IntegrityFailed)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pmapp_core::protocol::commands::{CreateNodeCommand, SetNodeTitleCommand};

    fn conn() -> ProjectLog {
        let mut log = ProjectLog::open_in_memory("019ff400-0000-7000-8000-000000000001").unwrap();
        log.ensure_project("Shared", "019ff400-0000-7000-8000-0000000000c0").unwrap();
        log
    }

    fn create_node(id: &str, command_id: &str, base: i64) -> ProductCommand {
        ProductCommand::CreateNode(CreateNodeCommand {
            command_name: String::new(),
            protocol_version: pmapp_core::protocol::PROTOCOL_VERSION.to_string(),
            command_id: command_id.to_string(),
            project_id: "019ff400-0000-7000-8000-000000000001".to_string(),
            base_revision: base,
            expected_revision: base + 1,
            node_id: id.to_string(),
            parent_id: None,
            position: "4294967296".to_string(),
            title: "A".to_string(),
            actor_id: None,
        })
    }

    const ACTOR: &str = "019ff400-0000-7000-8000-0000000000b1";

    fn missing_title(command_id: &str, base: i64) -> ProductCommand {
        ProductCommand::SetNodeTitle(SetNodeTitleCommand {
            command_name: String::new(),
            protocol_version: pmapp_core::protocol::PROTOCOL_VERSION.to_string(),
            command_id: command_id.to_string(),
            project_id: "019ff400-0000-7000-8000-000000000001".to_string(),
            base_revision: base,
            expected_revision: base + 1,
            node_id: "019ff400-0000-7000-8000-0000000000ff".to_string(),
            title: "X".to_string(),
            actor_id: None,
        })
    }

    fn wires(commands: &[ProductCommand]) -> Vec<serde_json::Value> {
        commands.iter().map(|c| serde_json::to_value(c).unwrap()).collect()
    }

    // ── Story 28.3: compaction (AC 27.8-6, R5/R9) ─────────────────────────
    const FAR_FUTURE: &str = "9999-01-01T00:00:00.000Z";

    /// A project with `n` committed creates by ACTOR (revisions 2..=n+1).
    fn with_history(n: u32) -> ProjectLog {
        let mut log = conn();
        let epoch = log.stream_epoch().unwrap();
        for i in 0..n {
            let base = log.revision().unwrap();
            let cmd = create_node(&format!("019ff400-0000-7000-8000-0000000a{:04x}", i), &format!("019ff400-0000-7000-8000-0000000d{:04x}", i), base);
            assert!(matches!(log.submit_wire_as_actor_in_epoch(serde_json::to_value(&cmd).unwrap(), epoch, ACTOR).unwrap(), ProductCommandResult::ProductCommandApplied(_)));
        }
        log
    }

    #[test]
    fn compaction_trims_old_history_keeps_the_newest_and_leaves_the_project_intact() {
        let mut log = with_history(6);
        let before = log.recovery_envelope().unwrap();
        let report = log.compact(FAR_FUTURE, 2).unwrap();
        // ensure_project is revision 1; creates are 2..=7; the newest 2 are kept.
        assert_eq!((report.previous_floor, report.history_floor), (before.history_floor, 5));
        let after = log.recovery_envelope().unwrap();
        assert_eq!(after.history_floor, 5);
        assert_eq!(after.server_revision, before.server_revision);
        assert_eq!(after.graph.nodes.len(), before.graph.nodes.len());
        assert_eq!(after.confirmed_history.iter().map(|h| h.server_revision).collect::<Vec<_>>(), vec![6, 7]);
        // Attribution on what remains is unchanged.
        assert!(after.confirmed_history.iter().all(|h| h.actor_id.as_deref() == Some(ACTOR)));
        // A second pass with nothing newly eligible is a no-op.
        assert_eq!(log.compact(FAR_FUTURE, 2).unwrap().trimmed, 0);
    }

    #[test]
    fn compaction_never_trims_history_newer_than_the_cutoff() {
        let mut log = with_history(3);
        let report = log.compact("2000-01-01T00:00:00.000Z", 0).unwrap();
        assert_eq!(report.trimmed, 0);
        assert_eq!(log.recovery_envelope().unwrap().confirmed_history.len(), 4);
    }

    #[test]
    fn a_client_behind_the_floor_resyncs_and_one_above_it_catches_up() {
        let mut log = with_history(5);
        log.compact(FAR_FUTURE, 2).unwrap();
        let epoch = log.stream_epoch().unwrap();
        let behind = log.recovery_cut(2, Some(epoch)).unwrap();
        assert!(behind.resync_required);
        assert!(behind.envelope.is_some());
        let caught_up = log.recovery_cut(4, Some(epoch)).unwrap();
        assert!(!caught_up.resync_required);
        assert_eq!(caught_up.commands.iter().map(|h| h.server_revision).collect::<Vec<_>>(), vec![5, 6]);
        // The live catch-up path agrees.
        assert!(log.catch_up(2).unwrap().resync_required);
        assert_eq!(log.catch_up(4).unwrap().commands.len(), 2);
    }

    #[test]
    fn a_late_retry_of_a_compacted_command_is_still_exactly_once() {
        let mut log = with_history(4);
        log.compact(FAR_FUTURE, 1).unwrap();
        let epoch = log.stream_epoch().unwrap();
        let revision = log.revision().unwrap();
        // Same id, same payload: the original result, no new revision.
        let original = create_node("019ff400-0000-7000-8000-0000000a0000", "019ff400-0000-7000-8000-0000000d0000", 1);
        let replay = log.submit_wire_as_actor_in_epoch(serde_json::to_value(&original).unwrap(), epoch, ACTOR).unwrap();
        assert!(matches!(replay, ProductCommandResult::ProductCommandApplied(_)), "{replay:?}");
        assert_eq!(log.revision().unwrap(), revision);
        // Same id, different payload: refused, nothing applied.
        let mut changed = original.clone();
        if let ProductCommand::CreateNode(c) = &mut changed { c.title = "Changed".into(); }
        let conflict = log.submit_wire_as_actor_in_epoch(serde_json::to_value(&changed).unwrap(), epoch, ACTOR).unwrap();
        assert!(matches!(conflict, ProductCommandResult::ProductCommandRejected(_)), "{conflict:?}");
        assert_eq!(log.revision().unwrap(), revision);
        // A viewer-style forced rejection of an already committed id records nothing new.
        assert!(log.in_server_log("019ff400-0000-7000-8000-0000000d0000").unwrap());
    }

    #[test]
    fn group_commits_every_member_at_consecutive_revisions_and_retries_idempotently() {
        let mut log = conn();
        let epoch = log.stream_epoch().unwrap();
        let group = [
            create_node("019ff400-0000-7000-8000-0000000000a1", "019ff400-0000-7000-8000-0000000000d1", 1),
            create_node("019ff400-0000-7000-8000-0000000000a2", "019ff400-0000-7000-8000-0000000000d2", 2),
        ];
        let results = log.submit_group_as_actor_in_epoch(wires(&group), epoch, ACTOR).unwrap();
        assert!(results.iter().all(|r| matches!(r, ProductCommandResult::ProductCommandApplied(_))));
        assert_eq!(log.revision().unwrap(), 3);
        let envelope = log.recovery_envelope().unwrap();
        assert_eq!(envelope.graph.nodes.len(), 2);
        assert_eq!(envelope.confirmed_history.iter().map(|h| h.server_revision).collect::<Vec<_>>(), vec![1, 2, 3]);
        // A retry of the committed group replays stored receipts; no new revisions.
        let again = log.submit_group_as_actor_in_epoch(wires(&group), epoch, ACTOR).unwrap();
        assert!(again.iter().all(|r| matches!(r, ProductCommandResult::ProductCommandApplied(a) if a.disposition != "NewCommit")));
        assert_eq!(log.revision().unwrap(), 3);
    }

    #[test]
    fn a_refused_member_rolls_back_the_whole_group_and_every_member_is_terminal() {
        let mut log = conn();
        let epoch = log.stream_epoch().unwrap();
        let group = [
            create_node("019ff400-0000-7000-8000-0000000000a1", "019ff400-0000-7000-8000-0000000000d1", 1),
            missing_title("019ff400-0000-7000-8000-0000000000d2", 2),
        ];
        let results = log.submit_group_as_actor_in_epoch(wires(&group), epoch, ACTOR).unwrap();
        let codes: Vec<String> = results.iter().map(|r| match r {
            ProductCommandResult::ProductCommandRejected(rej) => rej.code.clone(),
            _ => "APPLIED".into(),
        }).collect();
        assert_eq!(codes[0], "ATOMIC_GROUP_REJECTED");
        assert_ne!(codes[1], "APPLIED");
        // Nothing from the group committed: no node, no revision, no history.
        assert_eq!(log.revision().unwrap(), 1);
        let envelope = log.recovery_envelope().unwrap();
        assert!(envelope.graph.nodes.is_empty());
        assert_eq!(envelope.confirmed_history.len(), 1);
        // Recovery retains BOTH members as terminal rejections.
        assert_eq!(envelope.terminal_rejections.len(), 2);
        // A retry replays the stored answers; a lone resubmission of a member too.
        let again = log.submit_group_as_actor_in_epoch(wires(&group), epoch, ACTOR).unwrap();
        assert_eq!(serde_json::to_value(&again).unwrap().as_array().unwrap().len(), 2);
        assert!(again.iter().all(|r| matches!(r, ProductCommandResult::ProductCommandRejected(_))));
        let single = log.submit_wire_as_actor_in_epoch(wires(&group[..1]).remove(0), epoch, ACTOR).unwrap();
        assert!(matches!(single, ProductCommandResult::ProductCommandRejected(r) if r.code == "ATOMIC_GROUP_REJECTED"));
        assert_eq!(log.revision().unwrap(), 1);
    }

    #[test]
    fn a_group_must_be_new_or_wholly_committed_and_unique() {
        let mut log = conn();
        let epoch = log.stream_epoch().unwrap();
        let first = create_node("019ff400-0000-7000-8000-0000000000a1", "019ff400-0000-7000-8000-0000000000d1", 1);
        log.submit_wire_as_actor_in_epoch(serde_json::to_value(&first).unwrap(), epoch, ACTOR).unwrap();
        let second = create_node("019ff400-0000-7000-8000-0000000000a2", "019ff400-0000-7000-8000-0000000000d2", 2);
        assert!(matches!(log.submit_group_as_actor_in_epoch(wires(&[first.clone(), second.clone()]), epoch, ACTOR),
            Err(RepositoryError::CommandIdentityConflict)));
        assert!(matches!(log.submit_group_as_actor_in_epoch(wires(&[second.clone(), second.clone()]), epoch, ACTOR),
            Err(RepositoryError::InvalidRequest)));
        assert!(matches!(log.submit_group_as_actor_in_epoch(Vec::new(), epoch, ACTOR), Err(RepositoryError::InvalidRequest)));
        assert!(matches!(log.submit_group_as_actor_in_epoch(wires(&[second]), epoch + 1, ACTOR), Err(RepositoryError::ResyncRequired)));
        assert_eq!(log.revision().unwrap(), 2);
    }

    #[test]
    fn a_shared_forecast_with_people_and_scope_bootstraps() {
        let mut log = ProjectLog::open_in_memory("019ff400-0000-7000-8000-000000000001").unwrap();
        let snapshot: pmapp_core::db::runtime::PortableImportSnapshot = serde_json::from_value(serde_json::json!({
            "projectId":"019ff400-0000-7000-8000-000000000001", "projectName":"Forecast", "projectRevision":9,
            "phases":[], "nodes":[{"id":"019ff400-0000-7000-8000-0000000000a1","parentId":null,"title":"Feature Alpha","bodyText":null,
                "position":"4294967296","nodeType":"Feature","startDate":null,"endDate":null,"durationDays":null,"scheduleSourceMode":null,
                "completed":false,"effortPoints":null,"effortPointsDone":null,"strategicWeight":null,"phaseId":null,"deliveryStatus":"not_started"}],
            "nodeCustomFields":[], "typeTemplateFields":[], "unlockEdges":[], "findingDismissals":[], "affectedReasons":[], "openQuestions":[],
            "forecastPlan":{"selectedFeatureIds":["019ff400-0000-7000-8000-0000000000a1"],"parallelGroups":[],"pointsPerSprint":20,"sprintLengthDays":14,
                "cadence":"fixed-contiguous","startSprintOrdinal":12,"startDate":"2026-09-07","policyVersion":"staffed-capacity-v1","planningLevel":"Feature",
                "roster":[{"id":"019ff400-0000-7000-8000-0000000000b1","name":"Ada","weightUnits":100},{"id":"019ff400-0000-7000-8000-0000000000b2","name":"Ben","weightUnits":100}],
                "assignments":{}}
        })).unwrap();
        log.provision_snapshot("op-forecast", &snapshot).unwrap();
        let envelope = log.recovery_envelope();
        assert!(envelope.is_ok(), "{envelope:?}");
    }

    fn empty_share_snapshot() -> pmapp_core::db::runtime::PortableImportSnapshot {
        serde_json::from_value(serde_json::json!({
            "projectId":"019ff400-0000-7000-8000-000000000001", "projectName":"Captured graph", "projectRevision":42,
            "phases":[], "nodes":[], "nodeCustomFields":[], "typeTemplateFields":[], "unlockEdges":[],
            "findingDismissals":[], "affectedReasons":[], "openQuestions":[]
        })).unwrap()
    }

    #[test]
    fn share_retry_recovers_import_commit_before_completion_marker() {
        let mut log = ProjectLog::open_in_memory("019ff400-0000-7000-8000-000000000001").unwrap();
        let snapshot = empty_share_snapshot();
        log.provision_snapshot("op-1", &snapshot).unwrap();
        assert_eq!(log.revision().unwrap(), 42, "the shared stream continues from the owner's revision");
        let envelope = log.recovery_envelope().unwrap();
        assert_eq!((envelope.server_revision, envelope.history_floor), (42, 42));
        // Model crash after atomic import, before completing the intent journal.
        log.conn.execute("UPDATE server_share_intent SET complete = 0", []).unwrap();
        log.provision_snapshot("op-1", &snapshot).unwrap();
        assert_eq!(log.revision().unwrap(), 42);
        assert_eq!(log.snapshot().unwrap()["projectName"], "Captured graph");
        let mut changed = snapshot.clone(); changed.project_name = "Substituted".into();
        assert!(log.provision_snapshot("op-1", &changed).is_err());
    }

    #[test]
    fn failed_share_import_rolls_back_all_graph_rows() {
        let mut log = ProjectLog::open_in_memory("019ff400-0000-7000-8000-000000000001").unwrap();
        let mut snapshot = empty_share_snapshot();
        snapshot.nodes.push(serde_json::from_value(serde_json::json!({
            "id":"019ff400-0000-7000-8000-0000000000a1", "title":"Synthetic", "position":"1", "completed":false,
            "phaseId":"019ff400-0000-7000-8000-0000000000ff"
        })).unwrap());
        assert!(log.provision_snapshot("op-1", &snapshot).is_err());
        assert_eq!(log.revision().unwrap(), 0);
        let count:i64 = log.conn.query_row("SELECT COUNT(*) FROM nodes", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
        assert!(log.provision_snapshot("op-1", &snapshot).is_err());
    }

    #[test]
    fn assigns_contiguous_revisions_and_orders_the_log() {
        let mut log = conn();
        assert_eq!(log.revision().unwrap(), 1);
        let r1 = log.submit(create_node("019ff400-0000-7000-8000-0000000000a1", "019ff400-0000-7000-8000-0000000000d1", 1)).unwrap();
        assert!(matches!(r1, ProductCommandResult::ProductCommandApplied(_)));
        assert_eq!(log.revision().unwrap(), 2);
        let r2 = log.submit(create_node("019ff400-0000-7000-8000-0000000000a2", "019ff400-0000-7000-8000-0000000000d2", 2)).unwrap();
        assert!(matches!(r2, ProductCommandResult::ProductCommandApplied(_)));
        assert_eq!(log.revision().unwrap(), 3);
    }

    /// H02: the server command log advances atomically with state/revision. After
    /// every commit, the log has exactly one row per revision with no gap.
    #[test]
    fn command_log_and_revision_advance_atomically() {
        let mut log = conn();
        log.submit(create_node("019ff400-0000-7000-8000-0000000000a1", "019ff400-0000-7000-8000-0000000000d1", 1)).unwrap();
        log.submit(create_node("019ff400-0000-7000-8000-0000000000a2", "019ff400-0000-7000-8000-0000000000d2", 2)).unwrap();
        let revision = log.revision().unwrap();
        let logged: Vec<i64> = log
            .conn
            .prepare("SELECT server_revision FROM server_command_log WHERE project_id = ?1 ORDER BY server_revision ASC")
            .unwrap()
            .query_map(rusqlite::params![&log.project_id], |r| r.get(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        // Revisions 1..=revision are present exactly once (no gap, no duplicate).
        assert_eq!(logged, (1..=revision).collect::<Vec<_>>());
        // And every revision in the log is replayable via catch_up.
        let up = log.catch_up(0).unwrap();
        assert_eq!(up.revision, revision);
        assert_eq!(up.commands.len() as i64, revision);
    }

    #[test]
    fn duplicate_command_id_is_exactly_once() {
        let mut log = conn();
        let cmd = create_node("019ff400-0000-7000-8000-0000000000a1", "019ff400-0000-7000-8000-0000000000d1", 1);
        let first = log.submit(cmd.clone()).unwrap();
        assert!(matches!(first, ProductCommandResult::ProductCommandApplied(_)));
        let revision_after = log.revision().unwrap();
        let dup = log.submit(cmd).unwrap();
        match dup {
            ProductCommandResult::ProductCommandApplied(a) => assert_eq!(a.disposition, "StoredResultReturned"),
            _ => panic!("expected replay"),
        }
        assert_eq!(log.revision().unwrap(), revision_after, "duplicate must not advance");
    }

    /// H03: a terminal domain rejection is durable. An identical retry replays
    /// the recorded rejection and never applies.
    #[test]
    fn a_domain_rejection_is_durable_and_replayed() {
        let mut log = conn();
        // A SetNodeTitle on a node that does not exist is rejected.
        let cmd = ProductCommand::SetNodeTitle(SetNodeTitleCommand {
            command_name: String::new(),
            protocol_version: pmapp_core::protocol::PROTOCOL_VERSION.to_string(),
            command_id: "019ff400-0000-7000-8000-0000000000e1".to_string(),
            project_id: "019ff400-0000-7000-8000-000000000001".to_string(),
            base_revision: 1,
            expected_revision: 2,
            node_id: "019ff400-0000-7000-8000-0000000000ff".to_string(),
            title: "X".to_string(),
            actor_id: None,
        });
        let first = log.submit(cmd.clone()).unwrap();
        assert!(matches!(first, ProductCommandResult::ProductCommandRejected(_)));
        assert_eq!(log.revision().unwrap(), 1, "a rejection consumes no revision");
        // The identical retry replays the recorded rejection without re-applying.
        let again = log.submit(cmd).unwrap();
        match again {
            ProductCommandResult::ProductCommandRejected(r) => assert_eq!(r.code, first_code(&first)),
            _ => panic!("expected the recorded rejection to replay"),
        }
    }

    fn first_code(result: &ProductCommandResult) -> String {
        match result {
            ProductCommandResult::ProductCommandRejected(r) => r.code.clone(),
            _ => String::new(),
        }
    }

    #[test]
    fn catch_up_returns_the_contiguous_suffix() {
        let mut log = conn();
        log.submit(create_node("019ff400-0000-7000-8000-0000000000a1", "019ff400-0000-7000-8000-0000000000d1", 1)).unwrap();
        log.submit(create_node("019ff400-0000-7000-8000-0000000000a2", "019ff400-0000-7000-8000-0000000000d2", 2)).unwrap();
        // A client at revision 1 sees the two commands after it.
        let up = log.catch_up(1).unwrap();
        assert!(!up.resync_required);
        assert_eq!(up.revision, 3);
        assert_eq!(up.commands.len(), 2);
        // A client already current sees nothing.
        let current = log.catch_up(3).unwrap();
        assert_eq!(current.commands.len(), 0);
    }

    #[test]
    fn missing_trailing_log_revision_requires_resync() {
        let mut log = conn();
        log.submit(create_node("019ff400-0000-7000-8000-0000000000a1", "019ff400-0000-7000-8000-0000000000d1", 1)).unwrap();
        log.conn.execute("DELETE FROM server_command_log WHERE server_revision = 2", []).unwrap();
        let up = log.catch_up(1).unwrap();
        assert!(up.resync_required);
        assert!(up.commands.is_empty());
        assert!(up.snapshot.is_some());
    }

    #[test]
    fn unknown_or_future_revision_requires_resync_with_snapshot() {
        let mut log = conn();
        log.submit(create_node("019ff400-0000-7000-8000-0000000000a1", "019ff400-0000-7000-8000-0000000000d1", 1)).unwrap();
        let future = log.catch_up(99).unwrap();
        assert!(future.resync_required);
        assert!(future.snapshot.is_some());
        let negative = log.catch_up(-1).unwrap();
        assert!(negative.resync_required);
    }

    #[test]
    fn snapshot_carries_revision_and_nodes() {
        let mut log = conn();
        log.submit(create_node("019ff400-0000-7000-8000-0000000000a1", "019ff400-0000-7000-8000-0000000000d1", 1)).unwrap();
        let snap = log.snapshot().unwrap();
        assert_eq!(snap["revision"], 2);
        assert_eq!(snap["nodes"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn legacy_stale_revision_receipt_is_retained_with_explicit_unavailability() {
        let mut log = conn();
        log.submit(create_node("019ff400-0000-7000-8000-0000000000a1", "019ff400-0000-7000-8000-0000000000d1", 1)).unwrap();
        let id = "019ff400-0000-7000-8000-0000000000d2";
        let result = log.submit(create_node("019ff400-0000-7000-8000-0000000000a2", id, 1)).unwrap();
        let ProductCommandResult::ProductCommandApplied(mut legacy) = result else { panic!("applied"); };
        legacy.base_revision = 1;
        legacy.target_revision = 2;
        let changes = legacy.change_set.as_mut().unwrap();
        changes.base_revision = 1;
        changes.target_revision = 2;
        let legacy_result = ProductCommandResult::ProductCommandApplied(legacy.clone());
        log.conn.execute("DELETE FROM server_recovery_history WHERE server_revision = 3", []).unwrap();
        log.conn.execute("UPDATE product_command_receipt SET result_json = ?1 WHERE command_id = ?2", rusqlite::params![serde_json::to_string(&legacy_result).unwrap(), id]).unwrap();
        let envelope = log.recovery_envelope().unwrap();
        let entry = &envelope.confirmed_history[2];
        assert_eq!(entry.server_revision, 3);
        assert_eq!(entry.receipt_revision_availability, "legacy-client-revision");
        assert_eq!(entry.result, legacy_result);
        for (field, value) in [("commandId", serde_json::json!("019ff400-0000-7000-8000-0000000000d9")), ("projectId", serde_json::json!("019ff400-0000-7000-8000-000000000009")), ("targetRevision", serde_json::json!(7))] {
            let mut malformed = serde_json::to_value(&legacy_result).unwrap();
            malformed[field] = value;
            log.conn.execute("UPDATE product_command_receipt SET result_json = ?1 WHERE command_id = ?2", rusqlite::params![malformed.to_string(), id]).unwrap();
            assert!(matches!(log.recovery_envelope(), Err(RepositoryError::IntegrityFailed)));
        }
    }

    #[test]
    fn recovery_cut_retains_raw_identity_and_unavailable_legacy_metadata() {
        let mut log = conn();
        let command = create_node("019ff400-0000-7000-8000-0000000000a1", "019ff400-0000-7000-8000-0000000000d1", 1);
        let mut wire = serde_json::to_value(command).unwrap();
        wire.as_object_mut().unwrap().remove("actorId");
        let epoch = log.stream_epoch().unwrap();
        log.submit_wire_in_epoch(wire.clone(), epoch).unwrap();
        let envelope = log.recovery_envelope().unwrap();
        assert_eq!((envelope.stream_epoch, envelope.server_revision), (epoch, 2));
        assert_eq!(envelope.graph.nodes.len(), 1);
        assert_eq!(envelope.confirmed_history.len(), 2);
        assert_eq!(envelope.confirmed_history[1].command.wire, wire);
        assert_eq!(envelope.confirmed_history[1].command_footprint.availability, "complete");
        log.conn.execute("DELETE FROM server_recovery_history WHERE server_revision = 2", []).unwrap();
        let historic = log.recovery_envelope().unwrap();
        let entry = &historic.confirmed_history[1];
        assert_eq!(entry.command.wire, wire);
        assert_eq!(entry.command_footprint.availability, "unavailable");
        assert_eq!(entry.effect_footprint.reason.as_deref(), Some("HISTORICAL_TRANSACTION_FOOTPRINT_UNAVAILABLE"));
        assert!(entry.recorded_at_iso.is_none());
        assert!(entry.label.is_none());
    }

    #[test]
    fn server_ordered_path_assigns_revisions_and_accepts_stale_bases() {
        let mut log = conn();
        log.submit(create_node("019ff400-0000-7000-8000-0000000000a1", "019ff400-0000-7000-8000-0000000000d1", 1)).unwrap();
        assert_eq!(log.revision().unwrap(), 2);
        // On the server-ordered shared path the server owns the revision: a
        // command whose client base is stale (1 when current is 2) still applies
        // and is assigned the next revision (2 -> 3). Rebase re-applies commands
        // whose base advanced past their original value (R2/AC 27.3-4, H03).
        let second = log.submit(create_node("019ff400-0000-7000-8000-0000000000a2", "019ff400-0000-7000-8000-0000000000d2", 1)).unwrap();
        let ProductCommandResult::ProductCommandApplied(applied) = &second else { panic!("applied"); };
        assert_eq!((applied.base_revision, applied.target_revision), (2, 3));
        let changes = applied.change_set.as_ref().unwrap();
        assert_eq!((changes.base_revision, changes.target_revision), (2, 3));
        assert_eq!(log.revision().unwrap(), 3);
        let retry = log.submit(create_node("019ff400-0000-7000-8000-0000000000a2", "019ff400-0000-7000-8000-0000000000d2", 1)).unwrap();
        let ProductCommandResult::ProductCommandApplied(replayed) = retry else { panic!("cached applied"); };
        assert_eq!(replayed.change_set, applied.change_set);
        assert_eq!((replayed.base_revision, replayed.target_revision), (2, 3));
        let history_json: String = log.conn.query_row(
            "SELECT entry_json FROM server_recovery_history WHERE project_id = ?1 AND server_revision = 3",
            [&log.project_id], |row| row.get(0),
        ).unwrap();
        let history: ConfirmedHistoryEntry = serde_json::from_str(&history_json).unwrap();
        assert_eq!(history.command.wire["baseRevision"], 1);
        assert_eq!(history.command.wire["expectedRevision"], 2);
        assert_eq!(history.payload_digest, payload_digest(&history.command).unwrap());
        assert_eq!(history.result, second);
        let epoch = log.stream_epoch().unwrap();
        let next = log.rotate_restored_epoch(epoch + 10).unwrap();
        assert_eq!(next, epoch + 11);
        assert!(matches!(log.submit_wire_in_epoch(history.command.wire, epoch), Err(RepositoryError::ResyncRequired)));
        assert_eq!(log.revision().unwrap(), 3);
    }

    #[test]
    fn stream_epoch_survives_reopen_and_rotation_refuses_a_reused_generation() {
        let dir = std::env::temp_dir().join(format!("pmapp-epoch-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let path = dir.join("project.sqlite");
        let project = "019ff400-0000-7000-8000-000000000001";
        let rotated = {
            let mut log = ProjectLog::open(&path, project).unwrap();
            log.ensure_project("Shared", "019ff400-0000-7000-8000-0000000000c0").unwrap();
            log.submit(create_node("019ff400-0000-7000-8000-0000000000a1", "019ff400-0000-7000-8000-0000000000d1", 1)).unwrap();
            assert_eq!(log.stream_epoch().unwrap(), 1);
            log.rotate_restored_epoch(4).unwrap()
        };
        assert_eq!(rotated, 5);
        let mut reopened = ProjectLog::open(&path, project).unwrap();
        assert_eq!(reopened.stream_epoch().unwrap(), 5, "normal restart keeps the persisted epoch");
        assert_eq!(reopened.revision().unwrap(), 2);
        // A witness at or below the retained high-water mark (e.g. an older
        // backup generation) can never authorize another rotation.
        for stale in [1, 4, 5] {
            assert!(reopened.rotate_restored_epoch(stale).is_err(), "stale witness {stale} rotated");
        }
        assert_eq!(reopened.stream_epoch().unwrap(), 5);
        drop(reopened);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn title_update_advances_and_is_streamed() {
        let mut log = conn();
        log.submit(create_node("019ff400-0000-7000-8000-0000000000a1", "019ff400-0000-7000-8000-0000000000d1", 1)).unwrap();
        let title = ProductCommand::SetNodeTitle(SetNodeTitleCommand {
            command_name: String::new(),
            protocol_version: pmapp_core::protocol::PROTOCOL_VERSION.to_string(),
            command_id: "019ff400-0000-7000-8000-0000000000d3".to_string(),
            project_id: "019ff400-0000-7000-8000-000000000001".to_string(),
            base_revision: 2,
            expected_revision: 3,
            node_id: "019ff400-0000-7000-8000-0000000000a1".to_string(),
            title: "Renamed".to_string(),
            actor_id: None,
        });
        assert!(matches!(log.submit(title).unwrap(), ProductCommandResult::ProductCommandApplied(_)));
        let up = log.catch_up(2).unwrap();
        assert_eq!(up.commands.len(), 1);
    }
}
