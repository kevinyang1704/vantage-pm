//! Product SQLite schema version 8 — ported verbatim from
//! `src/adapters/persistence/schema.ts` (E9-FR2, E9-AR4) plus the Epic 10
//! viewport view-state columns (E10-AR9), the Epic 16 node open questions
//! table (Story 16.1), the Epic 17 workspace registry, and the Epic 18
//! forecast plan table (Story 18.2).
//!
//! `application_id = 0x504D4150` ("PMAP") identifies native PMApp databases;
//! `user_version` is the application-owned schema version.

/// Magic application id bytes: "PMAP".
pub const PMAPP_APPLICATION_ID: i64 = 0x504D_4150;

/// Baseline schema version: the first native schema release.
pub const BASELINE_SCHEMA_VERSION: i64 = 4;

/// Current product schema version.
///
/// DERIVED from the migration registry rather than hardcoded. It was
/// previously a literal, and drifted: Epic 15 appended the `nav_collapsed`
/// step (v6) without bumping the constant off 5. Because `run_migrations`
/// short-circuits on `current == CURRENT_SCHEMA_VERSION` *before* the step
/// loop, any database stamped `user_version = 5` would return `MigratedNoop`
/// and never receive the v6 column. Deriving it makes that class of drift
/// impossible: adding a step to MIGRATION_STEPS advances this automatically.
pub const CURRENT_SCHEMA_VERSION: i64 =
    BASELINE_SCHEMA_VERSION + crate::migration::registry::MIGRATION_STEPS.len() as i64;

