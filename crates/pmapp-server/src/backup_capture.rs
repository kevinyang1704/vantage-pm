//! Coherent backup capture (Story 27.5, R5).
//!
//! Every durable membership or project write in the service runs while holding
//! the membership store lock, then the project-cache lock, then the project's
//! own log lock (in that order; project creation, provisioning, share
//! activation/stop and cache opening that may migrate a file all go through
//! the cache lock). The capture acquires exactly that order — membership,
//! cache, then every cached project in sorted order — so while it holds them no
//! write can commit and no new project database can be opened. All SQLite
//! copies complete inside that window; the window closes before any hashing,
//! metadata reads or network I/O, so a slow upload never holds writers back.
//!
//! Metadata (membership revision, project revision, stream epoch, history
//! floor, schema) is read from the captured copies, never from live files and
//! never substituted with zero after a failed query.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::OptionalExtension;

use crate::backup_checkpoint::{new_generation_id, DatabaseKind};
use crate::membership_store::MembershipStore;
use crate::project_log::{is_safe_project_id, ProjectLog};

/// The live handles a capture must exclude. Cloned from `AppState`.
#[derive(Clone)]
pub struct CaptureSources {
    pub membership: Arc<Mutex<MembershipStore>>,
    pub logs: Arc<Mutex<HashMap<String, Arc<Mutex<ProjectLog>>>>>,
    pub data_dir: PathBuf,
}

#[derive(Debug, Clone)]
pub struct CapturedDatabase {
    pub kind: DatabaseKind,
    pub logical_name: String,
    pub project_id: Option<String>,
    pub path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct CapturedCut {
    pub generation_id: String,
    pub cut_at: chrono::DateTime<chrono::Utc>,
    pub dir: PathBuf,
    pub databases: Vec<CapturedDatabase>,
    /// How long writers were excluded.
    pub gate_held: Duration,
}

/// Metadata read from one captured copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyMetadata {
    pub schema_version: i64,
    pub membership_revision: Option<i64>,
    pub server_revision: Option<i64>,
    pub stream_epoch: Option<i64>,
    pub history_floor: Option<i64>,
}

fn project_id_of(file_name: &str) -> Option<&str> {
    let id = file_name.strip_prefix("project-")?.strip_suffix(".sqlite")?;
    is_safe_project_id(id).then_some(id)
}

fn copy_file_database(source: &Path, dest: &Path) -> Result<(), String> {
    let src = rusqlite::Connection::open_with_flags(source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|_| "CAPTURE_SOURCE_OPEN_FAILED".to_string())?;
    let mut dst = rusqlite::Connection::open(dest).map_err(|_| "CAPTURE_TARGET_OPEN_FAILED".to_string())?;
    let backup = rusqlite::backup::Backup::new(&src, &mut dst).map_err(|_| "CAPTURE_BACKUP_INIT_FAILED".to_string())?;
    backup.run_to_completion(256, Duration::from_millis(0), None).map_err(|_| "CAPTURE_COPY_FAILED".to_string())
}

