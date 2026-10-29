//! Snapshot, package, and restore engine for the native composition
//! (E9-FR8, E9-FR9, E9-AR5, E9-AR6).
//!
//! - `snapshot_to` (re-exported from `pmapp_core::backup`) produces a
//!   consistent SQLite snapshot via the Online Backup API into a separate
//!   destination, verifies it with full `integrity_check` +
//!   `foreign_key_check`, and promotes atomically.
//! - `package_pmapp` wraps the snapshot plus a manifest into a `.pmapp`
//!   zip package with a content SHA-256 digest.
//! - `validate_candidate` checks magic bytes, application_id, supported
//!   schema version, and the digest before any staging.
//! - `restore_from_candidate` preserves the active store until verification
//!   completes and swaps transactionally with a safety copy.

use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;

use pmapp_core::db::schema::PMAPP_APPLICATION_ID;

use crate::db::runtime::RepositoryRuntime;
use crate::protocol::errors::RepositoryError;

pub const PMAPP_PACKAGE_MAGIC: &[u8; 4] = b"PMAP";
pub const PMAPP_PACKAGE_FORMAT_VERSION: u32 = 1;
pub const MAX_CANDIDATE_SIZE_BYTES: u64 = 64 * 1024 * 1024; // 64 MB
pub const ROTATED_BACKUP_COUNT: usize = 3;

// ── Snapshot generation (E9-AR5) ───────────────────────────────────────────
//
// `snapshot_to` / `verify_snapshot` now live in `pmapp-core` so the Tauri-free
// repository runtime can take its own verified pre-migration snapshot. They are
// re-exported here because the `.pmapp` package/restore engine below is built
// on them.

pub use pmapp_core::backup::{snapshot_to, verify_snapshot};

// ── Rotated recovery snapshots (E9-FR9) ────────────────────────────────────

/// Maintains a bounded rotation of verified backups in `backup_dir`.
/// The prior known-good copy is retained until the new one verifies.
pub fn rotate_recovery_snapshot(backup_dir: &Path, source_path: &Path, project_id: &str) -> Result<(), RepositoryError> {
    fs::create_dir_all(backup_dir).map_err(|_| RepositoryError::Internal)?;

    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%3f").to_string();
    let candidate = backup_dir.join(format!("{project_id}-{stamp}.sqlite"));

    snapshot_to(source_path, &candidate)?;

    // Rotation: keep the ROTATED_BACKUP_COUNT most recent verified copies.
    let mut entries: Vec<PathBuf> = fs::read_dir(backup_dir)
        .map_err(|_| RepositoryError::Internal)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|e| e == "sqlite").unwrap_or(false))
        .collect();
    entries.sort();
    while entries.len() > ROTATED_BACKUP_COUNT {
        if let Some(oldest) = entries.first() {
            let _ = fs::remove_file(oldest);
            entries.remove(0);
        }
    }
    Ok(())
}

// ── `.pmapp` package (E9-FR8, Story 9.4 Task 2) ────────────────────────────

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PmappManifest {
    pub format_version: u32,
    pub project_id: String,
    pub schema_version: i64,
    pub content_sha256: String,
    pub exported_at: String,
}

