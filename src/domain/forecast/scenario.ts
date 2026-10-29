/**
 * Historical trade-off scenario contracts (Story 20.3, AD-22, §6, FR-16).
 *
 * A saved scenario is a workflow assertion: "compare these baseline input
 * facts with this explicit variation." The baseline captures ordered scope,
 * configuration, parallel groups, and the blocked set *at one authoritative
 * revision*, plus an immutable fact map over the union of baseline and
 * variant Feature IDs. Both baseline and variant normalize using these
 * historical facts only — never the live graph. Later live changes mark the
 * baseline historical; they never silently rebase it.
 *
 * The allowed patch is exactly one optional final `orderedScope` (expressing
 * scope and/or priority in one array — never a competing reorder field),
 * per-Feature point overrides, and shared capacity. Parallel / start /
 * cadence / blocker overrides are outside MVP; the stored baseline still
 * carries those inputs so results remain reproducible.
 */

import {
  FORECAST_POLICY_VERSION,
  STAFFED_FORECAST_POLICY_VERSION,
  DEFAULT_FORECAST_NODE_LEVEL,
  type ForecastConfiguration,
  type ForecastParallelGroup,
  type ForecastPolicyVersion,
  type ForecastNodeLevel,
  type ForecastPerson,
  type ForecastPlan,
} from './forecast-plan.entity';
import {
  canonicalizeForecast,
  computeForecastFingerprint,
  sortIdsLexically,
} from './forecast-canonical';
import { isValidStaffingWeightUnits } from './forecast-validators';

/**
 * One captured historical fact about a node (or referenced node) needed to
 * validate and evaluate a scenario without consulting the live graph.
 *
 * Story 21.9 (FR-16): the fact records the node's ACTUAL type at capture
 * time (`nodeType`), replacing the Feature-only `isFeature` boolean — so a
 * scenario captured at Theme or Component level evaluates and diffs
 * correctly. Legacy facts (saved before Epic 21) carry `isFeature` and are
 * normalized on read: `isFeature: true` → `nodeType: 'Feature'`,
 * `isFeature: false` → `nodeType: 'Theme'` (a non-Feature type, so the
 * Feature-level `NOT_A_FEATURE` behavior is preserved byte-identically).
 */
export type ScenarioFeatureFact = Readonly<{
  /** Explicit `Node.effortPoints` at capture time (null = unknown). */
  effortPoints: number | null;
  /** The node's actual type at capture time (Epic 21, Story 21.9). */
  nodeType: string;
  /** The project the node belonged to at capture time. */
  projectId: string;
  /**
   * Ancestor node IDs (nearest first) at capture time, used for the OQ-7
   * parent/descendant overlap check without walking the live tree.
   */
  ancestorIds: readonly string[];
}>;

export type ForecastScenarioBaseline = Readonly<{
  projectId: string;
  /** The authoritative revision every captured fact came from. */
  baselineRevision: number;
  policyVersion: ForecastPolicyVersion;
  /** The node hierarchy level the baseline was captured at (Epic 21, Story 21.9). */
  planningLevel: ForecastNodeLevel;
  orderedScope: readonly string[];
  configuration: ForecastConfiguration;
  parallelGroups: readonly ForecastParallelGroup[];
  blockedFeatureIds: readonly string[];
  /** Union of baseline + variant scope IDs → their captured facts. */
  factMap: Readonly<Record<string, ScenarioFeatureFact>>;
  /** Captured project roster for staffed forecasting (Story 23.1, SF-FR15). */
  roster?: readonly ForecastPerson[];
  /** Captured per-item assignments for staffed forecasting (Story 23.1, SF-FR15). */
  assignments?: Readonly<Record<string, readonly string[]>>;
}>;

/**
 * A saved scenario as a durable project workflow fact (Story 20.4). Stores
 * inputs only — never a computed `ForecastResult`. Reproduces from these
 * stored facts without consulting current nodes (AD-22, §6).
 */
export type PersistedForecastScenario = Readonly<{
  scenarioId: string;
  projectId: string;
  label: string;
  /** The revision every captured baseline fact came from. */
  baselineRevision: number;
  /** Material fingerprint of the live forecast at capture time (provenance). */
  baselineFingerprint: string;
  policyVersion: ForecastPolicyVersion;
  createdAtISO: string;
  baseline: Omit<ForecastScenarioBaseline, 'projectId' | 'baselineRevision' | 'policyVersion'>;
  patch: ForecastScenarioPatch;
}>;

export type ForecastScenarioPatch = Readonly<{
  /**
   * The single scope/order field. Absent → the baseline order is used.
   * Present → this is the complete final ordered scope (may add, remove, or
   * reorder). Members must all be captured in the baseline fact map.
   */
  orderedScope?: readonly string[];
  /** Point overrides by *included* Feature ID; never writes Node.effortPoints. */
  pointOverrides?: Readonly<Record<string, number>>;
  /** Shared capacity override (points per sprint). */
  pointsPerSprint?: number;
  /**
   * Pacing-mode override (Story 26.4, FC-FR4): the variant evaluates under the
   * chosen policy instead of the captured one. A switch to staffed mode with
   * no captured assignments yields the normal missing-assignment result.
   */
  policyVersion?: ForecastPolicyVersion;
  /**
   * Full parallel-group override for the variant (Story 26.4, FC-FR4): the
   * "run together" lever groups adjacent items. Absent → the resolved
   * baseline groups are used.
   */
  parallelGroups?: readonly ForecastParallelGroup[];
  /** Per-person weight overrides by captured person ID (positive safe-integer hundredths, the live range). (Story 23.2, 23.9, SF-FR16) */
  weightOverrides?: Readonly<Record<string, number>>;
  /** Per-item assigned person IDs override by selected item ID. Empty array clears. (Story 23.2, SF-FR16) */
  assignmentOverrides?: Readonly<Record<string, readonly string[]>>;
}>;

export type ScenarioAssignmentCleanup = Readonly<{
  featureId: string;
  removedPersonIds: readonly string[];
  reason: 'scope-removed' | 'zero-work';
}>;

