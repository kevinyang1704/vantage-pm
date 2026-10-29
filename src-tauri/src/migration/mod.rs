//! Desktop re-export of the Tauri-free `pmapp-core` migration engine.
//!
//! Re-exporting the module keeps every existing `crate::migration::*` path in
//! the desktop crate and its tests resolving unchanged.

pub use pmapp_core::migration::*;
