/**
 * Forecast input validators (Story 18.1, AC 18.1-2..18.1-4, AD-18).
 *
 * Points and capacity accept only finite non-negative safe integers; sprint
 * length and start ordinal accept only positive safe integers; dates use
 * strict ISO date-only values. Invalid values are rejected without coercion.
 * Scope validation resolves members to same-project Features, rejects
 * duplicates, and names parent/descendant overlap without automatic
 * exclusion. Deleted/retyped selected nodes remain visible as invalid
 * references until explicit exclusion — the system never silently shrinks
 * scope.
 */

import { Temporal } from 'temporal-polyfill';
import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import type { Node } from '../tree/node.entity';
import {
  DEFAULT_FORECAST_NODE_LEVEL,
  FORECAST_POLICY_VERSION,
  STAFFED_FORECAST_POLICY_VERSION,
  type ForecastNodeLevel,
  type ForecastPerson,
  type ForecastParallelGroup,
  type ForecastPolicyVersion,
} from './forecast-plan.entity';

/** A typed validation issue with a stable code and named IDs (AR-10). */
export type ForecastIssue = Readonly<{
  code:
    | 'INVALID_POINTS'
    | 'INVALID_CAPACITY'
    | 'INVALID_SPRINT_LENGTH'
    | 'INVALID_START_ORDINAL'
    | 'INVALID_START_DATE'
    | 'FOREIGN_FEATURE'
    | 'NOT_A_FEATURE'
    | 'DUPLICATE_MEMBER'
    | 'OVERLAPPING_SCOPE'
    | 'UNSUPPORTED_POLICY'
    | 'UNSUPPORTED_GROUPS'
    | 'INVALID_GROUP'
    | 'OVERFLOW'
    | 'MISSING_ESTIMATE'
    | 'MISSING_CAPACITY'
    | 'MISSING_SPRINT_LENGTH'
    | 'MISSING_START_ORDINAL'
    | 'MISSING_START_DATE'
    | 'ZERO_CAPACITY'
    | 'CONDITIONAL_BLOCKER'
    | 'INVALID_STAFFING_WEIGHT'
    | 'INVALID_PERSON'
    | 'DUPLICATE_PERSON'
    | 'UNKNOWN_PERSON'
    | 'DUPLICATE_ASSIGNMENT'
    | 'ASSIGNMENT_TO_EXCLUDED_ITEM'
    | 'ASSIGNMENT_TO_WRONG_LEVEL'
    | 'ASSIGNMENT_TO_ZERO_WORK'
    | 'CONCURRENT_ASSIGNMENT_CONFLICT'
    | 'MISSING_ASSIGNMENT'
    | 'MISSING_ROSTER';
  field: string;
  message: string;
  featureIds?: readonly string[];
  personIds?: readonly string[];
}>;

export function isFiniteNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isValidIsoDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try {
    Temporal.PlainDate.from(value);
    return true;
  } catch {
    return false;
  }
}

export function validatePoints(value: unknown, field: string): ForecastIssue | null {
  if (value === null || value === undefined) return null;
  if (!isFiniteNonNegativeSafeInteger(value)) {
    return Object.freeze({
      code: 'INVALID_POINTS',
      field,
      message: 'Points must be a finite non-negative safe integer or null.',
    });
  }
  return null;
}

export function validateCapacity(value: unknown, field: string): ForecastIssue | null {
  if (value === null || value === undefined) return null;
  if (!isFiniteNonNegativeSafeInteger(value)) {
    return Object.freeze({
      code: 'INVALID_CAPACITY',
      field,
      message: 'Capacity must be a finite non-negative safe integer or null.',
    });
  }
  return null;
}

export function validateSprintLength(value: unknown, field: string): ForecastIssue | null {
  if (value === null || value === undefined) return null;
  if (!isPositiveSafeInteger(value)) {
    return Object.freeze({
      code: 'INVALID_SPRINT_LENGTH',
      field,
      message: 'Sprint length must be a positive safe integer or null.',
    });
  }
  return null;
}

export function validateStartOrdinal(value: unknown, field: string): ForecastIssue | null {
  if (value === null || value === undefined) return null;
  if (!isPositiveSafeInteger(value)) {
    return Object.freeze({
      code: 'INVALID_START_ORDINAL',
      field,
      message: 'Start sprint ordinal must be a positive safe integer or null.',
    });
  }
  return null;
}