/// Copy every database at one cut into `staging_root/<generation>/`.
/// Blocking; run on a blocking thread.
pub fn capture_cut(sources: &CaptureSources, staging_root: &Path) -> Result<CapturedCut, String> {
    // Lock order: membership, cache, projects (sorted). Matches every route.
    let membership = sources.membership.lock().unwrap_or_else(|e| e.into_inner());
    let cache = sources.logs.lock().unwrap_or_else(|e| e.into_inner());
    let started = Instant::now();
    let mut cached: Vec<(String, Arc<Mutex<ProjectLog>>)> = cache.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    cached.sort_by(|a, b| a.0.cmp(&b.0));
    let guards: Vec<(String, std::sync::MutexGuard<'_, ProjectLog>)> = cached
        .iter()
        .map(|(id, log)| (id.clone(), log.lock().unwrap_or_else(|e| e.into_inner())))
        .collect();

    let cut_at = chrono::Utc::now();
    let generation_id = new_generation_id(&cut_at);
    let dir = staging_root.join(&generation_id);
    std::fs::create_dir_all(&dir).map_err(|_| "CAPTURE_STAGING_UNAVAILABLE".to_string())?;

    let mut databases = Vec::new();
    let membership_path = dir.join("membership.sqlite");
    membership.backup_to(&membership_path).map_err(|_| "CAPTURE_MEMBERSHIP_COPY_FAILED".to_string())?;
    databases.push(CapturedDatabase { kind: DatabaseKind::Membership, logical_name: "membership".into(), project_id: None, path: membership_path });

    let mut project_ids: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(&sources.data_dir).map_err(|_| "CAPTURE_ENUMERATION_FAILED".to_string())? {
        let entry = entry.map_err(|_| "CAPTURE_ENUMERATION_FAILED".to_string())?;
        if let Some(id) = entry.file_name().to_str().and_then(project_id_of) { project_ids.push(id.to_string()); }
    }
    for (id, _) in &guards {
        if !project_ids.contains(id) { return Err("CAPTURE_CACHED_PROJECT_WITHOUT_FILE".into()); }
    }
    project_ids.sort();
    for id in project_ids {
        let logical = format!("project-{id}");
        let dest = dir.join(format!("{logical}.sqlite"));
        match guards.iter().find(|(cached_id, _)| *cached_id == id) {
            Some((_, log)) => log.backup_to(&dest).map_err(|_| "CAPTURE_PROJECT_COPY_FAILED".to_string())?,
            None => copy_file_database(&crate::project_log::project_db_path(&sources.data_dir, &id), &dest)?,
        }
        databases.push(CapturedDatabase { kind: DatabaseKind::Project, logical_name: logical, project_id: Some(id), path: dest });
    }
    let gate_held = started.elapsed();
    drop(guards);
    drop(cache);
    drop(membership);
    Ok(CapturedCut { generation_id, cut_at, dir, databases, gate_held })
}

/// Read cut metadata from a captured copy. Any failed query is an error.
pub fn read_copy_metadata(database: &CapturedDatabase) -> Result<CopyMetadata, String> {
    let conn = rusqlite::Connection::open_with_flags(&database.path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "CUT_COPY_OPEN_FAILED".to_string())?;
    match database.kind {
        DatabaseKind::Membership => {
            let (revision, schema_version): (i64, i64) = conn
                .query_row("SELECT revision, schema_version FROM membership_meta WHERE singleton = 1", [], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(|_| "CUT_MEMBERSHIP_REVISION_UNREADABLE".to_string())?;
            Ok(CopyMetadata { schema_version, membership_revision: Some(revision), server_revision: None, stream_epoch: None, history_floor: None })
        }
        DatabaseKind::Project => {
            let project = database.project_id.as_deref().ok_or("CUT_PROJECT_ID_MISSING")?;
            let schema_version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(|_| "CUT_SCHEMA_UNREADABLE".to_string())?;
            // A provisioned file whose project row does not exist yet is at
            // revision 0; a failed query is not.
            let revision: i64 = conn
                .query_row("SELECT revision FROM projects WHERE id = ?1", [project], |r| r.get(0))
                .optional()
                .map_err(|_| "CUT_PROJECT_REVISION_UNREADABLE".to_string())?
                .unwrap_or(0);
            let (epoch, floor): (i64, i64) = conn
                .query_row("SELECT stream_epoch, history_floor FROM server_stream_state WHERE project_id = ?1", [project], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(|_| "CUT_STREAM_STATE_UNREADABLE".to_string())?;
            Ok(CopyMetadata { schema_version, membership_revision: None, server_revision: Some(revision), stream_epoch: Some(epoch), history_floor: Some(floor) })
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::membership::Role;
    use pmapp_core::protocol::commands::{CreateNodeCommand, ProductCommand};

    pub const PROJECT: &str = "019ff400-0000-7000-8000-000000000001";

    pub fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pmapp-{tag}-{}-{:016x}", std::process::id(), rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    pub fn create_node(n: u32, base: i64) -> ProductCommand {
        ProductCommand::CreateNode(CreateNodeCommand {
            command_name: String::new(),
            protocol_version: pmapp_core::protocol::PROTOCOL_VERSION.to_string(),
            command_id: format!("019ff400-0000-7000-8000-{:012x}", 0xd000 + n),
            project_id: PROJECT.to_string(),
            base_revision: base,
            expected_revision: base + 1,
            node_id: format!("019ff400-0000-7000-8000-{:012x}", 0xa000 + n),
            parent_id: None,
            position: "4294967296".to_string(),
            title: "Synthetic".to_string(),
            actor_id: None,
        })
    }

    /// A real data directory with a membership database and one cached,
    /// file-backed project, shaped exactly as `AppState::with_data_dir` makes.
    pub fn sources(tag: &str) -> CaptureSources {
        let data_dir = temp_dir(tag);
        let membership = MembershipStore::open(&data_dir.join("membership.sqlite")).unwrap();
        membership.upsert_device("dev1", PROJECT, "019ff400-0000-7000-8000-0000000000b1", "Owner", Role::Owner, true, "bearerHash", "ab", "2026-10-06T00:00:00Z").unwrap();
        let mut log = ProjectLog::open(&crate::project_log::project_db_path(&data_dir, PROJECT), PROJECT).unwrap();
        log.ensure_project("Shared", "019ff400-0000-7000-8000-0000000000c0").unwrap();
        let mut logs = HashMap::new();
        logs.insert(PROJECT.to_string(), Arc::new(Mutex::new(log)));
        CaptureSources { membership: Arc::new(Mutex::new(membership)), logs: Arc::new(Mutex::new(logs)), data_dir }
    }

    #[test]
    fn capture_reads_real_revisions_from_copies() {
        let sources = sources("cap");
        {
            let logs = sources.logs.lock().unwrap();
            logs[PROJECT].lock().unwrap().submit(create_node(1, 1)).unwrap();
        }
        let membership_revision = sources.membership.lock().unwrap().revision().unwrap();
        let staging = temp_dir("cap-staging");
        let cut = capture_cut(&sources, &staging).unwrap();
        assert_eq!(cut.databases.len(), 2);
        let meta: Vec<CopyMetadata> = cut.databases.iter().map(|d| read_copy_metadata(d).unwrap()).collect();
        assert_eq!(meta[0].membership_revision, Some(membership_revision));
        assert!(membership_revision > 0);
        assert_eq!(meta[1].server_revision, Some(2));
        assert_eq!(meta[1].stream_epoch, Some(1));
        assert_eq!(meta[1].history_floor, Some(0));
        let _ = std::fs::remove_dir_all(&sources.data_dir);
        let _ = std::fs::remove_dir_all(&staging);
    }

    #[test]
    fn failed_metadata_query_is_an_error_not_zero() {
        let dir = temp_dir("cap-bad");
        let path = dir.join("project-x.sqlite");
        rusqlite::Connection::open(&path).unwrap().execute_batch("CREATE TABLE projects(id TEXT, revision INTEGER)").unwrap();
        let db = CapturedDatabase { kind: DatabaseKind::Project, logical_name: format!("project-{PROJECT}"), project_id: Some(PROJECT.into()), path };
        assert_eq!(read_copy_metadata(&db).unwrap_err(), "CUT_STREAM_STATE_UNREADABLE");
        let membership = CapturedDatabase { kind: DatabaseKind::Membership, logical_name: "membership".into(), project_id: None, path: dir.join("project-x.sqlite") };
        assert_eq!(read_copy_metadata(&membership).unwrap_err(), "CUT_MEMBERSHIP_REVISION_UNREADABLE");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn uncached_project_files_are_copied_without_opening_a_writer() {
        let sources = sources("cap-uncached");
        let other = "019ff400-0000-7000-8000-000000000002";
        {
            let mut log = ProjectLog::open(&crate::project_log::project_db_path(&sources.data_dir, other), other).unwrap();
            log.ensure_project("Other", "019ff400-0000-7000-8000-0000000000c1").unwrap();
        }
        std::fs::write(sources.data_dir.join("project-not-a-uuid.sqlite"), b"ignored").unwrap();
        let staging = temp_dir("cap-uncached-staging");
        let cut = capture_cut(&sources, &staging).unwrap();
        let names: Vec<&str> = cut.databases.iter().map(|d| d.logical_name.as_str()).collect();
        assert_eq!(names, vec!["membership", &format!("project-{PROJECT}"), &format!("project-{other}")]);
        assert_eq!(read_copy_metadata(&cut.databases[2]).unwrap().server_revision, Some(1));
        assert!(!sources.logs.lock().unwrap().contains_key(other), "capture must not open a cache entry");
        let _ = std::fs::remove_dir_all(&sources.data_dir);
        let _ = std::fs::remove_dir_all(&staging);
    }

    /// Writers commit membership and project changes together under the
    /// route lock order. Every captured cut must show them in step: the
    /// membership revision and project revision advance together, never one
    /// without the other.
    #[test]
    fn concurrent_writers_never_split_a_cut() {
        let sources = sources("cap-race");
        let base_membership = sources.membership.lock().unwrap().revision().unwrap();
        let writer_sources = sources.clone();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let writer_stop = stop.clone();
        let writer = std::thread::spawn(move || {
            let mut n = 1u32;
            while !writer_stop.load(std::sync::atomic::Ordering::Relaxed) && n < 400 {
                let membership = writer_sources.membership.lock().unwrap();
                membership.upsert_share(PROJECT, &format!("op-{n}"), "shared", "2026-10-06T00:00:00Z").unwrap();
                let cache = writer_sources.logs.lock().unwrap();
                let log = cache[PROJECT].clone();
                drop(cache);
                log.lock().unwrap().submit(create_node(n, n as i64)).unwrap();
                drop(membership);
                n += 1;
            }
        });
        let staging = temp_dir("cap-race-staging");
        for _ in 0..20 {
            let cut = capture_cut(&sources, &staging).unwrap();
            let membership = read_copy_metadata(&cut.databases[0]).unwrap().membership_revision.unwrap();
            let project = read_copy_metadata(&cut.databases[1]).unwrap().server_revision.unwrap();
            // Each writer step adds one share write and one project revision.
            assert_eq!(membership - base_membership, project - 1, "split cut: membership {membership} project {project}");
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        writer.join().unwrap();
        let _ = std::fs::remove_dir_all(&sources.data_dir);
        let _ = std::fs::remove_dir_all(&staging);
    }
}