export type ScenarioEvaluationIssue =
  | Readonly<{ code: 'DUPLICATE_SCOPE_MEMBER'; featureId: string }>
  | Readonly<{ code: 'CROSS_PROJECT_MEMBER'; featureId: string }>
  | Readonly<{ code: 'NOT_A_FEATURE'; featureId: string }>
  | Readonly<{ code: 'OVERLAPPING_SCOPE'; featureIds: readonly string[] }>
  | Readonly<{ code: 'OVERRIDE_FOR_EXCLUDED_MEMBER'; featureId: string }>
  | Readonly<{ code: 'INVALID_POINT_OVERRIDE'; featureId: string }>
  | Readonly<{ code: 'INVALID_CAPACITY_OVERRIDE' }>
  | Readonly<{ code: 'ORDER_SPLITS_RETAINED_GROUP'; featureIds: readonly string[] }>
  | Readonly<{ code: 'UNCAPTURED_FEATURE'; featureId: string }>
  | Readonly<{ code: 'UNSUPPORTED_FORECAST_POLICY'; policyVersion: string }>
  | Readonly<{ code: 'ASSIGNMENT_PERSON_NOT_IN_ROSTER'; personId: string; featureId?: string }>
  | Readonly<{ code: 'DUPLICATE_ITEM_ASSIGNMENT'; featureId: string; personId?: string }>
  | Readonly<{ code: 'ASSIGNMENT_TO_ZERO_WORK'; featureId: string }>
  | Readonly<{ code: 'INVALID_WEIGHT_OVERRIDE'; personId: string }>
  | Readonly<{ code: 'WEIGHT_OVERRIDE_FOR_UNKNOWN_PERSON'; personId: string }>
  | Readonly<{ code: 'STAFFING_DATA_IN_SHARED_POLICY'; message?: string }>
  | Readonly<{ code: 'PARALLEL_GROUP_MEMBER_EXCLUDED'; featureId: string }>
  | Readonly<{ code: 'UNSUPPORTED_SCENARIO_LEVER'; lever?: string; message?: string }>;

export type ScenarioValidationIssue = Readonly<{
  code:
    | 'UNSUPPORTED_FORECAST_POLICY'
    | 'DUPLICATE_ROSTER_PERSON_ID'
    | 'INVALID_PERSON_WEIGHT'
    | 'INVALID_PERSON_NAME'
    | 'INVALID_PERSON_ID'
    | 'ASSIGNMENT_PERSON_NOT_IN_ROSTER'
    | 'DUPLICATE_ITEM_ASSIGNMENT'
    | 'ASSIGNMENT_ITEM_NOT_CAPTURED'
    | 'STAFFING_DATA_IN_SHARED_POLICY'
    | 'MISSING_STAFFING_DATA'
    | 'INVALID_SCENARIO_SHAPE'
    | 'INVALID_BASELINE_SHAPE'
    | 'INVALID_SCOPE'
    | 'INVALID_CONFIG'
    | 'INVALID_FACT_MAP'
    | 'PROJECT_ID_MISMATCH'
    | 'DUPLICATE_SCOPE_MEMBER'
    | 'INVALID_PARALLEL_GROUP'
    | 'INVALID_PATCH_SHAPE'
    | 'WEIGHT_OVERRIDE_FOR_UNKNOWN_PERSON'
    | 'ASSIGNMENT_TO_ZERO_WORK'
    | 'UNSUPPORTED_SCENARIO_LEVER';
  message: string;
  field?: string;
  personIds?: readonly string[];
  featureIds?: readonly string[];
  policyVersion?: string;
}>;

const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