export function validateStartDate(value: unknown, field: string): ForecastIssue | null {
  if (value === null || value === undefined) return null;
  if (!isValidIsoDateOnly(value)) {
    return Object.freeze({
      code: 'INVALID_START_DATE',
      field,
      message: 'Start date must be a strict ISO YYYY-MM-DD date or null.',
    });
  }
  return null;
}

/**
 * Validate the ordered scope against the project's nodes.
 *
 * Every member must resolve to a same-project node of the plan's
 * `planningLevel`, occur once, and not overlap a selected ancestor or
 * descendant node. Failures name the affected IDs and never mutate state
 * (AC 18.1-3). A selected node that was deleted or retyped remains an
 * invalid reference — never silently removed (AC 18.1-4).
 *
 * `level` defaults to `'Feature'` so existing call sites and specs keep
 * compiling; `normalizeForecastInputs` passes `plan.planningLevel` explicitly
 * (Story 21.6 AC 2). The issue code stays `NOT_A_FEATURE` (AR-6: the code is
 * a stable wire string; only the message becomes level-aware).
 */
export function validateForecastScope(
  selectedFeatureIds: readonly string[],
  nodes: readonly Node[],
  projectId: string,
  level: ForecastNodeLevel = DEFAULT_FORECAST_NODE_LEVEL,
): readonly ForecastIssue[] {
  const issues: ForecastIssue[] = [];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const seen = new Set<string>();
  for (const id of selectedFeatureIds) {
    if (seen.has(id)) {
      issues.push(
        Object.freeze({
          code: 'DUPLICATE_MEMBER',
          field: 'selectedFeatureIds',
          message: `Feature ${id} occurs more than once in forecast scope.`,
          featureIds: Object.freeze([id]),
        }),
      );
      continue;
    }
    seen.add(id);

    const node = nodeById.get(id);
    if (!node) {
      issues.push(
        Object.freeze({
          code: 'FOREIGN_FEATURE',
          field: 'selectedFeatureIds',
          message: `Feature ${id} does not exist in this project.`,
          featureIds: Object.freeze([id]),
        }),
      );
      continue;
    }
    if (node.projectId !== projectId) {
      issues.push(
        Object.freeze({
          code: 'FOREIGN_FEATURE',
          field: 'selectedFeatureIds',
          message: `Feature ${id} belongs to another project.`,
          featureIds: Object.freeze([id]),
        }),
      );
      continue;
    }
    if (node.nodeType !== level) {
      issues.push(
        Object.freeze({
          code: 'NOT_A_FEATURE',
          field: 'selectedFeatureIds',
          message: `Expected node of type ${level}, but found ${node.nodeType}.`,
          featureIds: Object.freeze([id]),
        }),
      );
      continue;
    }
  }

  // Parent/descendant overlap: the PM chooses either a parent node or its
  // descendant nodes for one forecast; overlapping levels are named and
  // rejected without automatic exclusion (AR-4). The ancestor walk is
  // level-agnostic — it must not be narrowed to Features (Story 21.6 AC 5).
  const selected = new Set(selectedFeatureIds);
  const parentOf = new Map<string, string | null>();
  for (const n of nodes) parentOf.set(n.id, n.parentId);
  for (const id of selectedFeatureIds) {
    let ancestor = parentOf.get(id) ?? null;
    // Bounded walk: a corrupt parent_id chain must never spin the worker.
    const visited = new Set<string>([id]);
    while (ancestor !== null && !visited.has(ancestor)) {
      visited.add(ancestor);
      if (selected.has(ancestor)) {
        issues.push(
          Object.freeze({
            code: 'OVERLAPPING_SCOPE',
            field: 'selectedFeatureIds',
            message: `Feature ${id} overlaps selected ancestor Feature ${ancestor}.`,
            featureIds: Object.freeze([id, ancestor]),
          }),
        );
        break;
      }
      ancestor = parentOf.get(ancestor) ?? null;
    }
  }

  return Object.freeze(issues);
}

/**
 * Validate parallel groups: each group has at least two unique selected IDs,
 * groups are disjoint, and each group is contiguous in forecast priority
 * order (AR-5, AR-18). Noncontiguous or overlapping groups are rejected.
 */
