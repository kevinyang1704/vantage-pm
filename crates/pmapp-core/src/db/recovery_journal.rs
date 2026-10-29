//! Recovery sidecars never participate in authored graph enumeration.
use rusqlite::Connection;

pub const MIGRATION_DDL: &str = r#"
ALTER TABLE collaboration_cursor ADD COLUMN stream_epoch INTEGER;
ALTER TABLE collaboration_cursor ADD COLUMN recovery_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collaboration_cursor ADD COLUMN recovery_reason TEXT;
CREATE TABLE IF NOT EXISTS collaboration_authoritative_history(
  project_id TEXT NOT NULL,
  stream_epoch INTEGER NOT NULL,
  server_revision INTEGER NOT NULL,
  entry_json TEXT NOT NULL,
  PRIMARY KEY(project_id, stream_epoch, server_revision)
);
CREATE TABLE IF NOT EXISTS collaboration_recovery_envelope(
  project_id TEXT PRIMARY KEY,
  envelope_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collaboration_recovery_archive(
  archive_id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL,
  prior_epoch INTEGER,
  prior_cursor INTEGER NOT NULL,
  reason TEXT NOT NULL,
  archive_json TEXT NOT NULL,
  created_at_iso TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS collaboration_recovery_archive_by_project
  ON collaboration_recovery_archive(project_id, archive_id);
"#;

pub const SIDECAR_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS collaboration_authoritative_history(
  project_id TEXT NOT NULL,
  stream_epoch INTEGER NOT NULL,
  server_revision INTEGER NOT NULL,
  entry_json TEXT NOT NULL,
  PRIMARY KEY(project_id, stream_epoch, server_revision)
);
CREATE TABLE IF NOT EXISTS collaboration_recovery_envelope(
  project_id TEXT PRIMARY KEY,
  envelope_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collaboration_recovery_archive(
  archive_id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL,
  prior_epoch INTEGER,
  prior_cursor INTEGER NOT NULL,
  reason TEXT NOT NULL,
  archive_json TEXT NOT NULL,
  created_at_iso TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS collaboration_recovery_archive_by_project
  ON collaboration_recovery_archive(project_id, archive_id);
"#;

/// Both fresh and upgraded databases get all sidecars before their version
/// marker advances. Legacy cursors intentionally have no asserted epoch.
pub fn initialize(conn: &Connection) -> rusqlite::Result<()> {
    let mut statement = conn.prepare("PRAGMA table_info(collaboration_cursor)")?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    for (column, ddl) in [
        ("stream_epoch", "ALTER TABLE collaboration_cursor ADD COLUMN stream_epoch INTEGER"),
        ("recovery_required", "ALTER TABLE collaboration_cursor ADD COLUMN recovery_required INTEGER NOT NULL DEFAULT 0"),
        ("recovery_reason", "ALTER TABLE collaboration_cursor ADD COLUMN recovery_reason TEXT"),
    ] {
        if !columns.iter().any(|existing| existing == column) { conn.execute_batch(ddl)?; }
    }
    // Composite-gesture membership on queued edits (Story 27.2 on shared projects).
    let mut statement = conn.prepare("PRAGMA table_info(collaboration_outbox)")?;
    let outbox = statement.query_map([], |row| row.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    for (column, ddl) in [
        ("group_id", "ALTER TABLE collaboration_outbox ADD COLUMN group_id TEXT"),
        ("group_index", "ALTER TABLE collaboration_outbox ADD COLUMN group_index INTEGER"),
    ] {
        if !outbox.iter().any(|existing| existing == column) { conn.execute_batch(ddl)?; }
    }
    conn.execute_batch(SIDECAR_DDL)
}
