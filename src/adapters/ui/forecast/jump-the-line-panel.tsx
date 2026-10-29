/**
 * Jump-the-line what-if (Epic 26, Story 26.7, FC-FR7, FC-FR8, FC-UX4, FC-UX5).
 *
 * A non-modal section in the forecast rail. The user picks an existing selected
 * item or enters a new draft item, chooses one of three absorb strategies, and
 * sees per-item old → new finishes with slip labels, the completion change and
 * a copyable plain-language summary. Every value comes from the two
 * acknowledged results (live and what-if); nothing is written until Apply.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createUuidV7 } from '../../../../spikes/phase-0-durability/src/command-receipt';
import type { ForecastScenarioBaseline, ForecastScenarioPatch } from '../../../domain/forecast/scenario';
import type { ScenarioEvaluation } from '../../../domain/forecast/scenario-evaluate';
import type { ForecastResult } from '../../../domain/forecast/forecast-result';
import type { ScenarioDraftContext } from '../../../application/forecast/scenario-draft-context';
import type { ForecastPlanningRow } from './forecast-workspace';
import {
  buildChosenPeople,
  buildEveryonePauses,
  buildHoldTheDate,
  compareItemFinishes,
  stakeholderSummary,
  type JumpStrategy,
  type UrgentItem,
} from '../../../domain/forecast/jump-the-line';

export interface JumpTheLinePanelProps {
  readonly result: ForecastResult | null;
  readonly eligibleFeatures: readonly ForecastPlanningRow[];
  /** Project roster for the "chosen people" strategy (Story 26.7 AC 26.7-2). */
  readonly roster?: readonly { id: string; name: string }[];
  /** Capture a baseline for the what-if (Story 26.7). */
  readonly onCaptureBaseline: () => Promise<ScenarioDraftContext>;
  /** Evaluate a what-if patch as of today in the worker. */
  readonly onEvaluate: (patch: ForecastScenarioPatch, addedFact: { id: string; fact: unknown; title?: string } | undefined) => Promise<ScenarioEvaluation>;
  readonly onApply: (build: { patch: ForecastScenarioPatch; addedFact?: { id: string; fact: unknown; title?: string } }) => void;
  readonly onSave: (label: string, patch: ForecastScenarioPatch) => void;
  readonly names: (id: string) => string;
}

const STRATEGY_LABELS: Readonly<Record<JumpStrategy, string>> = Object.freeze({
  'everyone-pauses': 'Everyone pauses',
  'chosen-people': 'Chosen people take it',
  'hold-the-date': 'Hold the date',
});

