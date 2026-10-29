/**
 * Forecast levers panel and preview (Epic 26, Story 26.4, FC-FR4, FC-UX3,
 * FC-NFR1, FC-NFR2).
 *
 * Levers (pacing mode, team capacity, run-adjacent-in-parallel) edit a scenario
 * DRAFT captured once against the live plan. Every change evaluates in the
 * analysis worker with scenario-draft identity; nothing is written until the
 * user chooses Apply or Save as scenario. A "With these settings" card shows
 * the previewed sprint, date and signed difference beside the unchanged live
 * plan. Reset returns to the live plan exactly.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ForecastScenarioPatch } from '../../../domain/forecast/scenario';
import type { ScenarioEvaluation } from '../../../domain/forecast/scenario-evaluate';
import type { ScenarioDraftContext } from '../../../application/forecast/scenario-draft-context';
import type { ForecastPlan, ForecastPolicyVersion, ForecastParallelGroup } from '../../../domain/forecast/forecast-plan.entity';
import type { ForecastResult } from '../../../domain/forecast/forecast-result';
import type { ScenarioSaveOutcome } from './scenario-compare';
import { completionText } from './scenario-format';

export interface ForecastLeversProps {
  readonly plan: ForecastPlan | null;
  readonly result: ForecastResult | null;
  readonly canPreview: boolean;
  readonly onCaptureDraft: () => Promise<ScenarioDraftContext>;
  readonly onEvaluateDraft: (context: ScenarioDraftContext, patch: ForecastScenarioPatch) => Promise<ScenarioEvaluation>;
  readonly onCancelDraft?: (draftId: string) => void;
  readonly onSaveScenario: (params: {
    label: string;
    patch: ForecastScenarioPatch;
    context: ScenarioDraftContext;
  }) => Promise<ScenarioSaveOutcome>;
  readonly onApplyPolicy: (policyVersion: ForecastPolicyVersion) => Promise<boolean>;
  readonly onApplyConfiguration: (config: {
    pointsPerSprint: number | null;
    sprintLengthDays: number | null;
    startSprintOrdinal: number | null;
    startDate: string | null;
  }) => void;
  readonly onApplyGroups?: (featureIds: readonly string[], groups: readonly ForecastParallelGroup[]) => void;
}

type LeverState = Readonly<{
  policyVersion: ForecastPolicyVersion;
  capacity: string;
  runTogether: boolean;
}>;

/**
 * Signed sprint difference between the previewed completion and the live one.
 * Computed from the two acknowledged results only (FC-NFR1).
 */
function completionDelta(live: ForecastResult | null, preview: ForecastResult | null): number | null {
  if (!live?.arithmetic || !preview?.arithmetic) return null;
  if (live.arithmetic.completionSprint === null || preview.arithmetic.completionSprint === null) return null;
  return preview.arithmetic.completionSprint - live.arithmetic.completionSprint;
}

