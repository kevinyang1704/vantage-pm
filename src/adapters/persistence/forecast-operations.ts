/**
 * Forecast plan persistence operations (Story 18.2, AD-24).
 *
 * One optional project-owned forecast plan per project. The complete plan
 * shape is reserved from Epic 18 — including the empty parallel-group
 * collection — so Epic 19 requires no immediate schema migration. Nonempty
 * imported groups are preserved but reported as unsupported until Story 19.1
 * activates the complete `shared-capacity-v1` allocation policy; they are
 * never flattened or interpreted as sequential.
 *
 * Configuration fields are explicitly nullable: an incomplete configuration
 * is valid plan state and is displayed as such — never coerced to a
 * fabricated default (AR-10, UX-DR9).
 */

import type { Database, SqlValue } from '@sqlite.org/sqlite-wasm';
import {
  createEmptyForecastPlan,
  createForecastPlan,
  FORECAST_POLICY_VERSION,
  FORECAST_CADENCE,
  DEFAULT_FORECAST_NODE_LEVEL,
  EMPTY_FORECAST_SPRINT_PLAN,
  createForecastSprintPlan,
} from '../../domain/forecast/forecast-plan.entity';
import type { ForecastPlan, ForecastConfiguration, ForecastNodeLevel, ForecastPerson, ForecastSprintPlan } from '../../domain/forecast/forecast-plan.entity';
import type { PersistedForecastScenario } from '../../domain/forecast/scenario';
import { normalizePersistedForecastScenario } from '../../domain/forecast/scenario';

type Row = Record<string, SqlValue>;

