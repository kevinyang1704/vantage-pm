/**
 * Plain-language scenario explanations (Story 23.8, AC 23.8-2/-3/-6).
 *
 * Domain issues carry codes and captured identities; these functions turn
 * them into sentences that name the captured person and item and say how to
 * repair the draft. Names resolve through a `ScenarioNames` the caller
 * builds from captured facts (roster names, captured titles); an identity
 * that has no captured label says so rather than borrowing a live name.
 * Nothing here computes or rounds a forecast value: exact ratios are
 * printed as the reduced fractions the domain produced.
 */

import type { ReducedRatio } from '../../../domain/forecast/forecast-canonical';
import type { ScenarioEvaluationIssue } from '../../../domain/forecast/scenario';
import type { FeatureTimeline } from '../../../domain/forecast/forecast-allocation';

export type ScenarioNames = Readonly<{
  person: (id: string) => string;
  item: (id: string) => string;
  /** The captured planning level ("Feature", "Theme", …) for sentences. */
  level: string;
}>;

/** Last characters of a UUID, enough to tell identities apart in prose. */
export function shortId(id: string): string {
  return `…${id.slice(-6)}`;
}

export function unavailableItemLabel(id: string): string {
  return `Item ${shortId(id)} (title unavailable)`;
}

export function unavailablePersonLabel(id: string): string {
  return `Person ${shortId(id)} (name unavailable)`;
}

/** An exact reduced ratio: "6", "2/3". Never a rounded decimal. */
export function exact(ratio: ReducedRatio): string {
  return ratio.denominator === 1 ? String(ratio.numerator) : `${ratio.numerator}/${ratio.denominator}`;
}

function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export type Explanation = Readonly<{ message: string; repair?: string }>;

/** A calculated result's issue, as the result envelope carries it. */
export type ResultIssue = Readonly<{
  code: string;
  message: string;
  featureIds?: readonly string[];
  personIds?: readonly string[];
}>;

/** A calculated result's issue (baseline or variant), explained with captured names. */
export function explainForecastIssue(issue: ResultIssue, names: ScenarioNames): Explanation | null {
  const items = (issue.featureIds ?? []).map(names.item);
  const people = (issue.personIds ?? []).map(names.person);
  switch (issue.code) {
    case 'CONDITIONAL_BLOCKER':
      return null; // disclosed separately as a condition, not an error
    case 'CONCURRENT_ASSIGNMENT_CONFLICT':
      return {
        message: `${list(people)} is assigned to ${list(items)}, which run at the same time in one parallel group.`,
        repair: `Assign ${list(people)} to only one of them, or remove one item from the scenario.`,
      };
    case 'MISSING_ASSIGNMENT':
      return {
        message: `${list(items)} has work but nobody is assigned.`,
        repair: `Assign at least one person to ${list(items)}.`,
      };
    case 'UNKNOWN_PERSON':
      return {
        message: `${list(items)} is assigned to ${list(people)}, who is not on the captured roster.`,
        repair: 'Clear that assignment in the scenario.',
      };
    case 'ASSIGNMENT_TO_ZERO_WORK':
      return {
        message: `${list(items)} has 0 points but has people assigned.`,
        repair: `Clear its assignments, or give ${list(items)} a point override above 0.`,
      };
    case 'MISSING_ROSTER':
      return { message: 'The captured baseline has no people, so staffed work cannot be scheduled.' };
    case 'MISSING_ESTIMATE':
      return {
        message: `${items.length > 0 ? list(items) : 'An item'} has no estimate.`,
        repair: 'Enter a point override for it, or remove it from the scenario.',
      };
    case 'ZERO_CAPACITY':
    case 'MISSING_CAPACITY':
    case 'INVALID_CAPACITY':
      return { message: 'Capacity per sprint is missing or zero.', repair: 'Enter a capacity override above 0.' };
    case 'OVERFLOW':
      return { message: 'These values are too large to calculate exactly.', repair: 'Reduce the weights, points or capacity.' };
    case 'DUPLICATE_ASSIGNMENT':
      return { message: `${list(people)} is listed more than once on ${list(items)}.` };
    case 'ASSIGNMENT_TO_EXCLUDED_ITEM':
      return { message: `${list(items)} has assignments but is not in the scenario scope.` };
    default:
      return { message: issue.message };
  }
}