const exactKeys = (v: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(v).every((key) => allowed.includes(key));

const nullableSafe = (v: unknown, min: number): boolean =>
  v === null || (Number.isSafeInteger(v) && Number(v) >= min);

/** Validate baseline contracts strictly, returning actionable structured issues (Story 23.1, AC 23.1-4). */
export function validateForecastScenarioBaseline(
  value: unknown,
  policyVersion?: string,
  projectId?: string,
): readonly ScenarioValidationIssue[] {
  const issues: ScenarioValidationIssue[] = [];

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return Object.freeze([
      Object.freeze({
        code: 'INVALID_BASELINE_SHAPE',
        message: 'Scenario baseline must be an object.',
      }),
    ]);
  }

  const b = value as Record<string, unknown>;
  const effectivePolicy = policyVersion ?? (b.policyVersion as string | undefined);

  if (
    effectivePolicy !== FORECAST_POLICY_VERSION &&
    effectivePolicy !== STAFFED_FORECAST_POLICY_VERSION
  ) {
    issues.push(
      Object.freeze({
        code: 'UNSUPPORTED_FORECAST_POLICY',
        message: `Unsupported forecast policy version: ${effectivePolicy}`,
        policyVersion: typeof effectivePolicy === 'string' ? effectivePolicy : undefined,
      }),
    );
  }

  const allowedBaselineKeys =
    effectivePolicy === STAFFED_FORECAST_POLICY_VERSION
      ? [
          'orderedScope',
          'configuration',
          'parallelGroups',
          'blockedFeatureIds',
          'factMap',
          'planningLevel',
          'roster',
          'assignments',
          'projectId',
          'baselineRevision',
          'policyVersion',
        ]
      : [
          'orderedScope',
          'configuration',
          'parallelGroups',
          'blockedFeatureIds',
          'factMap',
          'planningLevel',
          'projectId',
          'baselineRevision',
          'policyVersion',
        ];

  if (!exactKeys(b, allowedBaselineKeys)) {
    if (
      effectivePolicy === FORECAST_POLICY_VERSION &&
      (b.roster !== undefined || b.assignments !== undefined)
    ) {
      issues.push(
        Object.freeze({
          code: 'STAFFING_DATA_IN_SHARED_POLICY',
          message: 'Staffing roster and assignments are not permitted in shared-capacity-v1 baseline.',
        }),
      );
    } else {
      issues.push(
        Object.freeze({
          code: 'INVALID_BASELINE_SHAPE',
          message: 'Scenario baseline contains unrecognized or invalid keys.',
        }),
      );
    }
  } else if (
    effectivePolicy === FORECAST_POLICY_VERSION &&
    (b.roster !== undefined || b.assignments !== undefined)
  ) {
    issues.push(
      Object.freeze({
        code: 'STAFFING_DATA_IN_SHARED_POLICY',
        message: 'Staffing roster and assignments are not permitted in shared-capacity-v1 baseline.',
      }),
    );
  }

  if (
    b.planningLevel !== undefined &&
    b.planningLevel !== 'Theme' &&
    b.planningLevel !== 'Component' &&
    b.planningLevel !== 'Feature'
  ) {
    issues.push(
      Object.freeze({
        code: 'INVALID_BASELINE_SHAPE',
        message: `Invalid planningLevel: ${String(b.planningLevel)}. Must be Theme, Component, or Feature.`,
      }),
    );
  }

  const seenScope = new Set<string>();
  if (!Array.isArray(b.orderedScope)) {
    issues.push(
      Object.freeze({
        code: 'INVALID_SCOPE',
        message: 'orderedScope must be an array of UUIDv7 strings.',
      }),
    );
  } else {
    for (const id of b.orderedScope) {
      if (!uuid(id)) {
        issues.push(
          Object.freeze({
            code: 'INVALID_SCOPE',
            message: `Scope member ${String(id)} is not a valid UUIDv7.`,
            featureIds: typeof id === 'string' ? Object.freeze([id]) : undefined,
          }),
        );
      } else if (seenScope.has(id)) {
        issues.push(
          Object.freeze({
            code: 'DUPLICATE_SCOPE_MEMBER',
            message: `Duplicate scope member in orderedScope: ${id}`,
            featureIds: Object.freeze([id]),
          }),
        );
      } else {
        seenScope.add(id);
      }
    }
  }

  if (!Array.isArray(b.blockedFeatureIds)) {
    issues.push(
      Object.freeze({
        code: 'INVALID_SCOPE',
        message: 'blockedFeatureIds must be an array.',
      }),
    );
  } else {
    for (const id of b.blockedFeatureIds) {
      if (!uuid(id) || !seenScope.has(id)) {
        issues.push(
          Object.freeze({
            code: 'INVALID_SCOPE',
            message: `Blocked feature ID ${String(id)} must be a valid UUIDv7 contained in orderedScope.`,
            featureIds: typeof id === 'string' ? Object.freeze([id]) : undefined,
          }),
        );
      }
    }
  }

  if (!Array.isArray(b.parallelGroups)) {
    issues.push(
      Object.freeze({
        code: 'INVALID_PARALLEL_GROUP',
        message: 'parallelGroups must be an array.',
      }),
    );
  } else {
    for (const group of b.parallelGroups) {
      if (typeof group !== 'object' || group === null || Array.isArray(group)) {
        issues.push(
          Object.freeze({
            code: 'INVALID_PARALLEL_GROUP',
            message: 'Each parallel group must be an object with featureIds array.',
          }),
        );
        continue;
      }
      const g = group as Record<string, unknown>;
      if (
        !exactKeys(g, ['featureIds']) ||
        !Array.isArray(g.featureIds) ||
        g.featureIds.length < 2 ||
        g.featureIds.some((id) => !uuid(id) || !seenScope.has(id))
      ) {
        issues.push(
          Object.freeze({
            code: 'INVALID_PARALLEL_GROUP',
            message: 'Parallel group featureIds must have >= 2 unique IDs from orderedScope.',
          }),
        );
      }
    }
  }

  if (typeof b.configuration !== 'object' || b.configuration === null || Array.isArray(b.configuration)) {
    issues.push(
      Object.freeze({
        code: 'INVALID_CONFIG',
        message: 'configuration must be an object.',
      }),
    );
  } else {
    const c = b.configuration as Record<string, unknown>;
    if (
      !exactKeys(c, ['pointsPerSprint', 'sprintLengthDays', 'cadence', 'startSprintOrdinal', 'startDate']) ||
      c.cadence !== 'fixed-contiguous'
    ) {
      issues.push(
        Object.freeze({
          code: 'INVALID_CONFIG',
          message: 'configuration keys or cadence invalid.',
        }),
      );
    }
    if (
      !nullableSafe(c.pointsPerSprint, 0) ||
      !nullableSafe(c.sprintLengthDays, 1) ||
      !nullableSafe(c.startSprintOrdinal, 1)
    ) {
      issues.push(
        Object.freeze({
          code: 'INVALID_CONFIG',
          message: 'pointsPerSprint, sprintLengthDays, or startSprintOrdinal is invalid.',
        }),
      );
    }
    if (!(c.startDate === null || (typeof c.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.startDate)))) {
      issues.push(
        Object.freeze({
          code: 'INVALID_CONFIG',
          message: 'startDate must be null or YYYY-MM-DD.',
        }),
      );
    }
  }

  const factKeys = new Set<string>();
  if (typeof b.factMap !== 'object' || b.factMap === null || Array.isArray(b.factMap)) {
    issues.push(
      Object.freeze({
        code: 'INVALID_FACT_MAP',
        message: 'factMap must be an object.',
      }),
    );
  } else {
    for (const [id, rawFact] of Object.entries(b.factMap as Record<string, unknown>)) {
      if (!uuid(id)) {
        issues.push(
          Object.freeze({
            code: 'INVALID_FACT_MAP',
            message: `factMap key ${id} is not a valid UUIDv7.`,
            featureIds: Object.freeze([id]),
          }),
        );
      } else {
        factKeys.add(id);
      }
      if (typeof rawFact !== 'object' || rawFact === null || Array.isArray(rawFact)) {
        issues.push(
          Object.freeze({
            code: 'INVALID_FACT_MAP',
            message: `factMap fact for ${id} is not an object.`,
            featureIds: Object.freeze([id]),
          }),
        );
        continue;
      }
      const fact = rawFact as Record<string, unknown>;
      const legacyFact = exactKeys(fact, ['effortPoints', 'isFeature', 'projectId', 'ancestorIds']);
      const newFact = exactKeys(fact, ['effortPoints', 'nodeType', 'projectId', 'ancestorIds']);
      if (!legacyFact && !newFact) {
        issues.push(
          Object.freeze({
            code: 'INVALID_FACT_MAP',
            message: `factMap fact for ${id} has invalid keys.`,
            featureIds: Object.freeze([id]),
          }),
        );
      }
      if (!nullableSafe(fact.effortPoints, 0)) {
        issues.push(
          Object.freeze({
            code: 'INVALID_FACT_MAP',
            message: `effortPoints for ${id} must be null or non-negative safe integer.`,
            featureIds: Object.freeze([id]),
          }),
        );
      }
      if (legacyFact && typeof fact.isFeature !== 'boolean') {
        issues.push(
          Object.freeze({
            code: 'INVALID_FACT_MAP',
            message: `isFeature for ${id} must be boolean.`,
            featureIds: Object.freeze([id]),
          }),
        );
      }
      if (newFact && typeof fact.nodeType !== 'string') {
        issues.push(
          Object.freeze({
            code: 'INVALID_FACT_MAP',
            message: `nodeType for ${id} must be string.`,
            featureIds: Object.freeze([id]),
          }),
        );
      }
      if (typeof fact.projectId !== 'string') {
        issues.push(
          Object.freeze({
            code: 'INVALID_FACT_MAP',
            message: `projectId for ${id} must be string.`,
            featureIds: Object.freeze([id]),
          }),
        );
      } else if (projectId !== undefined && fact.projectId !== projectId) {
        issues.push(
          Object.freeze({
            code: 'PROJECT_ID_MISMATCH',
            message: `fact ${id} projectId ${fact.projectId} does not match expected ${projectId}.`,
            featureIds: Object.freeze([id]),
          }),
        );
      }
      if (!Array.isArray(fact.ancestorIds) || fact.ancestorIds.some((ancId) => !uuid(ancId))) {
        issues.push(
          Object.freeze({
            code: 'INVALID_FACT_MAP',
            message: `ancestorIds for ${id} must be array of UUIDv7 strings.`,
            featureIds: Object.freeze([id]),
          }),
        );
      }
    }
  }

  if (effectivePolicy === STAFFED_FORECAST_POLICY_VERSION) {
    const seenRosterIds = new Set<string>();

    if (b.roster === undefined || !Array.isArray(b.roster)) {
      issues.push(
        Object.freeze({
          code: 'MISSING_STAFFING_DATA',
          message: 'Staffed baseline must contain a roster array.',
        }),
      );
    } else {
      for (let i = 0; i < b.roster.length; i++) {
        const p = b.roster[i];
        if (typeof p !== 'object' || p === null || Array.isArray(p)) {
          issues.push(
            Object.freeze({
              code: 'INVALID_PERSON_ID',
              message: `Roster member at index ${i} is not an object.`,
            }),
          );
          continue;
        }
        const person = p as Record<string, unknown>;
        if (!exactKeys(person, ['id', 'name', 'weightUnits'])) {
          issues.push(
            Object.freeze({
              code: 'INVALID_PERSON_ID',
              message: `Roster member at index ${i} has invalid keys.`,
            }),
          );
        }
        const pid = person.id;
        if (!uuid(pid)) {
          issues.push(
            Object.freeze({
              code: 'INVALID_PERSON_ID',
              message: `Person ID ${String(pid)} is not a valid UUIDv7.`,
              personIds: typeof pid === 'string' ? Object.freeze([pid]) : undefined,
            }),
          );
        } else if (seenRosterIds.has(pid)) {
          issues.push(
            Object.freeze({
              code: 'DUPLICATE_ROSTER_PERSON_ID',
              message: `Duplicate person ID in roster: ${pid}`,
              personIds: Object.freeze([pid]),
            }),
          );
        } else {
          seenRosterIds.add(pid);
        }

        if (typeof person.name !== 'string' || person.name.trim().length === 0) {
          issues.push(
            Object.freeze({
              code: 'INVALID_PERSON_NAME',
              message: `Person ${String(pid)} name must be a non-empty string.`,
              personIds: typeof pid === 'string' ? Object.freeze([pid]) : undefined,
            }),
          );
        }

        if (!isValidStaffingWeightUnits(person.weightUnits)) {
          issues.push(
            Object.freeze({
              code: 'INVALID_PERSON_WEIGHT',
              message: `Person ${String(pid)} weightUnits must be a positive safe integer.`,
              personIds: typeof pid === 'string' ? Object.freeze([pid]) : undefined,
            }),
          );
        }
      }
    }

    if (
      b.assignments === undefined ||
      typeof b.assignments !== 'object' ||
      b.assignments === null ||
      Array.isArray(b.assignments)
    ) {
      issues.push(
        Object.freeze({
          code: 'MISSING_STAFFING_DATA',
          message: 'Staffed baseline must contain an assignments record.',
        }),
      );
    } else {
      const assignments = b.assignments as Record<string, unknown>;
      for (const [itemId, personList] of Object.entries(assignments)) {
        if (!uuid(itemId)) {
          issues.push(
            Object.freeze({
              code: 'INVALID_SCOPE',
              message: `Assignment key ${itemId} is not a valid UUIDv7.`,
              featureIds: Object.freeze([itemId]),
            }),
          );
        }
        if (!Array.isArray(personList)) {
          issues.push(
            Object.freeze({
              code: 'INVALID_BASELINE_SHAPE',
              message: `Assignments for ${itemId} must be an array of person IDs.`,
              featureIds: Object.freeze([itemId]),
            }),
          );
          continue;
        }
        const seenPersonsOnItem = new Set<string>();
        for (const pid of personList) {
          if (!uuid(pid)) {
            issues.push(
              Object.freeze({
                code: 'INVALID_PERSON_ID',
                message: `Assigned person ID ${String(pid)} on item ${itemId} is not a valid UUIDv7.`,
                personIds: typeof pid === 'string' ? Object.freeze([pid]) : undefined,
                featureIds: Object.freeze([itemId]),
              }),
            );
          } else if (seenPersonsOnItem.has(pid)) {
            issues.push(
              Object.freeze({
                code: 'DUPLICATE_ITEM_ASSIGNMENT',
                message: `Person ${pid} is assigned multiple times to item ${itemId}.`,
                personIds: Object.freeze([pid]),
                featureIds: Object.freeze([itemId]),
              }),
            );
          } else {
            seenPersonsOnItem.add(pid);
          }

          if (typeof pid === 'string' && uuid(pid) && !seenRosterIds.has(pid)) {
            issues.push(
              Object.freeze({
                code: 'ASSIGNMENT_PERSON_NOT_IN_ROSTER',
                message: `Assigned person ${pid} is not in the captured roster.`,
                personIds: Object.freeze([pid]),
                featureIds: Object.freeze([itemId]),
              }),
            );
          }
        }
        if (factKeys.size > 0 && !factKeys.has(itemId)) {
          issues.push(
            Object.freeze({
              code: 'ASSIGNMENT_ITEM_NOT_CAPTURED',
              message: `Assigned item ${itemId} is not captured in the baseline fact map.`,
              featureIds: Object.freeze([itemId]),
            }),
          );
        } else if (factKeys.has(itemId)) {
          const itemFact = (b.factMap as Record<string, ScenarioFeatureFact> | undefined)?.[itemId];
          if (itemFact && itemFact.effortPoints === 0 && personList.length > 0) {
            issues.push(
              Object.freeze({
                code: 'ASSIGNMENT_TO_ZERO_WORK',
                message: `Cannot assign people to zero-effort item ${itemId} in baseline.`,
                featureIds: Object.freeze([itemId]),
              }),
            );
          }
        }
      }
    }
  }

  return Object.freeze(issues);
}

