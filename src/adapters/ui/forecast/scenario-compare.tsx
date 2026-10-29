/**
 * Scenario comparison experience (Story 20.5, UX-DR13, UX-DR14, FR-16, FR-17, Story 23.4, SF-UX8, SF-UX9).
 *
 * A non-modal section in the forecast rail. Shows each saved historical
 * scenario as a row: name, historical-baseline provenance, completion or
 * unavailable state, the changed lever(s), point/capacity deltas,
 * coverage/validity, conditions, and expandable Feature-timing differences.
 * An unchanged whole-set completion with changed item timing reads
 * "Same completion · feature timing changed", never "No change". Scenario
 * deltas compare the variant to its *saved* baseline; the current live
 * result is separately labelled context, never treated as the lever.
 *
 * In Story 23.4 (SF-UX8, SF-UX9): enables staffed scenario creation,
 * editing of captured-person weight overrides and per-item assignment
 * overrides, live draft preview with cleanup and conflict disclosure,
 * save conflict retention with explicit retry/discard, and historical
 * cross-model labeling.
 *
 * No best-scenario recommendation, optimization, apply-to-live action, or
 * chart export. Colour is never the sole channel — every difference carries
 * a sign and before/after text.
 */

import { useEffect, useRef, useState } from 'react';
import type { PersistedForecastScenario, ForecastScenarioPatch } from '../../../domain/forecast/scenario';
import type { ScenarioEvaluation } from '../../../domain/forecast/scenario-evaluate';
import type { ForecastResult } from '../../../domain/forecast/forecast-result';
import type { ScenarioDraftContext } from '../../../application/forecast/scenario-draft-context';
import { describeCause } from './change-summary';
import { ScenarioDraftEditor, type ScenarioSaveOutcome } from './scenario-draft-editor';
import type { ScenarioDraftFields } from './scenario-draft';
import { completionText } from './scenario-format';
import { ScenarioComparison } from './scenario-comparison';
import { unavailableItemLabel, unavailablePersonLabel, type ScenarioNames } from './scenario-explain';

export type { ScenarioSaveOutcome } from './scenario-draft-editor';

export interface ScenarioCompareProps {
  /** The live project; a draft for another project is discarded (AC 23.7-6). */
  readonly projectId: string;
  readonly scenarios: readonly PersistedForecastScenario[];
  readonly evaluations: ReadonlyMap<string, ScenarioEvaluation>;
  /** The current live forecast — shown only as separately labelled context. */
  readonly liveResult: ForecastResult | null;
  /** The live plan's planning level (Epic 21, Story 21.9 AC 6). */
  readonly livePlanningLevel?: import('../../../domain/forecast/forecast-plan.entity').ForecastNodeLevel;
  readonly canCreate: boolean;
  /** The active policy version (Epic 22 Story 22.5 AC 22.5-7). */
  readonly policyVersion?: import('../../../domain/forecast/forecast-plan.entity').ForecastPolicyVersion;
  /** Capture one acknowledged baseline for a new or refreshed draft (Story 23.7). */
  readonly onCaptureDraft: () => Promise<ScenarioDraftContext>;
  /** Evaluate the draft's captured facts + patch in the analysis worker (Story 23.7). */
  readonly onEvaluateDraft: (context: ScenarioDraftContext, patch: ForecastScenarioPatch) => Promise<ScenarioEvaluation>;
  /** Drop a closed or replaced draft's pending evaluation. */
  readonly onCancelDraft?: (draftId: string) => void;
  /** Save with the draft's captured expectations (Story 23.7 AC 23.7-2). */
  readonly onCreate: (params: {
    label: string;
    patch: ForecastScenarioPatch;
    context: ScenarioDraftContext;
  }) => Promise<ScenarioSaveOutcome>;
  readonly onRemove: (scenarioId: string) => void;
  /** An already-open draft (static rendering and controlled entry). */
  readonly initialDraft?: Readonly<{
    context: ScenarioDraftContext;
    fields?: ScenarioDraftFields;
    saveState?: 'stale';
  }>;
}

/**
 * Names for a saved scenario (Story 23.8, AC 23.8-6). People come from the
 * captured roster. Saved scenarios do not capture item titles (the AC forbids
 * adding required fields to released formats), so every item is named by its
 * stable identity with a clear unavailable-title label — never by consulting
 * the current live title, which would make a historical card drift with the
 * graph. Names never change the calculation or the captured identity.
 */
function savedScenarioNames(s: PersistedForecastScenario): ScenarioNames {
  const roster = new Map((s.baseline.roster ?? []).map((p) => [p.id, p.name] as const));
  return {
    person: (id) => roster.get(id) ?? unavailablePersonLabel(id),
    item: (id) => unavailableItemLabel(id),
    level: (s.baseline as { planningLevel?: string }).planningLevel ?? 'Feature',
  };
}

