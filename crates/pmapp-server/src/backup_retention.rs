//! Backup retention (Story 27.5, R5).
//!
//! Prunes only complete, validated generations that fall strictly outside the
//! retention window (default 30 days + 1 hour, covering the D9 offline/retry
//! window), and always keeps the newest valid recovery point even when it is
//! older than the window. Unpublished orphans (objects under a generation
//! prefix with no manifest) are removed only after their own age guard.
//!
//! Every decision is made before any deletion. A failed listing, an invalid
//! manifest or a published generation missing an object aborts the whole pass
//! (fail closed). Only keys under a well-formed `generations/<id>/` prefix are
//! ever deleted; arbitrary bucket keys, the witness and anything else are
//! never touched. Retention never compacts command identity or history.

use std::collections::{BTreeMap, BTreeSet};

use crate::backup_checkpoint::{generation_of_key, manifest_key, BackupManifest, GENERATIONS_PREFIX, MAX_MANIFEST_BYTES};
use crate::backup_config::BackupConfig;
use crate::backup_store::{ObjectInfo, ObjectStore};

/// Orphans must be older than any plausible publication before removal.
pub const DEFAULT_ORPHAN_AGE_SECS: i64 = 24 * 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetentionPolicy {
    pub retention_secs: i64,
    pub orphan_age_secs: i64,
}

impl RetentionPolicy {
    pub fn from_config(config: &BackupConfig) -> Self {
        Self { retention_secs: config.retention.as_secs() as i64, orphan_age_secs: DEFAULT_ORPHAN_AGE_SECS }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RetentionReport {
    pub valid_generations: usize,
    pub newest_kept: Option<String>,
    pub pruned: Vec<String>,
    pub orphan_objects_removed: usize,
}

pub async fn apply_retention<S: ObjectStore>(store: &S, policy: RetentionPolicy, now_secs: i64) -> Result<RetentionReport, String> {
    if policy.retention_secs < crate::backup_config::MIN_RETENTION_SECONDS as i64 { return Err("RETENTION_POLICY_UNSAFE".into()); }
    let objects = store.list(GENERATIONS_PREFIX).await.map_err(|e| format!("RETENTION_LIST_FAILED:{e}"))?;
    let mut by_generation: BTreeMap<String, Vec<ObjectInfo>> = BTreeMap::new();
    for object in objects {
        if let Some(generation) = generation_of_key(&object.key) {
            by_generation.entry(generation.to_string()).or_default().push(object);
        }
    }

    // Phase 1: validate everything; no deletion yet.
    let mut valid: Vec<(i64, BackupManifest)> = Vec::new();
    let mut orphans: Vec<String> = Vec::new();
    for (generation, objects) in &by_generation {
        let key = manifest_key(generation);
        if objects.iter().any(|o| o.key == key) {
            let bytes = store.get(&key, MAX_MANIFEST_BYTES).await.map_err(|e| format!("RETENTION_MANIFEST_UNREADABLE:{e}"))?;
            let manifest = BackupManifest::parse(&bytes).map_err(|e| format!("RETENTION_MANIFEST_INVALID:{e}"))?;
            if &manifest.generation_id != generation { return Err("RETENTION_MANIFEST_MISPLACED".into()); }
            for file in &manifest.files {
                let present = objects.iter().any(|o| o.key == file.object_key && o.size == file.size_bytes);
                if !present { return Err("RETENTION_GENERATION_INCOMPLETE".into()); }
            }
            valid.push((manifest.cut_at_secs().map_err(|e| e.to_string())?, manifest));
        } else {
            let newest = objects.iter().map(|o| o.last_modified_secs).collect::<Option<Vec<_>>>().and_then(|t| t.into_iter().max());
            // Unknown modification time: cannot prove age, so keep it.
            if newest.is_some_and(|t| now_secs - t > policy.orphan_age_secs) {
                orphans.extend(objects.iter().map(|o| o.key.clone()));
            }
        }
    }
    valid.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.generation_id.cmp(&b.1.generation_id)));
    let newest_kept = valid.last().map(|(_, m)| m.generation_id.clone());
    let expired: Vec<&BackupManifest> = valid
        .iter()
        .filter(|(cut, m)| Some(&m.generation_id) != newest_kept.as_ref() && now_secs - cut > policy.retention_secs)
        .map(|(_, m)| m)
        .collect();

    // Phase 2: delete. Manifest first, so a partially pruned generation is an
    // unpublished orphan (never a restorable but incomplete one).
    let mut pruned = Vec::new();
    for manifest in expired {
        let mut keys: BTreeSet<&str> = manifest.files.iter().map(|f| f.object_key.as_str()).collect();
        let manifest_key = manifest.manifest_key();
        store.delete(&manifest_key).await.map_err(|e| format!("RETENTION_DELETE_FAILED:{e}"))?;
        keys.remove(manifest_key.as_str());
        for key in keys {
            store.delete(key).await.map_err(|e| format!("RETENTION_DELETE_FAILED:{e}"))?;
        }
        pruned.push(manifest.generation_id.clone());
    }
    let mut orphan_objects_removed = 0;
    for key in orphans {
        store.delete(&key).await.map_err(|e| format!("RETENTION_DELETE_FAILED:{e}"))?;
        orphan_objects_removed += 1;
    }
    Ok(RetentionReport { valid_generations: valid.len(), newest_kept, pruned, orphan_objects_removed })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup_checkpoint::{object_key, BackupFile, DatabaseKind, WITNESS_KEY};
    use crate::backup_store::MemoryStore;

    const DAY: i64 = 24 * 60 * 60;
    const POLICY: RetentionPolicy = RetentionPolicy { retention_secs: 30 * DAY + 3600, orphan_age_secs: DAY };
    const BASE: i64 = 1_790_000_000; // 2026-09-21T...Z