export function validateForecastGroups(
  selectedFeatureIds: readonly string[],
  parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[],
): readonly ForecastIssue[] {
  const issues: ForecastIssue[] = [];
  const position = new Map(selectedFeatureIds.map((id, idx) => [id, idx]));
  const seen = new Set<string>();

  for (const group of parallelGroups) {
    if (group.featureIds.length < 2) {
      issues.push(
        Object.freeze({
          code: 'INVALID_GROUP',
          field: 'parallelGroups',
          message: 'A parallel group must contain at least two Features.',
          featureIds: Object.freeze([...group.featureIds]),
        }),
      );
      continue;
    }
    const positions: number[] = [];
    for (const id of group.featureIds) {
      if (seen.has(id)) {
        issues.push(
          Object.freeze({
            code: 'INVALID_GROUP',
            field: 'parallelGroups',
            message: `Feature ${id} appears in more than one parallel group.`,
            featureIds: Object.freeze([id]),
          }),
        );
        continue;
      }
      seen.add(id);
      const pos = position.get(id);
      if (pos === undefined) {
        issues.push(
          Object.freeze({
            code: 'INVALID_GROUP',
            field: 'parallelGroups',
            message: `Feature ${id} is not in forecast scope.`,
            featureIds: Object.freeze([id]),
          }),
        );
        continue;
      }
      positions.push(pos);
    }
    if (positions.length > 0) {
      const sorted = [...positions].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i += 1) {
        if (sorted[i] !== sorted[i - 1] + 1) {
          issues.push(
            Object.freeze({
              code: 'INVALID_GROUP',
              field: 'parallelGroups',
              message: 'A parallel group must be contiguous in forecast priority order.',
              featureIds: Object.freeze([...group.featureIds]),
            }),
          );
          break;
        }
      }
    }
  }

  return Object.freeze(issues);
}

export function validatePolicyVersion(value: unknown): ForecastIssue | null {
  if (value !== FORECAST_POLICY_VERSION && value !== STAFFED_FORECAST_POLICY_VERSION) {
    return Object.freeze({
      code: 'UNSUPPORTED_POLICY',
      field: 'policyVersion',
      message: `Unsupported forecast policy version: ${String(value)}.`,
    });
  }
  return null;
}

export function assertForecastPolicyVersion(value: unknown): asserts value is ForecastPolicyVersion {
  if (value !== FORECAST_POLICY_VERSION && value !== STAFFED_FORECAST_POLICY_VERSION) {
    throw new Error(`Unsupported forecast policy version: ${String(value)}.`);
  }
}

/** Default staffing weight units (1.00 = 100 units). */
export const DEFAULT_STAFFING_WEIGHT_UNITS = 100;

/**
 * Parse and normalize a staffing weight input into integer weight units (hundredths).
 * e.g., '1', '1.0', '1.00' -> 100
 *       '0.10' -> 10
 *       '0.20' -> 20
 *
 * Requirements (AC 22.1-2, SF-AR4):
 * - Trim outer whitespace.
 * - Require decimal digits with at most two fractional digits.
 * - Reject zero, negative, exponent, non-finite, excessive-precision and unsafe scaled-integer values without rounding.
 */
export function parseStaffingWeightToUnits(value: unknown): number {
  if (value === null || value === undefined) {
    throw new Error('INVALID_STAFFING_WEIGHT: Value is null or undefined.');
  }

  let str: string;
  if (typeof value === 'string') {
    str = value.trim();
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`INVALID_STAFFING_WEIGHT: Number ${value} is not a positive finite number.`);
    }
    str = String(value).trim();
  } else {
    throw new Error('INVALID_STAFFING_WEIGHT: Expected string or number.');
  }

  // Must be decimal digits with optional dot and at most 2 fractional digits.
  // Must NOT have signs (+, -), exponents (e, E), etc.
  if (!/^\d+(\.\d{1,2})?$/.test(str)) {
    throw new Error(`INVALID_STAFFING_WEIGHT: Invalid weight format "${str}".`);
  }

  const [wholeStr, fracStr = ''] = str.split('.');
  const whole = parseInt(wholeStr, 10);
  const frac = parseInt(fracStr.padEnd(2, '0'), 10);

  const units = whole * 100 + frac;
  if (!isValidStaffingWeightUnits(units)) {
    throw new Error(`INVALID_STAFFING_WEIGHT: Weight units ${units} must be a positive safe integer.`);
  }

  return units;
}

/**
 * The one approved staffing-weight range (SF-AR4, Story 23.9): positive
 * safe-integer hundredths. Live people and scenario weight overrides share
 * it — there is no narrower scenario-only maximum. An accepted weight does
 * not promise every aggregate is representable; the calculator reports that
 * separately as OVERFLOW.
 */
