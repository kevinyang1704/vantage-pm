/**
 * Forecast input normalization (Story 18.3, Task 1, AR-15, AD-21).
 *
 * `normalizeForecastInputs(snapshot, policyVersion)` validates and extracts
 * only the relevant canonical facts from one acknowledged snapshot revision.
 * Clock, locale, random IDs, and UI state are absent from arithmetic.
 *
 * The immutable ForecastInputs envelope forms the boundary between repository
 * state and read projections: calculation consumes only this envelope, never
 * live graph facts.
 */

import type { Node } from '../tree/node.entity';
import type { ForecastPlan } from './forecast-plan.entity';
import { FORECAST_POLICY_VERSION, STAFFED_FORECAST_POLICY_VERSION } from './forecast-plan.entity';
import {
  validateForecastScope,
  validateForecastGroups,
  validatePolicyVersion,
  validateCapacity,
  validateSprintLength,
  validateStartOrdinal,
  validateStartDate,
  validateRoster,
  validateStaffingAssignments,
} from './forecast-validators';
import type { ForecastIssue } from './forecast-validators';
import type { ForecastInputs } from './forecast-result';
import type { ReducedRatio } from './forecast-canonical';
import { reduceRatio } from './forecast-canonical';
import { asOfOffset, isOnOrAfterStart, remainingPoints, type RemainingPointsItem } from './forecast-remaining';

export type NormalizeForecastInputsResult = Readonly<{
  ok: true;
  inputs: ForecastInputs;
  issues: readonly ForecastIssue[];
}>;

/** Story 26.6: the injected local date plus each item's progress facts. */
export type ForecastTodayInputs = Readonly<{
  today: string | null;
  nodes: readonly Pick<Node, 'id' | 'deliveryStatus' | 'effortPoints' | 'effortPointsDone'>[];
}>;

/**
 * Normalize one acknowledged snapshot + plan into immutable calculation
 * inputs. Scope/group/policy issues are collected (not just the first
 * failure); numeric configuration issues are collected the same way. The
 * result is always a well-formed ForecastInputs envelope — calculation then
 * decides the typed result state from it.
 */
