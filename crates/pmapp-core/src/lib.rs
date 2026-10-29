//! `pmapp-core` — the Tauri-free core of the native PMApp composition.
//!
//! This crate owns the wire protocol, the SQLite schema, the product command
//! handler, the workspace registry, ordered idempotent migrations, and the
//! single-writer repository runtime. It has NO dependency on Tauri, so the
//! long-running 27.5 service can reuse the exact command layer the desktop
//! app runs. The desktop crate (`pmapp-desktop`) re-exports these modules from
//! its own root so existing crate-relative paths keep resolving.

pub mod backup;
pub mod db;
pub mod migration;
pub mod protocol;
