//! Backup evidence for operations (Story 28.3, AC 27.5-6 / contract R5).
//!
//! * `rpo_report` — sustained RPO from the published generations alone: the
//!   gaps between consecutive cuts and how long each cut took to publish. A
//!   generation id begins with its UTC cut time and the manifest's
//!   last-modified time is when it was published, so only the bucket listing
//!   is read (no downloads).
//! * `rto_bench` — RTO on production-sized data: a synthetic data set is
//!   captured, published and then restored and verified by the same code the
//!   real drill uses, against the configured object store, inside an isolated
//!   `bench/<id>/` prefix that live backups, retention and drills never list.
//!   The prefix is deleted afterwards.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;

use crate::backup_capture::{capture_cut, CaptureSources};
use crate::backup_checkpoint::{generation_of_key, manifest_key, GENERATIONS_PREFIX};
use crate::backup_loop::publish_cut;
use crate::backup_store::{ObjectInfo, ObjectStore, StoreError};
use crate::restore_drill::{run_restore_drill, DrillEvidence};

/// ADR R5: RPO <= 15 minutes.
pub const RPO_BUDGET_SECS: i64 = 15 * 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpoReport {
    pub generations: usize,
    pub first_cut_iso: Option<String>,
    pub last_cut_iso: Option<String>,
    /// Gaps between consecutive cuts, in seconds.
    pub median_gap_secs: Option<i64>,
    pub p95_gap_secs: Option<i64>,
    pub max_gap_secs: Option<i64>,
    /// Cut-to-published delay, in seconds.
    pub max_publish_delay_secs: Option<i64>,
    /// Worst observed loss window: largest gap plus largest publish delay.
    pub observed_rpo_secs: Option<i64>,
    /// Seconds since the newest cut at the time of the report.
    pub newest_cut_age_secs: Option<i64>,
    pub gaps_over_budget: usize,
    pub rpo_budget_secs: i64,
    pub within_rpo: bool,
}

fn cut_secs(generation_id: &str) -> Option<i64> {
    let stamp = generation_id.split_once('-')?.0;
    chrono::NaiveDateTime::parse_from_str(stamp, "%Y%m%dT%H%M%SZ").ok().map(|t| t.and_utc().timestamp())
}

fn percentile(sorted: &[i64], p: f64) -> Option<i64> {
    if sorted.is_empty() { return None; }
    let rank = ((p * sorted.len() as f64).ceil() as usize).clamp(1, sorted.len());
    Some(sorted[rank - 1])
}

/// Sustained RPO over every published generation in the store.
pub async fn rpo_report<S: ObjectStore>(store: &S, now_secs: i64) -> Result<RpoReport, String> {
    let objects = store.list(GENERATIONS_PREFIX).await.map_err(|e| format!("RPO_LIST_FAILED:{e}"))?;
    Ok(rpo_from_listing(&objects, now_secs))
}

pub fn rpo_from_listing(objects: &[ObjectInfo], now_secs: i64) -> RpoReport {
    // (cut, published) per published generation (one that has a manifest).
    let mut published: Vec<(String, i64, Option<i64>)> = objects
        .iter()
        .filter_map(|o| {
            let generation = generation_of_key(&o.key)?;
            (o.key == manifest_key(generation)).then_some(())?;
            Some((generation.to_string(), cut_secs(generation)?, o.last_modified_secs))
        })
        .collect();
    published.sort();
    let mut gaps: Vec<i64> = published.windows(2).map(|w| w[1].1 - w[0].1).collect();
    let max_publish_delay = published.iter().filter_map(|(_, cut, at)| at.map(|at| (at - cut).max(0))).max();
    let newest = published.last().map(|(_, cut, _)| *cut);
    let max_gap = gaps.iter().copied().max();
    let gaps_over_budget = gaps.iter().filter(|g| **g > RPO_BUDGET_SECS).count();
    gaps.sort_unstable();
    let observed = max_gap.map(|g| g + max_publish_delay.unwrap_or(0));
    let iso = |secs: i64| chrono::DateTime::from_timestamp(secs, 0).map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    RpoReport {
        generations: published.len(),
        first_cut_iso: published.first().and_then(|(_, cut, _)| iso(*cut)),
        last_cut_iso: newest.and_then(iso),
        median_gap_secs: percentile(&gaps, 0.5),
        p95_gap_secs: percentile(&gaps, 0.95),
        max_gap_secs: max_gap,
        max_publish_delay_secs: max_publish_delay,
        observed_rpo_secs: observed,
        newest_cut_age_secs: newest.map(|cut| now_secs - cut),
        gaps_over_budget,
        rpo_budget_secs: RPO_BUDGET_SECS,
        within_rpo: published.len() >= 2 && observed.is_some_and(|o| o <= RPO_BUDGET_SECS),
    }
}