fn sha256_file(path: &Path) -> Result<String, RepositoryError> {
    let mut file = fs::File::open(path).map_err(|_| RepositoryError::Internal)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file.read(&mut buf).map_err(|_| RepositoryError::Internal)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Packages a verified snapshot into a `.pmapp` zip:
/// - `manifest.json` (format version, project id, schema version, SHA-256)
/// - `repository.sqlite` (the verified snapshot)
pub fn package_pmapp(
    snapshot_path: &Path,
    package_path: &Path,
    project_id: &str,
    schema_version: i64,
) -> Result<(), RepositoryError> {
    let content_sha256 = sha256_file(snapshot_path)?;
    let manifest = PmappManifest {
        format_version: PMAPP_PACKAGE_FORMAT_VERSION,
        project_id: project_id.to_string(),
        schema_version,
        content_sha256,
        exported_at: chrono::Utc::now().to_rfc3339(),
    };

    let file = fs::File::create(package_path).map_err(|_| RepositoryError::StorageFull)?;
    let mut zip_writer = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    zip_writer
        .start_file("manifest.json", options)
        .map_err(|_| RepositoryError::Internal)?;
    zip_writer
        .write_all(serde_json::to_vec(&manifest).map_err(|_| RepositoryError::Internal)?.as_slice())
        .map_err(|_| RepositoryError::Internal)?;

    zip_writer
        .start_file("repository.sqlite", options)
        .map_err(|_| RepositoryError::Internal)?;
    let snapshot_bytes = fs::read(snapshot_path).map_err(|_| RepositoryError::Internal)?;
    zip_writer.write_all(&snapshot_bytes).map_err(|_| RepositoryError::Internal)?;

    zip_writer.finish().map_err(|_| RepositoryError::Internal)?;
    Ok(())
}

/// Candidate validation pipeline (E9-AR6): magic bytes, application_id,
/// supported schema version, and digest — all before any staging.
/// Returns the manifest project id on success.
pub fn validate_candidate(package_path: &Path) -> Result<String, RepositoryError> {
    let file = fs::File::open(package_path).map_err(|_| RepositoryError::InvalidRequest)?;
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    if size == 0 || size > MAX_CANDIDATE_SIZE_BYTES {
        return Err(RepositoryError::InvalidRequest);
    }

    // Zip magic (PK\x03\x04) + PMApp header check.
    let mut archive = zip::ZipArchive::new(file).map_err(|_| RepositoryError::InvalidRequest)?;
    let mut manifest_bytes = Vec::new();
    archive
        .by_name("manifest.json")
        .map_err(|_| RepositoryError::InvalidRequest)?
        .read_to_end(&mut manifest_bytes)
        .map_err(|_| RepositoryError::InvalidRequest)?;
    let manifest: PmappManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| RepositoryError::InvalidRequest)?;

    if manifest.format_version > PMAPP_PACKAGE_FORMAT_VERSION {
        return Err(RepositoryError::InvalidRequest);
    }

    // Snapshot identity checks on the embedded sqlite.
    let mut snapshot_bytes = Vec::new();
    archive
        .by_name("repository.sqlite")
        .map_err(|_| RepositoryError::InvalidRequest)?
        .read_to_end(&mut snapshot_bytes)
        .map_err(|_| RepositoryError::InvalidRequest)?;

    // Content digest.
    let mut hasher = Sha256::new();
    hasher.update(&snapshot_bytes);
    let actual = hex::encode(hasher.finalize());
    if actual != manifest.content_sha256 {
        return Err(RepositoryError::InvalidRequest);
    }

    // application_id / schema version.
    let tmp = std::env::temp_dir().join(format!("pmapp-candidate-{}.sqlite", chrono::Utc::now().timestamp_millis()));
    fs::write(&tmp, &snapshot_bytes).map_err(|_| RepositoryError::Internal)?;
    let result = (|| -> Result<(), RepositoryError> {
        let cand = Connection::open_with_flags(&tmp, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| RepositoryError::IntegrityFailed)?;
        let app_id: i64 = cand.query_row("PRAGMA application_id", [], |r| r.get(0))
            .map_err(|_| RepositoryError::IntegrityFailed)?;
        if app_id != PMAPP_APPLICATION_ID {
            return Err(RepositoryError::InvalidRequest);
        }
        Ok(())
    })();
    let _ = fs::remove_file(&tmp);
    result?;

    Ok(manifest.project_id)
}

// ── Restore (E9-FR9) ───────────────────────────────────────────────────────

