/**
 * Pure historical-baseline scenario evaluation (Story 20.3, AD-22, §6).
 *
 * `evaluateScenario` builds baseline and variant `ForecastInputs` entirely
 * from the captured fact map and runs them through the frozen
 * `shared-capacity-v1` calculator plus `compareForecasts`. It performs no
 * writes, consults no live graph fact, and never silently mixes facts from
 * different revisions. Invalid scope / override / group relationships and a
 * reference to an uncaptured Feature return typed issues.
 */

import {
  FORECAST_POLICY_VERSION,
  STAFFED_FORECAST_POLICY_VERSION,
  type ForecastPolicyVersion,
  type ForecastPerson,
} from './forecast-plan.entity';
import type { ForecastInputs, ForecastResult } from './forecast-result';
import type { ReducedRatio } from './forecast-canonical';
import { asOfOffset, isOnOrAfterStart } from './forecast-remaining';
import { calculateForecast } from './whole-set.policy';
import { isValidStaffingWeightUnits } from './forecast-validators';
import { compareForecasts } from './compare.policy';
import type { ForecastComparison } from './compare.policy';
import type {
  ForecastScenarioBaseline,
  ForecastScenarioPatch,
  ScenarioEvaluationIssue,
  ScenarioGroupCleanup,
  ScenarioAssignmentCleanup,
} from './scenario';

export type ScenarioEvaluation =
  | Readonly<{
      ok: true;
      baselineInputs: ForecastInputs;
      variantInputs: ForecastInputs;
      baselineResult: ForecastResult;
      variantResult: ForecastResult;
      comparison: ForecastComparison | null;
      /** Parallel-group cleanups the comparison must disclose beside the scope lever. */
      groupCleanups: readonly ScenarioGroupCleanup[];
      /** Assignment cleanups the comparison must disclose beside the changed lever (Story 23.2). */
      assignmentCleanups: readonly ScenarioAssignmentCleanup[];
    }>
  | Readonly<{ ok: false; issues: readonly ScenarioEvaluationIssue[] }>;

function isSafeNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/** Story 26.6 (AC 26.6-5): the as-of offset for a captured configuration. */
function asOfFor(baseline: ForecastScenarioBaseline, today: string): ReducedRatio {
  return asOfOffset(today, baseline.configuration.startDate, baseline.configuration.sprintLengthDays);
}

/**
 * Story 26.6 (AC 26.6-2/-5): the injected today and its offset, or a null
 * today when the date is before the captured start (so the result reads the
 * same as the live plan, which shows no as-of before the start date).
 */
function asOfFields(baseline: ForecastScenarioBaseline, today: string): { today: string | null; asOfOffset: ReducedRatio } {
  const isAfterStart = isOnOrAfterStart(today, baseline.configuration.startDate);
  return {
    today: isAfterStart ? today : null,
    asOfOffset: asOfFor(baseline, today),
  };
}
function dedupeIssues(issues: readonly ScenarioEvaluationIssue[]): readonly ScenarioEvaluationIssue[] {
  const seen = new Set<string>();
  const out: ScenarioEvaluationIssue[] = [];
  for (const i of issues) {
    const key = JSON.stringify(i);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(i);
  }
  return Object.freeze(out);
}

function buildInputs(params: {
  projectId: string;
  revision: number;
  policyVersion: ForecastPolicyVersion;
  scope: readonly string[];
  estimates: Readonly<Record<string, number | null>>;
  pointsPerSprint: number | null;
  sprintLengthDays: number | null;
  startSprintOrdinal: number | null;
  startDate: string | null;
  parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
  blockedFeatureIds: readonly string[];
  roster?: readonly ForecastPerson[];
  assignments?: Readonly<Record<string, readonly string[]>>;
}): ForecastInputs {
  const scopeSet = new Set(params.scope);
  const estimates: Record<string, number | null> = {};
  for (const id of params.scope) estimates[id] = params.estimates[id] ?? null;
  return Object.freeze({
    projectId: params.projectId,
    projectRevision: params.revision,
    policyVersion: params.policyVersion,
    selectedFeatureIds: Object.freeze([...params.scope]),
    estimates: Object.freeze(estimates),
    pointsPerSprint: params.pointsPerSprint,
    sprintLengthDays: params.sprintLengthDays,
    startSprintOrdinal: params.startSprintOrdinal,
    startDate: params.startDate,
    parallelGroups: Object.freeze(
      params.parallelGroups.map((g) => Object.freeze({ featureIds: Object.freeze([...g.featureIds]) })),
    ),
    blockedFeatureIds: Object.freeze(params.blockedFeatureIds.filter((id) => scopeSet.has(id))),
    ...(params.roster !== undefined ? { roster: params.roster } : {}),
    ...(params.assignments !== undefined ? { assignments: params.assignments } : {}),
  });
}