/** A structural validation issue (`evaluation.ok === false`), explained with captured names. */
export function explainScenarioIssue(issue: ScenarioEvaluationIssue, names: ScenarioNames): Explanation {
  switch (issue.code) {
    case 'DUPLICATE_SCOPE_MEMBER':
      return { message: `${names.item(issue.featureId)} appears twice in the scenario scope.`, repair: 'Include it once.' };
    case 'CROSS_PROJECT_MEMBER':
      return { message: `${names.item(issue.featureId)} belongs to another project.`, repair: 'Remove it from the scenario scope.' };
    case 'NOT_A_FEATURE':
      return {
        message: `${names.item(issue.featureId)} is not a ${names.level} in the captured baseline.`,
        repair: 'Remove it from the scenario scope.',
      };
    case 'OVERLAPPING_SCOPE':
      return {
        message: `${list(issue.featureIds.map(names.item))} overlap: one contains another.`,
        repair: 'Include only one of them.',
      };
    case 'OVERRIDE_FOR_EXCLUDED_MEMBER':
      return {
        message: `A point override is set for ${names.item(issue.featureId)}, which is not in the scenario scope.`,
        repair: 'Include the item, or clear its point override.',
      };
    case 'INVALID_POINT_OVERRIDE':
      return { message: `The point override for ${names.item(issue.featureId)} is not a whole number of points.` };
    case 'INVALID_CAPACITY_OVERRIDE':
      return { message: 'The capacity override is not a whole number of points.' };
    case 'ORDER_SPLITS_RETAINED_GROUP':
      return {
        message: `${list(issue.featureIds.map(names.item))} share a parallel group but are not next to each other in the scenario order.`,
        repair: 'Move them next to each other, or remove one from the scenario.',
      };
    case 'UNCAPTURED_FEATURE':
      return { message: `${names.item(issue.featureId)} was not captured with this baseline.`, repair: 'Remove it from the scenario.' };
    case 'UNSUPPORTED_FORECAST_POLICY':
      return { message: `This scenario uses a forecast model this version cannot evaluate (${issue.policyVersion}).` };
    case 'ASSIGNMENT_PERSON_NOT_IN_ROSTER':
      return {
        message: `${names.person(issue.personId)}${issue.featureId ? ` (on ${names.item(issue.featureId)})` : ''} is not on the captured roster.`,
        repair: 'Clear that assignment in the scenario.',
      };
    case 'DUPLICATE_ITEM_ASSIGNMENT':
      return {
        message: `${issue.personId ? names.person(issue.personId) : 'A person'} is listed more than once on ${names.item(issue.featureId)}.`,
      };
    case 'ASSIGNMENT_TO_ZERO_WORK':
      return {
        message: `${names.item(issue.featureId)} has 0 points but has people assigned.`,
        repair: 'Clear its assignments, or give it a point override above 0.',
      };
    case 'INVALID_WEIGHT_OVERRIDE':
      return { message: `The weight override for ${names.person(issue.personId)} is not a valid weight.` };
    case 'WEIGHT_OVERRIDE_FOR_UNKNOWN_PERSON':
      return {
        message: `A weight override is set for ${names.person(issue.personId)}, who is not on the captured roster.`,
        repair: 'Remove that weight override.',
      };
    case 'UNSUPPORTED_SCENARIO_LEVER':
      return { message: issue.message ?? `This scenario changes ${issue.lever ?? 'a lever'} that scenarios cannot change.` };
    case 'PARALLEL_GROUP_MEMBER_EXCLUDED':
      return {
        message: `${names.item(issue.featureId)} is in a parallel group but not in the scenario scope.`,
        repair: 'Include it, or remove it from the group.',
      };
    case 'STAFFING_DATA_IN_SHARED_POLICY':
      return {
        message: 'Weights and assignments can only be changed when the plan uses assigned people.',
        repair: 'Switch pacing to "Assigned people", or clear the staffing overrides.',
      };
  }
}

/** One item's exact timing on one side of the comparison. */
export function describeTiming(timeline: FeatureTimeline | undefined, names: ScenarioNames): string {
  if (!timeline) return 'not in this scope';
  if (timeline.startOffset === null || timeline.finishOffset === null) return 'timing withheld (the result is not complete)';
  const window =
    timeline.startSprintOrdinal === timeline.completionSprintOrdinal
      ? `Sprint ${timeline.startSprintOrdinal}`
      : `Sprints ${timeline.startSprintOrdinal}–${timeline.completionSprintOrdinal}`;
  const dates = `${timeline.startDate} → ${timeline.completionDate}`;
  const offsets = `sprint offset ${exact(timeline.startOffset)} → ${exact(timeline.finishOffset)}`;
  if (timeline.isMilestone) return `milestone · ${offsets} · ${window} (${dates})`;
  const parts: string[] = [];
  if (timeline.assignedPersonIds !== undefined) {
    parts.push(timeline.assignedPersonIds.length > 0 ? timeline.assignedPersonIds.map(names.person).join(', ') : 'unassigned');
  }
  if (timeline.itemRate) parts.push(`rate ${exact(timeline.itemRate)} points/sprint`);
  if (timeline.duration) parts.push(`duration ${exact(timeline.duration)} sprints`);
  parts.push(offsets, `${window} (${dates})`);
  return parts.join(' · ');
}
