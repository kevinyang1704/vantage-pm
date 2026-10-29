//! Periodic history compaction (Story 28.3, AC 27.8-6, contract R5/R9).
//!
//! Off unless `PMAPP_COMPACTION_RETENTION_DAYS` is set. Confirmed history older
//! than the retention window is trimmed per project (see `ProjectLog::compact`),
//! always keeping the newest `PMAPP_COMPACTION_KEEP_LATEST` commands (default
//! 1000) so a new member still sees recent activity. The window may not be
//! shorter than 30 days: R5 guarantees a client offline that long can still
//! catch up from history instead of resyncing.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::backup_capture::CaptureSources;
use crate::project_log::{project_db_path, CompactionReport, ProjectLog};

/// R5: history retained for at least the 30-day offline recovery window.
pub const MIN_RETENTION_DAYS: i64 = 30;
const DEFAULT_KEEP_LATEST: i64 = 1000;
const DEFAULT_INTERVAL_SECS: u64 = 6 * 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompactionConfig {
    pub retention_days: i64,
    pub keep_latest: i64,
    pub interval: Duration,
}

impl CompactionConfig {
    /// `Ok(None)` when compaction is not enabled.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Option<Self>, String> {
        let Some(raw) = get("PMAPP_COMPACTION_RETENTION_DAYS") else { return Ok(None) };
        let retention_days: i64 = raw.trim().parse().map_err(|_| "PMAPP_COMPACTION_RETENTION_DAYS must be a whole number of days".to_string())?;
        if retention_days < MIN_RETENTION_DAYS {
            return Err(format!("PMAPP_COMPACTION_RETENTION_DAYS must be at least {MIN_RETENTION_DAYS} (30-day offline recovery)"));
        }
        let keep_latest = match get("PMAPP_COMPACTION_KEEP_LATEST") {
            Some(v) => v.trim().parse::<i64>().ok().filter(|n| *n >= 0).ok_or("PMAPP_COMPACTION_KEEP_LATEST must be a non-negative integer")?,
            None => DEFAULT_KEEP_LATEST,
        };
        let interval_secs = match get("PMAPP_COMPACTION_INTERVAL_SECS") {
            Some(v) => v.trim().parse::<u64>().ok().filter(|n| *n >= 60).ok_or("PMAPP_COMPACTION_INTERVAL_SECS must be at least 60")?,
            None => DEFAULT_INTERVAL_SECS,
        };
        Ok(Some(Self { retention_days, keep_latest, interval: Duration::from_secs(interval_secs) }))
    }

    pub fn from_env() -> Result<Option<Self>, String> {
        Self::from_lookup(|k| std::env::var(k).ok().filter(|v| !v.trim().is_empty()))
    }

    /// Records before this instant are eligible (RFC 3339, millisecond, UTC —
    /// the same format history entries are recorded in).
    pub fn cutoff_iso(&self, now: chrono::DateTime<chrono::Utc>) -> String {
        (now - chrono::Duration::days(self.retention_days)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }
}

/// One pass over every project file. Each project is compacted under its own
/// lock; the cache lock is held only to find or open the log.
pub fn compact_all(sources: &CaptureSources, cutoff_iso: &str, keep_latest: i64) -> Result<Vec<(String, CompactionReport)>, String> {
    let mut ids = Vec::new();
    for path in crate::server_migration::project_files(&sources.data_dir).map_err(|e| e.0)? {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        if let Some(id) = name.strip_prefix("project-").and_then(|n| n.strip_suffix(".sqlite")) {
            ids.push(id.to_string());
        }
    }
    let mut reports = Vec::new();
    for id in ids {
        let log: Arc<Mutex<ProjectLog>> = {
            let mut cache = sources.logs.lock().unwrap_or_else(|e| e.into_inner());
            match cache.get(&id) {
                Some(log) => log.clone(),
                None => {
                    let opened = ProjectLog::open(&project_db_path(&sources.data_dir, &id), &id).map_err(|_| format!("COMPACTION_OPEN_FAILED:{id}"))?;
                    let log = Arc::new(Mutex::new(opened));
                    cache.insert(id.clone(), log.clone());
                    log
                }
            }
        };
        let report = log.lock().unwrap_or_else(|e| e.into_inner()).compact(cutoff_iso, keep_latest).map_err(|_| format!("COMPACTION_FAILED:{id}"))?;
        if report.trimmed > 0 { reports.push((id, report)); }
    }
    Ok(reports)
}