export function isValidStaffingWeightUnits(units: unknown): units is number {
  return typeof units === 'number' && Number.isSafeInteger(units) && units > 0;
}

/** Exact decimal text for weight units ("1000.01"), the form the parser accepts back. */
export function formatStaffingWeightUnits(units: number): string {
  const scaled = BigInt(units);
  return `${scaled / 100n}.${(scaled % 100n).toString().padStart(2, '0')}`;
}

export function validateStaffingWeight(value: unknown, field: string): ForecastIssue | null {
  try {
    parseStaffingWeightToUnits(value);
    return null;
  } catch (err) {
    return Object.freeze({
      code: 'INVALID_STAFFING_WEIGHT',
      field,
      message: err instanceof Error ? err.message : 'Invalid staffing weight.',
    });
  }
}

/** Validate the project roster for staffed forecasting (Story 22.1, SF-FR2). */
export function validateRoster(
  roster: unknown,
  field = 'roster',
): readonly ForecastIssue[] {
  const issues: ForecastIssue[] = [];
  if (!Array.isArray(roster)) {
    return Object.freeze([
      Object.freeze({
        code: 'INVALID_PERSON',
        field,
        message: 'Roster must be an array of people.',
      }),
    ]);
  }

  const seenIds = new Set<string>();
  for (let i = 0; i < roster.length; i++) {
    const person = roster[i];
    const personField = `${field}[${i}]`;
    if (!person || typeof person !== 'object') {
      issues.push(
        Object.freeze({
          code: 'INVALID_PERSON',
          field: personField,
          message: 'Roster member must be an object.',
        }),
      );
      continue;
    }

    const { id, name, weightUnits } = person as Record<string, unknown>;

    try {
      assertUuidV7(id as string, 'Person ID must be a valid UUIDv7');
    } catch {
      issues.push(
        Object.freeze({
          code: 'INVALID_PERSON',
          field: `${personField}.id`,
          message: 'Person ID must be a valid UUIDv7.',
          personIds: typeof id === 'string' ? Object.freeze([id]) : undefined,
        }),
      );
    }

    if (typeof id === 'string') {
      if (seenIds.has(id)) {
        issues.push(
          Object.freeze({
            code: 'DUPLICATE_PERSON',
            field: `${personField}.id`,
            message: `Duplicate person ID in roster: ${id}.`,
            personIds: Object.freeze([id]),
          }),
        );
      } else {
        seenIds.add(id);
      }
    }

    if (typeof name !== 'string' || name.trim().length === 0) {
      issues.push(
        Object.freeze({
          code: 'INVALID_PERSON',
          field: `${personField}.name`,
          message: 'Person name must be a non-empty string.',
        }),
      );
    }

    if (!isValidStaffingWeightUnits(weightUnits)) {
      issues.push(
        Object.freeze({
          code: 'INVALID_STAFFING_WEIGHT',
          field: `${personField}.weightUnits`,
          message: 'Weight units must be a positive safe integer.',
        }),
      );
    }
  }

  return Object.freeze(issues);
}

/**
 * Validate staffing assignments against roster, scope, hierarchy, estimates and groups
 * (Story 22.1, AC 22.1-4, SF-FR4, SF-FR5).
 */
