/**
 * Product SQLite schema version 8 (Epic 1, Epic 2, Epic 3, Epic 4, Epic 16,
 * Epic 17).
 *
 * Defines the DDL for the product domain's persistence tables.
 *
 * Project-scoping convention (AD-4):
 *   Every project-owned table MUST carry:
 *     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
 *
 * Workspaces are deliberately NOT part of that convention. A workspace groups
 * projects; it does not own project content. Only `projects` carries
 * `workspace_id` — no project-owned table does — so re-homing a project stays
 * a single UPDATE and workspace scoping never has to be threaded through the
 * node/phase/edge queries.
 *
 * Schema version: 17 (Epic 27: actor identity on receipts and a stable local
 * actor). Epic 26 Story 26.5 added `nodes.effort_points_done`.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';

/**
 * Current product schema version.
 *
 * Gated on `user_version` across both browser and native compositions (Story 22.15).
 * Browser stamps this atomically as the final step in `prepareProductDatabase`
 * and refuses newer databases (`user_version > PRODUCT_SCHEMA_VERSION`)
 * before executing any writing statement or migration.
 * Keep this in step with `src-tauri/src/db/schema.rs:CURRENT_SCHEMA_VERSION`.
 */
export const PRODUCT_SCHEMA_VERSION = 21;

/**
 * Actionable message shown when a database saved by a newer build is opened.
 */
export const NEWER_SCHEMA_REFUSAL_MESSAGE =
  'This project data was saved by a newer version of the app. Reload to update.';

/**
 * Thrown when an opened database carries a user_version newer than supported.
 */
export class NewerSchemaVersionError extends Error {
  readonly code = 'UNSUPPORTED_NEWER_SCHEMA';
  readonly foundVersion: number;
  readonly supportedVersion: number;

  constructor(found: number, supported: number = PRODUCT_SCHEMA_VERSION) {
    super(NEWER_SCHEMA_REFUSAL_MESSAGE);
    this.name = 'NewerSchemaVersionError';
    this.foundVersion = found;
    this.supportedVersion = supported;
  }
}

/**
 * Reads SQLite PRAGMA user_version non-mutatingly.
 */