/**
 * Intersect each baseline group with the variant scope. A group that keeps
 * fewer than two members dissolves (reported). A retained group (>=2 kept)
 * whose members are not contiguous in the variant order splits — that is an
 * issue, never an implicit regroup.
 */
function resolveVariantGroups(
  baselineGroups: readonly Readonly<{ featureIds: readonly string[] }>[],
  variantScope: readonly string[],
): { groups: Readonly<{ featureIds: readonly string[] }>[]; cleanups: ScenarioGroupCleanup[]; issues: ScenarioEvaluationIssue[] } {
  const pos = new Map(variantScope.map((id, i) => [id, i]));
  const groups: Readonly<{ featureIds: readonly string[] }>[] = [];
  const cleanups: ScenarioGroupCleanup[] = [];
  const issues: ScenarioEvaluationIssue[] = [];

  for (const g of baselineGroups) {
    const kept = g.featureIds.filter((id) => pos.has(id));
    const removed = g.featureIds.filter((id) => !pos.has(id));
    if (kept.length < 2) {
      if (removed.length > 0 || kept.length !== g.featureIds.length) {
        cleanups.push(Object.freeze({ keptFeatureIds: Object.freeze(kept), removedFeatureIds: Object.freeze(removed), dissolved: true }));
      }
      continue;
    }
    const ordered = [...kept].sort((a, b) => (pos.get(a) ?? 0) - (pos.get(b) ?? 0));
    const positions = ordered.map((id) => pos.get(id) as number);
    const contiguous = positions.every((p, i) => i === 0 || p === positions[i - 1] + 1);
    if (!contiguous) {
      issues.push(Object.freeze({ code: 'ORDER_SPLITS_RETAINED_GROUP', featureIds: Object.freeze(ordered) }));
      continue;
    }
    groups.push(Object.freeze({ featureIds: Object.freeze(ordered) }));
    if (removed.length > 0) {
      cleanups.push(Object.freeze({ keptFeatureIds: Object.freeze(ordered), removedFeatureIds: Object.freeze(removed), dissolved: false }));
    }
  }
  return { groups, cleanups, issues };
}