export function ScenarioCompare({
  projectId,
  scenarios,
  evaluations,
  liveResult,
  livePlanningLevel,
  canCreate,
  policyVersion,
  onCaptureDraft,
  onEvaluateDraft,
  onCancelDraft,
  onCreate,
  onRemove,
  initialDraft,
}: ScenarioCompareProps): React.ReactElement {
  const [draft, setDraft] = useState<ScenarioCompareProps['initialDraft'] | null>(initialDraft ?? null);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);

  // A draft belongs to the project it captured; switching projects discards
  // it so a late reply can never reach another project's editor (AC 23.7-6).
  useEffect(() => {
    if (draft && draft.context.projectId !== projectId) setDraft(null);
  }, [draft, projectId]);

  const openDraft = async (): Promise<void> => {
    setCapturing(true);
    setCaptureError(null);
    try {
      const context = await onCaptureDraft();
      if (context.projectId === projectId) setDraft({ context });
    } catch (err) {
      setCaptureError(
        err instanceof Error && err.message.startsWith('FORECAST_PLAN_CORRUPT')
          ? 'A scenario cannot be drafted: stored forecast inputs could not be read.'
          : 'A scenario cannot be drafted right now: the current plan could not be read.',
      );
    } finally {
      setCapturing(false);
    }
  };

  const closeDraft = (): void => {
    setDraft(null);
    queueMicrotask(() => createButtonRef.current?.focus());
  };

  return (
    <section className="pm-forecast__section" aria-label="Scenarios">
      <p className="pm-forecast__section-title">Scenarios</p>

      {liveResult && (
        <p className="pm-forecast__completion-note">
          Current live plan: {completionText(liveResult)} — shown as context; scenario deltas compare each
          variant to its own saved baseline.
        </p>
      )}

      {scenarios.length > 0 && (
        <p className="pm-forecast__completion-note">
          Scenarios keep their captured people and numbers. Saved scenarios do not store item titles, so each item is
          named by its stable identifier; current live titles are never substituted.
        </p>
      )}

      {scenarios.length === 0 && !draft && (
        <p className="pm-forecast__completion-note">No saved scenarios.</p>
      )}

      <ul className="pm-forecast__cause-list">
        {scenarios.map((s) => {
          const evaluation = evaluations.get(s.scenarioId);
          // Story 21.9 AC 6, 23.4 AC 23.4-5 and 23.8 AC 23.8-4 (D1): a scenario
          // captured at another level or under another model stays readable
          // as its own baseline-to-variant comparison, with the mismatch to
          // the live plan labelled — never hidden, never compared with live.
          const capturedLevel = (s.baseline as { planningLevel?: string }).planningLevel ?? 'Feature';
          const crossLevel = livePlanningLevel !== undefined && capturedLevel !== livePlanningLevel;
          const capturedPolicy = s.policyVersion ?? 'shared-capacity-v1';
          const crossPolicy = policyVersion !== undefined && capturedPolicy !== policyVersion;
          const names = savedScenarioNames(s);

          return (
            <li key={s.scenarioId} className="pm-forecast__cause">
              <div className="pm-forecast__scenario-head">
                <strong>{s.label}</strong>{' '}
                <span className="pm-forecast__completion-note">Based on revision {s.baselineRevision}</span>
                <span className="pm-forecast__scenario-level-badge">
                  Captured at {capturedLevel} level ·{' '}
                  {capturedPolicy === 'staffed-capacity-v1' ? 'Staffed Capacity' : 'Shared Capacity'}
                </span>
                <button
                  type="button"
                  className="pm-forecast__button pm-forecast__button--small"
                  aria-label={`Remove scenario ${s.label}`}
                  onClick={() => onRemove(s.scenarioId)}
                >
                  Remove
                </button>
              </div>

              {crossLevel && (
                <p className="pm-forecast__completion-note pm-forecast__completion-note--warning">
                  Captured at {capturedLevel} level; the live plan is now at {livePlanningLevel} level. This
                  comparison is the scenario&apos;s own captured baseline against its variant — it is not compared
                  with live facts.
                </p>
              )}
              {crossPolicy && (
                <p className="pm-forecast__completion-note">
                  Captured under the {capturedPolicy === 'staffed-capacity-v1' ? 'Staffed' : 'Shared'} Capacity
                  model. The comparison uses that captured model against its own saved baseline.
                </p>
              )}

              {!evaluation ? (
                <p className="pm-forecast__completion-note">Evaluating…</p>
              ) : (
                <ScenarioComparison evaluation={evaluation} names={names} disclosureLabel={s.label} showTotals />
              )}
            </li>
          );
        })}
      </ul>

      {draft ? (
        <ScenarioDraftEditor
          key={draft.context.draftId}
          context={draft.context}
          initialFields={draft.fields}
          initialSaveState={draft.saveState}
          onEvaluate={onEvaluateDraft}
          onCancelEvaluation={onCancelDraft}
          onCapture={onCaptureDraft}
          onSave={onCreate}
          onClose={closeDraft}
        />
      ) : (
        <>
          <button
            ref={createButtonRef}
            type="button"
            className="pm-forecast__button pm-forecast__button--small"
            disabled={!canCreate || capturing}
            onClick={() => void openDraft()}
          >
            {capturing ? 'Capturing baseline…' : 'Create scenario…'}
          </button>
          {captureError && (
            <p role="alert" className="pm-forecast__completion-note pm-forecast__completion-note--warning">
              {captureError}
            </p>
          )}
        </>
      )}
    </section>
  );
}
