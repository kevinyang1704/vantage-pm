//! Isolated restore drill (Story 27.5, R5).
//!
//! Exercised only through the private `pmapp-server restore-drill <manifest>`
//! mode: no HTTP route, no listening socket. It reads object storage alone —
//! the named manifest and the objects it lists — into a fresh temporary target
//! that must not overlap the live data directory, and never copies anything
//! back. It verifies paths, duplicates, coverage, size, SHA-256, SQLite
//! integrity and foreign keys, recorded schema and cut revisions, and each
//! project's typed recovery cut. The restored membership database is
//! quarantined before anything could admit an operation. Stream epochs rotate
//! in the isolated copy only above a valid external witness.
//!
//! Evidence is codes, counts, hashes and timings — never authored content or
//! credentials. The drill measures its own duration against the 4-hour RTO; it
//! claims nothing about physical flush or loss beyond the captured cut.

use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;

use crate::backup::sha256_hex;
use crate::backup_checkpoint::{generation_of_key, manifest_key, BackupManifest, DatabaseKind, EpochWitness, GENERATIONS_PREFIX, MAX_MANIFEST_BYTES, WITNESS_KEY};
use crate::backup_store::{ObjectStore, StoreError};
use crate::membership_store::MembershipStore;
use crate::project_log::ProjectLog;

pub const RTO_BUDGET_SECS: u64 = 4 * 60 * 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RotationStatus {
    /// Every project epoch rotated above the verified external witness.
    Rotated,
    /// No valid witness above this generation's epochs: rotation refused.
    WitnessMissing,
    WitnessStale,
    WitnessInvalid,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEvidence {
    pub project_id: String,
    pub server_revision: i64,
    pub stream_epoch: i64,
    pub rotated_epoch: Option<i64>,
    pub confirmed_history: usize,
    pub terminal_rejections: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrillEvidence {
    pub result: &'static str,
    pub generation_id: String,
    pub manifest_sha256: String,
    pub files: usize,
    pub bytes: u64,
    pub membership_revision: i64,
    pub membership_quarantined: bool,
    pub projects: Vec<ProjectEvidence>,
    pub rotation: RotationStatus,
    pub witness_exclusive_high_water: Option<i64>,
    pub download_ms: u128,
    pub verify_ms: u128,
    pub total_ms: u128,
    pub rto_budget_secs: u64,
    pub within_rto: bool,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrillError(pub String);

impl std::fmt::Display for DrillError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}", self.0) }
}

fn fail<T>(code: impl Into<String>) -> Result<T, DrillError> { Err(DrillError(code.into())) }

/// Resolve a path that may not exist yet: canonicalize the nearest existing
/// ancestor and re-append the rest, so both sides compare in one form (on
/// Windows `canonicalize` yields a verbatim `\\?\` prefix).
fn resolve(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(path) };
    let mut existing = absolute.as_path();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if let Ok(canonical) = std::fs::canonicalize(existing) {
            return rest.iter().rev().fold(canonical, |acc, part| acc.join(part));
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => { rest.push(name.to_os_string()); existing = parent; }
            _ => return absolute,
        }
    }
}

/// Whether `a` and `b` overlap (either contains the other), after resolving.
fn overlaps(a: &Path, b: &Path) -> bool {
    let (a, b) = (resolve(a), resolve(b));
    a.starts_with(&b) || b.starts_with(&a)
}

fn sqlite_checks(path: &Path) -> Result<rusqlite::Connection, DrillError> {
    let conn = rusqlite::Connection::open(path).map_err(|_| DrillError("RESTORE_SQLITE_OPEN_FAILED".into()))?;
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).map_err(|_| DrillError("RESTORE_INTEGRITY_UNREADABLE".into()))?;
    if integrity != "ok" { return fail("RESTORE_INTEGRITY_FAILED"); }
    let violation = {
        let mut statement = conn.prepare("PRAGMA foreign_key_check").map_err(|_| DrillError("RESTORE_FOREIGN_KEYS_UNREADABLE".into()))?;
        let mut rows = statement.query([]).map_err(|_| DrillError("RESTORE_FOREIGN_KEYS_UNREADABLE".into()))?;
        rows.next().map_err(|_| DrillError("RESTORE_FOREIGN_KEYS_UNREADABLE".into()))?.is_some()
    };
    if violation { return fail("RESTORE_FOREIGN_KEYS_FAILED"); }
    Ok(conn)
}

