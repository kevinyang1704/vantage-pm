//! Body-free advisory events emitted from the native runtime to the webview
//! (E9-AR7). Never carries raw SQL, paths, stack traces, or authored text.

use tauri::{AppHandle, Emitter};

use crate::protocol::commands::RevisionInvalidated;

/// The only native-to-webview event channel: revision invalidations.
pub const EVENT_REVISION_INVALIDATED: &str = "repository:revision-invalidated";

/// Emits a body-free revision invalidation for the given project.
pub fn emit_revision_invalidated(app: &AppHandle, project_id: &str, revision: i64) {
    let _ = app.emit(
        EVENT_REVISION_INVALIDATED,
        RevisionInvalidated {
            project_id: project_id.to_string(),
            revision,
        },
    );
}

/// Emits a file-open intent forwarded from a secondary instance (E9-FR12).
pub const EVENT_FILE_OPEN_INTENT: &str = "file-open-intent";

pub fn emit_file_open_intent(app: &AppHandle, path: &str) {
    let _ = app.emit(EVENT_FILE_OPEN_INTENT, serde_json::json!({ "path": path }));
}

/// Emits a shutdown-complete notification (E9-FR12 safe shutdown).
pub const EVENT_SHUTDOWN_COMPLETE: &str = "repository:shutdown-complete";

pub fn emit_shutdown_complete(app: &AppHandle) {
    let _ = app.emit(EVENT_SHUTDOWN_COMPLETE, ());
}
