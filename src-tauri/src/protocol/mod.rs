//! Desktop re-export of the Tauri-free `pmapp-core` wire protocol.
//!
//! Re-exporting the module keeps every existing `crate::protocol::*` path in
//! the desktop crate and its tests resolving unchanged.

pub use pmapp_core::protocol::*;