export function JumpTheLinePanel({
  result,
  eligibleFeatures,
  roster,
  onCaptureBaseline,
  onEvaluate,
  onApply,
  onSave,
  names,
}: JumpTheLinePanelProps): React.ReactElement {
  const included = eligibleFeatures.filter((f) => f.included);
  const staffed = result?.policyVersion === 'staffed-capacity-v1';
  const people = roster ?? [];
  const [open, setOpen] = useState(false);
  const [baseline, setBaseline] = useState<ForecastScenarioBaseline | null>(null);
  const [urgentKind, setUrgentKind] = useState<'existing' | 'new'>('new');
  const [existingId, setExistingId] = useState(included[0]?.id ?? '');
  const [newTitle, setNewTitle] = useState('');
  const [newPoints, setNewPoints] = useState('');
  const [strategy, setStrategy] = useState<JumpStrategy>('everyone-pauses');
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [evaluation, setEvaluation] = useState<ScenarioEvaluation | null>(null);
  const [pending, setPending] = useState(false);
  const [summaryCopied, setSummaryCopied] = useState(false);
  const [deferredIds, setDeferredIds] = useState<readonly string[]>([]);
  const [holdUnreachable, setHoldUnreachable] = useState(false);
  /** The exact patch+fact last evaluated, used for Save/Apply (never rebuilt). */
  const [applied, setApplied] = useState<{ patch: ForecastScenarioPatch; addedFact?: { id: string; fact: unknown; title?: string } } | null>(null);
  const tokenRef = useRef(0);
  /** A stable UUIDv7 for a new urgent draft item (valid at the command layer). */
  const newDraftIdRef = useRef<string>(createUuidV7());

  const urgent: UrgentItem | null = useMemo(() => {
    if (urgentKind === 'existing') {
      return existingId ? Object.freeze({ kind: 'existing', featureId: existingId }) : null;
    }
    const points = Number(newPoints);
    if (!newTitle.trim() || !Number.isSafeInteger(points) || points < 0) return null;
    return Object.freeze({
      kind: 'new',
      draftId: newDraftIdRef.current,
      title: newTitle.trim(),
      effortPoints: points,
    });
  }, [urgentKind, existingId, newTitle, newPoints]);

  const diffs = useMemo(
    () => compareItemFinishes(result, evaluation?.ok ? evaluation.variantResult : null, deferredIds),
    [result, evaluation, deferredIds],
  );

  const summary = useMemo(() => {
    if (!urgent || !evaluation?.ok) return '';
    return stakeholderSummary({
      urgentTitle: urgent.kind === 'new' ? urgent.title : names(urgent.featureId),
      diffs,
      names,
      liveCompletion: result?.arithmetic ? `Sprint ${result.arithmetic.completionSprint}` : null,
      whatIfCompletion: evaluation.variantResult.arithmetic
        ? `Sprint ${evaluation.variantResult.arithmetic.completionSprint}`
        : null,
    });
  }, [urgent, evaluation, diffs, names, result]);

  const run = async (): Promise<void> => {
    if (!baseline || !urgent) return;
    const token = ++tokenRef.current;
    setPending(true);
    try {
      if (strategy === 'hold-the-date') {
        // AC 26.7-2: defer the lowest-ranked items one at a time until the
        // what-if completion is no later than the live plan's. Bounded by the
        // scope size; each candidate is evaluated in the worker.
        const liveSprint = result?.arithmetic?.completionSprint ?? null;
        // If the live plan has no completion, there is no date to hold.
        if (liveSprint === null) {
          setEvaluation(null);
          setDeferredIds([]);
          setHoldUnreachable(true);
          setApplied(null);
          return;
        }
        const base = buildEveryonePauses(baseline, urgent);
        const urgentId = urgent.kind === 'new' ? urgent.draftId : urgent.featureId;
        let scope = [...(base.patch.orderedScope ?? baseline.orderedScope)];
        let lastEvaluation: ScenarioEvaluation | null = null;
        let lastPatch: ForecastScenarioPatch = base.patch;
        let deferred: string[] = [];
        let reachable = false;
        for (;;) {
          const patch = Object.freeze({ ...base.patch, orderedScope: Object.freeze([...scope]) });
          const evaluated = await onEvaluate(patch, base.addedFact);
          if (token !== tokenRef.current) return;
          lastEvaluation = evaluated;
          lastPatch = patch;
          if (evaluated.ok) {
            const sprint = evaluated.variantResult.arithmetic?.completionSprint ?? null;
            if (sprint !== null && sprint <= liveSprint) {
              reachable = true;
              break;
            }
          }
          const nextDefer = [...scope].reverse().find((id) => id !== urgentId);
          if (!nextDefer) break;
          scope = scope.filter((id) => id !== nextDefer);
          deferred = [...deferred, nextDefer];
        }
        setEvaluation(lastEvaluation);
        setDeferredIds(deferred);
        setHoldUnreachable(!reachable);
        setApplied({ patch: lastPatch, addedFact: base.addedFact });
        return;
      }
      const build =
        strategy === 'chosen-people'
          ? buildFor('chosen-people', baseline, urgent, chosen, included.length)
          : buildFor(strategy, baseline, urgent, chosen, included.length);
      const resultEvaluation = await onEvaluate(build.patch, build.addedFact);
      if (token === tokenRef.current) {
        setEvaluation(resultEvaluation);
        setDeferredIds([]);
        setHoldUnreachable(false);
        setApplied(build);
      }
    } catch {
      // A superseded/failed evaluation leaves the previous preview in place.
    } finally {
      if (token === tokenRef.current) setPending(false);
    }
  };

  const copySummary = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(summary);
      setSummaryCopied(true);
    } catch {
      setSummaryCopied(false);
    }
  };

  const openPanel = async (): Promise<void> => {
    setOpen(true);
    if (!baseline) {
      const captured = await onCaptureBaseline();
      setBaseline(captured.baseline);
    }
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
  };

  return (
    <section className="pm-forecast__section" aria-label="What if something jumps the line">
      <p className="pm-forecast__section-title">What if something jumps the line</p>
      {!open ? (
        <button type="button" className="pm-forecast__button pm-forecast__button--small" onClick={() => void openPanel()}>
          Start a what-if…
        </button>
      ) : (
        <div className="pm-forecast__whatif">
          <fieldset className="pm-forecast__config-field">
            <legend>What jumps the line?</legend>
            <label className="pm-forecast__whatif-radio">
              <input
                type="radio"
                name="urgent-kind"
                checked={urgentKind === 'existing'}
                onChange={() => setUrgentKind('existing')}
                aria-label="An item already in the plan"
              />
              An item already in the plan
            </label>
            {urgentKind === 'existing' && (
              <select
                className="pm-forecast__config-input"
                value={existingId}
                aria-label="Choose the urgent item"
                onChange={(e) => setExistingId(e.target.value)}
              >
                {included.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.title || names(f.id)}
                  </option>
                ))}
              </select>
            )}
            <label className="pm-forecast__whatif-radio">
              <input
                type="radio"
                name="urgent-kind"
                checked={urgentKind === 'new'}
                onChange={() => setUrgentKind('new')}
                aria-label="A new item"
              />
              A new item
            </label>
            {urgentKind === 'new' && (
              <div className="pm-forecast__whatif-new">
                <input
                  className="pm-forecast__config-input"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="Title"
                  aria-label="New item title"
                />
                <input
                  className="pm-forecast__config-input"
                  type="number"
                  min={0}
                  step={1}
                  value={newPoints}
                  onChange={(e) => setNewPoints(e.target.value)}
                  placeholder="Points"
                  aria-label="New item points"
                />
              </div>
            )}
          </fieldset>

          <fieldset className="pm-forecast__config-field">
            <legend>How should the team absorb it?</legend>
            {(['everyone-pauses', 'chosen-people', 'hold-the-date'] as const).map((s) => {
              // AC 26.7-2: "chosen people" is only offered when the plan uses
              // assigned people (the lever composes assignments).
              const disabled = s === 'chosen-people' && !staffed;
              return (
                <label key={s} className="pm-forecast__whatif-radio">
                  <input
                    type="radio"
                    name="strategy"
                    checked={strategy === s}
                    disabled={disabled}
                    onChange={() => setStrategy(s)}
                    aria-label={STRATEGY_LABELS[s]}
                  />
                  {STRATEGY_LABELS[s]}
                  {disabled && <span className="pm-forecast__completion-note"> (assigned-people mode only)</span>}
                </label>
              );
            })}
            {strategy === 'chosen-people' && staffed && (
              <div className="pm-forecast__whatif-people" role="group" aria-label="Choose the people who take it">
                {people.map((p) => (
                  <label key={p.id} className="pm-forecast__scenario-person-chip">
                    <input
                      type="checkbox"
                      checked={chosen.includes(p.id)}
                      onChange={(e) =>
                        setChosen((prev) => (e.target.checked ? [...prev, p.id] : prev.filter((id) => id !== p.id)))
                      }
                      aria-label={`Have ${p.name} take it`}
                    />
                    {p.name}
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <button
            type="button"
            className="pm-forecast__button pm-forecast__button--primary pm-forecast__button--small"
            onClick={() => void run()}
            disabled={!urgent || pending}
          >
            {pending ? 'Comparing…' : 'Compare'}
          </button>

          {evaluation && !evaluation.ok && (
            <p role="alert" className="pm-forecast__completion-note pm-forecast__completion-note--warning">
              That combination cannot be evaluated. Adjust the choice and try again.
            </p>
          )}

          {evaluation?.ok && (
            <>
              {strategy === 'hold-the-date' && holdUnreachable && (
                <p className="pm-forecast__completion-note pm-forecast__completion-note--warning" role="status">
                  The live completion cannot be held even after deferring every other item. Showing the best achievable
                  result{deferredIds.length > 0 ? ` with ${deferredIds.length} item(s) deferred` : ''}.
                </p>
              )}
              <div className="pm-forecast__whatif-comparison">
                <div className="pm-forecast__preview-card" aria-label="Current completion">
                  <span className="pm-forecast__preview-label">Current</span>
                  <span className="pm-forecast__preview-value">
                    {result?.arithmetic ? `Sprint ${result.arithmetic.completionSprint}` : '—'}
                  </span>
                </div>
                <div className="pm-forecast__preview-card" aria-label="What-if completion">
                  <span className="pm-forecast__preview-label">What-if</span>
                  <span className="pm-forecast__preview-value">
                    {evaluation.variantResult.arithmetic
                      ? `Sprint ${evaluation.variantResult.arithmetic.completionSprint}`
                      : '—'}
                  </span>
                </div>
              </div>
              <ul className="pm-forecast__whatif-list">
                {diffs.map((d) => (
                  <li key={d.featureId} className="pm-forecast__cause">
                    {names(d.featureId)}: {d.oldFinish ?? 'new'} → {d.newFinish ?? 'later'}{' '}
                    <span className="pm-forecast__slip-badge">{d.slipLabel}</span>
                  </li>
                ))}
              </ul>
              <p className="pm-forecast__whatif-summary">{summary}</p>
              <div className="pm-forecast__levers-actions">
                <button
                  type="button"
                  className="pm-forecast__button pm-forecast__button--small"
                  onClick={() => void copySummary()}
                >
                  Copy summary
                </button>
                <button
                  type="button"
                  className="pm-forecast__button pm-forecast__button--small"
                  onClick={() => applied && onSave(STRATEGY_LABELS[strategy], applied.patch)}
                  disabled={!applied}
                >
                  Save as scenario
                </button>
                <button
                  type="button"
                  className="pm-forecast__button pm-forecast__button--small pm-forecast__button--primary"
                  onClick={() => applied && onApply(applied)}
                  disabled={!applied}
                >
                  Apply
                </button>
              </div>
              {summaryCopied && (
                <p role="status" className="pm-forecast__completion-note">
                  Summary copied.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function buildFor(
  strategy: JumpStrategy,
  baseline: ForecastScenarioBaseline,
  urgent: UrgentItem,
  chosen: readonly string[],
  includedCount: number,
): { patch: ForecastScenarioPatch; addedFact?: { id: string; fact: unknown; title?: string } } {
  const build =
    strategy === 'chosen-people'
      ? buildChosenPeople(baseline, urgent, chosen, Math.min(chosen.length + 2, includedCount + 1))
      : strategy === 'hold-the-date'
        ? buildHoldTheDate(baseline, urgent, () => false)
        : buildEveryonePauses(baseline, urgent);
  const title = urgent.kind === 'new' ? urgent.title : undefined;
  return {
    patch: build.patch,
    addedFact: build.addedFact
      ? { id: build.addedFact.id, fact: build.addedFact.fact, ...(title ? { title } : {}) }
      : undefined,
  };
}