/// The newest published generation's manifest key (`restore-drill latest`).
/// Only well-formed manifest keys count (an unpublished generation has no
/// manifest); generation ids begin with their UTC cut time, so the greatest id
/// is the newest. The drill still fully validates the manifest it is given.
pub async fn latest_manifest_key<S: ObjectStore>(store: &S) -> Result<String, DrillError> {
    let objects = store.list(GENERATIONS_PREFIX).await.map_err(|e| DrillError(format!("DRILL_LIST_FAILED:{e}")))?;
    objects
        .iter()
        .filter_map(|o| generation_of_key(&o.key).filter(|g| o.key == manifest_key(g)))
        .max()
        .map(manifest_key)
        .ok_or_else(|| DrillError("DRILL_NO_PUBLISHED_GENERATION".into()))
}

/// Run the drill. `target_root` receives a new uniquely named directory.
pub async fn run_restore_drill<S: ObjectStore>(
    store: &S,
    manifest_key: &str,
    target_root: &Path,
    live_data_dir: Option<&Path>,
) -> Result<DrillEvidence, DrillError> {
    let started = Instant::now();
    let manifest_bytes = store.get(manifest_key, MAX_MANIFEST_BYTES).await.map_err(|e| DrillError(format!("RESTORE_MANIFEST_UNAVAILABLE:{e}")))?;
    let manifest = BackupManifest::parse(&manifest_bytes).map_err(|e| DrillError(format!("RESTORE_{e}")))?;
    if manifest.manifest_key() != manifest_key { return fail("RESTORE_MANIFEST_KEY_MISMATCH"); }

    let target: PathBuf = target_root.join(format!("pmapp-restore-drill-{}-{:016x}", manifest.generation_id, rand::random::<u64>()));
    if let Some(live) = live_data_dir {
        if overlaps(target_root, live) || overlaps(&target, live) { return fail("RESTORE_TARGET_OVERLAPS_LIVE_DATA"); }
    }
    if target.exists() { return fail("RESTORE_TARGET_EXISTS"); }
    std::fs::create_dir_all(&target).map_err(|_| DrillError("RESTORE_TARGET_UNAVAILABLE".into()))?;

    // Download and verify bytes before any SQLite open.
    let mut bytes_total = 0u64;
    for file in &manifest.files {
        let body = store.get(&file.object_key, file.size_bytes).await.map_err(|e| match e {
            StoreError::TooLarge => DrillError("RESTORE_OBJECT_SIZE_MISMATCH".into()),
            other => DrillError(format!("RESTORE_OBJECT_UNAVAILABLE:{other}")),
        })?;
        if body.len() as u64 != file.size_bytes { return fail("RESTORE_OBJECT_SIZE_MISMATCH"); }
        if sha256_hex(&body) != file.sha256 { return fail("RESTORE_OBJECT_HASH_MISMATCH"); }
        // Validated logical names are `membership` or `project-<uuid>` only.
        std::fs::write(target.join(format!("{}.sqlite", file.logical_name)), &body).map_err(|_| DrillError("RESTORE_TARGET_WRITE_FAILED".into()))?;
        bytes_total += body.len() as u64;
    }
    let download_ms = started.elapsed().as_millis();
    let verify_started = Instant::now();

    let witness = match store.get(WITNESS_KEY, 64 * 1024).await {
        Ok(bytes) => EpochWitness::parse(&bytes).map_err(|_| RotationStatus::WitnessInvalid),
        Err(StoreError::NotFound) => Err(RotationStatus::WitnessMissing),
        Err(_) => Err(RotationStatus::WitnessInvalid),
    };
    let witness = match witness {
        Ok(w) if w.exclusive_high_water > manifest.max_stream_epoch() => Ok(w),
        Ok(_) => Err(RotationStatus::WitnessStale),
        Err(status) => Err(status),
    };

    let mut membership_quarantined = false;
    let mut projects = Vec::new();
    for file in &manifest.files {
        let path = target.join(format!("{}.sqlite", file.logical_name));
        let conn = sqlite_checks(&path)?;
        match file.kind {
            DatabaseKind::Membership => {
                let (revision, schema): (i64, i64) = conn
                    .query_row("SELECT revision, schema_version FROM membership_meta WHERE singleton = 1", [], |r| Ok((r.get(0)?, r.get(1)?)))
                    .map_err(|_| DrillError("RESTORE_MEMBERSHIP_META_UNREADABLE".into()))?;
                if revision != manifest.membership_revision || schema != file.schema_version { return fail("RESTORE_MEMBERSHIP_CUT_MISMATCH"); }
                drop(conn);
                // Quarantine before any credential could be honoured, then prove it.
                let store = MembershipStore::open(&path).map_err(|_| DrillError("RESTORE_MEMBERSHIP_OPEN_FAILED".into()))?;
                store.quarantine("RESTORE_DRILL", &crate::now_iso()).map_err(|_| DrillError("RESTORE_QUARANTINE_FAILED".into()))?;
                let probe = rusqlite::Connection::open(&path).map_err(|_| DrillError("RESTORE_SQLITE_OPEN_FAILED".into()))?;
                let mut statement = probe.prepare("SELECT device_id, project_id FROM devices").map_err(|_| DrillError("RESTORE_MEMBERSHIP_UNREADABLE".into()))?;
                let devices = statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                    .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
                    .map_err(|_| DrillError("RESTORE_MEMBERSHIP_UNREADABLE".into()))?;
                for (device, project) in devices {
                    if store.auth_context(&device, &project).map_err(|_| DrillError("RESTORE_QUARANTINE_UNVERIFIED".into()))?.is_some()
                        || store.device_verifier(&device, &project).map_err(|_| DrillError("RESTORE_QUARANTINE_UNVERIFIED".into()))?.is_some() {
                        return fail("RESTORE_QUARANTINE_UNVERIFIED");
                    }
                }
                membership_quarantined = store.quarantined().map_err(|_| DrillError("RESTORE_QUARANTINE_UNVERIFIED".into()))?;
                if !membership_quarantined { return fail("RESTORE_QUARANTINE_UNVERIFIED"); }
            }
            DatabaseKind::Project => {
                let project = file.project_id.as_deref().ok_or_else(|| DrillError("RESTORE_PROJECT_ID_MISSING".into()))?;
                let schema: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(|_| DrillError("RESTORE_SCHEMA_UNREADABLE".into()))?;
                if schema != file.schema_version { return fail("RESTORE_SCHEMA_MISMATCH"); }
                drop(conn);
                // Story 28.3: a generation from an earlier release holds older
                // server data; bring this isolated copy to the current version
                // exactly as startup would (additive, transactional).
                crate::server_migration::migrate_file(&path, crate::server_migration::SERVER_DATA_VERSION)
                    .map_err(|e| DrillError(format!("RESTORE_MIGRATION_FAILED:{e}")))?;
                let mut log = ProjectLog::open(&path, project).map_err(|_| DrillError("RESTORE_PROJECT_OPEN_FAILED".into()))?;
                let envelope = log.recovery_envelope().map_err(|_| DrillError("RESTORE_RECOVERY_CUT_INVALID".into()))?;
                envelope.validate(project).map_err(|_| DrillError("RESTORE_RECOVERY_CUT_INVALID".into()))?;
                if Some(envelope.server_revision) != file.server_revision || Some(envelope.stream_epoch) != file.stream_epoch
                    || Some(envelope.history_floor) != file.history_floor {
                    return fail("RESTORE_PROJECT_CUT_MISMATCH");
                }
                let rotated_epoch = match &witness {
                    Ok(w) => {
                        let next = log.rotate_restored_epoch(w.exclusive_high_water).map_err(|_| DrillError("RESTORE_ROTATION_REFUSED".into()))?;
                        if next <= manifest.max_stream_epoch() { return fail("RESTORE_ROTATION_NOT_FRESH"); }
                        Some(next)
                    }
                    Err(_) => None,
                };
                projects.push(ProjectEvidence {
                    project_id: project.to_string(), server_revision: envelope.server_revision, stream_epoch: envelope.stream_epoch,
                    rotated_epoch, confirmed_history: envelope.confirmed_history.len(), terminal_rejections: envelope.terminal_rejections.len(),
                });
            }
        }
    }
    let total = started.elapsed();
    Ok(DrillEvidence {
        result: "verified",
        generation_id: manifest.generation_id.clone(),
        manifest_sha256: sha256_hex(&manifest_bytes),
        files: manifest.files.len(),
        bytes: bytes_total,
        membership_revision: manifest.membership_revision,
        membership_quarantined,
        projects,
        rotation: match &witness { Ok(_) => RotationStatus::Rotated, Err(status) => status.clone() },
        witness_exclusive_high_water: witness.as_ref().ok().map(|w| w.exclusive_high_water),
        download_ms,
        verify_ms: verify_started.elapsed().as_millis(),
        total_ms: total.as_millis(),
        rto_budget_secs: RTO_BUDGET_SECS,
        within_rto: total.as_secs() < RTO_BUDGET_SECS,
        target: target.display().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlap_detects_nonexistent_nested_targets() {
        let live = crate::backup_capture::tests::temp_dir("overlap");
        assert!(overlaps(&live.join("a").join("b"), &live));
        assert!(overlaps(&live, &live.join("missing")));
        assert!(!overlaps(&live.with_extension("sibling"), &live));
        let _ = std::fs::remove_dir_all(&live);
    }
    use crate::backup_capture::{capture_cut, tests::{create_node, sources, temp_dir, PROJECT}};
    use crate::backup_checkpoint::object_key;
    use crate::backup_loop::publish_cut;
    use crate::backup_store::MemoryStore;

    async fn published() -> (MemoryStore, String, crate::backup_capture::CaptureSources, PathBuf) {
        let sources = sources("drill");
        {
            let cache = sources.logs.lock().unwrap();
            let mut log = cache[PROJECT].lock().unwrap();
            log.submit(create_node(1, 1)).unwrap();
            log.submit(create_node(2, 2)).unwrap();
        }
        let store = MemoryStore::new();
        let staging = temp_dir("drill-staging");
        let generation = publish_cut(&store, &capture_cut(&sources, &staging).unwrap()).await.unwrap();
        (store, generation.manifest.manifest_key(), sources, staging)
    }

    #[tokio::test]
    async fn a_generation_from_the_previous_release_still_restores_and_verifies() {
        let sources = sources("drill-v1");
        {
            let cache = sources.logs.lock().unwrap();
            let mut log = cache[PROJECT].lock().unwrap();
            log.submit(create_node(1, 1)).unwrap();
        }
        // Rewind the live file to the previous release's data version (v1).
        sources.logs.lock().unwrap().clear();
        let path = crate::project_log::project_db_path(&sources.data_dir, PROJECT);
        rusqlite::Connection::open(&path).unwrap()
            .execute_batch("DROP TABLE server_compacted_command; DROP TABLE server_schema_meta;").unwrap();
        let store = MemoryStore::new();
        let staging = temp_dir("drill-v1-staging");
        let generation = publish_cut(&store, &capture_cut(&sources, &staging).unwrap()).await.unwrap();
        let target = temp_dir("drill-v1-target");
        let evidence = run_restore_drill(&store, &generation.manifest.manifest_key(), &target, Some(&sources.data_dir)).await.unwrap();
        assert_eq!(evidence.result, "verified");
        assert_eq!(evidence.projects.len(), 1);
    }

    #[tokio::test]
    async fn latest_resolves_the_newest_published_manifest_only() {
        let empty = MemoryStore::new();
        assert_eq!(latest_manifest_key(&empty).await.unwrap_err().0, "DRILL_NO_PUBLISHED_GENERATION");
        let (store, key, sources, staging) = published().await;
        // An older published generation and a newer unpublished one (no manifest).
        store.insert("generations/20000101T000000Z-0000000000000000/manifest.json", b"{}".to_vec(), 0);
        store.insert("generations/29990101T000000Z-ffffffffffffffff/membership.sqlite", b"x".to_vec(), 0);
        store.insert("generations/not-a-generation/manifest.json", b"{}".to_vec(), 0);
        assert_eq!(latest_manifest_key(&store).await.unwrap(), key);
        for dir in [&sources.data_dir, &staging] { let _ = std::fs::remove_dir_all(dir); }
    }

    #[tokio::test]
    async fn verifies_quarantines_and_rotates_in_isolation() {
        let (store, key, sources, staging) = published().await;
        let live_before: Vec<_> = std::fs::read_dir(&sources.data_dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        let root = temp_dir("drill-target");
        let evidence = run_restore_drill(&store, &key, &root, Some(&sources.data_dir)).await.unwrap();
        assert_eq!(evidence.result, "verified");
        assert!(evidence.membership_quarantined);
        assert_eq!(evidence.rotation, RotationStatus::Rotated);
        assert_eq!(evidence.witness_exclusive_high_water, Some(2));
        let project = &evidence.projects[0];
        assert_eq!((project.server_revision, project.stream_epoch, project.rotated_epoch), (3, 1, Some(3)));
        assert_eq!(project.confirmed_history, 3);
        assert!(evidence.within_rto);
        // The restored membership refuses the live owner's credential.
        let restored = MembershipStore::open(&PathBuf::from(&evidence.target).join("membership.sqlite")).unwrap();
        assert!(restored.auth_context("dev1", PROJECT).unwrap().is_none());
        // Live data is untouched: same files, live store still admits.
        let live_after: Vec<_> = std::fs::read_dir(&sources.data_dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(live_before, live_after);
        assert!(sources.membership.lock().unwrap().auth_context("dev1", PROJECT).unwrap().is_some());
        assert_eq!(sources.logs.lock().unwrap()[PROJECT].lock().unwrap().stream_epoch().unwrap(), 1);
        // Evidence carries no authored text.
        let json = serde_json::to_string(&evidence).unwrap();
        assert!(!json.contains("Synthetic") && !json.contains("Shared") && !json.contains("Owner"));
        for dir in [&sources.data_dir, &staging, &root] { let _ = std::fs::remove_dir_all(dir); }
    }

    #[tokio::test]
    async fn refuses_corrupt_missing_mismatched_or_overlapping_inputs() {
        let (store, key, sources, staging) = published().await;
        let root = temp_dir("drill-refuse");
        let manifest = BackupManifest::parse(&store.get(&key, 1 << 20).await.unwrap()).unwrap();
        let project_key = object_key(&manifest.generation_id, &format!("project-{PROJECT}"));
        let original = store.get(&project_key, 1 << 30).await.unwrap();

        // Hash mismatch (same length).
        let mut flipped = original.clone();
        let last = flipped.len() - 1; flipped[last] ^= 0xff;
        store.insert(&project_key, flipped, 0);
        assert_eq!(run_restore_drill(&store, &key, &root, None).await.unwrap_err().0, "RESTORE_OBJECT_HASH_MISMATCH");
        // Size mismatch.
        store.insert(&project_key, [original.clone(), vec![0]].concat(), 0);
        assert_eq!(run_restore_drill(&store, &key, &root, None).await.unwrap_err().0, "RESTORE_OBJECT_SIZE_MISMATCH");
        // Missing object.
        store.objects.lock().unwrap().remove(&project_key);
        assert!(run_restore_drill(&store, &key, &root, None).await.unwrap_err().0.starts_with("RESTORE_OBJECT_UNAVAILABLE"));
        store.insert(&project_key, original.clone(), 0);

        // Traversal name / tampered manifest is refused before any download.
        let mut tampered = serde_json::to_value(&manifest).unwrap();
        tampered["files"][1]["logicalName"] = serde_json::json!("../../evil");
        store.insert(&key, tampered.to_string().into_bytes(), 0);
        assert!(run_restore_drill(&store, &key, &root, None).await.unwrap_err().0.starts_with("RESTORE_MANIFEST_"));
        // Recorded cut that disagrees with the restored file.
        let mut wrong_cut = manifest.clone();
        wrong_cut.files[1].server_revision = Some(2);
        store.insert(&key, serde_json::to_vec(&wrong_cut).unwrap(), 0);
        assert_eq!(run_restore_drill(&store, &key, &root, None).await.unwrap_err().0, "RESTORE_PROJECT_CUT_MISMATCH");
        let mut wrong_schema = manifest.clone();
        wrong_schema.files[1].schema_version = 99;
        store.insert(&key, serde_json::to_vec(&wrong_schema).unwrap(), 0);
        assert_eq!(run_restore_drill(&store, &key, &root, None).await.unwrap_err().0, "RESTORE_SCHEMA_MISMATCH");
        store.insert(&key, serde_json::to_vec(&manifest).unwrap(), 0);

        // A manifest under another key, and a target overlapping live data.
        let other_key = "generations/20261006T120000Z-ffffffffffffffff/manifest.json";
        store.insert(other_key, serde_json::to_vec(&manifest).unwrap(), 0);
        assert_eq!(run_restore_drill(&store, other_key, &root, None).await.unwrap_err().0, "RESTORE_MANIFEST_KEY_MISMATCH");
        assert_eq!(run_restore_drill(&store, &key, &sources.data_dir, Some(&sources.data_dir)).await.unwrap_err().0, "RESTORE_TARGET_OVERLAPS_LIVE_DATA");
        assert_eq!(run_restore_drill(&store, &key, &sources.data_dir.join("nested"), Some(&sources.data_dir)).await.unwrap_err().0, "RESTORE_TARGET_OVERLAPS_LIVE_DATA");
        // Corrupt SQLite with a matching manifest hash.
        let garbage = vec![7u8; original.len()];
        let mut forged = manifest.clone();
        forged.files[1].sha256 = sha256_hex(&garbage);
        store.insert(&project_key, garbage, 0);
        store.insert(&key, serde_json::to_vec(&forged).unwrap(), 0);
        assert!(run_restore_drill(&store, &key, &root, None).await.unwrap_err().0.starts_with("RESTORE_"));
        for dir in [&sources.data_dir, &staging, &root] { let _ = std::fs::remove_dir_all(dir); }
    }

    #[tokio::test]
    async fn missing_stale_or_invalid_witness_never_authorizes_rotation() {
        let (store, key, sources, staging) = published().await;
        let root = temp_dir("drill-witness");
        store.objects.lock().unwrap().remove(WITNESS_KEY);
        let evidence = run_restore_drill(&store, &key, &root, None).await.unwrap();
        assert_eq!(evidence.rotation, RotationStatus::WitnessMissing);
        assert!(evidence.projects.iter().all(|p| p.rotated_epoch.is_none()));
        store.insert(WITNESS_KEY, b"garbage".to_vec(), 0);
        assert_eq!(run_restore_drill(&store, &key, &root, None).await.unwrap().rotation, RotationStatus::WitnessInvalid);

        // A later generation captured after the live stream moved to epoch 3.
        {
            let cache = sources.logs.lock().unwrap();
            assert_eq!(cache[PROJECT].lock().unwrap().rotate_restored_epoch(2).unwrap(), 3);
        }
        store.objects.lock().unwrap().remove(WITNESS_KEY);
        let later = publish_cut(&store, &capture_cut(&sources, &staging).unwrap()).await.unwrap();
        let later_key = later.manifest.manifest_key();
        assert_eq!(later.witness, crate::backup_loop::WitnessOutcome::Raised(4));
        // A witness that does not exceed the generation's epoch 3 is stale.
        let stale = serde_json::json!({"witnessVersion":1,"exclusiveHighWater":3,"updatedAtIso":"2026-10-06T00:00:00Z","generationId":later.manifest.generation_id});
        store.insert(WITNESS_KEY, stale.to_string().into_bytes(), 0);
        let evidence = run_restore_drill(&store, &later_key, &root, None).await.unwrap();
        assert_eq!(evidence.rotation, RotationStatus::WitnessStale);
        assert!(evidence.projects.iter().all(|p| p.rotated_epoch.is_none()));
        // Restoring the OLDER generation with the raised witness rotates above
        // every epoch ever published, never back onto epoch 2 or 3.
        let raised = serde_json::json!({"witnessVersion":1,"exclusiveHighWater":4,"updatedAtIso":"2026-10-06T00:00:00Z","generationId":later.manifest.generation_id});
        store.insert(WITNESS_KEY, raised.to_string().into_bytes(), 0);
        let evidence = run_restore_drill(&store, &key, &root, None).await.unwrap();
        assert_eq!(evidence.projects[0].stream_epoch, 1);
        assert_eq!(evidence.projects[0].rotated_epoch, Some(5));
        for dir in [&sources.data_dir, &staging, &root] { let _ = std::fs::remove_dir_all(dir); }
    }
}
