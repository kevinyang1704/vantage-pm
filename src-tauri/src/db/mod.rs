//! Desktop re-export of the Tauri-free `pmapp-core` database layer.
//!
//! The modules themselves (handler, schema, workspace, runtime) live in
//! `pmapp-core`; re-exporting them here keeps every existing `crate::db::*`
//! path in the desktop crate and its tests resolving unchanged.

pub use pmapp_core::db::*;
