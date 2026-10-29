/**
 * One scenario comparison, draft or saved (Story 23.8, AC 23.8-1..3; review
 * R8, R11).
 *
 * Shows the captured baseline and the variant together, each with its own
 * whole-set completion, the changed levers, and — on request — every item's
 * exact timing on both sides (assignees, rate, duration, exact sprint
 * offsets and the containing sprints and dates). A variant that did not
 * calculate is explained with the named captured people and items and a
 * repair, never replaced by a live or shared-capacity result. Structural
 * failures are explained the same way; codes alone are never the message.
 */

import { useState } from 'react';
import type { ScenarioEvaluation } from '../../../domain/forecast/scenario-evaluate';
import type { ForecastResult } from '../../../domain/forecast/forecast-result';
import type { ForecastChangeCause } from '../../../domain/forecast/compare.policy';
import { describeCause } from './change-summary';
import { completionText, signed } from './scenario-format';
import {
  describeTiming,
  explainForecastIssue,
  explainScenarioIssue,
  type Explanation,
  type ScenarioNames,
} from './scenario-explain';

function Explanations({ items }: { items: readonly Explanation[] }): React.ReactElement {
  return (
    <ul className="pm-forecast__scenario-changes">
      {items.map((e, i) => (
        <li key={i}>
          {e.message}
          {e.repair ? ` ${e.repair}` : ''}
        </li>
      ))}
    </ul>
  );
}

function resultIssues(result: ForecastResult, names: ScenarioNames): readonly Explanation[] {
  return result.issues.map((i) => explainForecastIssue(i, names)).filter((e): e is Explanation => e !== null);
}

function levers(causes: readonly ForecastChangeCause[], names: ScenarioNames): readonly string[] {
  return causes.map((c) => describeCause(c, names.item));
}

export interface ScenarioComparisonProps {
  readonly evaluation: ScenarioEvaluation;
  readonly names: ScenarioNames;
  /** Distinguishes the timing disclosure of each comparison on the page. */
  readonly disclosureLabel: string;
  /** Saved cards also show point/capacity deltas and coverage. */
  readonly showTotals?: boolean;
}

