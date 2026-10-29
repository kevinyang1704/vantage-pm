//! Ordered idempotent schema migration registry (E9-FR11, E9-NFR7).
//!
//! The baseline native schema is version 4 (matching
//! `PRODUCT_SCHEMA_VERSION = 4` in the TypeScript product schema). Future
//! schema evolutions register here as (version, SQL) steps; each runs in its
//! own transaction and updates `user_version` atomically. Migrations from
//! every stable v1+ version are supported (lossless schema-retention window).

use crate::db::schema::BASELINE_SCHEMA_VERSION;

/// A single ordered migration step: target version + SQL that upgrades the
/// schema FROM (version - 1) TO version. Each step is idempotent (guarded by
/// `IF NOT EXISTS` where applicable) and runs inside one transaction.
pub const MIGRATION_STEPS: [MigrationStep; 16] = [
    // v5 (Epic 10, E10-AR9): viewport pan/zoom columns on the isolated
    // Visual view-state lane. Guarded so a fresh v5 baseline (DDL already
    // contains the columns) skips cleanly.
    MigrationStep {
        version: 5,
        sql: "ALTER TABLE view_state ADD COLUMN pan_x REAL NOT NULL DEFAULT 0.0;
             ALTER TABLE view_state ADD COLUMN pan_y REAL NOT NULL DEFAULT 0.0;
             ALTER TABLE view_state ADD COLUMN scale REAL NOT NULL DEFAULT 1.0;",
    },
    // v6 (Epic 15, E15-AR2): side-navigation collapsed flag on the isolated
    // per-(project, view) view-state lane. Guarded so a fresh v6 baseline
    // (DDL already contains the column) skips cleanly.
    MigrationStep {
        version: 6,
        sql: "ALTER TABLE view_state ADD COLUMN nav_collapsed INTEGER NOT NULL DEFAULT 0;",
    },
    // v7 (Epic 16, Story 16.1): node open questions & decisions table.
    // Guarded so a fresh v7 baseline (DDL already contains the table) skips
    // cleanly.
    MigrationStep {
        version: 7,
        sql: "CREATE TABLE IF NOT EXISTS node_open_questions(
                id              TEXT    PRIMARY KEY,
                project_id      TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                node_id         TEXT    NOT NULL,
                question_text   TEXT    NOT NULL,
                status          TEXT    NOT NULL CHECK(status IN ('OPEN','DECIDED')),
                decision_text  TEXT,
                position        INTEGER NOT NULL,
                resolved_at_iso TEXT,
                created_at_iso  TEXT    NOT NULL,
                FOREIGN KEY (node_id, project_id) REFERENCES nodes(id, project_id) ON DELETE CASCADE
              );
              CREATE INDEX IF NOT EXISTS node_open_questions_by_node
                ON node_open_questions(project_id, node_id, position);",
    },
    // v8 (Epic 17): workspaces. Adds the workspace registry, the app-level
    // settings table, and the `projects.workspace_id` column. The one-time
    // backfill that gives every existing project a home is NOT done here —
    // it runs in `ensure_default_workspace` on every open, so a database
    // that reaches v8 through any path (fresh baseline DDL included) gets
    // the same repair. `ADD COLUMN` carries no REFERENCES clause: the added
    // column is NULL on every existing row until that backfill runs, and a
    // rebuild to attach the constraint would rewrite the user's only copy
    // of their work for no enforcement gain.
    MigrationStep {
        version: 8,
        sql: "CREATE TABLE IF NOT EXISTS workspaces(
                id       TEXT    PRIMARY KEY,
                name     TEXT    NOT NULL,
                position INTEGER NOT NULL
              );
              CREATE INDEX IF NOT EXISTS workspaces_by_position ON workspaces(position);
              CREATE TABLE IF NOT EXISTS app_settings(
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
              );
              ALTER TABLE projects ADD COLUMN workspace_id TEXT;
              CREATE INDEX IF NOT EXISTS projects_by_workspace ON projects(workspace_id, name);",
    },
    // v9 (outline status badging): per-node delivery status. Bare nullable
    // TEXT with no CHECK — matching the v8 `workspace_id` precedent: `ADD
    // COLUMN` carries no constraint so a migrated schema and a fresh v9
    // baseline stay identical, and the three allowed values are enforced in
    // the TS domain command + the Rust handler. A legacy NULL row reads back
    // as 'not_started'.
    MigrationStep {
        version: 9,
        sql: "ALTER TABLE nodes ADD COLUMN delivery_status TEXT;",
    },
    // v10 (Epic 18, Story 18.2): the optional project-owned forecast plan.
    // Guarded so a fresh v10 baseline (DDL already contains the table) skips
    // cleanly. Existing projects load with no plan and unchanged schedule
    // facts (AC 18.2-1).
    MigrationStep {
        version: 10,
        sql: "CREATE TABLE IF NOT EXISTS forecast_plans(
                project_id          TEXT    PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                selected_feature_ids TEXT   NOT NULL DEFAULT '[]',
                parallel_groups     TEXT    NOT NULL DEFAULT '[]',
                points_per_sprint   INTEGER,
                sprint_length_days  INTEGER,
                cadence             TEXT    NOT NULL DEFAULT 'fixed-contiguous',
                start_sprint_ordinal INTEGER,
                start_date          TEXT,
                policy_version      TEXT    NOT NULL DEFAULT 'shared-capacity-v1'
              );",
    },
    // v11 (Epic 20, Story 20.1): the forecast-owned blocked Feature set. Bare
    // TEXT with a constant `'[]'` default so a migrated schema and a fresh v11
    // baseline stay identical; a legacy row (impossible here — the column is
    // NOT NULL DEFAULT) reads as an empty set. The value is validated in the
    // TS domain command and the Rust handler.
    MigrationStep {
        version: 11,
        sql: "ALTER TABLE forecast_plans ADD COLUMN blocked_feature_ids TEXT NOT NULL DEFAULT '[]';",
    },
    // v12 (Epic 20, Story 20.4): saved historical trade-off scenarios.
    // Guarded so a fresh v12 baseline (DDL already contains the table) skips
    // cleanly. Existing projects load with no scenarios and unchanged facts.
    MigrationStep {
        version: 12,
        sql: "CREATE TABLE IF NOT EXISTS forecast_scenarios(
                scenario_id        TEXT    PRIMARY KEY,
                project_id         TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                label              TEXT    NOT NULL,
                baseline_revision  INTEGER NOT NULL,
                baseline_fingerprint TEXT  NOT NULL,
                policy_version     TEXT    NOT NULL DEFAULT 'shared-capacity-v1',
                created_at_iso     TEXT    NOT NULL,
                baseline_json      TEXT    NOT NULL,
                patch_json         TEXT    NOT NULL
              );
              CREATE INDEX IF NOT EXISTS forecast_scenarios_by_project
                ON forecast_scenarios(project_id, created_at_iso);",
    },
    // v13 (Epic 21, Story 21.7): the plan's node hierarchy level. Bare TEXT
    // with a constant `'Feature'` default so a migrated schema and a fresh
    // v13 baseline stay identical; a legacy row reads as a Feature plan.
    MigrationStep {
        version: 13,
        sql: "ALTER TABLE forecast_plans ADD COLUMN planning_level TEXT NOT NULL DEFAULT 'Feature';",
    },
    // v14 (Epic 22, Story 22.3): the project roster for staffed forecasting.
    // Bare TEXT with a constant `'[]'` default so a migrated schema and a
    // fresh v14 baseline stay identical.
    MigrationStep {
        version: 14,
        sql: "ALTER TABLE forecast_plans ADD COLUMN roster TEXT NOT NULL DEFAULT '[]';",
    },
    // v15 (Epic 22, Story 22.4): the feature assignments mapping for staffed forecasting.
    // Bare TEXT with a constant `'{}'` default so a migrated schema and a
    // fresh v15 baseline stay identical.
    MigrationStep {
        version: 15,
        sql: "ALTER TABLE forecast_plans ADD COLUMN assignments TEXT NOT NULL DEFAULT '{}';",
    },
    // v16 (Epic 26, Story 26.5): points done on an item. Nullable with no
    // default, so a migrated row and a fresh row both read back None
    // ("not recorded") — byte-identical across the two paths.
    MigrationStep {
        version: 16,
        sql: "ALTER TABLE nodes ADD COLUMN effort_points_done INTEGER;",
    },
    // v17 (Epic 27, Story 27.3): actor identity on receipts. Bare nullable
    // TEXT with no default; existing receipts backfill to the local actor
    // lazily (the browser/native `ensure_local_actor`), matching the v9/v16
    // additive-column precedent.
    MigrationStep {
        version: 17,
        sql: "ALTER TABLE product_command_receipt ADD COLUMN actor_id TEXT;",
    },
    // v18 sidecars are separate from authored project schema enumeration.
    MigrationStep { version: 18, sql: crate::db::collaboration::JOURNAL_DDL },
    MigrationStep { version: 19, sql: crate::db::recovery_journal::MIGRATION_DDL },
    MigrationStep { version: 20, sql: crate::db::local_file::DDL },
];

pub struct MigrationStep {
    pub version: i64,
    pub sql: &'static str,
}

/// Registry of all supported migration steps ordered by version.
pub fn migration_steps() -> &'static [MigrationStep] {
    &MIGRATION_STEPS
}

/// The maximum schema version this application build can open.
pub fn current_supported_version() -> i64 {
    BASELINE_SCHEMA_VERSION + MIGRATION_STEPS.len() as i64
}