/// Every key behind a fixed prefix, so a bench never shares keys with live
/// backups (or another bench).
pub struct PrefixedStore<'a, S> {
    inner: &'a S,
    prefix: String,
}

impl<'a, S: ObjectStore> PrefixedStore<'a, S> {
    pub fn new(inner: &'a S, prefix: &str) -> Self { Self { inner, prefix: prefix.to_string() } }
}

impl<S: ObjectStore> ObjectStore for PrefixedStore<'_, S> {
    async fn put(&self, key: &str, body: Vec<u8>) -> Result<(), StoreError> { self.inner.put(&format!("{}{key}", self.prefix), body).await }
    async fn get(&self, key: &str, max_bytes: u64) -> Result<Vec<u8>, StoreError> { self.inner.get(&format!("{}{key}", self.prefix), max_bytes).await }
    async fn delete(&self, key: &str) -> Result<(), StoreError> { self.inner.delete(&format!("{}{key}", self.prefix)).await }
    async fn list(&self, prefix: &str) -> Result<Vec<ObjectInfo>, StoreError> {
        let listed = self.inner.list(&format!("{}{prefix}", self.prefix)).await?;
        Ok(listed.into_iter().filter_map(|o| Some(ObjectInfo { key: o.key.strip_prefix(&self.prefix)?.to_string(), ..o })).collect())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchShape {
    pub projects: u32,
    pub nodes_per_project: u32,
    pub history_per_project: u32,
    pub body_bytes: u32,
}

/// The default "production-sized" shape: well above staging today (17
/// projects), sized so an R2 round trip stays a few minutes.
pub const PRODUCTION_SHAPE: BenchShape = BenchShape { projects: 100, nodes_per_project: 2000, history_per_project: 100, body_bytes: 200 };

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RtoBench {
    pub shape: BenchShape,
    pub data_bytes: u64,
    pub seed_ms: u128,
    pub capture_ms: u128,
    pub publish_ms: u128,
    /// The restore itself (download + verify), from object storage alone.
    pub drill: DrillEvidence,
    pub cleaned_up: bool,
}

fn synthetic_id(group: u32, n: u32) -> String { format!("0199{group:04x}-0000-7000-8000-{n:012x}") }

/// Write a synthetic data set: real commands for history, then bulk nodes.
pub fn seed_synthetic(data_dir: &Path, shape: BenchShape) -> Result<u64, String> {
    use pmapp_core::protocol::commands::{CreateNodeCommand, ProductCommand};
    std::fs::create_dir_all(data_dir).map_err(|_| "BENCH_DATA_DIR_FAILED".to_string())?;
    let membership = crate::MembershipStore::open(&data_dir.join("membership.sqlite")).map_err(|_| "BENCH_MEMBERSHIP_FAILED".to_string())?;
    drop(membership);
    let body = "x".repeat(shape.body_bytes as usize);
    for p in 0..shape.projects {
        let project_id = synthetic_id(0x1000 + p, 0);
        let path = crate::project_log::project_db_path(data_dir, &project_id);
        let parent = synthetic_id(0x2000 + p, 1);
        {
            let mut log = crate::project_log::ProjectLog::open(&path, &project_id).map_err(|_| "BENCH_PROJECT_OPEN_FAILED".to_string())?;
            log.ensure_project("Synthetic", &synthetic_id(0x3000 + p, 0)).map_err(|_| "BENCH_PROJECT_CREATE_FAILED".to_string())?;
            for n in 0..shape.history_per_project.max(1) {
                let base = log.revision().map_err(|_| "BENCH_REVISION_FAILED".to_string())?;
                let command = ProductCommand::CreateNode(CreateNodeCommand {
                    command_name: String::new(),
                    protocol_version: pmapp_core::protocol::PROTOCOL_VERSION.to_string(),
                    command_id: synthetic_id(0x3000 + p, n + 1),
                    project_id: project_id.clone(),
                    base_revision: base,
                    expected_revision: base + 1,
                    node_id: synthetic_id(0x2000 + p, n + 1),
                    parent_id: None,
                    position: ((n as u64 + 1) * 4_294_967_296).to_string(),
                    title: format!("Synthetic {n}"),
                    actor_id: None,
                });
                log.submit(command).map_err(|_| "BENCH_COMMAND_FAILED".to_string())?;
            }
        }
        let conn = rusqlite::Connection::open(&path).map_err(|_| "BENCH_PROJECT_OPEN_FAILED".to_string())?;
        conn.execute_batch("BEGIN").map_err(|_| "BENCH_BULK_FAILED".to_string())?;
        {
            let mut insert = conn
                .prepare("INSERT INTO nodes(id, project_id, parent_id, title, body_text, position) VALUES(?1, ?2, ?3, ?4, ?5, ?6)")
                .map_err(|_| "BENCH_BULK_FAILED".to_string())?;
            for n in shape.history_per_project..shape.nodes_per_project {
                insert
                    .execute(rusqlite::params![synthetic_id(0x4000 + p, n), project_id, parent, format!("Bulk {n}"), body, (n as i64 + 1) * 1024])
                    .map_err(|_| "BENCH_BULK_FAILED".to_string())?;
            }
        }
        conn.execute_batch("COMMIT").map_err(|_| "BENCH_BULK_FAILED".to_string())?;
    }
    let mut bytes = 0;
    for entry in std::fs::read_dir(data_dir).map_err(|_| "BENCH_SIZE_FAILED".to_string())?.flatten() {
        bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
    }
    Ok(bytes)
}

/// Seed, capture, publish to `bench/<id>/`, restore + verify, clean up.
pub async fn rto_bench<S: ObjectStore>(store: &S, work_root: &Path, shape: BenchShape) -> Result<RtoBench, String> {
    let id = format!("{}-{:08x}", chrono::Utc::now().format("%Y%m%dT%H%M%SZ"), rand::random::<u32>());
    let work: PathBuf = work_root.join(format!("pmapp-rto-bench-{id}"));
    let data_dir = work.join("data");
    let seed_started = Instant::now();
    let seed_dir = data_dir.clone();
    let data_bytes = tokio::task::spawn_blocking(move || seed_synthetic(&seed_dir, shape))
        .await.map_err(|_| "BENCH_SEED_TASK_FAILED".to_string())??;
    let seed_ms = seed_started.elapsed().as_millis();

    let membership = crate::MembershipStore::open(&data_dir.join("membership.sqlite")).map_err(|_| "BENCH_MEMBERSHIP_FAILED".to_string())?;
    let sources = CaptureSources { membership: Arc::new(Mutex::new(membership)), logs: Arc::new(Mutex::new(Default::default())), data_dir: data_dir.clone() };
    let capture_started = Instant::now();
    let staging = work.join("staging");
    let cut = tokio::task::spawn_blocking(move || capture_cut(&sources, &staging))
        .await.map_err(|_| "BENCH_CAPTURE_TASK_FAILED".to_string())??;
    let capture_ms = capture_started.elapsed().as_millis();

    let bench_prefix = format!("bench/{id}/");
    let bench = PrefixedStore::new(store, &bench_prefix);
    let publish_started = Instant::now();
    let outcome = async {
        let published = publish_cut(&bench, &cut).await?;
        let publish_ms = publish_started.elapsed().as_millis();
        let drill = run_restore_drill(&bench, &published.manifest.manifest_key(), &work.join("restore"), Some(&data_dir))
            .await.map_err(|e| e.0)?;
        Ok::<_, String>((publish_ms, drill))
    }.await;
    // Always remove the bench objects and the local work directory.
    let mut cleaned_up = true;
    match store.list(&bench_prefix).await {
        Ok(objects) => for object in objects { cleaned_up &= store.delete(&object.key).await.is_ok(); },
        Err(_) => cleaned_up = false,
    }
    let _ = std::fs::remove_dir_all(&work);
    let (publish_ms, drill) = outcome?;
    Ok(RtoBench { shape, data_bytes, seed_ms, capture_ms, publish_ms, drill, cleaned_up })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup_store::MemoryStore;

    fn manifest(generation: &str, published_secs: i64) -> ObjectInfo {
        ObjectInfo { key: manifest_key(generation), size: 10, last_modified_secs: Some(published_secs) }
    }

    fn secs(stamp: &str) -> i64 { cut_secs(&format!("{stamp}-0000000000000000")).unwrap() }

    #[test]
    fn rpo_is_the_largest_gap_plus_the_largest_publish_delay() {
        let a = "20261008T000000Z-00000000000000a1";
        let b = "20261008T001500Z-00000000000000b2";
        let c = "20261008T003100Z-00000000000000c3";
        let objects = vec![
            manifest(a, secs("20261008T000000Z") + 2),
            ObjectInfo { key: format!("generations/{b}/membership.sqlite"), size: 1, last_modified_secs: None },
            manifest(b, secs("20261008T001500Z") + 5),
            manifest(c, secs("20261008T003100Z") + 1),
            // A generation without a manifest (never published) does not count.
            ObjectInfo { key: "generations/20261008T004600Z-00000000000000d4/membership.sqlite".into(), size: 1, last_modified_secs: None },
        ];
        let report = rpo_from_listing(&objects, secs("20261008T003100Z") + 60);
        assert_eq!(report.generations, 3);
        assert_eq!((report.max_gap_secs, report.max_publish_delay_secs), (Some(960), Some(5)));
        assert_eq!(report.observed_rpo_secs, Some(965));
        assert_eq!((report.gaps_over_budget, report.within_rpo), (1, false));
        assert_eq!(report.newest_cut_age_secs, Some(60));
        assert_eq!(report.first_cut_iso.as_deref(), Some("2026-10-08T00:00:00Z"));
    }

    #[test]
    fn steady_fifteen_minute_cuts_are_within_rpo() {
        let start = secs("20261008T000000Z");
        let objects: Vec<ObjectInfo> = (0..96)
            .map(|i| {
                let cut = start + i * 900;
                let stamp = chrono::DateTime::from_timestamp(cut, 0).unwrap().format("%Y%m%dT%H%M%SZ");
                manifest(&format!("{stamp}-{i:016x}"), cut)
            })
            .collect();
        let report = rpo_from_listing(&objects, start + 96 * 900);
        assert_eq!((report.generations, report.median_gap_secs, report.max_gap_secs), (96, Some(900), Some(900)));
        assert!(report.within_rpo);
    }

    /// Local timing of the full production shape (no network): run with
    /// `cargo test -p pmapp-server --release -- --ignored production_shape --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn production_shape_local_timing() {
        let store = MemoryStore::new();
        let work = crate::backup_capture::tests::temp_dir("rto-bench-full");
        let bench = rto_bench(&store, &work, PRODUCTION_SHAPE).await.unwrap();
        println!("{}", serde_json::to_string_pretty(&bench).unwrap());
        assert_eq!(bench.drill.result, "verified");
        assert!(bench.drill.within_rto);
    }

    #[tokio::test]
    async fn a_bench_restores_and_verifies_inside_its_own_prefix_and_cleans_up() {
        let store = MemoryStore::new();
        store.insert("generations/live/manifest.json", b"untouched".to_vec(), 0);
        let work = crate::backup_capture::tests::temp_dir("rto-bench");
        let shape = BenchShape { projects: 3, nodes_per_project: 50, history_per_project: 5, body_bytes: 32 };
        let bench = rto_bench(&store, &work, shape).await.unwrap();
        assert_eq!(bench.drill.result, "verified");
        assert_eq!(bench.drill.projects.len(), 3);
        assert!(bench.cleaned_up);
        assert_eq!(store.keys(), vec!["generations/live/manifest.json".to_string()]);
    }
}