/** Validate persisted forecast scenario strictly (Story 23.1, AC 23.1-4). */
export function validatePersistedForecastScenario(
  value: unknown,
  projectId?: string,
): readonly ScenarioValidationIssue[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return Object.freeze([
      Object.freeze({
        code: 'INVALID_SCENARIO_SHAPE',
        message: 'Scenario must be an object.',
      }),
    ]);
  }

  const issues: ScenarioValidationIssue[] = [];
  const s = value as Record<string, unknown>;

  if (
    !exactKeys(s, [
      'scenarioId',
      'projectId',
      'label',
      'baselineRevision',
      'baselineFingerprint',
      'policyVersion',
      'createdAtISO',
      'baseline',
      'patch',
    ])
  ) {
    issues.push(
      Object.freeze({
        code: 'INVALID_SCENARIO_SHAPE',
        message: 'Scenario contains unrecognized or missing top-level keys.',
      }),
    );
  }

  if (!uuid(s.scenarioId)) {
    issues.push(
      Object.freeze({
        code: 'INVALID_SCENARIO_SHAPE',
        message: 'scenarioId must be a valid UUIDv7.',
      }),
    );
  }

  if (!uuid(s.projectId)) {
    issues.push(
      Object.freeze({
        code: 'INVALID_SCENARIO_SHAPE',
        message: 'projectId must be a valid UUIDv7.',
      }),
    );
  } else if (projectId !== undefined && s.projectId !== projectId) {
    issues.push(
      Object.freeze({
        code: 'PROJECT_ID_MISMATCH',
        message: `Scenario projectId ${String(s.projectId)} does not match expected ${projectId}.`,
      }),
    );
  }

  if (typeof s.label !== 'string' || s.label.trim().length === 0) {
    issues.push(
      Object.freeze({
        code: 'INVALID_SCENARIO_SHAPE',
        message: 'label must be a non-empty string.',
      }),
    );
  }

  if (!Number.isSafeInteger(s.baselineRevision) || Number(s.baselineRevision) < 0) {
    issues.push(
      Object.freeze({
        code: 'INVALID_SCENARIO_SHAPE',
        message: 'baselineRevision must be a non-negative safe integer.',
      }),
    );
  }

  if (typeof s.baselineFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(s.baselineFingerprint)) {
    issues.push(
      Object.freeze({
        code: 'INVALID_SCENARIO_SHAPE',
        message: 'baselineFingerprint must be a 64-character lowercase hex string.',
      }),
    );
  }

  if (
    s.policyVersion !== FORECAST_POLICY_VERSION &&
    s.policyVersion !== STAFFED_FORECAST_POLICY_VERSION
  ) {
    issues.push(
      Object.freeze({
        code: 'UNSUPPORTED_FORECAST_POLICY',
        message: `Unsupported policyVersion: ${String(s.policyVersion)}`,
        policyVersion: typeof s.policyVersion === 'string' ? s.policyVersion : undefined,
      }),
    );
  }

  if (typeof s.createdAtISO !== 'string' || Number.isNaN(Date.parse(s.createdAtISO))) {
    issues.push(
      Object.freeze({
        code: 'INVALID_SCENARIO_SHAPE',
        message: 'createdAtISO must be a valid ISO date-time string.',
      }),
    );
  }

  if (typeof s.patch !== 'object' || s.patch === null || Array.isArray(s.patch)) {
    issues.push(
      Object.freeze({
        code: 'INVALID_PATCH_SHAPE',
        message: 'patch must be an object.',
      }),
    );
  } else {
    const p = s.patch as Record<string, unknown>;
    const allowedPatchKeys = [
      'orderedScope',
      'pointOverrides',
      'pointsPerSprint',
      'policyVersion',
      'parallelGroups',
      'weightOverrides',
      'assignmentOverrides',
    ];

    if (!exactKeys(p, allowedPatchKeys)) {
      issues.push(
        Object.freeze({
          code: 'INVALID_PATCH_SHAPE',
          message: 'patch contains unrecognized keys.',
        }),
      );
    }
    if (
      p.policyVersion !== undefined &&
      p.policyVersion !== FORECAST_POLICY_VERSION &&
      p.policyVersion !== STAFFED_FORECAST_POLICY_VERSION
    ) {
      issues.push(
        Object.freeze({
          code: 'UNSUPPORTED_FORECAST_POLICY',
          message: 'patch.policyVersion must be a supported policy version.',
        }),
      );
    }
    if (p.parallelGroups !== undefined && !Array.isArray(p.parallelGroups)) {
      issues.push(
        Object.freeze({
          code: 'INVALID_PATCH_SHAPE',
          message: 'patch.parallelGroups must be an array of groups.',
        }),
      );
    }
    // Staffing overrides require the variant to be evaluated in assigned-people
    // mode — either the captured policy or the patch's policy lever (26.4).
    const variantPolicy =
      p.policyVersion === STAFFED_FORECAST_POLICY_VERSION ||
      (p.policyVersion === undefined && s.policyVersion === STAFFED_FORECAST_POLICY_VERSION)
        ? STAFFED_FORECAST_POLICY_VERSION
        : FORECAST_POLICY_VERSION;
    if (
      variantPolicy !== STAFFED_FORECAST_POLICY_VERSION &&
      (p.weightOverrides !== undefined || p.assignmentOverrides !== undefined)
    ) {
      issues.push(
        Object.freeze({
          code: 'STAFFING_DATA_IN_SHARED_POLICY',
          message: 'Staffing weightOverrides and assignmentOverrides require assigned-people mode.',
        }),
      );
    }
    if (p.orderedScope !== undefined && (!Array.isArray(p.orderedScope) || p.orderedScope.some((id) => !uuid(id)))) {
      issues.push(
        Object.freeze({
          code: 'INVALID_PATCH_SHAPE',
          message: 'patch.orderedScope must be an array of UUIDv7 strings.',
        }),
      );
    }
    if (p.pointsPerSprint !== undefined && !nullableSafe(p.pointsPerSprint, 0)) {
      issues.push(
        Object.freeze({
          code: 'INVALID_PATCH_SHAPE',
          message: 'patch.pointsPerSprint must be null or non-negative safe integer.',
        }),
      );
    }
    if (p.pointOverrides !== undefined) {
      if (typeof p.pointOverrides !== 'object' || p.pointOverrides === null || Array.isArray(p.pointOverrides)) {
        issues.push(
          Object.freeze({
            code: 'INVALID_PATCH_SHAPE',
            message: 'patch.pointOverrides must be an object.',
          }),
        );
      } else {
        for (const [id, points] of Object.entries(p.pointOverrides as Record<string, unknown>)) {
          if (!uuid(id) || !nullableSafe(points, 0)) {
            issues.push(
              Object.freeze({
                code: 'INVALID_PATCH_SHAPE',
                message: `patch.pointOverrides for ${id} must be non-negative safe integer.`,
                featureIds: Object.freeze([id]),
              }),
            );
          }
        }
      }
    }
    const rosterPersonIds = new Set<string>();
    if (s.baseline && typeof s.baseline === 'object' && Array.isArray((s.baseline as { roster?: unknown[] }).roster)) {
      for (const person of (s.baseline as { roster: unknown[] }).roster) {
        if (typeof person === 'object' && person !== null && typeof (person as { id?: unknown }).id === 'string') {
          rosterPersonIds.add((person as { id: string }).id);
        }
      }
    }
    const baselineFactMap = (s.baseline && typeof s.baseline === 'object' && (s.baseline as { factMap?: Record<string, unknown> }).factMap)
      ? (s.baseline as { factMap: Record<string, ScenarioFeatureFact> }).factMap
      : undefined;
    const baselineFactKeys = new Set(baselineFactMap ? Object.keys(baselineFactMap) : []);

    if (p.weightOverrides !== undefined) {
      if (typeof p.weightOverrides !== 'object' || p.weightOverrides === null || Array.isArray(p.weightOverrides)) {
        issues.push(
          Object.freeze({
            code: 'INVALID_PATCH_SHAPE',
            message: 'patch.weightOverrides must be an object.',
          }),
        );
      } else {
        for (const [id, weight] of Object.entries(p.weightOverrides as Record<string, unknown>)) {
          if (!uuid(id)) {
            issues.push(
              Object.freeze({
                code: 'INVALID_PERSON_ID',
                message: `weightOverride personId ${id} is not a valid UUIDv7.`,
                personIds: Object.freeze([id]),
              }),
            );
          } else if (s.policyVersion === STAFFED_FORECAST_POLICY_VERSION && rosterPersonIds.size > 0 && !rosterPersonIds.has(id)) {
            issues.push(
              Object.freeze({
                code: 'WEIGHT_OVERRIDE_FOR_UNKNOWN_PERSON',
                message: `Person ${id} in patch.weightOverrides is not in the captured roster.`,
                personIds: Object.freeze([id]),
              }),
            );
          }
          if (!isValidStaffingWeightUnits(weight)) {
            issues.push(
              Object.freeze({
                code: 'INVALID_PERSON_WEIGHT',
                message: `patch.weightOverrides for person ${id} must be a positive safe integer number of hundredths.`,
                personIds: Object.freeze([id]),
              }),
            );
          }
        }
      }
    }
    if (p.assignmentOverrides !== undefined) {
      if (typeof p.assignmentOverrides !== 'object' || p.assignmentOverrides === null || Array.isArray(p.assignmentOverrides)) {
        issues.push(
          Object.freeze({
            code: 'INVALID_PATCH_SHAPE',
            message: 'patch.assignmentOverrides must be an object.',
          }),
        );
      } else {
        for (const [id, pids] of Object.entries(p.assignmentOverrides as Record<string, unknown>)) {
          if (!uuid(id)) {
            issues.push(
              Object.freeze({
                code: 'INVALID_SCOPE',
                message: `assignmentOverride featureId ${id} is not a valid UUIDv7.`,
                featureIds: Object.freeze([id]),
              }),
            );
          } else if (baselineFactKeys.size > 0 && !baselineFactKeys.has(id)) {
            issues.push(
              Object.freeze({
                code: 'ASSIGNMENT_ITEM_NOT_CAPTURED',
                message: `Item ${id} in patch.assignmentOverrides is not in the captured fact map.`,
                featureIds: Object.freeze([id]),
              }),
            );
          } else if (baselineFactMap?.[id]?.effortPoints === 0 && Array.isArray(pids) && pids.length > 0) {
            issues.push(
              Object.freeze({
                code: 'ASSIGNMENT_TO_ZERO_WORK',
                message: `Cannot assign people to zero-effort item ${id} in patch.`,
                featureIds: Object.freeze([id]),
              }),
            );
          }
          if (!Array.isArray(pids)) {
            issues.push(
              Object.freeze({
                code: 'INVALID_PATCH_SHAPE',
                message: `patch.assignmentOverrides for feature ${id} must be an array of person IDs.`,
                featureIds: Object.freeze([id]),
              }),
            );
          } else {
            const seenPersons = new Set<string>();
            for (const pid of pids) {
              if (!uuid(pid)) {
                issues.push(
                  Object.freeze({
                    code: 'INVALID_PERSON_ID',
                    message: `Assigned person ID ${String(pid)} in patch.assignmentOverrides for ${id} is not a valid UUIDv7.`,
                    personIds: typeof pid === 'string' ? Object.freeze([pid]) : undefined,
                    featureIds: Object.freeze([id]),
                  }),
                );
              } else if (seenPersons.has(pid)) {
                issues.push(
                  Object.freeze({
                    code: 'DUPLICATE_ITEM_ASSIGNMENT',
                    message: `Person ${pid} is assigned multiple times to item ${id} in patch.`,
                    personIds: Object.freeze([pid]),
                    featureIds: Object.freeze([id]),
                  }),
                );
              } else {
                seenPersons.add(pid);
              }
              if (typeof pid === 'string' && uuid(pid) && s.policyVersion === STAFFED_FORECAST_POLICY_VERSION && rosterPersonIds.size > 0 && !rosterPersonIds.has(pid)) {
                issues.push(
                  Object.freeze({
                    code: 'ASSIGNMENT_PERSON_NOT_IN_ROSTER',
                    message: `Assigned person ${pid} in patch.assignmentOverrides is not in the captured roster.`,
                    personIds: Object.freeze([pid]),
                    featureIds: Object.freeze([id]),
                  }),
                );
              }
            }
          }
        }
      }
    }
  }

  const baselineIssues = validateForecastScenarioBaseline(
    s.baseline,
    s.policyVersion as string | undefined,
    typeof s.projectId === 'string' ? s.projectId : undefined,
  );
  issues.push(...baselineIssues);

  return Object.freeze(issues);
}