/// Spawn the periodic pass. A no-op when compaction is not enabled.
pub fn spawn_compaction_loop(config: Option<CompactionConfig>, sources: CaptureSources) {
    let Some(config) = config else { return };
    eprintln!("compaction: enabled retention_days={} keep_latest={} interval_s={}", config.retention_days, config.keep_latest, config.interval.as_secs());
    tokio::spawn(async move {
        loop {
            let pass_sources = sources.clone();
            let cutoff = config.cutoff_iso(chrono::Utc::now());
            let keep = config.keep_latest;
            match tokio::task::spawn_blocking(move || compact_all(&pass_sources, &cutoff, keep)).await {
                Ok(Ok(reports)) => {
                    let trimmed: usize = reports.iter().map(|(_, r)| r.trimmed).sum();
                    eprintln!("compaction: pass complete projects_compacted={} commands_trimmed={trimmed}", reports.len());
                }
                Ok(Err(code)) => eprintln!("compaction: pass stopped code={code}"),
                Err(_) => eprintln!("compaction: pass task failed"),
            }
            tokio::time::sleep(config.interval).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn lookup(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| map.get(k).cloned()
    }

    #[test]
    fn off_unless_configured_and_never_below_thirty_days() {
        assert_eq!(CompactionConfig::from_lookup(lookup(&[])).unwrap(), None);
        assert!(CompactionConfig::from_lookup(lookup(&[("PMAPP_COMPACTION_RETENTION_DAYS", "29")])).is_err());
        assert!(CompactionConfig::from_lookup(lookup(&[("PMAPP_COMPACTION_RETENTION_DAYS", "x")])).is_err());
        let config = CompactionConfig::from_lookup(lookup(&[("PMAPP_COMPACTION_RETENTION_DAYS", "45")])).unwrap().unwrap();
        assert_eq!((config.retention_days, config.keep_latest, config.interval.as_secs()), (45, 1000, 21600));
        assert!(CompactionConfig::from_lookup(lookup(&[("PMAPP_COMPACTION_RETENTION_DAYS", "30"), ("PMAPP_COMPACTION_KEEP_LATEST", "-1")])).is_err());
    }

    #[test]
    fn the_cutoff_is_the_retention_window_before_now() {
        let config = CompactionConfig { retention_days: 30, keep_latest: 0, interval: Duration::from_secs(60) };
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-31T12:00:00Z").unwrap().with_timezone(&chrono::Utc);
        assert_eq!(config.cutoff_iso(now), "2026-10-01T12:00:00.000Z");
    }

    #[test]
    fn a_pass_compacts_file_backed_projects_through_the_shared_cache() {
        let sources = crate::backup_capture::tests::sources("compaction");
        let project = crate::backup_capture::tests::PROJECT;
        {
            let cache = sources.logs.lock().unwrap();
            let mut log = cache.get(project).unwrap().lock().unwrap();
            let epoch = log.stream_epoch().unwrap();
            for n in 0..3 {
                let base = log.revision().unwrap();
                let wire = serde_json::to_value(crate::backup_capture::tests::create_node(n, base)).unwrap();
                log.submit_wire_in_epoch(wire, epoch).unwrap();
            }
        }
        let reports = compact_all(&sources, "9999-01-01T00:00:00.000Z", 1).unwrap();
        assert_eq!(reports.len(), 1);
        let cache = sources.logs.lock().unwrap();
        let log = cache.get(project).unwrap().lock().unwrap();
        let envelope = log.recovery_envelope().unwrap();
        assert_eq!(envelope.confirmed_history.len(), 1);
        assert_eq!(envelope.history_floor, envelope.server_revision - 1);
    }
}
