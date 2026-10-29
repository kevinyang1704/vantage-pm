/**
 * Product schema-version model and migration-step contract (Story 1.9 Task 1).
 *
 * Tracks the product SQLite database's own DDL shape — distinct from:
 * (a) the Gate A/B qualification fixtures' migration-protocol versioning
 * (b) Story 1.8's PortableFileEnvelope.schemaVersion (user-facing file format)
 *
 * This story's schema version tracks the product database's DDL shape.
 */

/** Current product database schema version. */
export const PRODUCT_SCHEMA_VERSION = 1;

/** A single migration step: idempotent DDL/data change from one version to the next. */
export type MigrationStep = Readonly<{
  /** Unique identifier for this migration step. */
  migrationId: string;
  /** The schema version this step migrates FROM. */
  sourceSchema: number;
  /** The schema version this step migrates TO. */
  targetSchema: number;
  /** SQL statements to execute (idempotent — safe to re-run). */
  sql: readonly string[];
}>;

/** The ordered list of migration steps from version 1 onward. */
export type MigrationPlan = Readonly<{
  currentVersion: number;
  steps: readonly MigrationStep[];
}>;

/**
 * Create an empty migration plan at the current schema version.
 * As future epics add entity tables, they append steps to this plan.
 */
export function createMigrationPlan(): MigrationPlan {
  return Object.freeze({
    currentVersion: PRODUCT_SCHEMA_VERSION,
    steps: Object.freeze([]),
  });
}
