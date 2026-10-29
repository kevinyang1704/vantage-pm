//! Backup coordination loop (Story 27.5, D4/R5, H10).
//!
//! Each iteration captures one coherent cut (`backup_capture`), releases the
//! writer exclusion, then hashes and uploads every copy, writes the strict
//! manifest LAST, raises the external epoch witness, and applies retention.
//! Evidence is codes, counts, hashes and timings only — never authored text
//! or credentials.
//!
//! The 900-second cadence alone does not prove RPO <= 15 minutes: publication
//! latency consumes the same budget. Every iteration reports the published
//! cut's age and the publication duration so staging can measure it.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::backup::sha256_hex;
use crate::backup_capture::{capture_cut, read_copy_metadata, CaptureSources, CapturedCut};
use crate::backup_checkpoint::{object_key, BackupFile, BackupManifest, DatabaseKind, EpochWitness, MANIFEST_VERSION, WITNESS_KEY};
use crate::backup_config::BackupConfig;
use crate::backup_retention::{apply_retention, RetentionPolicy};
use crate::backup_store::{ObjectStore, S3Store, StoreError};

/// Keep cadence start-to-start; an overrun retries immediately without
/// accumulating missed timer ticks.
fn cadence_delay(interval: Duration, elapsed: Duration) -> Duration {
    interval.saturating_sub(elapsed)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WitnessOutcome {
    Raised(i64),
    Unchanged(i64),
    /// The existing witness could not be read or parsed; it is left alone and
    /// therefore cannot authorize a rotation above this generation's epochs.
    Unreadable(String),
}

#[derive(Debug, Clone)]
pub struct PublishedGeneration {
    pub manifest: BackupManifest,
    pub manifest_sha256: String,
    pub bytes: u64,
    pub writer_exclusion: Duration,
    pub publication: Duration,
    /// Age of the cut when its manifest became visible.
    pub published_cut_age: Duration,
    pub witness: WitnessOutcome,
}

/// Build the manifest from a captured cut using metadata read from the copies.
pub fn manifest_for(cut: &CapturedCut) -> Result<(BackupManifest, Vec<(String, Vec<u8>)>), String> {
    let mut files = Vec::new();
    let mut payloads = Vec::new();
    let mut membership_revision = None;
    for database in &cut.databases {
        let meta = read_copy_metadata(database)?;
        let bytes = std::fs::read(&database.path).map_err(|_| "CUT_COPY_UNREADABLE".to_string())?;
        let key = object_key(&cut.generation_id, &database.logical_name);
        if database.kind == DatabaseKind::Membership { membership_revision = meta.membership_revision; }
        files.push(BackupFile {
            kind: database.kind,
            logical_name: database.logical_name.clone(),
            object_key: key.clone(),
            sha256: sha256_hex(&bytes),
            size_bytes: bytes.len() as u64,
            schema_version: meta.schema_version,
            project_id: database.project_id.clone(),
            server_revision: meta.server_revision,
            stream_epoch: meta.stream_epoch,
            history_floor: meta.history_floor,
        });
        payloads.push((key, bytes));
    }
    let manifest = BackupManifest {
        manifest_version: MANIFEST_VERSION,
        generation_id: cut.generation_id.clone(),
        cut_at_iso: cut.cut_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        membership_revision: membership_revision.ok_or("CUT_MEMBERSHIP_MISSING")?,
        files,
    };
    manifest.validate().map_err(|e| e.to_string())?;
    Ok((manifest, payloads))
}

/// Upload a captured cut: every object, then the manifest LAST, then raise the
/// witness. A failure before the manifest leaves an unpublished orphan that
/// retention may later remove; it is never restorable.
pub async fn publish_cut<S: ObjectStore>(store: &S, cut: &CapturedCut) -> Result<PublishedGeneration, String> {
    let started = Instant::now();
    let (manifest, payloads) = manifest_for(cut)?;
    let mut bytes = 0u64;
    for (key, body) in payloads {
        bytes += body.len() as u64;
        store.put(&key, body).await.map_err(|e| format!("PUBLISH_OBJECT_FAILED:{e}"))?;
    }
    let manifest_json = serde_json::to_vec_pretty(&manifest).map_err(|_| "MANIFEST_ENCODE_FAILED".to_string())?;
    let manifest_sha256 = sha256_hex(&manifest_json);
    store.put(&manifest.manifest_key(), manifest_json).await.map_err(|e| format!("PUBLISH_MANIFEST_FAILED:{e}"))?;
    let published_cut_age = (chrono::Utc::now() - cut.cut_at).to_std().unwrap_or_default();
    let witness = raise_witness(store, &manifest).await;
    Ok(PublishedGeneration {
        manifest, manifest_sha256, bytes, writer_exclusion: cut.gate_held,
        publication: started.elapsed(), published_cut_age, witness,
    })
}

/// Raise the external witness to strictly above this generation's epochs.
pub async fn raise_witness<S: ObjectStore>(store: &S, manifest: &BackupManifest) -> WitnessOutcome {
    let prior = match store.get(WITNESS_KEY, 64 * 1024).await {
        Ok(bytes) => match EpochWitness::parse(&bytes) {
            Ok(witness) => Some(witness),
            Err(e) => return WitnessOutcome::Unreadable(e.to_string()),
        },
        Err(StoreError::NotFound) => None,
        Err(e) => return WitnessOutcome::Unreadable(e.to_string()),
    };
    let needed = manifest.max_stream_epoch() + 1;
    if let Some(prior) = &prior {
        if prior.exclusive_high_water >= needed { return WitnessOutcome::Unchanged(prior.exclusive_high_water); }
    }
    let next = EpochWitness {
        witness_version: 1,
        exclusive_high_water: needed.max(2),
        updated_at_iso: crate::now_iso(),
        generation_id: manifest.generation_id.clone(),
    };
    match serde_json::to_vec(&next) {
        Ok(body) => match store.put(WITNESS_KEY, body).await {
            Ok(()) => WitnessOutcome::Raised(next.exclusive_high_water),
            Err(e) => WitnessOutcome::Unreadable(format!("WITNESS_WRITE_FAILED:{e}")),
        },
        Err(_) => WitnessOutcome::Unreadable("WITNESS_ENCODE_FAILED".into()),
    }
}

/// One iteration: capture (blocking thread), publish, then retention.
pub async fn run_iteration<S: ObjectStore>(store: &S, sources: &CaptureSources, staging: &Path, policy: RetentionPolicy) -> Result<PublishedGeneration, String> {
    let capture_sources = sources.clone();
    let capture_staging = staging.to_path_buf();
    let cut = tokio::task::spawn_blocking(move || capture_cut(&capture_sources, &capture_staging))
        .await
        .map_err(|_| "CAPTURE_TASK_FAILED".to_string())??;
    let published = publish_cut(store, &cut).await;
    let _ = std::fs::remove_dir_all(&cut.dir);
    let published = published?;
    match apply_retention(store, policy, chrono::Utc::now().timestamp()).await {
        Ok(report) => eprintln!("backup: retention valid={} pruned={} orphans_removed={}", report.valid_generations, report.pruned.len(), report.orphan_objects_removed),
        Err(code) => eprintln!("backup: retention skipped (fail closed) code={code}"),
    }
    Ok(published)
}

/// Spawn the periodic backup loop. A no-op when backup is unconfigured.
pub fn spawn_backup_loop(config: Option<BackupConfig>, sources: CaptureSources) {
    let Some(config) = config else { return };
    let interval = config.interval;
    let policy = RetentionPolicy::from_config(&config);
    tokio::spawn(async move {
        let store = match S3Store::new(config) {
            Ok(store) => store,
            Err(e) => { eprintln!("backup: store unavailable code={e}"); return; }
        };
        let staging: PathBuf = sources.data_dir.join(".backup-staging");
        loop {
            let started = tokio::time::Instant::now();
            match run_iteration(&store, &sources, &staging, policy).await {
                Ok(p) => eprintln!(
                    "backup: published generation={} files={} bytes={} manifest_sha256={} writer_exclusion_ms={} publication_ms={} published_cut_age_ms={} witness={:?}",
                    p.manifest.generation_id, p.manifest.files.len(), p.bytes, p.manifest_sha256,
                    p.writer_exclusion.as_millis(), p.publication.as_millis(), p.published_cut_age.as_millis(), p.witness,
                ),
                Err(code) => eprintln!("backup: generation failed code={code}"),
            }
            let elapsed = started.elapsed();
            if elapsed >= interval {
                eprintln!("backup: cadence overrun elapsed_ms={} interval_ms={}; recovery point objective unverified", elapsed.as_millis(), interval.as_millis());
            }
            tokio::time::sleep(cadence_delay(interval, elapsed)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup_capture::tests::{sources, temp_dir, PROJECT};
    use crate::backup_store::MemoryStore;

    #[test]
    fn upload_time_does_not_extend_the_scheduled_interval() {
        let interval = Duration::from_secs(900);
        assert_eq!(cadence_delay(interval, Duration::from_secs(120)), Duration::from_secs(780));
        assert_eq!(cadence_delay(interval, interval), Duration::ZERO);
        assert_eq!(cadence_delay(interval, Duration::from_secs(901)), Duration::ZERO);
    }

    #[tokio::test]
    async fn publishes_objects_before_the_manifest_and_raises_the_witness() {
        let sources = sources("pub");
        let store = MemoryStore::new();
        let staging = temp_dir("pub-staging");
        let cut = capture_cut(&sources, &staging).unwrap();
        let published = publish_cut(&store, &cut).await.unwrap();
        let log = store.put_log.lock().unwrap().clone();
        let manifest_at = log.iter().position(|k| k.ends_with("manifest.json")).unwrap();
        assert_eq!(manifest_at, published.manifest.files.len(), "manifest must be written after every object");
        assert_eq!(log.last().unwrap(), WITNESS_KEY);
        assert_eq!(published.witness, WitnessOutcome::Raised(2));
        let stored = BackupManifest::parse(&store.get(&published.manifest.manifest_key(), 1 << 20).await.unwrap()).unwrap();
        assert_eq!(stored, published.manifest);
        let project = stored.files.iter().find(|f| f.project_id.as_deref() == Some(PROJECT)).unwrap();
        assert_eq!((project.server_revision, project.stream_epoch), (Some(1), Some(1)));
        for file in &stored.files {
            assert_eq!(sha256_hex(&store.get(&file.object_key, 1 << 30).await.unwrap()), file.sha256);
        }
        // A second publication at the same epoch leaves the witness unchanged.
        let again = publish_cut(&store, &capture_cut(&sources, &staging).unwrap()).await.unwrap();
        assert_eq!(again.witness, WitnessOutcome::Unchanged(2));
        assert_ne!(again.manifest.generation_id, published.manifest.generation_id);
        let _ = std::fs::remove_dir_all(&sources.data_dir);
        let _ = std::fs::remove_dir_all(&staging);
    }

    #[tokio::test]
    async fn failed_object_upload_never_publishes_a_manifest() {
        let sources = sources("pub-fail");
        let store = MemoryStore::new();
        store.fail_put_keys.lock().unwrap().push(format!("project-{PROJECT}.sqlite"));
        let staging = temp_dir("pub-fail-staging");
        let cut = capture_cut(&sources, &staging).unwrap();
        assert!(publish_cut(&store, &cut).await.unwrap_err().starts_with("PUBLISH_OBJECT_FAILED"));
        assert!(store.keys().iter().all(|k| !k.ends_with("manifest.json")));
        assert!(store.keys().iter().all(|k| k != WITNESS_KEY));
        let _ = std::fs::remove_dir_all(&sources.data_dir);
        let _ = std::fs::remove_dir_all(&staging);
    }

    #[tokio::test]
    async fn unreadable_witness_is_left_alone() {
        let sources = sources("pub-witness");
        let store = MemoryStore::new();
        store.insert(WITNESS_KEY, b"not json".to_vec(), 0);
        let staging = temp_dir("pub-witness-staging");
        let published = publish_cut(&store, &capture_cut(&sources, &staging).unwrap()).await.unwrap();
        assert!(matches!(published.witness, WitnessOutcome::Unreadable(_)));
        assert_eq!(store.get(WITNESS_KEY, 1024).await.unwrap(), b"not json".to_vec());
        let _ = std::fs::remove_dir_all(&sources.data_dir);
        let _ = std::fs::remove_dir_all(&staging);
    }

    /// The upload runs after the capture released every lock: writers proceed
    /// while publication is still in flight.
    #[tokio::test]
    async fn blocked_upload_does_not_hold_writers() {
        let sources = sources("pub-blocked");
        let staging = temp_dir("pub-blocked-staging");
        let cut = capture_cut(&sources, &staging).unwrap();
        // Capture has returned and publication has not started; every lock is free.
        assert!(sources.membership.try_lock().is_ok());
        assert!(sources.logs.try_lock().is_ok());
        let store = MemoryStore::new();
        let publishing = publish_cut(&store, &cut);
        // A writer commits while publication is pending.
        {
            let cache = sources.logs.lock().unwrap();
            cache[PROJECT].lock().unwrap().submit(crate::backup_capture::tests::create_node(1, 1)).unwrap();
        }
        let published = publishing.await.unwrap();
        let project = published.manifest.files.iter().find(|f| f.project_id.is_some()).unwrap();
        assert_eq!(project.server_revision, Some(1), "post-cut write must be excluded from the generation");
        let _ = std::fs::remove_dir_all(&sources.data_dir);
        let _ = std::fs::remove_dir_all(&staging);
    }
}