export function readUserVersion(target: Database): number {
  const rows = target.exec({
    sql: 'PRAGMA user_version',
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as unknown as Record<string, unknown>[];
  if (!rows || rows.length === 0) return 0;
  const first = rows[0];
  const val = first.user_version ?? Object.values(first)[0];
  return typeof val === 'number' ? val : Number(val ?? 0);
}

/**
 * Story 22.15 AC 22.15-2/-3: refuse a database whose `user_version` is newer
 * than this build supports, before any write. Every durable mutation boundary
 * that does NOT go through `ProductCommandHandler.apply` (workspace, view
 * state, portable import, reset) must call this too — otherwise a live upgrade
 * by another tab lets those writers mutate a database this build does not
 * understand.
 */
export function assertWritableSchema(target: Database): void {
  const currentVersion = readUserVersion(target);
  if (currentVersion > PRODUCT_SCHEMA_VERSION) {
    throw new NewerSchemaVersionError(currentVersion, PRODUCT_SCHEMA_VERSION);
  }
}

/**
 * DDL statements to initialize the product schema.
 * Idempotent — uses IF NOT EXISTS on every statement.
 * Caller must ensure foreign_keys = ON before executing.
 */
export const PRODUCT_SCHEMA_DDL = [
  // ── Workspaces table (Epic 17) ──────────────────────────────────
  // Declared before `projects` so the FK target exists on a fresh create.
  `CREATE TABLE IF NOT EXISTS workspaces(
    id       TEXT    PRIMARY KEY,
    name     TEXT    NOT NULL,
    position INTEGER NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS workspaces_by_position
    ON workspaces(position)`,

  // ── App settings (Epic 17) ──────────────────────────────────────
  // App-level key/value pointers that are not project-scoped and never
  // appear in a ChangeSet, the undo stack, or the portable file.
  // Currently: `active_workspace_id`.
  `CREATE TABLE IF NOT EXISTS app_settings(
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // ── Projects table ──────────────────────────────────────────────
  // `workspace_id` has NO ON DELETE clause on purpose. SQLite's default
  // NO ACTION makes the database itself refuse to drop a workspace that
  // still holds projects, which backs up the same check in
  // workspace.policy.ts — deleting a workspace can never become a
  // backdoor to deleting projects.
  //
  // It is nullable only because SQLite cannot ADD COLUMN ... NOT NULL
  // without a default, and a foreign key has no sensible literal default.
  // Making it NOT NULL here would leave freshly-created databases with a
  // stricter schema than migrated ones. Instead the column is nullable in
  // both and the "every project has a workspace" invariant is enforced by
  // the migration backfill plus ensureDefaultWorkspace() on every open.
  `CREATE TABLE IF NOT EXISTS projects(
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    revision     INTEGER NOT NULL DEFAULT 0,
    workspace_id TEXT REFERENCES workspaces(id)
  )`,

  `CREATE INDEX IF NOT EXISTS projects_by_workspace
    ON projects(workspace_id, name)`,

  // ── Product command receipt table ───────────────────────────────
  // Append-only idempotency ledger: the serialized result of every applied
  // product command, so a duplicate commandId replays the stored result.
  // project_id is recorded as plain metadata (no FK) because receipts must
  // SURVIVE the deletion of their project — a retried DeleteProject (same
  // commandId) replays the stored success rather than PROJECT_NOT_FOUND;
  // a hard FK would either be wiped by cascade or block the delete (Story 5.7).
  `CREATE TABLE IF NOT EXISTS product_command_receipt(
    command_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    command_type TEXT NOT NULL,
    base_revision INTEGER NOT NULL,
    target_revision INTEGER NOT NULL,
    result_json TEXT NOT NULL,
    actor_id TEXT
  )`,

  // ── Phases table (Story 3.7) ────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS phases(
    id          TEXT    PRIMARY KEY,
    project_id  TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    position    INTEGER NOT NULL,
    UNIQUE (id, project_id)
  )`,

  `CREATE INDEX IF NOT EXISTS phases_by_project
    ON phases(project_id, position)`,

  // ── Nodes table (Story 2.3, Epic 3) ─────────────────────────────
  `CREATE TABLE IF NOT EXISTS nodes(
    id                   TEXT    NOT NULL,
    project_id           TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id            TEXT,
    title                TEXT    NOT NULL DEFAULT '',
    body_text            TEXT,
    position             INTEGER NOT NULL,
    -- No CHECK: the type vocabulary evolves (a legacy DB's baked-in CHECK
    -- cannot be ALTERed), so the allowed values are enforced in the domain
    -- layer (validateTypedNeighborhood / isValidNodeType) and CHECK
    -- enforcement is disabled connection-wide via PRAGMA
    -- ignore_check_constraints. Matches the delivery_status / workspace_id
    -- precedent.
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
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS nodes_sibling_order
    ON nodes(project_id, IFNULL(parent_id, ''), position)`,

  `CREATE INDEX IF NOT EXISTS nodes_by_parent
    ON nodes(project_id, IFNULL(parent_id, ''), position)`,

  // ── Node Custom Fields table (Story 3.2) ────────────────────────
  `CREATE TABLE IF NOT EXISTS node_custom_fields(
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    node_id     TEXT NOT NULL,
    field_key   TEXT NOT NULL,
    field_value TEXT,
    PRIMARY KEY (project_id, node_id, field_key),
    FOREIGN KEY (node_id, project_id) REFERENCES nodes(id, project_id) ON DELETE CASCADE
  )`,

  // ── Type Template Fields table (Story 3.2) ──────────────────────
  `CREATE TABLE IF NOT EXISTS type_template_fields(
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    node_type   TEXT NOT NULL,
    field_key   TEXT NOT NULL,
    field_label TEXT NOT NULL,
    position    INTEGER NOT NULL,
    PRIMARY KEY (project_id, node_type, field_key)
  )`,

  // ── Unlock Edges table (Story 3.8, Story 3.9) ───────────────────
  `CREATE TABLE IF NOT EXISTS unlock_edges(
    id              TEXT NOT NULL PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source_node_id  TEXT NOT NULL,
    target_node_id  TEXT NOT NULL,
    UNIQUE (project_id, source_node_id, target_node_id),
    FOREIGN KEY (source_node_id, project_id) REFERENCES nodes(id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (target_node_id, project_id) REFERENCES nodes(id, project_id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS unlock_edges_by_source
    ON unlock_edges(project_id, source_node_id)`,

  `CREATE INDEX IF NOT EXISTS unlock_edges_by_target
    ON unlock_edges(project_id, target_node_id)`,

  // ── View State table (Story 2.5, Epic 10 viewport E10-AR9) ────────
  `CREATE TABLE IF NOT EXISTS view_state(
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
  )`,

  // ── Finding Dismissals table (Story 4.6) ──────────────────────────
  `CREATE TABLE IF NOT EXISTS finding_dismissals(
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    finding_id    TEXT NOT NULL,
    finding_kind  TEXT NOT NULL,
    target_id     TEXT NOT NULL,
    fingerprint   TEXT NOT NULL,
    dismissed_at  TEXT NOT NULL,
    PRIMARY KEY (project_id, finding_kind, target_id, fingerprint)
  )`,

  `CREATE INDEX IF NOT EXISTS finding_dismissals_by_project
    ON finding_dismissals(project_id)`,

  // ── Affected Reasons table (Story 4.8) ───────────────────────────
  `CREATE TABLE IF NOT EXISTS affected_reasons(
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
  )`,

  `CREATE INDEX IF NOT EXISTS affected_reasons_by_node
    ON affected_reasons(project_id, affected_node_id)`,

  // ── Node Open Questions table (Story 16.1, E16-FR3, E16-AR1) ────────────
  `CREATE TABLE IF NOT EXISTS node_open_questions(
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
  )`,

  `CREATE INDEX IF NOT EXISTS node_open_questions_by_node
    ON node_open_questions(project_id, node_id, position)`,

  // ── Forecast Plan table (Epic 18, Story 18.2) ─────────────────────────
  // One optional project-owned forecast plan (AR-2). The complete plan shape
  // is reserved from Epic 18 — including the empty parallel-group collection
  // — so Epic 19 requires no immediate schema migration. Nonempty imported
  // groups are preserved but reported as unsupported until Story 19.1
  // activates the complete `shared-capacity-v1` allocation policy; they are
  // never flattened or interpreted as sequential.
  //
  // Configuration fields are explicitly nullable: an incomplete
  // configuration is valid plan state and is displayed as such — never
  // coerced to a fabricated default (AR-10, UX-DR9). `cadence` is always
  // 'fixed-contiguous' in v1. `policy_version` is 'shared-capacity-v1'.
  //
  // `blocked_feature_ids` (Epic 20, Story 20.1): forecast-owned explicit
  // blocker set — a subset of `selected_feature_ids`. Never inferred from
  // unlock edges or delivery status; marking a member turns an otherwise
  // ready result `conditional` with no assumed delay (AR-12).
  `CREATE TABLE IF NOT EXISTS forecast_plans(
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
  )`,
  // ── Forecast Scenarios table (Epic 20, Story 20.4) ────────────────
  // Saved historical trade-off scenarios: inputs only, never a computed
  // ForecastResult (AD-22). `baseline_json` holds ordered scope + config +
  // parallel groups + blocked set + the immutable union fact map; each
  // scenario reproduces from these facts alone.
  `CREATE TABLE IF NOT EXISTS forecast_scenarios(
    scenario_id        TEXT    PRIMARY KEY,
    project_id         TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    label              TEXT    NOT NULL,
    baseline_revision  INTEGER NOT NULL,
    baseline_fingerprint TEXT  NOT NULL,
    policy_version     TEXT    NOT NULL DEFAULT 'shared-capacity-v1',
    created_at_iso     TEXT    NOT NULL,
    baseline_json      TEXT    NOT NULL,
    patch_json         TEXT    NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS forecast_scenarios_by_project
    ON forecast_scenarios(project_id, created_at_iso)`,
] as const;
