//! Service data migrations (Story 28.3, AC 27.9-4, contract R10).
//!
//! Each project file carries a server data version (`server_schema_meta`;
//! a file from before versioning is version 1). A migration runs at startup,
//! before the listener binds, so no write is admitted while it runs
//! (quiescence). It is backed up first: a local copy of every file it will
//! touch (plus a remote generation, taken by the caller, when object storage is
//! configured). Each file migrates in one transaction, and a journal in the
//! data directory records the plan and every completed file, so a crash or
//! failure part way resumes on the next start instead of serving a mix of
//! versions. Down steps exist so a release can be rolled back without
//! discarding accepted commits; a down step that would lose information
//! refuses instead (restore from backup is the path then).
//!
//! This binary serves only `SERVER_DATA_VERSION`. Opening a project file at any
//! other version is refused (`ProjectLog::open`).

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

/// The server data version this build reads and writes.
pub const SERVER_DATA_VERSION: i64 = 2;
/// Journal of the migration in progress (or the last one), in the data dir.
pub const JOURNAL_FILE: &str = "server-migration.json";
/// Local pre-migration copies, one directory per run, in the data dir.
pub const BACKUP_DIR: &str = "migration-backups";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationError(pub String);

impl std::fmt::Display for MigrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.0) }
}

fn err(code: &str) -> MigrationError { MigrationError(code.to_string()) }

const META_SCHEMA: &str =
    "CREATE TABLE IF NOT EXISTS server_schema_meta(singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL)";

/// v2: compaction keeps each trimmed command's id and payload digest, so a
/// late retry of a compacted command is still recognised (exactly-once).
const V2_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS server_compacted_command(
  project_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  server_revision INTEGER NOT NULL,
  command_sha256 TEXT NOT NULL,
  PRIMARY KEY(project_id, command_id)
)";

fn table_exists(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    conn.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1", [name], |_| Ok(()))
        .optional()
        .map(|found| found.is_some())
}

/// The file's server data version: 0 for a new (empty) file, 1 for a file from
/// before versioning, otherwise the recorded version.
pub fn data_version(conn: &Connection) -> rusqlite::Result<i64> {
    if table_exists(conn, "server_schema_meta")? {
        return conn.query_row("SELECT version FROM server_schema_meta WHERE singleton = 1", [], |r| r.get(0));
    }
    Ok(if table_exists(conn, "server_stream_state")? { 1 } else { 0 })
}

/// Create the current version's server objects in a new file. Call after the
/// base schema (`SERVER_LOG_SCHEMA`) exists.
pub fn initialize_current(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(V2_SCHEMA)?;
    set_version(conn, SERVER_DATA_VERSION)
}

fn set_version(conn: &Connection, version: i64) -> rusqlite::Result<()> {
    conn.execute_batch(META_SCHEMA)?;
    conn.execute(
        "INSERT INTO server_schema_meta(singleton, version) VALUES(1, ?1) ON CONFLICT(singleton) DO UPDATE SET version = excluded.version",
        [version],
    )?;
    Ok(())
}

fn step_up(conn: &Connection, from: i64) -> Result<(), MigrationError> {
    match from {
        1 => {
            conn.execute_batch(V2_SCHEMA).map_err(|_| err("MIGRATION_STEP_FAILED"))?;
            set_version(conn, 2).map_err(|_| err("MIGRATION_STEP_FAILED"))
        }
        _ => Err(err("MIGRATION_STEP_UNKNOWN")),
    }
}

fn step_down(conn: &Connection, from: i64) -> Result<(), MigrationError> {
    match from {
        2 => {
            // Rolling back after compaction would lose the digests that keep a
            // late retry exactly-once; refuse (restore from backup instead).
            let compacted: i64 = conn
                .query_row("SELECT COUNT(*) FROM server_compacted_command", [], |r| r.get(0))
                .map_err(|_| err("MIGRATION_STEP_FAILED"))?;
            if compacted > 0 { return Err(err("DOWNGRADE_AFTER_COMPACTION")); }
            conn.execute_batch("DROP TABLE server_compacted_command; DROP TABLE server_schema_meta;")
                .map_err(|_| err("MIGRATION_STEP_FAILED"))
        }
        _ => Err(err("MIGRATION_STEP_UNKNOWN")),
    }
}

