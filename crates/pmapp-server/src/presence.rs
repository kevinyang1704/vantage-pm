//! Ephemeral presence (Story 27.8, TC-FR7, D9, H/27.8).
//!
//! Presence is in-memory only, authorized per project, and expires within the D9
//! bounds (heartbeat 10 s, gone after 30 s). It is never persisted and never
//! logged with authored text. `now` is injectable so the timeout is testable.

use std::collections::HashMap;
use std::sync::Mutex;

/// Heartbeat cadence (D9).
pub const HEARTBEAT_MS: i64 = 10_000;
/// A member is "gone" after this many ms without a heartbeat (D9).
pub const TIMEOUT_MS: i64 = 30_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresenceEntry {
    pub device_id: String,
    pub actor_id: String,
    pub display_name: String,
    pub last_seen_ms: i64,
}

/// In-memory presence registry, keyed by (project, device).
#[derive(Default)]
pub struct PresenceRegistry {
    entries: Mutex<HashMap<(String, String), PresenceEntry>>,
}

impl PresenceRegistry {
    pub fn new() -> Self {
        Self { entries: Mutex::new(HashMap::new()) }
    }

    /// Record a heartbeat for a device on a project (authorization is the
    /// caller's responsibility — it must have verified membership first).
    pub fn heartbeat(&self, project_id: &str, device_id: &str, actor_id: &str, display_name: &str, now_ms: i64) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        // Bound memory: drop entries that have already timed out before adding a
        // new one, so a long-lived process cannot accumulate every (project,
        // device) pair that ever heartbeated (H-review/27.8).
        entries.retain(|_, entry| now_ms - entry.last_seen_ms <= TIMEOUT_MS);
        entries.insert(
            (project_id.to_string(), device_id.to_string()),
            PresenceEntry {
                device_id: device_id.to_string(),
                actor_id: actor_id.to_string(),
                display_name: display_name.to_string(),
                last_seen_ms: now_ms,
            },
        );
    }

    /// Remove a device (leave / disconnect).
    pub fn remove(&self, project_id: &str, device_id: &str) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.remove(&(project_id.to_string(), device_id.to_string()));
    }

    /// The members currently present on a project: entries seen within the
    /// timeout of `now_ms`, deduplicated by actor (one person, many devices).
    /// Expired entries are dropped as they are observed, keeping the registry
    /// bounded even without an external pruner (H-review/27.8).
    pub fn present(&self, project_id: &str, now_ms: i64) -> Vec<PresenceEntry> {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.retain(|_, entry| now_ms - entry.last_seen_ms <= TIMEOUT_MS);
        let mut latest: HashMap<String, PresenceEntry> = HashMap::new();
        for ((p, _), entry) in entries.iter() {
            if p != project_id {
                continue;
            }
            latest
                .entry(entry.actor_id.clone())
                .and_modify(|existing| {
                    if entry.last_seen_ms > existing.last_seen_ms {
                        *existing = entry.clone();
                    }
                })
                .or_insert_with(|| entry.clone());
        }
        let mut out: Vec<PresenceEntry> = latest.into_values().collect();
        out.sort_by(|a, b| a.display_name.cmp(&b.display_name));
        out
    }

    /// Prune entries older than the timeout (bounded memory).
    pub fn prune(&self, now_ms: i64) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.retain(|_, entry| now_ms - entry.last_seen_ms <= TIMEOUT_MS);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn present_within_timeout_and_gone_after() {
        let reg = PresenceRegistry::new();
        reg.heartbeat("p", "d1", "a1", "Hera", 1000);
        assert_eq!(reg.present("p", 1000).len(), 1);
        // 10 s later (heartbeat window) still present.
        assert_eq!(reg.present("p", 1000 + HEARTBEAT_MS).len(), 1);
        // 31 s later → gone.
        assert_eq!(reg.present("p", 1000 + TIMEOUT_MS + 1).len(), 0);
    }

    #[test]
    fn presence_is_project_scoped() {
        let reg = PresenceRegistry::new();
        reg.heartbeat("p1", "d1", "a1", "Hera", 0);
        assert_eq!(reg.present("p1", 0).len(), 1);
        assert_eq!(reg.present("p2", 0).len(), 0);
    }

    #[test]
    fn multiple_devices_one_actor_dedupe_to_one_person() {
        let reg = PresenceRegistry::new();
        reg.heartbeat("p", "d1", "a1", "Hera", 0);
        reg.heartbeat("p", "d2", "a1", "Hera", 5);
        assert_eq!(reg.present("p", 5).len(), 1);
    }

    #[test]
    fn leave_removes_immediately() {
        let reg = PresenceRegistry::new();
        reg.heartbeat("p", "d1", "a1", "Hera", 0);
        reg.remove("p", "d1");
        assert_eq!(reg.present("p", 0).len(), 0);
    }
}
