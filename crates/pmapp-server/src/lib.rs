//! Vantage collaboration service (Epic 27, Stories 27.4+).
//!
//! 27.4 creates the package: membership, guest device identities, invite links,
//! join approval and owner recovery. 27.5 adds the command log and live stream.
//! This crate is the Rust service from D2; it reuses `pmapp-core` for command
//! handling (added in 27.5). No Tauri dependency.
//!
//! The HTTP surface here is deliberately small and in-memory-backed for local
//! development and tests. Persistence to per-project SQLite files and the
//! membership database, TLS, and Railway deployment are 27.5.

pub mod auth;
pub mod backup;
pub mod backup_capture;
pub mod backup_checkpoint;
pub mod backup_config;
pub mod backup_evidence;
pub mod backup_loop;
pub mod backup_retention;
pub mod backup_store;
pub mod command_routes;
pub mod compaction;
pub mod cors;
pub mod handshake;
pub mod membership;
pub mod membership_store;
pub mod principal;
pub mod presence;
pub mod project_log;
pub mod rate_limit;
pub mod restore_drill;
pub mod routes;
pub mod server_migration;
pub mod share_routes;

pub use membership_store::{AuthContext, MembershipStore};

/// The server's current UTC time as an ISO-8601 instant. Used so expiry and
/// lifecycle decisions are made by the server clock, never a client-supplied
/// time (R6).
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