export async function evaluateScenario(
  baseline: ForecastScenarioBaseline,
  patch: ForecastScenarioPatch,
  today?: string | null,
): Promise<ScenarioEvaluation> {
  const issues: ScenarioEvaluationIssue[] = [];

  if (
    baseline.policyVersion !== FORECAST_POLICY_VERSION &&
    baseline.policyVersion !== STAFFED_FORECAST_POLICY_VERSION
  ) {
    return Object.freeze({
      ok: false,
      issues: Object.freeze([Object.freeze({ code: 'UNSUPPORTED_FORECAST_POLICY', policyVersion: baseline.policyVersion })]),
    });
  }

  // ── Reject unsupported scenario levers (SF-FR16, AC 23.2-6; Story 26.4) ──
  const allowedPatchKeys = [
    'orderedScope',
    'pointOverrides',
    'pointsPerSprint',
    'policyVersion',
    'parallelGroups',
    'weightOverrides',
    'assignmentOverrides',
  ];

  if (
    patch.policyVersion !== undefined &&
    patch.policyVersion !== FORECAST_POLICY_VERSION &&
    patch.policyVersion !== STAFFED_FORECAST_POLICY_VERSION
  ) {
    issues.push(Object.freeze({ code: 'UNSUPPORTED_FORECAST_POLICY', policyVersion: String(patch.policyVersion) }));
  }

  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (!allowedPatchKeys.includes(key)) {
      issues.push(
        Object.freeze({
          code: 'UNSUPPORTED_SCENARIO_LEVER',
          lever: key,
          message: `Unsupported scenario lever: ${key}`,
        }),
      );
    }
  }
  // Staffing levers remain forbidden when the variant stays on shared mode.
  const variantPolicy = patch.policyVersion ?? baseline.policyVersion;
  if (
    variantPolicy !== STAFFED_FORECAST_POLICY_VERSION &&
    (patch.weightOverrides !== undefined || patch.assignmentOverrides !== undefined)
  ) {
    issues.push(
      Object.freeze({ code: 'STAFFING_DATA_IN_SHARED_POLICY', message: 'Staffing levers require assigned-people mode.' }),
    );
  }

  const variantScope = patch.orderedScope ?? baseline.orderedScope;

  // ── Scope validation against the captured facts only ──────────────────
  const seen = new Set<string>();
  for (const id of variantScope) {
    if (seen.has(id)) {
      issues.push(Object.freeze({ code: 'DUPLICATE_SCOPE_MEMBER', featureId: id }));
      continue;
    }
    seen.add(id);
    const fact = baseline.factMap[id];
    if (!fact) {
      issues.push(Object.freeze({ code: 'UNCAPTURED_FEATURE', featureId: id }));
      continue;
    }
    if (fact.projectId !== baseline.projectId) {
      issues.push(Object.freeze({ code: 'CROSS_PROJECT_MEMBER', featureId: id }));
    }
    // Story 21.9 AC 3: a member whose captured type equals the scenario's
    // captured level is accepted; NOT_A_FEATURE is raised only for a genuine
    // level mismatch (AR-6 keeps the code string).
    if (fact.nodeType !== baseline.planningLevel) {
      issues.push(Object.freeze({ code: 'NOT_A_FEATURE', featureId: id }));
    }
  }

  // Parent/descendant overlap within the variant scope (OQ-7A), from
  // captured ancestor chains — never the live tree.
  const scopeSet = new Set(variantScope);
  for (const id of variantScope) {
    const fact = baseline.factMap[id];
    if (!fact) continue;
    for (const anc of fact.ancestorIds) {
      if (scopeSet.has(anc)) {
        issues.push(Object.freeze({ code: 'OVERLAPPING_SCOPE', featureIds: Object.freeze([id, anc]) }));
        break;
      }
    }
  }

  // ── Point overrides: only for included members; safe non-negative ints ─
  for (const [id, value] of Object.entries(patch.pointOverrides ?? {})) {
    if (!scopeSet.has(id)) {
      issues.push(Object.freeze({ code: 'OVERRIDE_FOR_EXCLUDED_MEMBER', featureId: id }));
      continue;
    }
    if (!isSafeNonNegativeInt(value)) {
      issues.push(Object.freeze({ code: 'INVALID_POINT_OVERRIDE', featureId: id }));
    }
  }

  if (patch.pointsPerSprint !== undefined && !isSafeNonNegativeInt(patch.pointsPerSprint)) {
    issues.push(Object.freeze({ code: 'INVALID_CAPACITY_OVERRIDE' }));
  }

  const { groups: resolvedGroups, cleanups: groupCleanups, issues: groupIssues } = resolveVariantGroups(
    baseline.parallelGroups,
    variantScope,
  );
  issues.push(...groupIssues);

  // Story 26.4 (FC-FR4): the "run together" lever supplies a complete
  // parallel-group override; it must reference variant-scope members and its
  // members must be contiguous in the variant order (same rule as retained
  // groups).
  let variantGroups: readonly Readonly<{ featureIds: readonly string[] }>[] = resolvedGroups;
  if (patch.parallelGroups !== undefined) {
    const pos = new Map(variantScope.map((id, i) => [id, i]));
    const override: Readonly<{ featureIds: readonly string[] }>[] = [];
    for (const group of patch.parallelGroups) {
      for (const id of group.featureIds) {
        if (!scopeSet.has(id)) {
          issues.push(Object.freeze({ code: 'PARALLEL_GROUP_MEMBER_EXCLUDED', featureId: id }));
        }
      }
      const memberPositions = group.featureIds.map((id) => pos.get(id)).filter((p): p is number => p !== undefined);
      const contiguous = memberPositions.every((p, i) => i === 0 || p === memberPositions[i - 1] + 1);
      if (group.featureIds.length >= 2 && contiguous) {
        override.push(Object.freeze({ featureIds: Object.freeze([...group.featureIds]) }));
      } else if (group.featureIds.length >= 2) {
        issues.push(
          Object.freeze({ code: 'ORDER_SPLITS_RETAINED_GROUP', featureIds: Object.freeze([...group.featureIds]) }),
        );
      }
    }
    variantGroups = Object.freeze(override);
  }

  // ── Staffed scenario variants: weights, assignments, cleanups (AC 23.2-1..23.2-4) ──
  const assignmentCleanups: ScenarioAssignmentCleanup[] = [];
  let variantRoster = baseline.roster;
  let variantAssignments = baseline.assignments;

  if (baseline.policyVersion === STAFFED_FORECAST_POLICY_VERSION || variantPolicy === STAFFED_FORECAST_POLICY_VERSION) {
    const roster = baseline.roster ?? [];
    const rosterMap = new Map(roster.map((p) => [p.id, p]));

    // 1. Weight overrides: validate captured people & positive integers
    if (patch.weightOverrides !== undefined) {
      for (const [pid, weight] of Object.entries(patch.weightOverrides)) {
        if (!rosterMap.has(pid)) {
          issues.push(Object.freeze({ code: 'WEIGHT_OVERRIDE_FOR_UNKNOWN_PERSON', personId: pid }));
        }
        if (!isValidStaffingWeightUnits(weight)) {
          issues.push(Object.freeze({ code: 'INVALID_WEIGHT_OVERRIDE', personId: pid }));
        }
      }
      variantRoster = Object.freeze(
        roster.map((p) => {
          const w = patch.weightOverrides?.[p.id];
          if (isValidStaffingWeightUnits(w)) {
            return Object.freeze({
              id: p.id,
              name: p.name,
              weightUnits: w,
            });
          }
          return p;
        }),
      );
    }

    // 2. Assignment inheritance, cleanup, and atomic overrides
    const workingAssignments: Record<string, readonly string[]> = { ...(baseline.assignments ?? {}) };

    // 2a. Scope removal cleanup: if item is no longer in variantScope, remove inherited assignments
    for (const [id, pids] of Object.entries(baseline.assignments ?? {})) {
      if (!scopeSet.has(id)) {
        delete workingAssignments[id];
        if (pids && pids.length > 0) {
          assignmentCleanups.push(
            Object.freeze({
              featureId: id,
              removedPersonIds: Object.freeze([...pids]),
              reason: 'scope-removed',
            }),
          );
        }
      }
    }

    // 2b. Zero-work cleanup & validation: if variant points are 0
    for (const id of variantScope) {
      const overrides = patch.pointOverrides ?? {};
      const pts = id in overrides ? overrides[id] : baseline.factMap[id]?.effortPoints ?? null;
      if (pts === 0) {
        // Explicit nonempty override on zero-work item rejects
        const explicit = patch.assignmentOverrides?.[id];
        if (explicit !== undefined && Array.isArray(explicit) && explicit.length > 0) {
          issues.push(Object.freeze({ code: 'ASSIGNMENT_TO_ZERO_WORK', featureId: id }));
        }
        // Inherited assignments are removed and disclosed
        const prior = workingAssignments[id];
        if (prior && prior.length > 0) {
          delete workingAssignments[id];
          assignmentCleanups.push(
            Object.freeze({
              featureId: id,
              removedPersonIds: Object.freeze([...prior]),
              reason: 'zero-work',
            }),
          );
        }
      }
    }

    // 2c. Apply assignment overrides atomically
    if (patch.assignmentOverrides !== undefined) {
      for (const [id, personList] of Object.entries(patch.assignmentOverrides)) {
        if (!scopeSet.has(id)) {
          issues.push(Object.freeze({ code: 'OVERRIDE_FOR_EXCLUDED_MEMBER', featureId: id }));
          continue;
        }
        if (!Array.isArray(personList)) {
          continue;
        }
        const seenPersons = new Set<string>();
        for (const pid of personList) {
          if (seenPersons.has(pid)) {
            issues.push(Object.freeze({ code: 'DUPLICATE_ITEM_ASSIGNMENT', featureId: id, personId: pid }));
          }
          seenPersons.add(pid);
          if (!rosterMap.has(pid)) {
            issues.push(Object.freeze({ code: 'ASSIGNMENT_PERSON_NOT_IN_ROSTER', personId: pid, featureId: id }));
          }
        }

        const overrides = patch.pointOverrides ?? {};
        const pts = id in overrides ? overrides[id] : baseline.factMap[id]?.effortPoints ?? null;
        if (pts === 0 && personList.length > 0) {
          issues.push(Object.freeze({ code: 'ASSIGNMENT_TO_ZERO_WORK', featureId: id }));
        }

        if (personList.length === 0) {
          delete workingAssignments[id];
        } else {
          workingAssignments[id] = Object.freeze(
            [...new Set(personList)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
          );
        }
      }
    }

    variantAssignments = Object.freeze(workingAssignments);
  }

  if (issues.length > 0) {
    return Object.freeze({ ok: false, issues: dedupeIssues(issues) });
  }

  // ── Build inputs from captured facts and evaluate ─────────────────────
  const baselineInputs = buildInputs({
    projectId: baseline.projectId,
    revision: baseline.baselineRevision,
    policyVersion: baseline.policyVersion,
    scope: baseline.orderedScope,
    estimates: Object.fromEntries(
      baseline.orderedScope.map((id) => [id, baseline.factMap[id]?.effortPoints ?? null]),
    ),
    pointsPerSprint: baseline.configuration.pointsPerSprint,
    sprintLengthDays: baseline.configuration.sprintLengthDays,
    startSprintOrdinal: baseline.configuration.startSprintOrdinal,
    startDate: baseline.configuration.startDate,
    parallelGroups: baseline.parallelGroups,
    blockedFeatureIds: baseline.blockedFeatureIds,
    roster: baseline.roster,
    assignments: baseline.assignments,
  });

  const overrides = patch.pointOverrides ?? {};
  const variantInputs = buildInputs({
    projectId: baseline.projectId,
    revision: baseline.baselineRevision,
    policyVersion: variantPolicy,
    scope: variantScope,
    estimates: Object.fromEntries(
      variantScope.map((id) => [
        id,
        id in overrides ? overrides[id] : baseline.factMap[id]?.effortPoints ?? null,
      ]),
    ),
    pointsPerSprint:
      patch.pointsPerSprint !== undefined ? patch.pointsPerSprint : baseline.configuration.pointsPerSprint,
    sprintLengthDays: baseline.configuration.sprintLengthDays,
    startSprintOrdinal: baseline.configuration.startSprintOrdinal,
    startDate: baseline.configuration.startDate,
    parallelGroups: variantGroups,
    blockedFeatureIds: baseline.blockedFeatureIds,
    roster: variantRoster,
    assignments: variantAssignments,
  });

  const baselineResult = await calculateForecast(
    today ? { ...baselineInputs, ...asOfFields(baseline, today) } : baselineInputs,
  );
  const variantResult = await calculateForecast(
    today ? { ...variantInputs, ...asOfFields(baseline, today) } : variantInputs,
  );
  const comparison = compareForecasts(baselineInputs, variantInputs, baselineResult, variantResult);

  return Object.freeze({
    ok: true,
    baselineInputs,
    variantInputs,
    baselineResult,
    variantResult,
    comparison,
    groupCleanups: Object.freeze(groupCleanups),
    assignmentCleanups: Object.freeze(
      [...assignmentCleanups].sort((a, b) => a.featureId.localeCompare(b.featureId)),
    ),
  });
}