function rows(db: Database, sql: string, bind?: readonly SqlValue[]): Row[] {
  return db.exec({
    sql,
    ...(bind ? { bind } : {}),
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Row[];
}

/**
 * Thrown when a persisted forecast_plans cell cannot be parsed. Corruption is
 * surfaced as a recoverable read failure — the scope is never silently
 * collapsed to `[]`, which would read as an authoritative empty forecast and
 * would flatten preserved parallel groups (Story 18.2, "never silently
 * shrinks scope"; groups "never flattened").
 */
export class ForecastPlanCorruptError extends Error {
  readonly column: string;
  readonly field: string;
  constructor(field: string) {
    super(`FORECAST_PLAN_CORRUPT: ${field}`);
    this.name = 'ForecastPlanCorruptError';
    this.column = field;
    this.field = field;
  }
}

/**
 * Every member of a persisted identity array must be a string, matching the
 * native `Vec<String>` deserialization: valid JSON of the wrong element type
 * (an object, a number, `null`) is a corrupt column, never coerced with
 * `String(...)` into `"[object Object]"` (Story 22.14 AC 22.14-1/-2/-4).
 */
function requireStringMembers(parsed: unknown, column: string): readonly string[] {
  if (!Array.isArray(parsed)) throw new ForecastPlanCorruptError(column);
  return Object.freeze(
    parsed.map((v) => {
      if (typeof v !== 'string') throw new ForecastPlanCorruptError(column);
      return v;
    }),
  );
}

function parseIdArray(raw: SqlValue | undefined): readonly string[] {
  if (raw === null || raw === undefined) return Object.freeze([]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new ForecastPlanCorruptError('selected_feature_ids');
  }
  return requireStringMembers(parsed, 'selected_feature_ids');
}

function parseGroups(raw: SqlValue | undefined): readonly Readonly<{ featureIds: readonly string[] }>[] {
  if (raw === null || raw === undefined) return Object.freeze([]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new ForecastPlanCorruptError('parallel_groups');
  }
  if (!Array.isArray(parsed)) throw new ForecastPlanCorruptError('parallel_groups');
  return Object.freeze(
    parsed.map((g) => {
      const ids = (g as { featureIds?: unknown })?.featureIds;
      return Object.freeze({ featureIds: requireStringMembers(ids, 'parallel_groups') });
    }),
  );
}

function nullableNumber(value: SqlValue | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function nullableString(value: SqlValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function parseRoster(raw: SqlValue | undefined): readonly ForecastPerson[] {
  if (raw === null || raw === undefined) return Object.freeze([]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new ForecastPlanCorruptError('roster');
  }
  if (!Array.isArray(parsed)) throw new ForecastPlanCorruptError('roster');
  return Object.freeze(
    parsed.map((p) => {
      if (
        !p ||
        typeof p !== 'object' ||
        typeof (p as { id?: unknown }).id !== 'string' ||
        typeof (p as { name?: unknown }).name !== 'string' ||
        // Story 25.2 AC 25.2-1: a non-integer weight (e.g. 1.5, NaN) must be
        // corrupt here, matching the native `i64` deserialization that rejects
        // a JSON float. Native imposes no positivity check, so the browser must
        // not either, or the read boundaries diverge; the positive-integer
        // domain invariant is enforced by the command layer
        // (`validateStaffingWeight`) on the write path.
        !Number.isSafeInteger((p as { weightUnits?: unknown }).weightUnits)
      ) {
        throw new ForecastPlanCorruptError('roster');
      }
      return Object.freeze({
        id: String((p as { id: string }).id),
        name: String((p as { name: string }).name),
        weightUnits: Number((p as { weightUnits: number }).weightUnits),
      });
    }),
  );
}

function parseAssignments(raw: SqlValue | undefined): Readonly<Record<string, readonly string[]>> {
  if (raw === null || raw === undefined) return Object.freeze({});
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new ForecastPlanCorruptError('assignments');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ForecastPlanCorruptError('assignments');
  }
  // A null-prototype record so a stored `__proto__` key is kept as an own
  // data property (as native `HashMap<String, Vec<String>>` does) instead of
  // hitting the prototype setter, which would drop the key and pollute the
  // record's prototype (review edge-case).
  //
  // Story 25.2 AC 25.2-2 (revised): keys are NOT required to be UUIDv7 here.
  // The native reader deserializes this cell as `HashMap<String, Vec<String>>`
  // and accepts any string key, so rejecting a non-UUID key in the browser
  // would itself be a browser/native parity defect. The portable-file
  // validator is stricter, but import is a separate trust boundary. Only the
  // value shape is validated here.
  const result: Record<string, readonly string[]> = Object.create(null);
  for (const [key, val] of Object.entries(parsed)) {
    result[key] = requireStringMembers(val, 'assignments');
  }
  return Object.freeze(result);
}

/** Read the project's forecast plan, or null when none exists yet. */
export function readForecastPlan(db: Database, projectId: string): ForecastPlan | null {
  const row = rows(db, 'SELECT * FROM forecast_plans WHERE project_id = ?', [projectId])[0];
  if (!row) return null;

  const configuration: ForecastConfiguration = Object.freeze({
    pointsPerSprint: nullableNumber(row.points_per_sprint),
    sprintLengthDays: nullableNumber(row.sprint_length_days),
    cadence: (row.cadence as ForecastConfiguration['cadence']) ?? FORECAST_CADENCE,
    startSprintOrdinal: nullableNumber(row.start_sprint_ordinal),
    startDate: nullableString(row.start_date),
  });

  return createForecastPlan({
    projectId,
    selectedFeatureIds: parseIdArray(row.selected_feature_ids),
    parallelGroups: parseGroups(row.parallel_groups),
    blockedFeatureIds: parseBlockedIds(row.blocked_feature_ids),
    configuration,
    policyVersion: (row.policy_version as ForecastPlan['policyVersion']) ?? FORECAST_POLICY_VERSION,
    // Story 21.7 AC 6: a missing/NULL/unrecognized planning_level normalizes
    // to 'Feature' on read — never a throw (the SELECT * path needs no
    // per-column change; the writes carry the column).
    planningLevel: normalizePlanningLevel(row.planning_level),
    roster: parseRoster(row.roster),
    assignments: parseAssignments(row.assignments),
    sprintPlan: parseSprintPlan(row.sprint_plan),
  });
}

/**
 * Parse `sprint_plan` (the Delivery Board's hand placements and per-sprint
 * capacities). `NULL` or a missing column (a row before the column) is the
 * empty sprint plan; a damaged cell is reported, never silently emptied.
 */
function parseSprintPlan(raw: SqlValue | undefined): ForecastSprintPlan {
  if (raw === null || raw === undefined) return EMPTY_FORECAST_SPRINT_PLAN;
  try {
    return createForecastSprintPlan(JSON.parse(String(raw)));
  } catch {
    throw new ForecastPlanCorruptError('sprint_plan');
  }
}

/**
 * Store the plan's sprint plan. `writeForecastPlan` never touches this column,
 * so every other forecast write keeps the hand placements as they are.
 */
export function writeForecastSprintPlan(db: Database, projectId: string, sprintPlan: ForecastSprintPlan): void {
  db.exec({
    sql: 'UPDATE forecast_plans SET sprint_plan = ? WHERE project_id = ?',
    bind: [JSON.stringify(createForecastSprintPlan(sprintPlan)), projectId],
  });
}

/**
 * Normalize a stored `planning_level` value to a valid `ForecastNodeLevel`.
 * Missing, NULL, or unrecognized values fall back to `'Feature'` (Story 21.7
 * AC 6) — a legacy row predating the v13 column must read as a Feature plan.
 */
function normalizePlanningLevel(raw: SqlValue | undefined): ForecastNodeLevel {
  const value = raw === null || raw === undefined ? null : String(raw);
  return value === 'Theme' || value === 'Component' || value === 'Feature' ? value : 'Feature';
}

/**
 * Parse `blocked_feature_ids` (Story 20.1). A corrupt cell must not silently
 * become `[]` — that would read as an authoritative "nothing blocked". `NULL`
 * (legacy row before the v11 column) is a real empty set.
 */
function parseBlockedIds(raw: SqlValue | undefined): readonly string[] {
  if (raw === null || raw === undefined) return Object.freeze([]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new ForecastPlanCorruptError('blocked_feature_ids');
  }
  if (!Array.isArray(parsed)) throw new ForecastPlanCorruptError('blocked_feature_ids');
  return requireStringMembers(parsed, 'blocked_feature_ids');
}

/** Insert the empty plan for a project (first forecast mutation). */
export function insertEmptyForecastPlan(db: Database, projectId: string): void {
  db.exec({
    sql: `INSERT INTO forecast_plans(
            project_id, selected_feature_ids, parallel_groups, blocked_feature_ids, points_per_sprint,
            sprint_length_days, cadence, start_sprint_ordinal, start_date, policy_version, planning_level,
            roster, assignments
          ) VALUES(?, '[]', '[]', '[]', NULL, NULL, ?, NULL, NULL, ?, ?, '[]', '{}')`,
    bind: [projectId, FORECAST_CADENCE, FORECAST_POLICY_VERSION, DEFAULT_FORECAST_NODE_LEVEL],
  });
}

/** Persist the complete plan shape (one atomic write). */
export function writeForecastPlan(db: Database, plan: ForecastPlan): void {
  db.exec({
    sql: `INSERT INTO forecast_plans(
            project_id, selected_feature_ids, parallel_groups, blocked_feature_ids, points_per_sprint,
            sprint_length_days, cadence, start_sprint_ordinal, start_date, policy_version, planning_level,
            roster, assignments
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id) DO UPDATE SET
            selected_feature_ids = excluded.selected_feature_ids,
            parallel_groups      = excluded.parallel_groups,
            blocked_feature_ids  = excluded.blocked_feature_ids,
            points_per_sprint    = excluded.points_per_sprint,
            sprint_length_days   = excluded.sprint_length_days,
            cadence              = excluded.cadence,
            start_sprint_ordinal = excluded.start_sprint_ordinal,
            start_date           = excluded.start_date,
            policy_version       = excluded.policy_version,
            planning_level       = excluded.planning_level,
            roster               = excluded.roster,
            assignments          = excluded.assignments`,
    bind: [
      plan.projectId,
      JSON.stringify(plan.selectedFeatureIds),
      JSON.stringify(plan.parallelGroups.map((g) => ({ featureIds: g.featureIds }))),
      JSON.stringify(plan.blockedFeatureIds),
      plan.configuration.pointsPerSprint,
      plan.configuration.sprintLengthDays,
      plan.configuration.cadence,
      plan.configuration.startSprintOrdinal,
      plan.configuration.startDate,
      plan.policyVersion,
      plan.planningLevel,
      JSON.stringify(plan.roster),
      JSON.stringify(plan.assignments),
    ],
  });
}

export function deleteForecastPlan(db: Database, projectId: string): void {
  db.exec({
    sql: 'DELETE FROM forecast_plans WHERE project_id = ?',
    bind: [projectId],
  });
}

export function createEmptyPlanForProject(projectId: string): ForecastPlan {
  return createEmptyForecastPlan(projectId);
}

// ── Forecast scenarios (Story 20.4) ──────────────────────────────────────

function rowToScenario(row: Row): PersistedForecastScenario {
  let baseline: unknown;
  let patch: unknown;
  try {
    baseline = JSON.parse(String(row.baseline_json));
    patch = JSON.parse(String(row.patch_json));
  } catch {
    throw new ForecastPlanCorruptError('forecast_scenarios');
  }
  return normalizePersistedForecastScenario({
    scenarioId: String(row.scenario_id),
    projectId: String(row.project_id),
    label: String(row.label),
    baselineRevision: Number(row.baseline_revision),
    baselineFingerprint: String(row.baseline_fingerprint),
    policyVersion: (row.policy_version as PersistedForecastScenario['policyVersion']) ?? 'shared-capacity-v1',
    createdAtISO: String(row.created_at_iso),
    baseline: baseline as PersistedForecastScenario['baseline'],
    patch: patch as PersistedForecastScenario['patch'],
  });
}

/** All saved scenarios for a project, oldest first. */
export function readForecastScenarios(db: Database, projectId: string): readonly PersistedForecastScenario[] {
  return Object.freeze(
    rows(db, 'SELECT * FROM forecast_scenarios WHERE project_id = ? ORDER BY created_at_iso, scenario_id', [projectId]).map(rowToScenario),
  );
}

export function readForecastScenario(db: Database, scenarioId: string): PersistedForecastScenario | null {
  const row = rows(db, 'SELECT * FROM forecast_scenarios WHERE scenario_id = ?', [scenarioId])[0];
  return row ? rowToScenario(row) : null;
}

export function insertForecastScenario(db: Database, scenario: PersistedForecastScenario): void {
  db.exec({
    sql: `INSERT INTO forecast_scenarios(
            scenario_id, project_id, label, baseline_revision, baseline_fingerprint,
            policy_version, created_at_iso, baseline_json, patch_json
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bind: [
      scenario.scenarioId,
      scenario.projectId,
      scenario.label,
      scenario.baselineRevision,
      scenario.baselineFingerprint,
      scenario.policyVersion,
      scenario.createdAtISO,
      JSON.stringify(scenario.baseline),
      JSON.stringify(scenario.patch),
    ],
  });
}

export function deleteForecastScenario(db: Database, scenarioId: string): void {
  db.exec({ sql: 'DELETE FROM forecast_scenarios WHERE scenario_id = ?', bind: [scenarioId] });
}
