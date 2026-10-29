/**
 * Localized presentation strings for forecast change attribution (Story
 * 20.2, Task 3, UX-DR14..UX-DR16).
 *
 * These live OUTSIDE the canonical `ForecastComparison` DTO — titles and
 * prose never enter fingerprints or canonical result bytes. The domain
 * `compareForecasts` produces typed causes; this maps them to sentence-case
 * copy in the planning voice ("state assumptions as facts", EXPERIENCE.md).
 */

import type { ForecastChangeCause, ForecastComparison } from '../../../domain/forecast/compare.policy';
import { formatStaffingWeightUnits } from '../../../domain/forecast/forecast-validators';

type TitleLookup = (featureId: string) => string;

function names(ids: readonly string[], titleOf: TitleLookup): string {
  return ids.map((id) => titleOf(id) || id).join(', ');
}

export function describeCause(cause: ForecastChangeCause, titleOf: TitleLookup): string {
  switch (cause.kind) {
    case 'ScopeAdded':
      return `Scope added: ${names(cause.featureIds, titleOf)}`;
    case 'ScopeRemoved':
      return `Scope removed: ${names(cause.featureIds, titleOf)}`;
    case 'EstimateIncreased':
      return `Estimate increase — ${titleOf(cause.featureId) || cause.featureId}: ${cause.before} → ${cause.after}`;
    case 'EstimateDecreased':
      return `Estimate decrease — ${titleOf(cause.featureId) || cause.featureId}: ${cause.before} → ${cause.after}`;
    case 'EstimateSet':
      return `Estimate set — ${titleOf(cause.featureId) || cause.featureId}: ${cause.after}`;
    case 'EstimateCleared':
      return `Estimate cleared — ${titleOf(cause.featureId) || cause.featureId}`;
    case 'OrderChanged':
      return 'Priority order changed';
    case 'ParallelChanged':
      return 'Parallel grouping changed';
    case 'CapacityChanged':
      return `Shared capacity: ${cause.before ?? '—'} → ${cause.after ?? '—'} points/sprint`;
    case 'StartChanged':
      return `Start anchor: Sprint ${cause.before.ordinal ?? '—'} (${cause.before.date ?? '—'}) → Sprint ${cause.after.ordinal ?? '—'} (${cause.after.date ?? '—'})`;
    case 'CadenceChanged':
      return `Sprint length: ${cause.before ?? '—'} → ${cause.after ?? '—'} days`;
    case 'BlockerChanged': {
      const parts: string[] = [];
      if (cause.added.length > 0) parts.push(`blocked ${names(cause.added, titleOf)}`);
      if (cause.removed.length > 0) parts.push(`cleared blocker on ${names(cause.removed, titleOf)}`);
      return `Blocker — ${parts.join('; ')}. No delay duration was assumed.`;
    }
    case 'PolicyChanged': {
      const modeLabel = (p: import('../../../domain/forecast/forecast-plan.entity').ForecastPolicyVersion) =>
        p === 'staffed-capacity-v1' ? 'Assigned people' : 'Whole team';
      return `Forecast mode: ${modeLabel(cause.before)} → ${modeLabel(cause.after)}`;
    }
    case 'AssignmentChanged': {
      const bStr = cause.before.length > 0 ? cause.before.join(', ') : 'unassigned';
      const aStr = cause.after.length > 0 ? cause.after.join(', ') : 'unassigned';
      return `Assignment — ${titleOf(cause.featureId) || cause.featureId}: ${bStr} → ${aStr}`;
    }
    case 'RosterChanged': {
      const parts: string[] = [];
      if (cause.added.length > 0) parts.push(`added ${cause.added.join(', ')}`);
      if (cause.removed.length > 0) parts.push(`removed ${cause.removed.join(', ')}`);
      return `Roster — ${parts.join('; ')}`;
    }
    case 'PersonWeightChanged':
      // The cause carries weight units (hundredths), not a rate: show the
      // relative weight exactly as it is entered (Story 23.9).
      return `Relative weight — ${cause.personName}: ${formatStaffingWeightUnits(cause.before)} → ${formatStaffingWeightUnits(cause.after)}`;
    default: {
      const _exhaustive: never = cause;
      return String(_exhaustive);
    }
  }
}

/**
 * The one-line headline for the "What changed" section. "Same completion"
 * where the whole-set date held while item timing moved (UX-DR14); never
 * "No change" in that case.
 */
export function describeComparisonHeadline(comparison: ForecastComparison): string {
  if (comparison.causes.length === 0) return 'No material change';
  if (comparison.sameCompletion) return 'Same completion · feature timing changed';
  if (!comparison.changedDimensions.date && !comparison.changedDimensions.sequence) {
    return 'Inputs changed · completion unchanged';
  }
  return 'Forecast updated';
}