    fn publish(store: &MemoryStore, cut_secs: i64, suffix: &str) -> String {
        let cut = chrono::DateTime::from_timestamp(cut_secs, 0).unwrap();
        let generation_id = format!("{}-{suffix}", cut.format("%Y%m%dT%H%M%SZ"));
        let body = b"sqlite".to_vec();
        let file = BackupFile {
            kind: DatabaseKind::Membership, logical_name: "membership".into(), object_key: object_key(&generation_id, "membership"),
            sha256: crate::backup::sha256_hex(&body), size_bytes: body.len() as u64, schema_version: 1,
            project_id: None, server_revision: None, stream_epoch: None, history_floor: None,
        };
        store.insert(&file.object_key, body, cut_secs);
        let manifest = BackupManifest { manifest_version: 1, generation_id: generation_id.clone(),
            cut_at_iso: cut.to_rfc3339_opts(chrono::SecondsFormat::Secs, true), membership_revision: 1, files: vec![file] };
        store.insert(&manifest.manifest_key(), serde_json::to_vec(&manifest).unwrap(), cut_secs);
        generation_id
    }

    #[tokio::test]
    async fn prunes_only_strictly_outside_the_window_and_keeps_the_newest() {
        let store = MemoryStore::new();
        let old = publish(&store, BASE, "0000000000000001");
        let boundary = publish(&store, BASE + 10 * DAY, "0000000000000002");
        let recent = publish(&store, BASE + 35 * DAY, "0000000000000003");
        store.insert(WITNESS_KEY, b"{}".to_vec(), BASE);
        store.insert("unrelated/key", b"x".to_vec(), BASE);
        let now = BASE + 10 * DAY + POLICY.retention_secs; // `boundary` is exactly at the window edge.
        let report = apply_retention(&store, POLICY, now).await.unwrap();
        assert_eq!(report.pruned, vec![old.clone()]);
        assert_eq!(report.newest_kept.as_deref(), Some(recent.as_str()));
        let keys = store.keys();
        assert!(keys.iter().all(|k| !k.contains(&old)));
        assert!(keys.iter().any(|k| k.contains(&boundary)), "a generation exactly at the edge is not strictly outside");
        assert!(keys.contains(&WITNESS_KEY.to_string()) && keys.contains(&"unrelated/key".to_string()));
    }

    #[tokio::test]
    async fn newest_valid_point_survives_even_when_stale() {
        let store = MemoryStore::new();
        let a = publish(&store, BASE, "000000000000000a");
        let b = publish(&store, BASE + DAY, "000000000000000b");
        let report = apply_retention(&store, POLICY, BASE + 400 * DAY).await.unwrap();
        assert_eq!(report.pruned, vec![a]);
        assert_eq!(report.newest_kept, Some(b.clone()));
        assert!(store.keys().iter().any(|k| k.contains(&b)));
    }

    #[tokio::test]
    async fn invalid_or_incomplete_generations_and_list_failure_fail_closed() {
        let store = MemoryStore::new();
        let old = publish(&store, BASE, "0000000000000001");
        publish(&store, BASE + 40 * DAY, "0000000000000002");
        let before = store.keys();
        // A corrupt manifest anywhere aborts the pass before deleting anything.
        let bad = publish(&store, BASE + 41 * DAY, "0000000000000003");
        store.insert(&manifest_key(&bad), b"{\"manifestVersion\":9}".to_vec(), BASE);
        assert!(apply_retention(&store, POLICY, BASE + 400 * DAY).await.unwrap_err().starts_with("RETENTION_MANIFEST_INVALID"));
        assert!(before.iter().all(|k| store.keys().contains(k)), "nothing deleted after a validation failure");
        // A published generation missing an object also aborts.
        store.objects.lock().unwrap().remove(&manifest_key(&bad));
        store.objects.lock().unwrap().remove(&object_key(&old, "membership"));
        assert_eq!(apply_retention(&store, POLICY, BASE + 400 * DAY).await.unwrap_err(), "RETENTION_GENERATION_INCOMPLETE");
        assert!(store.keys().contains(&manifest_key(&old)));
        // Listing failure aborts.
        *store.fail_list.lock().unwrap() = true;
        assert!(apply_retention(&store, POLICY, BASE + 400 * DAY).await.unwrap_err().starts_with("RETENTION_LIST_FAILED"));
        // An unsafe policy is refused outright.
        *store.fail_list.lock().unwrap() = false;
        assert_eq!(apply_retention(&store, RetentionPolicy { retention_secs: DAY, orphan_age_secs: DAY }, BASE).await.unwrap_err(), "RETENTION_POLICY_UNSAFE");
    }

    #[tokio::test]
    async fn orphans_need_their_own_age_guard_and_a_wellformed_prefix() {
        let store = MemoryStore::new();
        publish(&store, BASE, "0000000000000001");
        let young = "generations/20261006T120000Z-00000000000000aa/membership.sqlite";
        let old = "generations/20260901T120000Z-00000000000000bb/membership.sqlite";
        let malformed = "generations/not-a-generation/membership.sqlite";
        store.insert(young, b"x".to_vec(), BASE + 5 * DAY - 60);
        store.insert(old, b"x".to_vec(), BASE);
        store.insert(malformed, b"x".to_vec(), BASE);
        let report = apply_retention(&store, POLICY, BASE + 5 * DAY).await.unwrap();
        assert_eq!(report.orphan_objects_removed, 1);
        let keys = store.keys();
        assert!(!keys.contains(&old.to_string()));
        assert!(keys.contains(&young.to_string()), "an in-flight publication is not an orphan yet");
        assert!(keys.contains(&malformed.to_string()), "keys outside a valid generation prefix are never deleted");
    }
}
