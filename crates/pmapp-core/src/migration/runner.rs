//! Migration runner with pre-migration snapshot protection (E9-FR11, E9-AR4).
//!
//! Flow:
//! 1. Read `PRAGMA user_version`.
//! 2. If `user_version > current_supported` → `FutureSchemaVersionBlocked`
//!    (no mutation).
//! 3. If `user_version < baseline`, create a verified pre-migration snapshot
//!    before the first migration transaction.
//! 4. Execute each step in a discrete transaction that also updates
//!    `user_version` atomically.
//! 5. On failure: restore the pre-migration snapshot (if it exists) and
//!    record a diagnostic event; enter read-only recovery.

use rusqlite::{Connection, TransactionBehavior};

use super::registry::{current_supported_version, migration_steps};
use crate::db::schema::{CURRENT_SCHEMA_VERSION, PRODUCT_SCHEMA_DDL};
use crate::protocol::errors::RepositoryError;

/// Why startup adjudicated a read-only recovery state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryDecision {
    /// Migrated normally to the current version.
    Normal,
    /// The database schema is newer than this build supports.
    FutureSchemaVersionBlocked { found: i64, supported: i64 },
    /// Migration failed; the pre-migration snapshot was restored.
    MigrationFailedRestored,
    /// Integrity verification failed after migration.
    IntegrityFailed,
    /// No migration was needed (already current or freshly created).
    MigratedNoop,
}

/// Migrates the database to `CURRENT_SCHEMA_VERSION` if needed.
/// Returns the recovery decision for the UI state machine.
///
/// `conn` must already have foreign_keys enabled and the application_id set.
pub fn run_migrations(conn: &mut Connection) -> Result<RecoveryDecision, RepositoryError> {
    let current: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|_| RepositoryError::IntegrityFailed)?;

    let supported = current_supported_version();

    if current > supported {
        return Ok(RecoveryDecision::FutureSchemaVersionBlocked {
            found: current,
            supported,
        });
    }

    if current == CURRENT_SCHEMA_VERSION {
        return Ok(RecoveryDecision::MigratedNoop);
    }

    // Fresh database (user_version = 0): create the baseline schema.
    if current == 0 {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| RepositoryError::IntegrityFailed)?;
        for ddl in PRODUCT_SCHEMA_DDL.iter() { tx.execute_batch(ddl).map_err(|_| RepositoryError::IntegrityFailed)?; }
        tx.execute_batch(crate::db::collaboration::JOURNAL_DDL).map_err(|_| RepositoryError::IntegrityFailed)?;
        crate::db::recovery_journal::initialize(&tx).map_err(|_| RepositoryError::IntegrityFailed)?;
        tx.execute_batch(crate::db::local_file::DDL).map_err(|_| RepositoryError::IntegrityFailed)?;
        tx.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION).map_err(|_| RepositoryError::IntegrityFailed)?;
        tx.commit().map_err(|_| RepositoryError::IntegrityFailed)?;
        return Ok(RecoveryDecision::MigratedNoop);
    }

    // Pre-migration snapshot protection happens at the caller level (it needs
    // a file path); the runner here only executes ordered transactional steps.
    for step in migration_steps() {
        if current < step.version {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| RepositoryError::IntegrityFailed)?;
            tx.execute_batch(step.sql).map_err(|_| {
                // Rollback happens on drop.
                RepositoryError::IntegrityFailed
            })?;
            tx.pragma_update(None, "user_version", step.version)
                .map_err(|_| RepositoryError::IntegrityFailed)?;
            tx.commit().map_err(|_| RepositoryError::IntegrityFailed)?;
        }
    }

    // Post-migration full integrity check.
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|_| RepositoryError::IntegrityFailed)?;
    if integrity != "ok" {
        return Err(RepositoryError::IntegrityFailed);
    }

    Ok(RecoveryDecision::MigratedNoop)
}

// ── Read-only recovery adjudication (E9-FR11, E9-UX2) ──────────────────────

/// Adjudicates startup state from the repository's user_version.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StartupState {
    Ready,
    MigrationInProgress,
    ReadOnlyRecovery {
        cause: String,
    },
    IntegrityFailed {
        cause: String,
    },
}

/// Adjudicates startup state from the repository's user_version.
pub fn adjudicate_startup(conn: &Connection) -> Result<StartupState, RepositoryError> {
    let current: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|_| RepositoryError::IntegrityFailed)?;
    let supported = current_supported_version();

    if current > supported {
        return Ok(StartupState::ReadOnlyRecovery {
            cause: format!(
                "This project was created by a newer PMApp build (schema {current}, supported up to {supported}). Update the app to open it."
            ),
        });
    }

    let quick: String = conn
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|_| RepositoryError::IntegrityFailed)?;
    if quick != "ok" {
        return Ok(StartupState::ReadOnlyRecovery {
            cause: "The database integrity check failed on open. A verified backup may be available.".to_string(),
        });
    }

    Ok(StartupState::Ready)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::{CURRENT_SCHEMA_VERSION, PRODUCT_SCHEMA_DDL};

    fn setup_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        for ddl in PRODUCT_SCHEMA_DDL.iter() {
            conn.execute_batch(ddl).unwrap();
        }
        conn
    }

    #[test]
    fn fresh_database_initializes_to_current_version() {
        let mut conn = setup_conn();
        let decision = run_migrations(&mut conn).unwrap();
        assert_eq!(decision, RecoveryDecision::MigratedNoop);
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn noop_when_already_current() {
        let mut conn = setup_conn();
        conn.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION).unwrap();
        let decision = run_migrations(&mut conn).unwrap();
        assert_eq!(decision, RecoveryDecision::MigratedNoop);
    }

    #[test]
    fn future_schema_blocked_without_mutation() {
        let mut conn = setup_conn();
        conn.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION + 100).unwrap();
        let decision = run_migrations(&mut conn).unwrap();
        assert!(matches!(
            decision,
            RecoveryDecision::FutureSchemaVersionBlocked { found, supported }
                if found == CURRENT_SCHEMA_VERSION + 100 && supported == current_supported_version()
        ));
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION + 100, "must not mutate");
    }

    #[test]
    fn startup_adjudicates_future_schema_as_read_only_recovery() {
        let conn = setup_conn();
        conn.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION + 100).unwrap();
        let state = adjudicate_startup(&conn).unwrap();
        assert!(matches!(state, StartupState::ReadOnlyRecovery { .. }));
    }

    #[test]
    fn startup_adjudicates_healthy_store_as_ready() {
        let conn = setup_conn();
        conn.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION).unwrap();
        let state = adjudicate_startup(&conn).unwrap();
        assert_eq!(state, StartupState::Ready);
    }

    #[test]
    fn v9_step_adds_nodes_delivery_status_column() {
        // Simulate a database stamped at v8 (pre-status-badging): a `nodes`
        // table without `delivery_status`.
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE nodes(
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                position INTEGER NOT NULL
            );
            CREATE TABLE product_command_receipt(
                command_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                command_type TEXT NOT NULL,
                base_revision INTEGER NOT NULL,
                target_revision INTEGER NOT NULL,
                result_json TEXT NOT NULL
            );",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 8).unwrap();

        let decision = run_migrations(&mut conn).unwrap();
        assert_eq!(decision, RecoveryDecision::MigratedNoop);

        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);

        let has_column: bool = conn
            .prepare("PRAGMA table_info(nodes)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .filter_map(Result::ok)
            .any(|name| name == "delivery_status");
        assert!(has_column, "v9 migration must add nodes.delivery_status");
    }
}