export function normalizeForecastInputs(
  snapshot: Readonly<{
    projectId: string;
    projectRevision: number;
    nodes: readonly Node[];
  }>,
  plan: ForecastPlan,
  today?: ForecastTodayInputs | null,
): NormalizeForecastInputsResult {
  const issues: ForecastIssue[] = [];

  const policyIssue = validatePolicyVersion(plan.policyVersion);
  if (policyIssue) issues.push(policyIssue);

  const scopeIssues = validateForecastScope(
    plan.selectedFeatureIds,
    snapshot.nodes,
    snapshot.projectId,
    plan.planningLevel,
  );
  issues.push(...scopeIssues);

  const groupIssues = validateForecastGroups(plan.selectedFeatureIds, plan.parallelGroups);
  issues.push(...groupIssues);

  const capacityIssue = validateCapacity(plan.configuration.pointsPerSprint, 'pointsPerSprint');
  if (capacityIssue) issues.push(capacityIssue);
  const lengthIssue = validateSprintLength(plan.configuration.sprintLengthDays, 'sprintLengthDays');
  if (lengthIssue) issues.push(lengthIssue);
  const ordinalIssue = validateStartOrdinal(plan.configuration.startSprintOrdinal, 'startSprintOrdinal');
  if (ordinalIssue) issues.push(ordinalIssue);
  const dateIssue = validateStartDate(plan.configuration.startDate, 'startDate');
  if (dateIssue) issues.push(dateIssue);

  const nodeById = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const estimates: Record<string, number | null> = {};
  for (const id of plan.selectedFeatureIds) {
    const node = nodeById.get(id);
    // Only the selected node's OWN authored effortPoints count — child
    // descendant points are never rolled up, derived, or double-counted
    // (Story 21.6 AC 4). The node type must match the plan's planning level.
    if (node && node.nodeType === plan.planningLevel) {
      estimates[id] = node.effortPoints;
    }
  }

  // ── Story 26.6 (FC-FR6): remaining points and the as-of offset ──────────
  const deliveredFeatureIds: string[] = [];
  let plannedFeatureIds: readonly string[] = plan.selectedFeatureIds;
  let appliedEstimates: Record<string, number | null> = estimates;
  let asOf: ReducedRatio | undefined;
  let asOfDate: string | null | undefined;
  if (today) {
    const items: RemainingPointsItem[] = plan.selectedFeatureIds.flatMap((id) => {
      const node = nodeById.get(id);
      if (!node || node.nodeType !== plan.planningLevel) return [];
      return [
        Object.freeze({
          id,
          status: node.deliveryStatus,
          effortPoints: node.effortPoints,
          effortPointsDone: node.effortPointsDone,
        }),
      ];
    });
    const remaining = remainingPoints(items);
    // AC 26.6-1: a delivered item drops out of the plan entirely — it is not
    // planned and counts zero points. In-progress counts its remaining points.
    appliedEstimates = {};
    plannedFeatureIds = [];
    for (const id of plan.selectedFeatureIds) {
      if (!(id in remaining)) {
        if (nodeById.get(id)?.nodeType === plan.planningLevel) deliveredFeatureIds.push(id);
        continue;
      }
      plannedFeatureIds = [...plannedFeatureIds, id];
      appliedEstimates[id] = remaining[id];
    }
    asOf = asOfOffset(today.today, plan.configuration.startDate, plan.configuration.sprintLengthDays);
    // AC 26.6-2: a today before the start date leaves the forecast unchanged
    // from the pre-26.6 behaviour — no as-of shown, no offset applied.
    asOfDate = isOnOrAfterStart(today.today, plan.configuration.startDate) ? today.today : null;
  }

  // Parallel groups are intersected with the planned scope, so a delivered
  // item never leaves a dangling group.
  const plannedSet = new Set(plannedFeatureIds);
  const plannedGroups = plan.parallelGroups
    .map((g) => g.featureIds.filter((id) => plannedSet.has(id)))
    .filter((ids) => ids.length >= 2);

  // Validate staffing inputs when staffed policy is active (Story 22.1, SF-FR1, SF-FR4)
  if (plan.policyVersion === STAFFED_FORECAST_POLICY_VERSION) {
    const rosterIssues = validateRoster(plan.roster ?? []);
    issues.push(...rosterIssues);

    const assignmentIssues = validateStaffingAssignments({
      assignments: plan.assignments ?? {},
      roster: plan.roster ?? [],
      selectedFeatureIds: plannedFeatureIds,
      nodes: snapshot.nodes,
      planningLevel: plan.planningLevel,
      estimates: appliedEstimates,
      parallelGroups: plannedGroups.map((ids) => Object.freeze({ featureIds: Object.freeze([...ids]) })),
    });
    issues.push(...assignmentIssues);
  }

  const inputs: ForecastInputs = Object.freeze({
    projectId: snapshot.projectId,
    projectRevision: snapshot.projectRevision,
    policyVersion: plan.policyVersion === FORECAST_POLICY_VERSION ? FORECAST_POLICY_VERSION : plan.policyVersion,
    selectedFeatureIds: Object.freeze([...plannedFeatureIds]),
    estimates: Object.freeze(appliedEstimates),
    pointsPerSprint: plan.configuration.pointsPerSprint,
    sprintLengthDays: plan.configuration.sprintLengthDays,
    startSprintOrdinal: plan.configuration.startSprintOrdinal,
    startDate: plan.configuration.startDate,
    parallelGroups: Object.freeze(plannedGroups.map((ids) => Object.freeze({ featureIds: Object.freeze([...ids]) }))),
    // Already canonical (in-scope subset, scope-priority order) — the plan is
    // built through `createForecastPlan` on every read/delta path (Story 20.1).
    blockedFeatureIds: Object.freeze(plan.blockedFeatureIds.filter((id) => plannedSet.has(id))),
    roster: Object.freeze(
      (plan.roster ?? []).map((p) =>
        Object.freeze({ id: p.id, name: p.name, weightUnits: p.weightUnits }),
      ),
    ),
    assignments: Object.freeze(
      Object.fromEntries(
        Object.entries(plan.assignments ?? {})
          .filter(([k]) => plannedSet.has(k))
          .map(([k, v]) => [k, Object.freeze([...v])]),
      ),
    ),
    today: asOfDate ?? null,
    ...(today ? { asOfOffset: asOf ?? reduceRatio(0, 1) } : {}),
    ...(today ? { deliveredFeatureIds: Object.freeze(deliveredFeatureIds) } : {}),
  });

  return Object.freeze({ ok: true, inputs, issues: Object.freeze(issues) });
}