/** Strict repository/portable boundary validation for a captured scenario. */
export function isPersistedForecastScenario(value: unknown, projectId?: string): value is PersistedForecastScenario {
  return validatePersistedForecastScenario(value, projectId).length === 0;
}

/**
 * Construct an immutable forecast scenario baseline with full validation (Story 23.1, AC 23.1-1).
 * Captures all facts at the authoritative revision, including idle people whose weights affect rates.
 */
export function createForecastScenarioBaseline(params: {
  projectId: string;
  baselineRevision: number;
  policyVersion?: ForecastPolicyVersion;
  planningLevel?: ForecastNodeLevel;
  orderedScope: readonly string[];
  configuration: ForecastConfiguration;
  parallelGroups?: readonly ForecastParallelGroup[];
  blockedFeatureIds?: readonly string[];
  factMap: Readonly<Record<string, ScenarioFeatureFact>>;
  roster?: readonly ForecastPerson[];
  assignments?: Readonly<Record<string, readonly string[]>>;
}): ForecastScenarioBaseline {
  const policyVersion = params.policyVersion ?? FORECAST_POLICY_VERSION;
  const planningLevel = params.planningLevel ?? DEFAULT_FORECAST_NODE_LEVEL;
  const parallelGroups = Object.freeze(
    (params.parallelGroups ?? []).map((g) =>
      Object.freeze({ featureIds: Object.freeze([...g.featureIds]) }),
    ),
  );
  const blockedFeatureIds = Object.freeze([...(params.blockedFeatureIds ?? [])]);

  const roster = params.roster
    ? Object.freeze(
        params.roster.map((p) =>
          Object.freeze({
            id: p.id,
            name: p.name,
            weightUnits: p.weightUnits,
          }),
        ),
      )
    : undefined;

  let assignments: Record<string, readonly string[]> | undefined = undefined;
  if (params.assignments) {
    // Null prototype so a `__proto__` assignment key round-trips as an own
    // entry, matching the native map (see canonicalizeForecastAssignments).
    const canonicalAssignments: Record<string, readonly string[]> = Object.create(null);
    for (const [itemId, personIds] of Object.entries(params.assignments)) {
      canonicalAssignments[itemId] = Object.freeze(
        [...new Set(personIds)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
      );
    }
    assignments = Object.freeze(canonicalAssignments);
  }

  const baseline: ForecastScenarioBaseline = Object.freeze({
    projectId: params.projectId,
    baselineRevision: params.baselineRevision,
    policyVersion,
    planningLevel,
    orderedScope: Object.freeze([...params.orderedScope]),
    configuration: params.configuration,
    parallelGroups,
    blockedFeatureIds,
    factMap: Object.freeze({ ...params.factMap }),
    ...(roster !== undefined ? { roster } : {}),
    ...(assignments !== undefined ? { assignments } : {}),
  });

  const issues = validateForecastScenarioBaseline(baseline, policyVersion, params.projectId);
  if (issues.length > 0) {
    throw new Error(`INVALID_FORECAST_SCENARIO_BASELINE: ${issues.map((i) => i.code).join(', ')}`);
  }

  return baseline;
}

/**
 * Construct a scenario baseline from a live plan snapshot and captured fact map (Story 23.1, AC 23.1-1).
 * In staffed-capacity-v1, captures the full roster (including idle people) and all assignments.
 */
export function createBaselineFromPlan(
  plan: ForecastPlan,
  revision: number,
  factMap: Readonly<Record<string, ScenarioFeatureFact>>,
): ForecastScenarioBaseline {
  return createForecastScenarioBaseline({
    projectId: plan.projectId,
    baselineRevision: revision,
    policyVersion: plan.policyVersion,
    planningLevel: plan.planningLevel,
    orderedScope: plan.selectedFeatureIds,
    configuration: plan.configuration,
    parallelGroups: plan.parallelGroups,
    blockedFeatureIds: plan.blockedFeatureIds,
    factMap,
    roster: plan.policyVersion === STAFFED_FORECAST_POLICY_VERSION ? plan.roster : undefined,
    assignments: plan.policyVersion === STAFFED_FORECAST_POLICY_VERSION ? plan.assignments : undefined,
  });
}

/** A parallel-group cleanup that the comparison must disclose beside the scope lever. */
export type ScenarioGroupCleanup = Readonly<{
  /** The retained group's members that survive in the variant scope. */
  keptFeatureIds: readonly string[];
  /** The members dropped from the group because they left the variant scope. */
  removedFeatureIds: readonly string[];
  /** True when the group dissolved entirely (fewer than two members remain). */
  dissolved: boolean;
}>;

/**
 * Canonical fingerprint over a baseline + patch, used as the scenario
 * freshness key (Story 20.6). Independent of source array/key order for
 * semantically-unordered collections; ordered scope is preserved exactly.
 *
 * Story 23.1 (AC 23.1-3, SF-AR3): When policyVersion is staffed-capacity-v1,
 * includes full roster weights (including idle people) and item assignments.
 * Display names are non-material. Legacy shared fingerprints remain unchanged.
 */
export async function scenarioFingerprint(
  baseline: ForecastScenarioBaseline,
  patch: ForecastScenarioPatch,
  today?: string | null,
): Promise<string> {
  const factEntries = Object.keys(baseline.factMap)
    .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0))
    .map((id) => [id, baseline.factMap[id]] as const);
  const overrideEntries = Object.keys(patch.pointOverrides ?? {})
    .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0))
    .map((id) => [id, (patch.pointOverrides ?? {})[id]] as const);
  const priority = new Map(baseline.orderedScope.map((id, i) => [id, i]));
  const groups = baseline.parallelGroups
    .map((g) => [...g.featureIds].sort((x, y) => (priority.get(x) ?? 0) - (priority.get(y) ?? 0)))
    .sort((x, y) => (priority.get(x[0]) ?? 0) - (priority.get(y[0]) ?? 0));
  // Story 26.4 levers: a patch that switches policy or supplies groups must
  // change the fingerprint, and the injected date is part of the identity
  // (Story 26.6 AC 26.6-4).
  const patchGroups = patch.parallelGroups
    ? patch.parallelGroups
        .map((g) => [...g.featureIds].sort((x, y) => (priority.get(x) ?? 0) - (priority.get(y) ?? 0)))
        .sort((x, y) => (priority.get(x[0]) ?? 0) - (priority.get(y[0]) ?? 0))
    : null;

  if (baseline.policyVersion === STAFFED_FORECAST_POLICY_VERSION) {
    const canonicalRoster = (baseline.roster ?? [])
      .map((p) => ({ id: p.id, weightUnits: p.weightUnits }))
      .sort((a, b) => (a.id.toLowerCase() < b.id.toLowerCase() ? -1 : a.id.toLowerCase() > b.id.toLowerCase() ? 1 : 0));

    const assignmentEntries = Object.keys(baseline.assignments ?? {})
      .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0))
      .filter((id) => (baseline.assignments?.[id]?.length ?? 0) > 0)
      .map((id) => [id, sortIdsLexically(baseline.assignments![id])] as const);

    const weightOverrideEntries = patch.weightOverrides
      ? Object.keys(patch.weightOverrides)
          .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0))
          .map((id) => [id, patch.weightOverrides![id]] as const)
      : null;

    const assignmentOverrideEntries = patch.assignmentOverrides
      ? Object.keys(patch.assignmentOverrides)
          .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0))
          .map((id) => [id, sortIdsLexically(patch.assignmentOverrides![id])] as const)
      : null;

    return computeForecastFingerprint({
      baselineRevision: baseline.baselineRevision,
      policyVersion: baseline.policyVersion,
      orderedScope: baseline.orderedScope,
      configuration: baseline.configuration,
      parallelGroups: groups,
      blockedFeatureIds: [...baseline.blockedFeatureIds].sort(),
      factMap: factEntries,
      roster: canonicalRoster,
      assignments: assignmentEntries,
      ...(today !== undefined && today !== null ? { today } : {}),
      patch: {
        orderedScope: patch.orderedScope ?? null,
        pointOverrides: overrideEntries,
        pointsPerSprint: patch.pointsPerSprint ?? null,
        weightOverrides: weightOverrideEntries,
        assignmentOverrides: assignmentOverrideEntries,
        // Story 26.4 levers are included only when set, so an ordinary patch's
        // fingerprint stays byte-identical to its pre-26.4 value (AC 23.9-5).
        ...(patch.policyVersion !== undefined ? { policyVersion: patch.policyVersion } : {}),
        ...(patch.parallelGroups !== undefined ? { parallelGroups: patchGroups } : {}),
      },
    });
  }

  return computeForecastFingerprint({
    baselineRevision: baseline.baselineRevision,
    policyVersion: baseline.policyVersion,
    orderedScope: baseline.orderedScope,
    configuration: baseline.configuration,
    parallelGroups: groups,
    blockedFeatureIds: [...baseline.blockedFeatureIds].sort(),
    factMap: factEntries,
    ...(today !== undefined && today !== null ? { today } : {}),
    patch: {
      orderedScope: patch.orderedScope ?? null,
      pointOverrides: overrideEntries,
      pointsPerSprint: patch.pointsPerSprint ?? null,
      ...(patch.policyVersion !== undefined ? { policyVersion: patch.policyVersion } : {}),
      ...(patch.parallelGroups !== undefined ? { parallelGroups: patchGroups } : {}),
    },
  });
}