/// DDL statements to initialize the product schema (idempotent).
pub const PRODUCT_SCHEMA_DDL: [&str; 26] = [
    // ── Workspaces table (Epic 17) ──────────────────────────────────
    // Declared before `projects` so the FK target exists on a fresh create.
    r#"CREATE TABLE IF NOT EXISTS workspaces(
    id       TEXT    PRIMARY KEY,
    name     TEXT    NOT NULL,
    position INTEGER NOT NULL
  )"#,
    r#"CREATE INDEX IF NOT EXISTS workspaces_by_position
    ON workspaces(position)"#,
    // ── App settings (Epic 17) ──────────────────────────────────────
    // App-level key/value pointers that are not project-scoped and never
    // appear in a ChangeSet, the undo stack, or the portable file.
    r#"CREATE TABLE IF NOT EXISTS app_settings(
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )"#,
    // ── Projects table ──────────────────────────────────────────────
    // `workspace_id` deliberately has no ON DELETE clause: SQLite's default
    // NO ACTION makes the database refuse to drop a workspace that still
    // holds projects, backing up the same check in workspace policy.
    // Nullable for the same reason as the TS schema — ALTER TABLE cannot add
    // a NOT NULL foreign key, and fresh vs. migrated schemas must match.
    r#"CREATE TABLE IF NOT EXISTS projects(
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    revision     INTEGER NOT NULL DEFAULT 0,
    workspace_id TEXT REFERENCES workspaces(id)
  )"#,
    r#"CREATE INDEX IF NOT EXISTS projects_by_workspace
    ON projects(workspace_id, name)"#,
    // ── Product command receipt table ───────────────────────────────
    r#"CREATE TABLE IF NOT EXISTS product_command_receipt(
    command_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    command_type TEXT NOT NULL,
    base_revision INTEGER NOT NULL,
    target_revision INTEGER NOT NULL,
    result_json TEXT NOT NULL,
    actor_id TEXT
  )"#,
    // ── Phases table ────────────────────────────────────────────────
    r#"CREATE TABLE IF NOT EXISTS phases(
    id          TEXT    PRIMARY KEY,
    project_id  TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    position    INTEGER NOT NULL,
    UNIQUE (id, project_id)
  )"#,
    r#"CREATE INDEX IF NOT EXISTS phases_by_project
    ON phases(project_id, position)"#,
    // ── Nodes table ─────────────────────────────────────────────────
    r#"CREATE TABLE IF NOT EXISTS nodes(
    id                   TEXT    NOT NULL,
    project_id           TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id            TEXT,
    title                TEXT    NOT NULL DEFAULT '',
    body_text            TEXT,
    position             INTEGER NOT NULL,
    -- No CHECK: the type vocabulary evolves and a legacy DB's baked-in CHECK
    -- cannot be ALTERed. Allowed values are enforced in the domain layer
    -- (node_type_rank / validateTypedNeighborhood) and CHECK enforcement is
    -- disabled connection-wide via PRAGMA ignore_check_constraints.
    node_type            TEXT,
    start_date           TEXT,
    end_date             TEXT,
    duration_days        INTEGER,
    schedule_source_mode TEXT,
    completed            BOOLEAN NOT NULL DEFAULT 0,
    effort_points        INTEGER,
    effort_points_done   INTEGER,
    strategic_weight     INTEGER,
    phase_id             TEXT REFERENCES phases(id),
    delivery_status      TEXT,
    PRIMARY KEY (id),
    UNIQUE (id, project_id),
    FOREIGN KEY (parent_id, project_id) REFERENCES nodes(id, project_id) ON DELETE CASCADE
  )"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS nodes_sibling_order
    ON nodes(project_id, IFNULL(parent_id, ''), position)"#,
    r#"CREATE INDEX IF NOT EXISTS nodes_by_parent
    ON nodes(project_id, IFNULL(parent_id, ''), position)"#,
    // ── Node Custom Fields table ────────────────────────────────────
    r#"CREATE TABLE IF NOT EXISTS node_custom_fields(
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    node_id     TEXT NOT NULL,
    field_key   TEXT NOT NULL,
    field_value TEXT,
    PRIMARY KEY (project_id, node_id, field_key),
    FOREIGN KEY (node_id, project_id) REFERENCES nodes(id, project_id) ON DELETE CASCADE
  )"#,
    // ── Type Template Fields table ──────────────────────────────────
    r#"CREATE TABLE IF NOT EXISTS type_template_fields(
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    node_type   TEXT NOT NULL,
    field_key   TEXT NOT NULL,
    field_label TEXT NOT NULL,
    position    INTEGER NOT NULL,
    PRIMARY KEY (project_id, node_type, field_key)
  )"#,
    // ── Unlock Edges table ──────────────────────────────────────────
    r#"CREATE TABLE IF NOT EXISTS unlock_edges(
    id              TEXT NOT NULL PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source_node_id  TEXT NOT NULL,
    target_node_id  TEXT NOT NULL,
    UNIQUE (project_id, source_node_id, target_node_id),
    FOREIGN KEY (source_node_id, project_id) REFERENCES nodes(id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (target_node_id, project_id) REFERENCES nodes(id, project_id) ON DELETE CASCADE
  )"#,
    r#"CREATE INDEX IF NOT EXISTS unlock_edges_by_source
    ON unlock_edges(project_id, source_node_id)"#,
    r#"CREATE INDEX IF NOT EXISTS unlock_edges_by_target
    ON unlock_edges(project_id, target_node_id)"#,
    // ── View State table ────────────────────────────────────────────
    r#"CREATE TABLE IF NOT EXISTS view_state(
    project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    view_id               TEXT NOT NULL,
    view_state_revision   INTEGER NOT NULL DEFAULT 0,
    collapsed_node_ids    TEXT NOT NULL DEFAULT '[]',
    zoom_root_id          TEXT,
    scroll_top            REAL NOT NULL DEFAULT 0.0,
    focused_theme_id      TEXT,
    date_window_start     TEXT,
    date_window_end       TEXT,
    granularity           TEXT,
    pan_x                 REAL NOT NULL DEFAULT 0.0,
    pan_y                 REAL NOT NULL DEFAULT 0.0,
    scale                 REAL NOT NULL DEFAULT 1.0,
    nav_collapsed         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, view_id)
  )"#,
    // ── Finding Dismissals table ────────────────────────────────────
    r#"CREATE TABLE IF NOT EXISTS finding_dismissals(
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    finding_id    TEXT NOT NULL,
    finding_kind  TEXT NOT NULL,
    target_id     TEXT NOT NULL,
    fingerprint   TEXT NOT NULL,
    dismissed_at  TEXT NOT NULL,
    PRIMARY KEY (project_id, finding_kind, target_id, fingerprint)
  )"#,
    r#"CREATE INDEX IF NOT EXISTS finding_dismissals_by_project
    ON finding_dismissals(project_id)"#,
    // ── Affected Reasons table ──────────────────────────────────────
    r#"CREATE TABLE IF NOT EXISTS affected_reasons(
    id                  TEXT NOT NULL PRIMARY KEY,
    project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    affected_node_id    TEXT NOT NULL,
    causal_node_id      TEXT NOT NULL,
    causal_node_title   TEXT NOT NULL,
    delta_days          INTEGER NOT NULL,
    causal_date_summary TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    acknowledged_at     TEXT,
    FOREIGN KEY (affected_node_id, project_id) REFERENCES nodes(id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (causal_node_id, project_id) REFERENCES nodes(id, project_id) ON DELETE CASCADE
  )"#,
    r#"CREATE INDEX IF NOT EXISTS affected_reasons_by_node
    ON affected_reasons(project_id, affected_node_id)"#,
    // ── Node Open Questions table (Story 16.1, E16-FR3, E16-AR1) ─────
    r#"CREATE TABLE IF NOT EXISTS node_open_questions(
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
  )"#,
    r#"CREATE INDEX IF NOT EXISTS node_open_questions_by_node
    ON node_open_questions(project_id, node_id, position)"#,
    // ── Forecast Plan table (Epic 18, Story 18.2) ─────────────────────
    // One optional project-owned forecast plan (AR-2). The complete plan
    // shape is reserved from Epic 18 — including the empty parallel-group
    // collection — so Epic 19 requires no immediate schema migration.
    // Configuration fields are explicitly nullable: an incomplete
    // configuration is valid plan state and is displayed as such — never
    // coerced to a fabricated default (AR-10, UX-DR9).
    // `blocked_feature_ids` (Epic 20, Story 20.1): forecast-owned explicit
    // blocker set — a subset of `selected_feature_ids`. Never inferred from
    // unlock edges or delivery status (AR-12).
    r#"CREATE TABLE IF NOT EXISTS forecast_plans(
    project_id          TEXT    PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    selected_feature_ids TEXT   NOT NULL DEFAULT '[]',
    parallel_groups     TEXT    NOT NULL DEFAULT '[]',
    blocked_feature_ids TEXT    NOT NULL DEFAULT '[]',
    points_per_sprint   INTEGER,
    sprint_length_days  INTEGER,
    cadence             TEXT    NOT NULL DEFAULT 'fixed-contiguous',
    start_sprint_ordinal INTEGER,
    start_date          TEXT,
    policy_version      TEXT    NOT NULL DEFAULT 'shared-capacity-v1',
    planning_level      TEXT    NOT NULL DEFAULT 'Feature',
    roster              TEXT    NOT NULL DEFAULT '[]',
    assignments         TEXT    NOT NULL DEFAULT '{}',
    sprint_plan         TEXT    NOT NULL DEFAULT '{}'
  )"#,
    // ── Forecast Scenarios table (Epic 20, Story 20.4) ────────────────
    // Saved historical trade-off scenarios: inputs only (AD-22).
    r#"CREATE TABLE IF NOT EXISTS forecast_scenarios(
    scenario_id        TEXT    PRIMARY KEY,
    project_id         TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    label              TEXT    NOT NULL,
    baseline_revision  INTEGER NOT NULL,
    baseline_fingerprint TEXT  NOT NULL,
    policy_version     TEXT    NOT NULL DEFAULT 'shared-capacity-v1',
    created_at_iso     TEXT    NOT NULL,
    baseline_json      TEXT    NOT NULL,
    patch_json         TEXT    NOT NULL
  )"#,
    r#"CREATE INDEX IF NOT EXISTS forecast_scenarios_by_project
    ON forecast_scenarios(project_id, created_at_iso)"#,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_and_native_schema_versions_match() {
        let ts_source = include_str!("../../../../src/adapters/persistence/schema.ts");
        let expected_line = format!("export const PRODUCT_SCHEMA_VERSION = {CURRENT_SCHEMA_VERSION};");
        assert!(
            ts_source.contains(&expected_line),
            "Expected schema.ts to contain '{expected_line}' matching Rust CURRENT_SCHEMA_VERSION ({CURRENT_SCHEMA_VERSION})"
        );
    }
}