/// Migrate one file to `target` in a single transaction. Returns (from, to).
pub fn migrate_file(path: &Path, target: i64) -> Result<(i64, i64), MigrationError> {
    let mut conn = Connection::open(path).map_err(|_| err("MIGRATION_OPEN_FAILED"))?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| err("MIGRATION_LOCK_FAILED"))?;
    let from = data_version(&tx).map_err(|_| err("MIGRATION_VERSION_UNREADABLE"))?;
    if from == 0 { return Err(err("MIGRATION_FILE_NOT_A_PROJECT")); }
    let mut version = from;
    while version < target { step_up(&tx, version)?; version += 1; }
    while version > target { step_down(&tx, version)?; version -= 1; }
    tx.commit().map_err(|_| err("MIGRATION_COMMIT_FAILED"))?;
    Ok((from, target))
}

/// Every project file in the data directory, sorted.
pub fn project_files(data_dir: &Path) -> Result<Vec<PathBuf>, MigrationError> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(data_dir).map_err(|_| err("MIGRATION_ENUMERATION_FAILED"))? {
        let entry = entry.map_err(|_| err("MIGRATION_ENUMERATION_FAILED"))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(id) = name.strip_prefix("project-").and_then(|n| n.strip_suffix(".sqlite")) else { continue };
        if crate::project_log::is_safe_project_id(id) { files.push(entry.path()); }
    }
    files.sort();
    Ok(files)
}

/// Files whose version differs from `target`, with their current version.
pub fn plan(data_dir: &Path, target: i64) -> Result<Vec<(PathBuf, i64)>, MigrationError> {
    if !(1..=SERVER_DATA_VERSION).contains(&target) { return Err(err("MIGRATION_TARGET_UNSUPPORTED")); }
    let mut pending = Vec::new();
    for path in project_files(data_dir)? {
        let conn = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| err("MIGRATION_OPEN_FAILED"))?;
        let version = data_version(&conn).map_err(|_| err("MIGRATION_VERSION_UNREADABLE"))?;
        // Data written by a newer release: never guess at it.
        if version > SERVER_DATA_VERSION { return Err(err("DATA_NEWER_THAN_THIS_RELEASE")); }
        if version != 0 && version != target { pending.push((path, version)); }
    }
    Ok(pending)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    /// `in-progress` until every planned file is at `target`, then `complete`.
    pub status: String,
    pub target: i64,
    pub started_at: String,
    pub finished_at: Option<String>,
    /// Local pre-migration copies (relative to the data dir).
    pub backup_dir: String,
    /// Remote generation published before the migration, when configured.
    pub remote_generation: Option<String>,
    pub planned: Vec<String>,
    pub completed: Vec<String>,
    pub last_error: Option<String>,
}

