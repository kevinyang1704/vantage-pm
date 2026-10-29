//! SQLite snapshot boundary used by the core repository runtime (E9-FR9).
//!
//! `snapshot_to` produces a consistent snapshot of a live database via the
//! SQLite Online Backup API, verifies it with a full `integrity_check` +
//! `foreign_key_check`, and promotes it atomically. The desktop composition
//! re-exports this function and layers the `.pmapp` package/restore engine on
//! top of it (`pmapp_desktop_lib::backup`).
//!
//! Moved verbatim from the desktop `backup` module so the Tauri-free runtime
//! can take its verified pre-migration snapshot without depending on the
//! desktop crate.

use rusqlite::{Connection, OpenFlags};
use std::fs;
use std::path::Path;

use crate::protocol::errors::RepositoryError;

/// Generates a consistent snapshot of `source_path` into `dest_path` using
/// the SQLite Online Backup API, then verifies the destination with full
/// integrity checks. Writes to a `.tmp` sibling and promotes with an atomic
/// rename on success. Never raw-copies an open database.
pub fn snapshot_to(source_path: &Path, dest_path: &Path) -> Result<(), RepositoryError> {
    let tmp_path = dest_path.with_extension("sqlite.tmp");

    {
        let source = Connection::open_with_flags(
            source_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| RepositoryError::Internal)?;

        let mut dest = Connection::open_with_flags(
            &tmp_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        )
        .map_err(|_| RepositoryError::StorageFull)?;

        let backup = rusqlite::backup::Backup::new(&source, &mut dest)
            .map_err(|_| RepositoryError::Internal)?;
        backup.run_to_completion(100, std::time::Duration::from_millis(10), None)
            .map_err(|_| RepositoryError::Internal)?;
    }

    // Verify the generated snapshot before promotion.
    verify_snapshot(&tmp_path)?;

    // Atomic promote: the prior known-good copy remains until success.
    if dest_path.exists() {
        fs::remove_file(dest_path).map_err(|_| RepositoryError::Internal)?;
    }
    fs::rename(&tmp_path, dest_path).map_err(|_| RepositoryError::Internal)?;
    Ok(())
}

pub fn verify_snapshot(path: &Path) -> Result<(), RepositoryError> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| RepositoryError::IntegrityFailed)?;
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|_| RepositoryError::IntegrityFailed)?;
    if integrity != "ok" {
        return Err(RepositoryError::IntegrityFailed);
    }
    let fk_count: i64 = conn
        .prepare("PRAGMA foreign_key_check")
        .map_err(|_| RepositoryError::IntegrityFailed)?
        .query_map([], |_| Ok(()))
        .map_err(|_| RepositoryError::IntegrityFailed)?
        .count() as i64;
    if fk_count > 0 {
        return Err(RepositoryError::IntegrityFailed);
    }
    Ok(())
}