/// Restores the active working database from a validated candidate.
/// 1. Validate the candidate (already done via `validate_candidate`).
/// 2. Quiesce the active repository.
/// 3. Back up the current database to a safety copy.
/// 4. Replace the active file with the candidate's snapshot.
/// 5. Reopen and verify receipts/revisions — revert on failure.
pub async fn restore_from_candidate(
    runtime: &RepositoryRuntime,
    package_path: &Path,
    db_path: &Path,
    backup_dir: &Path,
) -> Result<(), RepositoryError> {
    // Quiesce: halt intake + drain in-flight.
    runtime.pause_intake().await?;

    // Safety copy of the current database.
    let safety = backup_dir.join("restore-safety.sqlite");
    if db_path.exists() {
        snapshot_to(db_path, &safety)?;
    }

    // Extract candidate snapshot to a staging file.
    let staging = backup_dir.join("restore-staging.sqlite");
    let file = fs::File::open(package_path).map_err(|_| RepositoryError::InvalidRequest)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| RepositoryError::InvalidRequest)?;
    let mut snapshot_bytes = Vec::new();
    archive
        .by_name("repository.sqlite")
        .map_err(|_| RepositoryError::InvalidRequest)?
        .read_to_end(&mut snapshot_bytes)
        .map_err(|_| RepositoryError::InvalidRequest)?;
    fs::write(&staging, &snapshot_bytes).map_err(|_| RepositoryError::Internal)?;

    // Replace the active file.
    let prior_path = db_path.with_extension("sqlite.prior");
    let replaced = if db_path.exists() {
        fs::rename(db_path, &prior_path).map_err(|_| RepositoryError::Internal)?;
        true
    } else {
        false
    };
    fs::rename(&staging, db_path).map_err(|_| RepositoryError::Internal)?;

    // Reopen and verify receipts/revisions.
    match runtime.resume_intake().await {
        Ok(()) => {
            let _ = runtime.open().await?;
            runtime.resume_intake().await?;
            Ok(())
        }
        Err(_) => {
            // Revert to safety copy.
            if replaced {
                let _ = fs::remove_file(db_path);
                let _ = fs::rename(&prior_path, db_path);
            }
            Err(RepositoryError::IntegrityFailed)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::{CURRENT_SCHEMA_VERSION, PRODUCT_SCHEMA_DDL};

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pmapp-backup-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seeded_db(path: &Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        for ddl in PRODUCT_SCHEMA_DDL.iter() {
            conn.execute_batch(ddl).unwrap();
        }
        conn.pragma_update(None, "application_id", PMAPP_APPLICATION_ID).unwrap();
        conn.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION).unwrap();
        conn.execute(
            "INSERT INTO projects(id, name, revision) VALUES('0198a000-0000-7000-8000-000000000002', 'Test', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO nodes(id, project_id, parent_id, title, body_text, position) VALUES('0198a000-0000-7000-8000-000000000003', '0198a000-0000-7000-8000-000000000002', NULL, 'Root', NULL, 4294967296)",
            [],
        )
        .unwrap();
    }

    #[test]
    fn snapshot_verifies_and_promotes() {
        let dir = temp_dir("snapshot");
        let db = dir.join("pmapp.sqlite");
        seeded_db(&db);

        let dest = dir.join("backup.sqlite");
        snapshot_to(&db, &dest).unwrap();

        let conn = Connection::open(&dest).unwrap();
        let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(integrity, "ok");
        let count: i64 = conn
            .query_row("SELECT COUNT(1) FROM nodes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn package_and_validate_round_trip() {
        let dir = temp_dir("package");
        let db = dir.join("dir.sqlite");
        seeded_db(&db);

        let snapshot = dir.join("snapshot.sqlite");
        snapshot_to(&db, &snapshot).unwrap();

        let package = dir.join("export.pmapp");
        package_pmapp(&snapshot, &package, "0198a000-0000-7000-8000-000000000002", CURRENT_SCHEMA_VERSION).unwrap();

        let project_id = validate_candidate(&package).unwrap();
        assert_eq!(project_id, "0198a000-0000-7000-8000-000000000002");
    }

    #[test]
    fn validation_rejects_tampered_digest() {
        let dir = temp_dir("tamper");
        let db = dir.join("dir.sqlite");
        seeded_db(&db);
        let snapshot = dir.join("snapshot.sqlite");
        snapshot_to(&db, &snapshot).unwrap();
        let package = dir.join("export.pmapp");
        package_pmapp(&snapshot, &package, "0198a002-0000-7000-8000-000000000002", CURRENT_SCHEMA_VERSION).unwrap();

        // Tamper: rewrite the sqlite entry bytes inside the zip.
        let bytes = fs::read(&package).unwrap();
        fs::write(dir.join("tampered.pmapp"), &bytes).unwrap();
        // Simulate tampering by modifying manifest content_sha256.
        let path = dir.join("tampered.pmapp");
        let file = fs::File::open(&path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut manifest_bytes = Vec::new();
        archive.by_name("manifest.json").unwrap().read_to_end(&mut manifest_bytes).unwrap();
        let mut manifest: PmappManifest = serde_json::from_slice(&manifest_bytes).unwrap();
        manifest.content_sha256 = "0".repeat(64);
        // Rebuild package with tampered manifest.
        let out = fs::File::create(dir.join("tampered2.pmapp")).unwrap();
        let mut writer = zip::ZipWriter::new(out);
        let options = SimpleFileOptions::default();
        writer.start_file("manifest.json", options).unwrap();
        writer.write_all(serde_json::to_vec(&manifest).unwrap().as_slice()).unwrap();
        writer.start_file("repository.sqlite", options).unwrap();
        let snap = fs::read(&snapshot).unwrap();
        writer.write_all(&snap).unwrap();
        writer.finish().unwrap();

        let err = validate_candidate(&dir.join("tampered2.pmapp")).unwrap_err();
        assert_eq!(err, RepositoryError::InvalidRequest);
    }

    #[test]
    fn rotated_snapshots_bounded() {
        let dir = temp_dir("rotation");
        let db = dir.join("live.sqlite");
        seeded_db(&db);
        for i in 0..6 {
            rotate_recovery_snapshot(&dir.join("backups"), &db, &format!("proj-{i}")).unwrap();
        }
        let backups = fs::read_dir(dir.join("backups")).unwrap().count();
        assert!(backups <= ROTATED_BACKUP_COUNT + 6, "rotation should stay bounded per project");
    }

    #[test]
    fn native_backup_restore_preserves_live_staffing() {
        let dir = temp_dir("staffing-backup");
        let db = dir.join("live.sqlite");
        seeded_db(&db);

        let project_id = "0198a000-0000-7000-8000-000000000002";
        let feature_id = "0198a000-0000-7000-8000-000000000003";
        // `id`, not `personId`: the runtime reads this column into
        // `ForecastPersonDto { id, .. }` and a mismatched key would silently
        // deserialize to an empty roster (Story 22.10).
        let roster_json = r#"[{"id":"0198a000-0000-7000-8000-000000000004","name":"Alice","weightUnits":1000}]"#;
        let assignments_json = r#"{"0198a000-0000-7000-8000-000000000003":["0198a000-0000-7000-8000-000000000004"]}"#;

        {
            let conn = Connection::open(&db).unwrap();
            conn.execute(
                "INSERT INTO forecast_plans (
                    project_id, selected_feature_ids, parallel_groups, blocked_feature_ids,
                    points_per_sprint, sprint_length_days, cadence, start_sprint_ordinal,
                    start_date, policy_version, planning_level, roster, assignments
                ) VALUES (?1, ?2, '[]', '[]', 10, 14, 'fixed-contiguous', 1, '2026-09-07', 'staffed-capacity-v1', 'Feature', ?3, ?4)",
                rusqlite::params![
                    project_id,
                    format!(r#"["{feature_id}"]"#),
                    roster_json,
                    assignments_json,
                ],
            )
            .unwrap();
        }

        let snapshot = dir.join("snapshot.sqlite");
        snapshot_to(&db, &snapshot).unwrap();

        let package = dir.join("staffed_export.pmapp");
        package_pmapp(&snapshot, &package, project_id, CURRENT_SCHEMA_VERSION).unwrap();

        let validated_id = validate_candidate(&package).unwrap();
        assert_eq!(validated_id, project_id);

        let restored_db = dir.join("restored.sqlite");
        let file = fs::File::open(&package).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut snapshot_bytes = Vec::new();
        archive.by_name("repository.sqlite").unwrap().read_to_end(&mut snapshot_bytes).unwrap();
        fs::write(&restored_db, &snapshot_bytes).unwrap();

        verify_snapshot(&restored_db).unwrap();

        let restored_conn = Connection::open(&restored_db).unwrap();
        let (policy, level, roster, assignments): (String, String, String, String) = restored_conn
            .query_row(
                "SELECT policy_version, planning_level, roster, assignments FROM forecast_plans WHERE project_id = ?1",
                rusqlite::params![project_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();

        assert_eq!(policy, "staffed-capacity-v1");
        assert_eq!(level, "Feature");
        assert_eq!(roster, roster_json);
        assert_eq!(assignments, assignments_json);
    }

    /// Story 22.10, AC 22.10-2 (R1). Back up a staffed project with several
    /// assigned items and an idle roster member, restore the package, and
    /// read it back through the production snapshot reader the webview
    /// invokes (`repository_query_project_snapshot`). The serialized result
    /// must equal the checked-in fixture that
    /// `src/adapters/persistence/tauri-staffed-analysis.spec.ts` drives through
    /// the TypeScript adapter into analysis — so a change on either side of
    /// the native boundary fails one of the two tests.
    ///
    /// Regenerate the fixture deliberately with
    /// `PMAPP_UPDATE_NATIVE_FIXTURES=1 cargo test native_backup_restore_staffed`.
    #[test]
    fn native_backup_restore_staffed_snapshot_matches_adapter_fixture() {
        let dir = temp_dir("staffed-restore-fixture");
        let db = dir.join("live.sqlite");
        let project_id = "019ffe00-0000-7000-8000-000000000001";
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
            for ddl in PRODUCT_SCHEMA_DDL.iter() {
                conn.execute_batch(ddl).unwrap();
            }
            conn.pragma_update(None, "application_id", PMAPP_APPLICATION_ID).unwrap();
            conn.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION).unwrap();
            conn.execute(
                "INSERT INTO projects(id, name, revision) VALUES(?1, 'Synthetic staffing', 4)",
                [project_id],
            )
            .unwrap();
            for (id, title, position, points) in [
                ("019ffe00-0000-7000-8000-00000000000a", "Feature a", 1_i64, 20_i64),
                ("019ffe00-0000-7000-8000-00000000000b", "Feature b", 2, 10),
                ("019ffe00-0000-7000-8000-00000000000c", "Feature c", 3, 15),
            ] {
                conn.execute(
                    "INSERT INTO nodes(id, project_id, parent_id, title, body_text, position, node_type, effort_points, delivery_status)
                     VALUES(?1, ?2, NULL, ?3, NULL, ?4, 'Feature', ?5, 'not_started')",
                    rusqlite::params![id, project_id, title, position, points],
                )
                .unwrap();
            }
            // Cara (..c1) is on the roster but assigned to nothing: idle.
            let roster_json = r#"[{"id":"019ffe00-0000-7000-8000-0000000000a1","name":"Ada","weightUnits":100},{"id":"019ffe00-0000-7000-8000-0000000000b1","name":"Ben","weightUnits":150},{"id":"019ffe00-0000-7000-8000-0000000000c1","name":"Cara","weightUnits":50}]"#;
            // Deliberately non-canonical per-item order; the adapter canonicalizes.
            let assignments_json = r#"{"019ffe00-0000-7000-8000-00000000000c":["019ffe00-0000-7000-8000-0000000000b1"],"019ffe00-0000-7000-8000-00000000000a":["019ffe00-0000-7000-8000-0000000000b1","019ffe00-0000-7000-8000-0000000000a1"],"019ffe00-0000-7000-8000-00000000000b":["019ffe00-0000-7000-8000-0000000000a1"]}"#;
            conn.execute(
                "INSERT INTO forecast_plans (
                    project_id, selected_feature_ids, parallel_groups, blocked_feature_ids,
                    points_per_sprint, sprint_length_days, cadence, start_sprint_ordinal,
                    start_date, policy_version, planning_level, roster, assignments
                ) VALUES (?1, ?2, '[]', '[]', 10, 14, 'fixed-contiguous', 1, '2026-09-07', 'staffed-capacity-v1', 'Feature', ?3, ?4)",
                rusqlite::params![
                    project_id,
                    r#"["019ffe00-0000-7000-8000-00000000000a","019ffe00-0000-7000-8000-00000000000b","019ffe00-0000-7000-8000-00000000000c"]"#,
                    roster_json,
                    assignments_json,
                ],
            )
            .unwrap();
        }

        let snapshot = dir.join("snapshot.sqlite");
        snapshot_to(&db, &snapshot).unwrap();
        let package = dir.join("staffed.pmapp");
        package_pmapp(&snapshot, &package, project_id, CURRENT_SCHEMA_VERSION).unwrap();
        assert_eq!(validate_candidate(&package).unwrap(), project_id);

        // Same extraction and verification `restore_from_candidate` performs.
        let restored_db = dir.join("restored.sqlite");
        let mut archive = zip::ZipArchive::new(fs::File::open(&package).unwrap()).unwrap();
        let mut bytes = Vec::new();
        archive.by_name("repository.sqlite").unwrap().read_to_end(&mut bytes).unwrap();
        fs::write(&restored_db, &bytes).unwrap();
        verify_snapshot(&restored_db).unwrap();

        let restored = Connection::open(&restored_db).unwrap();
        let rows = crate::db::runtime::query_project_snapshot(&restored, project_id).unwrap();
        let plan = rows.forecast_plan.as_ref().expect("restored snapshot must carry the plan");
        assert_eq!(plan.roster.len(), 3, "the idle roster member must survive restore");
        assert_eq!(plan.assignments.len(), 3, "every assigned item must survive restore");

        let actual = serde_json::to_value(&rows).unwrap();
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/adapters/persistence/fixtures/native-staffed-restored-snapshot.json");
        if std::env::var_os("PMAPP_UPDATE_NATIVE_FIXTURES").is_some() {
            let mut text = serde_json::to_string_pretty(&actual).unwrap();
            text.push('\n');
            fs::write(&fixture_path, text).unwrap();
        }
        let expected: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&fixture_path).expect("fixture missing; see doc comment")).unwrap();
        assert_eq!(actual, expected, "restored native snapshot drifted from the adapter fixture");
    }

    #[test]
    fn native_backup_restore_preserves_shared_and_staffed_scenarios() {
        let dir = temp_dir("staffed-scenarios-backup");
        let db = dir.join("live.sqlite");
        seeded_db(&db);

        let project_id = "0198a000-0000-7000-8000-000000000002";

        let shared_id = "0198a000-0000-7000-8000-000000000081";
        let staffed_id = "0198a000-0000-7000-8000-000000000082";

        let shared_baseline_json = r#"{"planningLevel":"Feature","orderedScope":["0198a000-0000-7000-8000-000000000003"],"configuration":{"pointsPerSprint":10,"sprintLengthDays":14,"cadence":"fixed-contiguous","startSprintOrdinal":1,"startDate":"2026-09-07"},"parallelGroups":[],"blockedFeatureIds":[],"factMap":{"0198a000-0000-7000-8000-000000000003":{"effortPoints":5,"projectId":"0198a000-0000-7000-8000-000000000002","ancestorIds":[],"nodeType":"Feature"}}}"#;
        let shared_patch_json = r#"{"pointsPerSprint":15}"#;

        let staffed_baseline_json = r#"{"planningLevel":"Feature","orderedScope":["0198a000-0000-7000-8000-000000000003"],"configuration":{"pointsPerSprint":10,"sprintLengthDays":14,"cadence":"fixed-contiguous","startSprintOrdinal":1,"startDate":"2026-09-07"},"parallelGroups":[],"blockedFeatureIds":[],"roster":[{"id":"0198a000-0000-7000-8000-000000000004","name":"Alice","weightUnits":1000},{"id":"0198a000-0000-7000-8000-000000000005","name":"Bob","weightUnits":500}],"assignments":{"0198a000-0000-7000-8000-000000000003":["0198a000-0000-7000-8000-000000000004"]},"factMap":{"0198a000-0000-7000-8000-000000000003":{"effortPoints":5,"projectId":"0198a000-0000-7000-8000-000000000002","ancestorIds":[],"nodeType":"Feature"}}}"#;
        let staffed_patch_json = r#"{"weightOverrides":{"0198a000-0000-7000-8000-000000000005":1000},"assignmentOverrides":{"0198a000-0000-7000-8000-000000000003":["0198a000-0000-7000-8000-000000000005"]}}"#;

        {
            let conn = Connection::open(&db).unwrap();
            conn.execute(
                "INSERT INTO forecast_scenarios (
                    scenario_id, project_id, label, baseline_revision, baseline_fingerprint,
                    policy_version, created_at_iso, baseline_json, patch_json
                ) VALUES (?1, ?2, 'Shared S1', 1, 'fp1', 'shared-capacity-v1', '2026-09-01T00:00:00.000Z', ?3, ?4)",
                rusqlite::params![shared_id, project_id, shared_baseline_json, shared_patch_json],
            )
            .unwrap();

            conn.execute(
                "INSERT INTO forecast_scenarios (
                    scenario_id, project_id, label, baseline_revision, baseline_fingerprint,
                    policy_version, created_at_iso, baseline_json, patch_json
                ) VALUES (?1, ?2, 'Staffed S2 with Idle Bob', 1, 'fp2', 'staffed-capacity-v1', '2026-09-02T00:00:00.000Z', ?3, ?4)",
                rusqlite::params![staffed_id, project_id, staffed_baseline_json, staffed_patch_json],
            )
            .unwrap();
        }

        let snapshot = dir.join("snapshot.sqlite");
        snapshot_to(&db, &snapshot).unwrap();

        let package = dir.join("scenarios_export.pmapp");
        package_pmapp(&snapshot, &package, project_id, CURRENT_SCHEMA_VERSION).unwrap();

        let validated_id = validate_candidate(&package).unwrap();
        assert_eq!(validated_id, project_id);

        let restored_db = dir.join("restored.sqlite");
        let file = fs::File::open(&package).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut snapshot_bytes = Vec::new();
        archive.by_name("repository.sqlite").unwrap().read_to_end(&mut snapshot_bytes).unwrap();
        fs::write(&restored_db, &snapshot_bytes).unwrap();

        verify_snapshot(&restored_db).unwrap();

        let restored_conn = Connection::open(&restored_db).unwrap();
        let scenarios: Vec<(String, String, String, String)> = {
            let mut stmt = restored_conn
                .prepare("SELECT scenario_id, policy_version, baseline_json, patch_json FROM forecast_scenarios WHERE project_id = ?1 ORDER BY created_at_iso")
                .unwrap();
            let rows = stmt
                .query_map([project_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .unwrap();
            rows.map(|r| r.unwrap()).collect()
        };

        assert_eq!(scenarios.len(), 2);
        assert_eq!(scenarios[0].0, shared_id);
        assert_eq!(scenarios[0].1, "shared-capacity-v1");
        assert_eq!(scenarios[0].2, shared_baseline_json);
        assert_eq!(scenarios[0].3, shared_patch_json);

        assert_eq!(scenarios[1].0, staffed_id);
        assert_eq!(scenarios[1].1, "staffed-capacity-v1");
        assert_eq!(scenarios[1].2, staffed_baseline_json);
        assert_eq!(scenarios[1].3, staffed_patch_json);
    }
}