pub fn read_journal(data_dir: &Path) -> Option<Journal> {
    let bytes = std::fs::read(data_dir.join(JOURNAL_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_journal(data_dir: &Path, journal: &Journal) -> Result<(), MigrationError> {
    let tmp = data_dir.join(format!("{JOURNAL_FILE}.tmp"));
    let bytes = serde_json::to_vec_pretty(journal).map_err(|_| err("MIGRATION_JOURNAL_WRITE_FAILED"))?;
    std::fs::write(&tmp, bytes).map_err(|_| err("MIGRATION_JOURNAL_WRITE_FAILED"))?;
    std::fs::rename(&tmp, data_dir.join(JOURNAL_FILE)).map_err(|_| err("MIGRATION_JOURNAL_WRITE_FAILED"))
}

fn file_name(path: &Path) -> String {
    path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string()
}

/// Copy the planned files and the membership database with SQLite's backup API.
fn local_backup(data_dir: &Path, planned: &[(PathBuf, i64)], target: i64) -> Result<String, MigrationError> {
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let relative = format!("{BACKUP_DIR}/to-v{target}-{stamp}-{:08x}", rand::random::<u32>());
    let dir = data_dir.join(&relative);
    std::fs::create_dir_all(&dir).map_err(|_| err("MIGRATION_BACKUP_FAILED"))?;
    let membership = data_dir.join("membership.sqlite");
    let sources = planned.iter().map(|(p, _)| p.clone()).chain(membership.exists().then_some(membership));
    for source in sources {
        let src = Connection::open_with_flags(&source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| err("MIGRATION_BACKUP_FAILED"))?;
        let mut dst = Connection::open(dir.join(file_name(&source))).map_err(|_| err("MIGRATION_BACKUP_FAILED"))?;
        rusqlite::backup::Backup::new(&src, &mut dst)
            .and_then(|b| b.run_to_completion(256, std::time::Duration::from_millis(0), None))
            .map_err(|_| err("MIGRATION_BACKUP_FAILED"))?;
    }
    Ok(relative)
}

/// True when a fresh migration (not a resume) is needed: the caller then takes
/// a remote backup generation before calling `run`.
pub fn needs_fresh_backup(data_dir: &Path, target: i64) -> Result<bool, MigrationError> {
    let resuming = read_journal(data_dir).is_some_and(|j| j.status == "in-progress" && j.target == target);
    Ok(!resuming && !plan(data_dir, target)?.is_empty())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationReport {
    pub target: i64,
    pub migrated: Vec<(String, i64)>,
    pub resumed: bool,
    pub backup_dir: Option<String>,
}

/// Bring every project file to `target`, backed up first and journalled.
/// `fail_before` (tests only) stops before the n-th file to simulate a crash.
pub fn run(data_dir: &Path, target: i64, remote_generation: Option<String>, fail_before: Option<usize>) -> Result<MigrationReport, MigrationError> {
    let prior = read_journal(data_dir).filter(|j| j.status == "in-progress");
    if let Some(prior) = &prior {
        if prior.target != target { return Err(err("MIGRATION_IN_PROGRESS_TO_OTHER_VERSION")); }
    }
    let pending = plan(data_dir, target)?;
    if pending.is_empty() {
        if let Some(mut journal) = prior {
            journal.status = "complete".into();
            journal.finished_at = Some(crate::now_iso());
            journal.last_error = None;
            write_journal(data_dir, &journal)?;
            return Ok(MigrationReport { target, migrated: Vec::new(), resumed: true, backup_dir: Some(journal.backup_dir) });
        }
        return Ok(MigrationReport { target, migrated: Vec::new(), resumed: false, backup_dir: None });
    }
    let resumed = prior.is_some();
    let mut journal = match prior {
        // Resume: keep the ORIGINAL pre-migration copies; never overwrite them
        // with copies of partially migrated files.
        Some(journal) => journal,
        None => {
            let backup_dir = local_backup(data_dir, &pending, target)?;
            let journal = Journal {
                status: "in-progress".into(), target, started_at: crate::now_iso(), finished_at: None,
                backup_dir, remote_generation, planned: pending.iter().map(|(p, _)| file_name(p)).collect(),
                completed: Vec::new(), last_error: None,
            };
            write_journal(data_dir, &journal)?;
            journal
        }
    };
    let mut migrated = Vec::new();
    for (index, (path, from)) in pending.iter().enumerate() {
        if fail_before == Some(index) {
            journal.last_error = Some("MIGRATION_INTERRUPTED".into());
            write_journal(data_dir, &journal)?;
            return Err(err("MIGRATION_INTERRUPTED"));
        }
        if let Err(e) = migrate_file(path, target) {
            journal.last_error = Some(format!("{}:{}", file_name(path), e.0));
            write_journal(data_dir, &journal)?;
            return Err(e);
        }
        journal.completed.push(file_name(path));
        write_journal(data_dir, &journal)?;
        migrated.push((file_name(path), *from));
    }
    journal.status = "complete".into();
    journal.finished_at = Some(crate::now_iso());
    journal.last_error = None;
    write_journal(data_dir, &journal)?;
    Ok(MigrationReport { target, migrated, resumed, backup_dir: Some(journal.backup_dir) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_log::{project_db_path, ProjectLog, SERVER_LOG_SCHEMA};

    const P1: &str = "019ff500-0000-7000-8000-000000000001";
    const P2: &str = "019ff500-0000-7000-8000-000000000002";

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pmapp-migration-{tag}-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A project file exactly as the previous release (data version 1) wrote it.
    fn legacy_project(dir: &Path, project_id: &str) -> PathBuf {
        let path = project_db_path(dir, project_id);
        {
            let mut log = ProjectLog::open(&path, project_id).unwrap();
            log.ensure_project("Legacy", "019ff500-0000-7000-8000-0000000000c0").unwrap();
        }
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("DROP TABLE server_compacted_command; DROP TABLE server_schema_meta;").unwrap();
        assert_eq!(data_version(&conn).unwrap(), 1);
        path
    }

    fn version_of(path: &Path) -> i64 { data_version(&Connection::open(path).unwrap()).unwrap() }

    fn create_node(project_id: &str, n: u32, base: i64) -> pmapp_core::protocol::commands::ProductCommand {
        pmapp_core::protocol::commands::ProductCommand::CreateNode(pmapp_core::protocol::commands::CreateNodeCommand {
            command_name: String::new(),
            protocol_version: pmapp_core::protocol::PROTOCOL_VERSION.to_string(),
            command_id: format!("019ff500-0000-7000-8000-{:012x}", 0xd000 + n),
            project_id: project_id.to_string(),
            base_revision: base,
            expected_revision: base + 1,
            node_id: format!("019ff500-0000-7000-8000-{:012x}", 0xa000 + n),
            parent_id: None,
            position: "4294967296".to_string(),
            title: "Synthetic".to_string(),
            actor_id: None,
        })
    }

    #[test]
    fn a_new_file_starts_at_the_current_version() {
        let conn = Connection::open_in_memory().unwrap();
        assert_eq!(data_version(&conn).unwrap(), 0);
        pmapp_core::db::handler::initialize_schema(&conn).unwrap();
        conn.execute_batch(SERVER_LOG_SCHEMA).unwrap();
        initialize_current(&conn).unwrap();
        assert_eq!(data_version(&conn).unwrap(), SERVER_DATA_VERSION);
    }

    #[test]
    fn migrates_every_legacy_file_backed_up_first_and_journalled() {
        let dir = temp_dir("up");
        let (a, b) = (legacy_project(&dir, P1), legacy_project(&dir, P2));
        assert!(needs_fresh_backup(&dir, 2).unwrap());
        let report = run(&dir, 2, Some("gen-1".into()), None).unwrap();
        assert_eq!(report.migrated.len(), 2);
        assert_eq!((version_of(&a), version_of(&b)), (2, 2));
        let journal = read_journal(&dir).unwrap();
        assert_eq!((journal.status.as_str(), journal.completed.len(), journal.remote_generation.as_deref()), ("complete", 2, Some("gen-1")));
        // The pre-migration copies are the previous version, readable as such.
        let backup = dir.join(&journal.backup_dir);
        assert_eq!(version_of(&backup.join(a.file_name().unwrap())), 1);
        // The migrated files open and serve; a second run is a no-op.
        ProjectLog::open(&a, P1).unwrap();
        assert!(run(&dir, 2, None, None).unwrap().migrated.is_empty());
        assert!(!needs_fresh_backup(&dir, 2).unwrap());
    }

    #[test]
    fn an_interrupted_migration_refuses_to_serve_then_resumes_without_rebacking_up() {
        let dir = temp_dir("resume");
        let (a, b) = (legacy_project(&dir, P1), legacy_project(&dir, P2));
        assert_eq!(run(&dir, 2, None, Some(1)).unwrap_err().0, "MIGRATION_INTERRUPTED");
        // Partially migrated: one file each side. The journal says so.
        assert_eq!((version_of(&a), version_of(&b)), (2, 1));
        let journal = read_journal(&dir).unwrap();
        assert_eq!((journal.status.as_str(), journal.completed.len()), ("in-progress", 1));
        // The not-yet-migrated file is refused by this release: nothing serves it.
        assert!(ProjectLog::open(&b, P2).is_err());
        // Resume keeps the original copies (both still version 1).
        assert!(!needs_fresh_backup(&dir, 2).unwrap());
        let report = run(&dir, 2, None, None).unwrap();
        assert!(report.resumed);
        assert_eq!(report.backup_dir.as_deref(), Some(journal.backup_dir.as_str()));
        assert_eq!((version_of(&a), version_of(&b)), (2, 2));
        let backup = dir.join(&journal.backup_dir);
        assert_eq!((version_of(&backup.join(a.file_name().unwrap())), version_of(&backup.join(b.file_name().unwrap()))), (1, 1));
    }

    #[test]
    fn rollback_keeps_every_accepted_commit_and_the_previous_release_reads_it() {
        let dir = temp_dir("down");
        let a = legacy_project(&dir, P1);
        run(&dir, 2, None, None).unwrap();
        // A commit accepted after the migration.
        let revision_after = {
            let mut log = ProjectLog::open(&a, P1).unwrap();
            let base = log.revision().unwrap();
            log.submit(create_node(P1, 1, base)).unwrap();
            log.revision().unwrap()
        };
        let report = run(&dir, 1, None, None).unwrap();
        assert_eq!(report.migrated, vec![(a.file_name().unwrap().to_str().unwrap().to_string(), 2)]);
        let conn = Connection::open(&a).unwrap();
        assert_eq!(data_version(&conn).unwrap(), 1);
        // The previous release's schema, with the commit intact.
        let revision: i64 = conn.query_row("SELECT revision FROM projects WHERE id = ?1", [P1], |r| r.get(0)).unwrap();
        let logged: i64 = conn.query_row("SELECT COUNT(*) FROM server_command_log", [], |r| r.get(0)).unwrap();
        assert_eq!(revision, revision_after);
        assert!(logged >= 1);
        // This release refuses to serve version-1 data.
        assert!(ProjectLog::open(&a, P1).is_err());
    }

    #[test]
    fn rollback_after_compaction_refuses_and_changes_nothing() {
        let dir = temp_dir("down-compacted");
        let a = legacy_project(&dir, P1);
        run(&dir, 2, None, None).unwrap();
        Connection::open(&a).unwrap().execute(
            "INSERT INTO server_compacted_command(project_id, command_id, server_revision, command_sha256) VALUES(?1, 'c', 1, 'x')", [P1],
        ).unwrap();
        assert_eq!(run(&dir, 1, None, None).unwrap_err().0, "DOWNGRADE_AFTER_COMPACTION");
        assert_eq!(version_of(&a), 2);
        assert!(ProjectLog::open(&a, P1).is_ok());
    }

    #[test]
    fn data_from_a_newer_release_is_never_touched() {
        let dir = temp_dir("newer");
        let a = legacy_project(&dir, P1);
        run(&dir, 2, None, None).unwrap();
        Connection::open(&a).unwrap().execute("UPDATE server_schema_meta SET version = 3", []).unwrap();
        assert_eq!(run(&dir, 2, None, None).unwrap_err().0, "DATA_NEWER_THAN_THIS_RELEASE");
        assert!(ProjectLog::open(&a, P1).is_err());
    }
}