export function ForecastLevers({
  plan,
  result,
  canPreview,
  onCaptureDraft,
  onEvaluateDraft,
  onCancelDraft,
  onSaveScenario,
  onApplyPolicy,
  onApplyConfiguration,
  onApplyGroups,
}: ForecastLeversProps): React.ReactElement {
  const [context, setContext] = useState<ScenarioDraftContext | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [levers, setLevers] = useState<LeverState | null>(null);
  const [preview, setPreview] = useState<Readonly<{
    status: 'idle' | 'pending' | 'ready' | 'failed';
    evaluation: ScenarioEvaluation | null;
    patchKey: string | null;
  }>>({ status: 'idle', evaluation: null, patchKey: null });
  const [applyNotice, setApplyNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const tokenRef = useRef(0);
  const activeDraftId = useRef<string | null>(null);
  /**
   * The acknowledged revision the current `context` was captured against.
   * Capture is LAZY (only once a lever is actually changed) so a plain
   * revision change — every estimate commit at scale — performs no capture,
   * no fact-map build and no main-thread work (Story 23.11 AC 23.11-4).
   */
  const capturedRevisionRef = useRef<number | null>(null);

  const live = useMemo<LeverState>(
    () =>
      Object.freeze({
        policyVersion: plan?.policyVersion ?? 'shared-capacity-v1',
        capacity: plan?.configuration.pointsPerSprint != null ? String(plan.configuration.pointsPerSprint) : '',
        runTogether: false,
      }),
    [plan?.policyVersion, plan?.configuration.pointsPerSprint],
  );

  const revisionKey = result?.projectRevision ?? null;

  const editLevers = useCallback((updater: (prev: LeverState | null) => LeverState) => {
    setLevers((prev) => updater(prev));
  }, []);

  // True once the user has moved any lever away from the live plan. Capture is
  // gated on this, never on a revision change (Story 23.11 AC 23.11-4).
  const leverChanged =
    levers !== null &&
    (levers.policyVersion !== live.policyVersion ||
      levers.capacity !== live.capacity ||
      levers.runTogether);

  // Drop a captured context when the acknowledged revision moves, so the next
  // preview re-captures against the current plan. Nothing is captured until a
  // lever is changed (see the lazy capture effect below).
  useEffect(() => {
    if (context && capturedRevisionRef.current !== revisionKey) {
      activeDraftId.current = null;
      onCancelDraft?.(context.draftId);
      setContext(null);
      setPreview({ status: 'idle', evaluation: null, patchKey: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revisionKey, context]);

  // Lazily capture one draft baseline the first time a lever is changed. An
  // idle panel never captures at all; a revision change while a preview is
  // active drops the context above and this re-captures.
  useEffect(() => {
    if (!canPreview || !leverChanged || context || revisionKey === null) return;
    let cancelled = false;
    setCaptureError(null);
    onCaptureDraft().then(
      (next) => {
        if (cancelled) {
          onCancelDraft?.(next.draftId);
          return;
        }
        capturedRevisionRef.current = revisionKey;
        setContext(next);
      },
      () => {
        if (!cancelled) setCaptureError('The plan could not be read for previewing. Reopen the project and try again.');
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPreview, leverChanged, context, revisionKey]);

  useEffect(() => {
    activeDraftId.current = context?.draftId ?? null;
    return () => {
      const id = activeDraftId.current;
      activeDraftId.current = null;
      if (id) onCancelDraft?.(id);
    };
  }, [context?.draftId, onCancelDraft]);

  const groups = useMemo<readonly ForecastParallelGroup[] | null>(() => {
    if (!levers?.runTogether || !plan) return null;
    const scope = context?.baseline.orderedScope ?? plan.selectedFeatureIds;
    if (scope.length < 2) return null;
    return Object.freeze([Object.freeze({ featureIds: Object.freeze([scope[0], scope[1]]) })]);
  }, [levers?.runTogether, plan, context]);

  const patch = useMemo<ForecastScenarioPatch>(() => {
    if (!levers || !context) return Object.freeze({});
    const next: Record<string, unknown> = {};
    if (levers.policyVersion !== context.policyVersion) next.policyVersion = levers.policyVersion;
    if (levers.capacity.trim() !== '') {
      const v = Number(levers.capacity.trim());
      if (Number.isSafeInteger(v) && v >= 0 && v !== plan?.configuration.pointsPerSprint) next.pointsPerSprint = v;
    }
    if (groups) {
      next.parallelGroups = groups;
    }
    return Object.freeze(next) as ForecastScenarioPatch;
  }, [levers, context, groups, plan?.configuration.pointsPerSprint]);

  const patchKey = useMemo(() => JSON.stringify(patch), [patch]);

  // Evaluate the draft whenever the patch changes (superseding older replies).
  useEffect(() => {
    if (!context || !canPreview) return;
    if (patchKey === '{}') {
      setPreview({ status: 'idle', evaluation: null, patchKey });
      return;
    }
    const token = ++tokenRef.current;
    const draftId = context.draftId;
    setPreview((prev) => ({ status: 'pending', evaluation: prev.evaluation, patchKey: prev.patchKey }));
    onEvaluateDraft(context, patch).then(
      (evaluation) => {
        if (token !== tokenRef.current || activeDraftId.current !== draftId) return;
        setPreview({ status: 'ready', evaluation, patchKey });
      },
      () => {
        if (token !== tokenRef.current || activeDraftId.current !== draftId) return;
        setPreview((prev) => ({ status: 'failed', evaluation: prev.evaluation, patchKey: prev.patchKey }));
      },
    );
  }, [context, patch, patchKey, canPreview, onEvaluateDraft]);

  const previewIsCurrent = preview.status === 'ready' && preview.patchKey === patchKey;
  const previewResult =
    previewIsCurrent && preview.evaluation?.ok ? preview.evaluation.variantResult : null;
  const delta = completionDelta(result, previewResult);
  const dirty = patchKey !== '{}';

  const reset = (): void => {
    setLevers(live);
    setApplyNotice(null);
    // Drop any pending evaluation and captured baseline for a discarded draft.
    if (context) onCancelDraft?.(context.draftId);
    setContext(null);
    capturedRevisionRef.current = null;
    setPreview({ status: 'idle', evaluation: null, patchKey: null });
  };

  const apply = async (): Promise<void> => {
    if (!levers || !plan) return;
    setApplyNotice(null);
    if (levers.policyVersion !== plan.policyVersion) {
      const ok = await onApplyPolicy(levers.policyVersion);
      if (!ok) {
        setApplyNotice('Could not switch pacing mode; resolve any parallel-bucket conflicts first.');
        return;
      }
    }
    if (levers.capacity.trim() !== '') {
      const v = Number(levers.capacity.trim());
      if (Number.isSafeInteger(v) && v >= 0 && v !== plan.configuration.pointsPerSprint) {
        onApplyConfiguration({
          pointsPerSprint: v,
          sprintLengthDays: plan.configuration.sprintLengthDays,
          startSprintOrdinal: plan.configuration.startSprintOrdinal,
          startDate: plan.configuration.startDate,
        });
      }
    }
    if (groups && onApplyGroups) {
      onApplyGroups(context?.baseline.orderedScope ?? plan.selectedFeatureIds, groups);
    }
    setApplyNotice('Applied to the plan.');
  };

  const save = async (): Promise<void> => {
    if (!context || patchKey === '{}') return;
    setSaving(true);
    setSaveNotice(null);
    const outcome = await onSaveScenario({ label: 'Lever preview', patch, context });
    setSaving(false);
    if (outcome.kind === 'saved') setSaveNotice('Saved as scenario.');
    else if (outcome.kind === 'stale') setSaveNotice('The plan changed since the preview; refresh and try again.');
    else setSaveNotice(`Not saved (${outcome.code}).`);
  };

  return (
    <section className="pm-forecast__levers" aria-label="Levers" role="group">
      <p className="pm-forecast__section-title">Try changes</p>

      {captureError && (
        <p role="alert" className="pm-forecast__completion-note pm-forecast__completion-note--warning">
          {captureError}
        </p>
      )}

      {/* Preview card beside the live plan (AC 26.4-2). */}
      {dirty && previewResult && (
        <div className="pm-forecast__preview-card" aria-label="Previewed plan">
          <span className="pm-forecast__preview-label">With these settings</span>
          <span className="pm-forecast__preview-value">Sprint {previewResult.arithmetic?.completionSprint}</span>
          <span className="pm-forecast__preview-date">{previewResult.arithmetic?.completionDate}</span>
          <span
            className={`pm-forecast__preview-delta${
              delta && delta > 0 ? ' pm-forecast__preview-delta--later' : ''
            }`}
          >
            {delta === null ? '—' : delta === 0 ? 'Same completion' : `${delta > 0 ? '+' : ''}${delta} sprints`}
          </span>
        </div>
      )}
      {dirty && preview.status === 'pending' && !previewResult && (
        <p className="pm-forecast__completion-note" role="status">
          Evaluating…
        </p>
      )}
      {dirty && preview.status === 'failed' && (
        <p role="alert" className="pm-forecast__completion-note pm-forecast__completion-note--warning">
          The preview could not be calculated. Your changes are not applied.
        </p>
      )}

      <fieldset className="pm-forecast__levers-group">
        <legend className="pm-forecast__config-label">How work is paced</legend>
        <div className="pm-forecast__pacing" role="radiogroup" aria-label="Pacing mode">
          {(
            [
              { value: 'shared-capacity-v1', label: 'Whole team', hint: 'Everyone works each item in turn' },
              { value: 'staffed-capacity-v1', label: 'Assigned people', hint: "Each item moves at its people's pace" },
            ] as const
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={(levers?.policyVersion ?? live.policyVersion) === option.value}
              className={`pm-forecast__pacing-option${
                (levers?.policyVersion ?? live.policyVersion) === option.value ? ' pm-forecast__pacing-option--on' : ''
              }`}
              onClick={() => editLevers((s) => ({ ...(s ?? live), policyVersion: option.value }))}
            >
              <span className="pm-forecast__pacing-label">{option.label}</span>
              <span className="pm-forecast__pacing-hint">{option.hint}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <div className="pm-forecast__lever-row">
        <span className="pm-forecast__config-label">Team capacity</span>
        <div className="pm-forecast__stepper">
          <button
            type="button"
            className="pm-forecast__stepper-btn"
            aria-label="Lower capacity"
            onClick={() =>
              editLevers((s) => {
                const base = Number((s ?? live).capacity || 0);
                return { ...(s ?? live), capacity: String(Math.max(base - 1, 0)) };
              })
            }
          >
            −
          </button>
          <input
            className="pm-forecast__config-input pm-forecast__stepper-input"
            type="number"
            min={0}
            step={1}
            value={levers?.capacity ?? live.capacity}
            onChange={(e) => editLevers((s) => ({ ...(s ?? live), capacity: e.target.value }))}
            aria-label="Team capacity"
          />
          <button
            type="button"
            className="pm-forecast__stepper-btn"
            aria-label="Raise capacity"
            onClick={() =>
              editLevers((s) => {
                const base = Number((s ?? live).capacity || 0);
                return { ...(s ?? live), capacity: String(base + 1) };
              })
            }
          >
            +
          </button>
        </div>
      </div>

      <label className="pm-forecast__lever-toggle">
        <input
          type="checkbox"
          checked={levers?.runTogether ?? false}
          aria-label="Run the first two items together"
          onChange={(e) => editLevers((s) => ({ ...(s ?? live), runTogether: e.target.checked }))}
        />
        Run the first two items together
      </label>

      <div className="pm-forecast__levers-actions">
        <button type="button" className="pm-forecast__button" onClick={reset} disabled={!dirty}>
          Reset
        </button>
        <button
          type="button"
          className="pm-forecast__button"
          onClick={() => void save()}
          disabled={!dirty || saving || !previewIsCurrent}
        >
          {saving ? 'Saving…' : 'Keep as scenario'}
        </button>
        <button
          type="button"
          className="pm-forecast__button pm-forecast__button--primary"
          onClick={() => void apply()}
          disabled={!dirty}
        >
          Apply to plan
        </button>
      </div>

      {applyNotice && (
        <p role="status" className="pm-forecast__completion-note">
          {applyNotice}
        </p>
      )}
      {saveNotice && (
        <p role="status" className="pm-forecast__completion-note">
          {saveNotice}
        </p>
      )}
      <p className="pm-forecast__completion-note">
        Live plan: {completionText(result ?? undefined)}. Nothing is written until you Apply or Save.
      </p>
    </section>
  );
}
