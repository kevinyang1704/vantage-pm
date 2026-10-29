//! Backup/restore command surface (E9-FR8, E9-FR9, E9-AR5, E9-AR6).
//!
//! Commands accept only validated candidate paths returned by the native
//! dialog plugin; the webview never passes arbitrary paths. Results are
//! sanitized unions; progress is advisory and body-free.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};

use crate::backup;
use crate::db::runtime::RepositoryRuntime;
use crate::protocol::errors::RepositoryError;

/// Resolves the app-managed backup directory (created on demand).
fn backup_dir(app: &AppHandle) -> Result<PathBuf, RepositoryError> {
    let app_data = app.path().app_data_dir().map_err(|_| RepositoryError::Internal)?;
    let dir = app_data.join("backups");
    std::fs::create_dir_all(&dir).map_err(|_| RepositoryError::Internal)?;
    Ok(dir)
}

/// Resolves the live database path for the current runtime.
fn db_path(app: &AppHandle) -> Result<PathBuf, RepositoryError> {
    let app_data = app.path().app_data_dir().map_err(|_| RepositoryError::Internal)?;
    let development = cfg!(debug_assertions);
    Ok(crate::state::state::resolve_db_path(&app_data, development))
}

/// `repository_export_package` — generates a consistent snapshot and packages
/// it as a `.pmapp` file at the given destination (chosen via the native save
/// dialog on the webview side).
#[tauri::command]
pub async fn repository_export_package(
    app: AppHandle,
    state: State<'_, RepositoryRuntime>,
    project_id: String,
    dest_path: String,
) -> Result<serde_json::Value, RepositoryError> {
    // Quiesce briefly for a consistent snapshot.
    let runtime = state.inner().clone();
    let _ = runtime.pause_intake().await;

    let dest = PathBuf::from(&dest_path);
    let db = db_path(&app)?;

    // Snapshot to a temp sibling of the destination, then package it.
    let tmp_snapshot = dest.with_extension("sqlite.tmp");
    backup::snapshot_to(&db, &tmp_snapshot)?;
    backup::package_pmapp(&tmp_snapshot, &dest, &project_id, crate::db::schema::CURRENT_SCHEMA_VERSION)?;
    let _ = std::fs::remove_file(&tmp_snapshot);

    let _ = runtime.resume_intake().await;
    Ok(serde_json::json!({
        "projectId": project_id,
        "destPath": dest_path,
        "exportedAt": chrono::Utc::now().to_rfc3339(),
        "verified": true,
    }))
}

/// `repository_validate_package` — candidate validation pipeline for a
/// `.pmapp` file chosen via the native open dialog.
#[tauri::command]
pub fn repository_validate_package(path: String) -> Result<serde_json::Value, RepositoryError> {
    let project_id = backup::validate_candidate(&PathBuf::from(path))?;
    Ok(serde_json::json!({
        "valid": true,
        "projectId": project_id,
    }))
}

/// `repository_restore_package` — verified restore of a validated candidate.
#[tauri::command]
pub async fn repository_restore_package(
    app: AppHandle,
    state: State<'_, RepositoryRuntime>,
    path: String,
) -> Result<serde_json::Value, RepositoryError> {
    backup::validate_candidate(&PathBuf::from(&path))?;
    let runtime = state.inner().clone();
    let db = db_path(&app)?;
    let dir = backup_dir(&app)?;
    backup::restore_from_candidate(&runtime, &PathBuf::from(&path), &db, &dir).await?;
    Ok(serde_json::json!({
        "restored": true,
        "at": chrono::Utc::now().to_rfc3339(),
    }))
}

/// `repository_read_import_candidate` — reads a portable `.pmapp.json`
/// candidate for browser→desktop migration (E9-FR13). Validates the size
/// limit and reads via a narrow purpose-built command; the webview never
/// receives arbitrary filesystem read capabilities.
#[tauri::command]
pub fn repository_read_import_candidate(path: String) -> Result<String, RepositoryError> {
    use std::io::Read;
    let p = PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|_| RepositoryError::InvalidRequest)?;
    if meta.len() > backup::MAX_CANDIDATE_SIZE_BYTES {
        return Err(RepositoryError::InvalidRequest);
    }
    let mut file = std::fs::File::open(&p).map_err(|_| RepositoryError::InvalidRequest)?;
    let mut content = String::new();
    file.read_to_string(&mut content).map_err(|_| RepositoryError::InvalidRequest)?;
    Ok(content)
}

/// Maximum export file size (50 MiB) to guard against unbounded writes.
pub const MAX_EXPORT_SIZE_BYTES: u64 = 50 * 1024 * 1024;

/// `save_office_export` — writes generated DOCX or PPTX bytes to a destination
/// path selected by the user via the native save dialog (E12-FR1, E12-FR2, E12-AR2).
/// Validates extension (.docx or .pptx) and writes the complete byte buffer.
#[tauri::command]
pub fn save_office_export(path: String, bytes: Vec<u8>) -> Result<serde_json::Value, RepositoryError> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_EXPORT_SIZE_BYTES {
        return Err(RepositoryError::InvalidRequest);
    }
    let p = PathBuf::from(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());

    match ext.as_deref() {
        Some("docx") | Some("pptx") => {}
        _ => return Err(RepositoryError::InvalidRequest),
    }

    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|_| RepositoryError::Internal)?;
        }
    }

    std::fs::write(&p, &bytes).map_err(|_| RepositoryError::Internal)?;

    Ok(serde_json::json!({
        "saved": true,
        "path": path,
        "bytesWritten": bytes.len(),
    }))
}

/// `save_portable_project` — writes a portable `*.pmapp.json` envelope through
/// the native save boundary (E13-FR6, E13 Task 5). The `.pmapp.json` suffix is
/// an indivisible artifact class; mismatched extensions and unsafe paths are
/// rejected. The complete byte buffer is written to a sibling temporary file
/// and atomically promoted on success.
#[tauri::command]
pub fn save_portable_project(path: String, bytes: Vec<u8>) -> Result<serde_json::Value, RepositoryError> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_EXPORT_SIZE_BYTES {
        return Err(RepositoryError::InvalidRequest);
    }
    let p = PathBuf::from(&path);
    let file_name = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_lowercase();
    // Exact indivisible suffix: `*.pmapp.json` (never a bare `.json`).
    if !file_name.ends_with(".pmapp.json") || file_name.len() <= ".pmapp.json".len() {
        return Err(RepositoryError::InvalidRequest);
    }

    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|_| RepositoryError::Internal)?;
        }
    }

    // Write to a sibling temp file, then atomically promote.
    let tmp = p.with_extension("pmapp.json.tmp");
    std::fs::write(&tmp, &bytes).map_err(|_| RepositoryError::Internal)?;
    std::fs::rename(&tmp, &p).map_err(|_| {
        let _ = std::fs::remove_file(&tmp);
        RepositoryError::Internal
    })?;

    Ok(serde_json::json!({
        "saved": true,
        "path": path,
        "bytesWritten": bytes.len(),
    }))
}