/**
 * Rebuild the full evaluable baseline from a persisted scenario record.
 *
 * Story 21.9 AC 4: this is the ONE shared normalization point for legacy
 * scenarios (saved before Epic 21) — a missing `planningLevel` defaults to
 * `'Feature'` and each fact's `isFeature` boolean maps forward to `nodeType`
 * (`true` → `'Feature'`, `false` → `'Theme'`). SQLite reads, portable import,
 * and scenario evaluation all go through this reader; there is no migration
 * of `forecast_scenarios.baseline_json` (TEXT, normalized on read).
 *
 * Story 23.1 (AC 23.1-2): Reconstructs captured roster and assignments purely
 * from captured facts; never looks up missing people or live plan data.
 */
export function baselineFromPersisted(scenario: PersistedForecastScenario): ForecastScenarioBaseline {
  const factMap: Record<string, ScenarioFeatureFact> = {};
  for (const [id, fact] of Object.entries(scenario.baseline.factMap)) {
    const legacy = fact as unknown as { isFeature?: boolean; nodeType?: string };
    factMap[id] = Object.freeze({
      effortPoints: fact.effortPoints,
      nodeType: legacy.nodeType ?? (legacy.isFeature === true ? 'Feature' : 'Theme'),
      projectId: fact.projectId,
      ancestorIds: fact.ancestorIds,
    });
  }

  const roster = scenario.baseline.roster
    ? Object.freeze(
        scenario.baseline.roster.map((p) =>
          Object.freeze({
            id: p.id,
            name: p.name,
            weightUnits: p.weightUnits,
          }),
        ),
      )
    : undefined;

  let assignments: Record<string, readonly string[]> | undefined = undefined;
  if (scenario.baseline.assignments) {
    // Null prototype so a `__proto__` assignment key round-trips as an own
    // entry, matching the native map (see canonicalizeForecastAssignments).
    const canonicalAssignments: Record<string, readonly string[]> = Object.create(null);
    for (const [itemId, personIds] of Object.entries(scenario.baseline.assignments)) {
      canonicalAssignments[itemId] = Object.freeze(
        [...new Set(personIds)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
      );
    }
    assignments = Object.freeze(canonicalAssignments);
  }

  return Object.freeze({
    projectId: scenario.projectId,
    baselineRevision: scenario.baselineRevision,
    policyVersion: scenario.policyVersion,
    planningLevel: scenario.baseline.planningLevel ?? 'Feature',
    orderedScope: scenario.baseline.orderedScope,
    configuration: scenario.baseline.configuration,
    parallelGroups: scenario.baseline.parallelGroups,
    blockedFeatureIds: scenario.baseline.blockedFeatureIds,
    factMap: Object.freeze(factMap),
    ...(roster !== undefined ? { roster } : {}),
    ...(assignments !== undefined ? { assignments } : {}),
  });
}

/** Normalize read/export shape without changing saved provenance or patch. */
export function normalizePersistedForecastScenario(scenario: PersistedForecastScenario): PersistedForecastScenario {
  const { projectId: _projectId, baselineRevision: _revision, policyVersion: _policy, ...baseline } = baselineFromPersisted(scenario);
  return Object.freeze({ ...scenario, baseline: Object.freeze(baseline) });
}

/** Deterministic canonical bytes for a baseline+patch (test/oracle use). */
export function scenarioCanonicalBytes(
  baseline: ForecastScenarioBaseline,
  patch: ForecastScenarioPatch,
): string {
  return canonicalizeForecast({ baseline, patch });
}