export function ScenarioComparison({ evaluation, names, disclosureLabel, showTotals }: ScenarioComparisonProps): React.ReactElement {
  const [timingOpen, setTimingOpen] = useState(false);

  if (!evaluation.ok) {
    return (
      <div role="alert" className="pm-forecast__completion-note pm-forecast__completion-note--warning">
        <p>This scenario cannot be evaluated as entered:</p>
        <Explanations items={evaluation.issues.map((i) => explainScenarioIssue(i, names))} />
      </div>
    );
  }

  const { baselineResult, variantResult, comparison } = evaluation;
  const variantCalculated = variantResult.arithmetic !== null;
  const variantProblems = resultIssues(variantResult, names);
  const baselineProblems = baselineResult.arithmetic === null ? resultIssues(baselineResult, names) : [];
  const baseArith = baselineResult.arithmetic;
  const variantArith = variantResult.arithmetic;
  const changed = comparison ? levers(comparison.causes, names) : [];

  const timelineIds = [
    ...new Set([
      ...(variantResult.allocation?.timelines ?? []).map((t) => t.featureId),
      ...(baselineResult.allocation?.timelines ?? []).map((t) => t.featureId),
    ]),
  ];

  return (
    <div className="pm-forecast__scenario-comparison">
      <dl className="pm-forecast__scenario-outcomes">
        <div>
          <dt>Captured baseline</dt>
          <dd>{completionText(baselineResult)}</dd>
        </div>
        <div>
          <dt>Variant</dt>
          <dd>
            {completionText(variantResult)}
            {comparison?.sameCompletion ? ' · Same completion · feature timing changed' : ''}
          </dd>
        </div>
      </dl>

      {changed.length > 0 && (
        <div className="pm-forecast__completion-note">
          <p>Changed lever:</p>
          <ul className="pm-forecast__scenario-changes">
            {changed.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      {!variantCalculated && variantProblems.length > 0 && (
        <div role="alert" className="pm-forecast__completion-note pm-forecast__completion-note--warning">
          <p>
            The variant has no forecast ({variantResult.state === 'incomplete' ? 'inputs are incomplete' : 'inputs conflict'}):
          </p>
          <Explanations items={variantProblems} />
        </div>
      )}
      {baselineProblems.length > 0 && (
        <div className="pm-forecast__completion-note pm-forecast__completion-note--warning">
          <p>The captured baseline itself has no forecast:</p>
          <Explanations items={baselineProblems} />
        </div>
      )}

      {evaluation.assignmentCleanups.length > 0 && (
        <div className="pm-forecast__completion-note pm-forecast__completion-note--warning">
          <p>Assignment cleanup in the variant:</p>
          <ul className="pm-forecast__scenario-changes">
            {evaluation.assignmentCleanups.map((c) => (
              <li key={`${c.featureId}-${c.reason}`}>
                {c.removedPersonIds.map(names.person).join(', ')} no longer assigned to {names.item(c.featureId)} —{' '}
                {c.reason === 'scope-removed' ? 'the item left the scenario scope' : 'the item has 0 points'}.
              </li>
            ))}
          </ul>
        </div>
      )}
      {evaluation.groupCleanups.length > 0 && (
        <div className="pm-forecast__completion-note pm-forecast__completion-note--warning">
          <p>Parallel group cleanup in the variant:</p>
          <ul className="pm-forecast__scenario-changes">
            {evaluation.groupCleanups.map((c, i) => (
              <li key={i}>
                {c.dissolved
                  ? `Group dissolved: ${c.keptFeatureIds.map(names.item).join(', ') || 'no members'} remain after ${c.removedFeatureIds.map(names.item).join(', ')} left the scope.`
                  : `${c.removedFeatureIds.map(names.item).join(', ')} left the group; ${c.keptFeatureIds.map(names.item).join(', ')} stay parallel.`}
              </li>
            ))}
          </ul>
        </div>
      )}
      {variantResult.issues.some((i) => i.code === 'CONDITIONAL_BLOCKER') && (
        <p className="pm-forecast__completion-note pm-forecast__completion-note--warning">
          Conditional — a blocked item is assumed; no delay duration was added.
        </p>
      )}

      {showTotals && baseArith && variantArith && (
        <p className="pm-forecast__completion-note">
          Points {signed(variantArith.totalPoints - baseArith.totalPoints)} · Capacity/sprint{' '}
          {signed(variantArith.pointsPerSprint - baseArith.pointsPerSprint)}
        </p>
      )}
      {showTotals && (
        <p className="pm-forecast__completion-note">
          Coverage {variantResult.coverage.estimatedCount}/{variantResult.coverage.selectedCount} · validity{' '}
          {variantResult.state}
        </p>
      )}

      {timelineIds.length > 0 && (
        <>
          <button
            type="button"
            className="pm-forecast__row-expand"
            aria-expanded={timingOpen}
            aria-label={`${timingOpen ? 'Hide' : 'Show'} exact item timing for ${disclosureLabel}`}
            onClick={() => setTimingOpen((o) => !o)}
          >
            {timingOpen ? '▾ Exact item timing' : '▸ Exact item timing'}
          </button>
          {timingOpen && (
            <ul className="pm-forecast__scenario-timing-list" aria-label={`Exact item timing for ${disclosureLabel}`}>
              {timelineIds.map((id) => (
                <li key={id}>
                  <strong>{names.item(id)}</strong>
                  <p>
                    <span className="pm-forecast__scenario-side">Baseline:</span>{' '}
                    {describeTiming(baselineResult.allocation?.timelines.find((t) => t.featureId === id), names)}
                  </p>
                  <p>
                    <span className="pm-forecast__scenario-side">Variant:</span>{' '}
                    {variantCalculated
                      ? describeTiming(variantResult.allocation?.timelines.find((t) => t.featureId === id), names)
                      : 'no timing — the variant has no forecast'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