export function validateStaffingAssignments(params: {
  assignments: unknown;
  roster: readonly ForecastPerson[];
  selectedFeatureIds: readonly string[];
  nodes?: readonly Node[];
  planningLevel?: ForecastNodeLevel;
  estimates: Readonly<Record<string, number | null>>;
  parallelGroups: readonly ForecastParallelGroup[];
}): readonly ForecastIssue[] {
  const issues: ForecastIssue[] = [];
  const { assignments, roster, selectedFeatureIds, nodes = [], planningLevel, estimates, parallelGroups } = params;

  if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) {
    return Object.freeze([
      Object.freeze({
        code: 'INVALID_GROUP',
        field: 'assignments',
        message: 'Assignments must be a record of item IDs to person ID arrays.',
      }),
    ]);
  }

  const rosterPersonIds = new Set(roster.map((p) => p.id));
  const selectedSet = new Set(selectedFeatureIds);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const assignmentRecord = assignments as Record<string, unknown>;

  // Check each item's assignments in assignmentRecord
  for (const [itemId, personList] of Object.entries(assignmentRecord)) {
    if (!Array.isArray(personList)) continue;
    if (personList.length === 0) continue;

    // Check if item is in forecast scope
    if (!selectedSet.has(itemId)) {
      issues.push(
        Object.freeze({
          code: 'ASSIGNMENT_TO_EXCLUDED_ITEM',
          field: `assignments[${itemId}]`,
          message: `Item ${itemId} is assigned people but is not in forecast scope.`,
          featureIds: Object.freeze([itemId]),
        }),
      );
    }

    // Check node level
    const node = nodeById.get(itemId);
    if (node && node.nodeType !== planningLevel) {
      issues.push(
        Object.freeze({
          code: 'ASSIGNMENT_TO_WRONG_LEVEL',
          field: `assignments[${itemId}]`,
          message: `Item ${itemId} is of type ${node.nodeType}, expected ${planningLevel}.`,
          featureIds: Object.freeze([itemId]),
        }),
      );
    }

    // Check assignments to zero-point items (AC 22.1-4, A7)
    if (estimates[itemId] === 0) {
      issues.push(
        Object.freeze({
          code: 'ASSIGNMENT_TO_ZERO_WORK',
          field: `assignments[${itemId}]`,
          message: `Zero-work item ${itemId} cannot have assigned people.`,
          featureIds: Object.freeze([itemId]),
        }),
      );
    }

    // Check person IDs
    const seenPersonsOnItem = new Set<string>();
    for (const pid of personList) {
      if (typeof pid !== 'string') continue;
      if (seenPersonsOnItem.has(pid)) {
        issues.push(
          Object.freeze({
            code: 'DUPLICATE_ASSIGNMENT',
            field: `assignments[${itemId}]`,
            message: `Person ${pid} is assigned more than once to item ${itemId}.`,
            featureIds: Object.freeze([itemId]),
            personIds: Object.freeze([pid]),
          }),
        );
      } else {
        seenPersonsOnItem.add(pid);
      }

      if (!rosterPersonIds.has(pid)) {
        issues.push(
          Object.freeze({
            code: 'UNKNOWN_PERSON',
            field: `assignments[${itemId}]`,
            message: `Person ${pid} assigned to item ${itemId} is not in the project roster.`,
            featureIds: Object.freeze([itemId]),
            personIds: Object.freeze([pid]),
          }),
        );
      }
    }
  }

  // Check missing assignments on selected positive-point work (incomplete state)
  for (const itemId of selectedFeatureIds) {
    const pts = estimates[itemId];
    if (typeof pts === 'number' && pts > 0) {
      const assigned = assignmentRecord[itemId];
      if (!Array.isArray(assigned) || assigned.length === 0) {
        issues.push(
          Object.freeze({
            code: 'MISSING_ASSIGNMENT',
            field: `assignments[${itemId}]`,
            message: `Positive-work item ${itemId} requires at least one assigned person.`,
            featureIds: Object.freeze([itemId]),
          }),
        );
      }
    }
  }

  // Check parallel group concurrency conflicts (M5):
  // A person on two positive-point members of a bucket is a conflict.
  for (const group of parallelGroups) {
    const personToItems = new Map<string, string[]>();
    for (const itemId of group.featureIds) {
      const pts = estimates[itemId];
      if (typeof pts !== 'number' || pts <= 0) continue;
      const assigned = assignmentRecord[itemId];
      if (!Array.isArray(assigned)) continue;
      for (const pid of assigned) {
        if (typeof pid !== 'string') continue;
        let list = personToItems.get(pid);
        if (!list) {
          list = [];
          personToItems.set(pid, list);
        }
        if (!list.includes(itemId)) {
          list.push(itemId);
        }
      }
    }

    for (const [pid, itemIds] of personToItems.entries()) {
      if (itemIds.length >= 2) {
        issues.push(
          Object.freeze({
            code: 'CONCURRENT_ASSIGNMENT_CONFLICT',
            field: 'assignments',
            message: `Person ${pid} is assigned to multiple positive-point items in the same parallel bucket: ${itemIds.join(', ')}.`,
            featureIds: Object.freeze([...itemIds]),
            personIds: Object.freeze([pid]),
          }),
        );
      }
    }
  }

  return Object.freeze(issues);
}

export function assertForecastPlanIdentity(plan: Readonly<{ projectId: string }>): void {
  assertUuidV7(plan.projectId, 'ForecastPlan.projectId must be a valid UUIDv7');
}
