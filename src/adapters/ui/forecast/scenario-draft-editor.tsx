/**
 * Scenario draft editor (Story 23.4; repaired in Story 23.7, AC 23.7-1..7,
 * and Story 23.9).
 *
 * The editor edits against one captured context and nothing else: its
 * items, titles, roster, assignments and configuration all come from the
 * capture, never from live props, so a live edit cannot change the draft or
 * its preview. Evaluation runs in the analysis worker through
 * `onEvaluate`; only the reply for the latest patch of the active draft can
 * be shown, and while a newer one is pending the previous preview stays
 * visible, labelled as belonging to earlier edits. Save sends the captured
 * expectations; a stale save keeps every entered value and offers an
 * explicit Refresh baseline (which re-captures and revalidates preserved
 * overrides, then previews without saving) or Discard.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ForecastScenarioPatch } from '../../../domain/forecast/scenario';
import type { ScenarioEvaluation } from '../../../domain/forecast/scenario-evaluate';
import type { ScenarioDraftContext } from '../../../application/forecast/scenario-draft-context';
import { STAFFED_FORECAST_POLICY_VERSION } from '../../../domain/forecast/forecast-plan.entity';
import { formatStaffingWeightUnits } from '../../../domain/forecast/forecast-validators';
import { WEIGHT_FIELD_ERROR } from './people-editor';
import {
  buildDraftPatch,
  describeBaselineChanges,
  draftScope,
  EMPTY_DRAFT_FIELDS,
  hasFieldErrors,
  isDraftDirty,
  revalidateDraft,
  type ScenarioDraftFields,
} from './scenario-draft';
import { ScenarioComparison } from './scenario-comparison';
import { unavailableItemLabel, unavailablePersonLabel, type ScenarioNames } from './scenario-explain';

export type ScenarioSaveOutcome =
  | Readonly<{ kind: 'saved' }>
  | Readonly<{ kind: 'stale' }>
  | Readonly<{ kind: 'rejected'; code: string }>;

export interface ScenarioDraftEditorProps {
  readonly context: ScenarioDraftContext;
  readonly initialFields?: ScenarioDraftFields;
  readonly initialSaveState?: 'stale';
  readonly onEvaluate: (context: ScenarioDraftContext, patch: ForecastScenarioPatch) => Promise<ScenarioEvaluation>;
  readonly onCancelEvaluation?: (draftId: string) => void;
  readonly onCapture: () => Promise<ScenarioDraftContext>;
  readonly onSave: (params: {
    label: string;
    patch: ForecastScenarioPatch;
    context: ScenarioDraftContext;
  }) => Promise<ScenarioSaveOutcome>;
  /** Close the editor; `saved` is true after a committed save. */
  readonly onClose: (saved: boolean) => void;
}

type Preview = Readonly<{
  status: 'idle' | 'pending' | 'ready' | 'failed';
  /** The last result shown, and the patch it was computed for. */
  shown: Readonly<{ evaluation: ScenarioEvaluation; patchKey: string; draftId: string }> | null;
  error: string | null;
}>;

type SaveState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'saving' }>
  | Readonly<{ kind: 'stale' }>
  | Readonly<{ kind: 'refreshing' }>
  | Readonly<{ kind: 'error'; message: string }>;

/** Errors a newer request, a closed draft or a stopped worker produce: not failures of this draft. */
function isSupersession(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'SCENARIO_EVALUATION_SUPERSEDED' || code === 'SCENARIO_EVALUATION_CANCELLED';
}

export function ScenarioDraftEditor({
  context: initialContext,
  initialFields,
  initialSaveState,
  onEvaluate,
  onCancelEvaluation,
  onCapture,
  onSave,
  onClose,
}: ScenarioDraftEditorProps): React.ReactElement {
  const [context, setContext] = useState(initialContext);
  const [fields, setFields] = useState<ScenarioDraftFields>(initialFields ?? EMPTY_DRAFT_FIELDS);
  const [saveState, setSaveState] = useState<SaveState>(initialSaveState === 'stale' ? { kind: 'stale' } : { kind: 'idle' });
  /** Contexts the draft has been edited against, newest last — names for revalidation errors. */
  const [history, setHistory] = useState<readonly ScenarioDraftContext[]>([initialContext]);
  const [refreshNotice, setRefreshNotice] = useState<Readonly<{ from: number; to: number; changes: readonly string[] }> | null>(null);
  const [preview, setPreview] = useState<Preview>({ status: 'idle', shown: null, error: null });
  const [retryNonce, setRetryNonce] = useState(0);
  const [errorsShown, setErrorsShown] = useState(false);
  const [weightsTouched, setWeightsTouched] = useState<ReadonlySet<string>>(new Set());
  /** Story 23.8 AC 23.8-5 (D2): a dirty draft asks before it is discarded. */
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);

  /** Bumped to move focus to the notices after they render (they are hidden while empty). */
  const [alertFocusRequest, setAlertFocusRequest] = useState(0);
  const requestCounter = useRef(0);
  const activeDraftId = useRef<string | null>(initialContext.draftId);
  const weightRefs = useRef(new Map<string, HTMLInputElement>());
  const alertRef = useRef<HTMLDivElement>(null);

  const staffed = context.policyVersion === STAFFED_FORECAST_POLICY_VERSION;
  const roster = context.baseline.roster ?? [];
  const capturedAssignments = context.baseline.assignments ?? {};
  const scope = draftScope(fields, context);

  const { patch, errors } = useMemo(() => buildDraftPatch(fields, context), [fields, context]);
  const patchKey = useMemo(() => JSON.stringify(patch), [patch]);

  const labels = useMemo(() => {
    const person = (id: string): string => {
      for (let i = history.length - 1; i >= 0; i--) {
        const p = history[i].baseline.roster?.find((r) => r.id === id);
        if (p) return p.name;
      }
      return unavailablePersonLabel(id);
    };
    const item = (id: string): string => {
      for (let i = history.length - 1; i >= 0; i--) {
        const found = history[i].items.find((it) => it.id === id);
        if (found?.title) return found.title;
      }
      return unavailableItemLabel(id);
    };
    return { person, item };
  }, [history]);
  const names: ScenarioNames = useMemo(
    () => ({ ...labels, level: context.planningLevel }),
    [labels, context.planningLevel],
  );

  const dirty = isDraftDirty(fields);

  /** Cancel, Escape: close a clean draft; ask before discarding a dirty one. */
  const requestClose = (): void => {
    if (!dirty) {
      onClose(false);
      return;
    }
    const active = document.activeElement;
    returnFocusRef.current = active instanceof HTMLElement ? active : null;
    setConfirmingDiscard(true);
  };
  const keepEditing = (): void => {
    setConfirmingDiscard(false);
    const target = returnFocusRef.current;
    queueMicrotask(() => target?.focus());
  };

  useEffect(() => {
    if (confirmingDiscard) keepEditingRef.current?.focus();
  }, [confirmingDiscard]);

  const referenceErrors = useMemo(() => revalidateDraft(fields, context, labels), [fields, context, labels]);
  const blocked = hasFieldErrors(errors) || referenceErrors.length > 0;

  useEffect(() => {
    if (alertFocusRequest > 0) alertRef.current?.focus();
  }, [alertFocusRequest]);

  // Cancel the active draft's evaluation when it is ACTUALLY replaced or the
  // editor unmounts — never on a mere parent rerender (review L5). Main
  // recreates `onCancelEvaluation` every render, so depending on it directly
  // ran this cleanup on every parent update, rejecting the in-flight preview;
  // the evaluation effect (which keys on draftId/patch/blocked) then did not
  // re-run, stranding the draft on "Previous preview: Updating…". Holding the
  // callback in a ref keeps the destructive effect keyed only on draftId.
  const cancelEvaluationRef = useRef(onCancelEvaluation);
  useEffect(() => {
    cancelEvaluationRef.current = onCancelEvaluation;
  }, [onCancelEvaluation]);

  useEffect(() => {
    activeDraftId.current = context.draftId;
    const draftId = context.draftId;
    return () => {
      activeDraftId.current = null;
      cancelEvaluationRef.current?.(draftId);
    };
  }, [context.draftId]);

  // ── Worker evaluation of the captured facts + current patch (AC 23.7-4/-5/-6) ──
  useEffect(() => {
    if (blocked) {
      setPreview((prev) => (prev.status === 'pending' ? { ...prev, status: 'idle' } : prev));
      return;
    }
    const token = ++requestCounter.current;
    const draftId = context.draftId;
    setPreview((prev) => ({ status: 'pending', shown: prev.shown, error: null }));
    onEvaluate(context, patch).then(
      (evaluation) => {
        if (token !== requestCounter.current || activeDraftId.current !== draftId) return;
        setPreview({ status: 'ready', shown: { evaluation, patchKey, draftId }, error: null });
      },
      (err: unknown) => {
        if (isSupersession(err) || token !== requestCounter.current || activeDraftId.current !== draftId) return;
        setPreview((prev) => ({
          status: 'failed',
          shown: prev.shown,
          error: 'The preview could not be calculated. Your draft is kept.',
        }));
      },
    );
    // `patchKey` stands for `patch`; `context` changes only with its draftId.
  }, [context.draftId, patchKey, blocked, retryNonce]);

  const setField = <K extends keyof ScenarioDraftFields>(key: K, value: ScenarioDraftFields[K]): void =>
    setFields((prev) => Object.freeze({ ...prev, [key]: value }));

  const save = async (): Promise<void> => {
    if (blocked) {
      setErrorsShown(true);
      setWeightsTouched(new Set(errors.weights));
      if (errors.weights.length > 0) weightRefs.current.get(errors.weights[0])?.focus();
      else setAlertFocusRequest((n) => n + 1);
      return;
    }
    setSaveState({ kind: 'saving' });
    const draftId = context.draftId;
    const outcome = await onSave({ label: fields.label.trim() || 'Untitled scenario', patch, context });
    if (activeDraftId.current !== draftId) return;
    if (outcome.kind === 'saved') {
      onClose(true);
    } else if (outcome.kind === 'stale') {
      setSaveState({ kind: 'stale' });
      setAlertFocusRequest((n) => n + 1);
    } else {
      setSaveState({ kind: 'error', message: `The scenario was not saved (${outcome.code}). Your draft is kept.` });
      setAlertFocusRequest((n) => n + 1);
    }
  };

  const refreshBaseline = async (): Promise<void> => {
    setSaveState({ kind: 'refreshing' });
    let next: ScenarioDraftContext;
    try {
      next = await onCapture();
    } catch {
      setSaveState({ kind: 'error', message: 'The current plan could not be read. Your draft is kept; try again.' });
      return;
    }
    const previous = context;
    setRefreshNotice({ from: previous.baselineRevision, to: next.baselineRevision, changes: describeBaselineChanges(previous, next) });
    setHistory((h) => [...h, next]);
    setContext(next);
    setSaveState({ kind: 'idle' });
    setErrorsShown(true);
    setAlertFocusRequest((n) => n + 1);
  };

  const previewIsCurrent =
    preview.status === 'ready' && preview.shown?.patchKey === patchKey && preview.shown.draftId === context.draftId;
  const shown = preview.shown?.draftId === context.draftId ? preview.shown : null;

  return (
    <div
      className="pm-forecast__config pm-forecast__scenario-draft"
      role="group"
      aria-label="Scenario draft"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        if (confirmingDiscard) keepEditing();
        else requestClose();
      }}
    >
      {confirmingDiscard && (
        <div
          role="alertdialog"
          aria-modal="false"
          aria-labelledby="pm-scenario-discard-title"
          aria-describedby="pm-scenario-discard-body"
          className="pm-forecast__scenario-discard"
        >
          <p id="pm-scenario-discard-title">
            <strong>Discard this scenario draft?</strong>
          </p>
          <p id="pm-scenario-discard-body" className="pm-forecast__completion-note">
            Your name, overrides and assignments for this draft will be lost. Nothing has been saved.
          </p>
          <div className="pm-forecast__group-bar">
            <button
              ref={keepEditingRef}
              type="button"
              className="pm-forecast__button pm-forecast__button--small"
              onClick={keepEditing}
            >
              Keep editing
            </button>
            <button type="button" className="pm-forecast__button pm-forecast__button--small" onClick={() => onClose(false)}>
              Discard draft
            </button>
          </div>
        </div>
      )}
      <div className="pm-forecast__scenario-draft-body" inert={confirmingDiscard}>
      <div className="pm-forecast__scenario-draft-context">
        <strong>Baseline:</strong> captured at revision {context.baselineRevision} ·{' '}
        <strong>Model:</strong> {staffed ? 'Staffed Capacity' : 'Shared Capacity'} · <strong>Level:</strong>{' '}
        {context.planningLevel}
      </div>

      <div ref={alertRef} tabIndex={-1} className="pm-forecast__scenario-alerts">
        {refreshNotice && (
          <div role="status" className="pm-forecast__completion-note">
            <p>
              Baseline refreshed from revision {refreshNotice.from} to {refreshNotice.to}.{' '}
              {refreshNotice.changes.length === 0
                ? 'No forecast inputs changed; review the preview, then save again.'
                : 'Changed since your draft began — review the preview before saving again:'}
            </p>
            {refreshNotice.changes.length > 0 && (
              <ul className="pm-forecast__scenario-changes">
                {refreshNotice.changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {referenceErrors.length > 0 && (
          <div role="alert" className="pm-forecast__completion-note pm-forecast__completion-note--warning">
            <p>Some of your overrides no longer match the captured plan:</p>
            <ul className="pm-forecast__scenario-changes">
              {referenceErrors.map((e) => (
                <li key={e.key}>
                  {e.message}{' '}
                  <button
                    type="button"
                    className="pm-forecast__button pm-forecast__button--small"
                    onClick={() => setFields((f) => e.resolve(f))}
                  >
                    Remove override
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {saveState.kind === 'stale' && (
          <div role="alert" className="pm-forecast__completion-note pm-forecast__completion-note--warning">
            Not saved: the live plan changed after this draft captured revision {context.baselineRevision}. Your edits
            are kept. Refresh the baseline to check them against the current plan, or discard the draft.
          </div>
        )}
        {saveState.kind === 'error' && (
          <div role="alert" className="pm-forecast__completion-note pm-forecast__completion-note--warning">
            {saveState.message}
          </div>
        )}
        {errorsShown && (errors.capacity || errors.points.length > 0) && (
          <div role="alert" className="pm-forecast__completion-note pm-forecast__completion-note--warning">
            {errors.capacity && <p>Capacity / sprint must be a whole non-negative number of points.</p>}
            {errors.points.map((id) => (
              <p key={id}>Point override for {labels.item(id)} must be a whole non-negative number of points.</p>
            ))}
          </div>
        )}
      </div>

      <label className="pm-forecast__config-field">
        <span>Scenario name</span>
        <input
          className="pm-forecast__config-input"
          value={fields.label}
          onChange={(e) => setField('label', e.target.value)}
          aria-label="Scenario name"
          placeholder="Untitled scenario"
        />
      </label>

      {staffed && roster.length > 0 && (
        <fieldset className="pm-forecast__config-field">
          <legend>Team member weight overrides</legend>
          <p className="pm-forecast__completion-note">
            Roster membership is fixed. Leave a weight blank to keep the captured value, or enter a relative weight
            such as 1.5 or 0.25.
          </p>
          {roster.map((person) => {
            const errorId = `pm-scenario-weight-error-${person.id}`;
            const showError = weightsTouched.has(person.id) && errors.weights.includes(person.id);
            return (
              <div key={person.id} className="pm-forecast__arithmetic-row">
                <span>{person.name}</span>
                <label>
                  <span>Weight: </span>
                  <input
                    ref={(el) => {
                      if (el) weightRefs.current.set(person.id, el);
                      else weightRefs.current.delete(person.id);
                    }}
                    className="pm-forecast__config-input"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={fields.weightOverrides[person.id] ?? ''}
                    placeholder={formatStaffingWeightUnits(person.weightUnits)}
                    aria-label={`${person.name} weight override`}
                    aria-invalid={showError || undefined}
                    aria-describedby={showError ? errorId : undefined}
                    onChange={(e) => setField('weightOverrides', Object.freeze({ ...fields.weightOverrides, [person.id]: e.target.value }))}
                    onBlur={() => setWeightsTouched((prev) => (prev.has(person.id) ? prev : new Set(prev).add(person.id)))}
                  />
                </label>
                {showError && (
                  <p id={errorId} className="pm-forecast__completion-note pm-forecast__completion-note--warning">
                    {person.name}: {WEIGHT_FIELD_ERROR}
                  </p>
                )}
              </div>
            );
          })}
        </fieldset>
      )}

      <fieldset className="pm-forecast__config-field">
        <legend>Scenario scope, order, estimates{staffed ? ', and assignments' : ''}</legend>
        {context.items.map((item) => {
          const name = item.title || unavailableItemLabel(item.id);
          const included = scope.includes(item.id);
          const index = scope.indexOf(item.id);
          const rawOverride = fields.pointOverrides[item.id] ?? '';
          const effectivePoints = rawOverride.trim() !== '' ? Number(rawOverride) : item.effortPoints;
          const isZeroWork = effectivePoints === 0;
          const assigned = fields.assignmentOverrides[item.id] ?? capturedAssignments[item.id] ?? [];
          const move = (delta: -1 | 1) =>
            setField(
              'scope',
              Object.freeze(
                (() => {
                  const next = [...scope];
                  [next[index + delta], next[index]] = [next[index], next[index + delta]];
                  return next;
                })(),
              ),
            );
          return (
            <div key={item.id} className="pm-forecast__scenario-draft-row">
              <div className="pm-forecast__group-bar">
                <label>
                  <input
                    type="checkbox"
                    checked={included}
                    aria-label={`Include ${name} in scenario`}
                    onChange={() =>
                      setField('scope', Object.freeze(included ? scope.filter((id) => id !== item.id) : [...scope, item.id]))
                    }
                  />
                  {name}
                </label>
                <button type="button" disabled={!included || index === 0} aria-label={`Move ${name} earlier`} onClick={() => move(-1)}>
                  ↑
                </button>
                <button
                  type="button"
                  disabled={!included || index < 0 || index === scope.length - 1}
                  aria-label={`Move ${name} later`}
                  onClick={() => move(1)}
                >
                  ↓
                </button>
                <label>
                  Points override
                  <input
                    className="pm-forecast__config-input"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    disabled={!included}
                    value={rawOverride}
                    placeholder={item.effortPoints === null ? 'unknown' : String(item.effortPoints)}
                    aria-label={`Point override for ${name}`}
                    aria-invalid={(errorsShown && errors.points.includes(item.id)) || undefined}
                    onChange={(e) => setField('pointOverrides', Object.freeze({ ...fields.pointOverrides, [item.id]: e.target.value }))}
                  />
                </label>
              </div>

              {staffed && included && roster.length > 0 && (
                <div className="pm-forecast__scenario-assignments">
                  <span className="pm-forecast__scenario-assignments-label">Assignments:</span>
                  {isZeroWork ? (
                    <span className="pm-forecast__completion-note">Zero-work item — assignments not permitted</span>
                  ) : (
                    roster.map((person) => (
                      <label key={person.id} className="pm-forecast__scenario-person-chip">
                        <input
                          type="checkbox"
                          checked={assigned.includes(person.id)}
                          aria-label={`Assign ${person.name} to ${name}`}
                          onChange={(e) =>
                            setField(
                              'assignmentOverrides',
                              Object.freeze({
                                ...fields.assignmentOverrides,
                                [item.id]: Object.freeze(
                                  e.target.checked ? [...assigned, person.id] : assigned.filter((id) => id !== person.id),
                                ),
                              }),
                            )
                          }
                        />
                        {person.name}
                      </label>
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })}
      </fieldset>

      <label className="pm-forecast__config-field">
        <span>Capacity / sprint override</span>
        <input
          className="pm-forecast__config-input"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={fields.capacity}
          onChange={(e) => setField('capacity', e.target.value)}
          aria-label="Scenario capacity override"
          aria-invalid={(errorsShown && errors.capacity) || undefined}
          placeholder={
            context.baseline.configuration.pointsPerSprint === null
              ? 'unchanged'
              : `unchanged (${context.baseline.configuration.pointsPerSprint})`
          }
        />
      </label>

      <div className="pm-forecast__scenario-preview-card" aria-label="Draft scenario preview" aria-busy={preview.status === 'pending'}>
        <strong>{previewIsCurrent ? 'Preview' : shown ? 'Previous preview' : 'Preview'}: </strong>
        {blocked ? (
          <span className="pm-forecast__completion-note">
            {errors.weights.length > 0
              ? 'Preview paused until every weight override is valid.'
              : 'Preview paused until the flagged fields are corrected.'}
          </span>
        ) : (
          <>
            {preview.status === 'pending' && (
              <span className="pm-forecast__completion-note" role="status">
                {shown ? 'Updating for your latest edits — the result below is for earlier edits.' : 'Evaluating…'}
              </span>
            )}
            {preview.status === 'failed' && (
              <span role="alert" className="pm-forecast__completion-note pm-forecast__completion-note--warning">
                {preview.error}{' '}
                <button
                  type="button"
                  className="pm-forecast__button pm-forecast__button--small"
                  onClick={() => setRetryNonce((n) => n + 1)}
                >
                  Retry preview
                </button>
              </span>
            )}
            {shown && <ScenarioComparison evaluation={shown.evaluation} names={names} disclosureLabel="the draft" />}
          </>
        )}
      </div>

      <p className="pm-forecast__completion-note">
        Inherited from the captured baseline:{' '}
        {staffed
          ? `roster membership, model (Staffed Capacity), planning level (${context.planningLevel}), parallel groups, blockers, start anchor, sprint length`
          : 'scope, order, groups, blockers, start anchor, sprint length'}
        . Only the fields above change.
      </p>

      {saveState.kind === 'stale' ? (
        <div className="pm-forecast__group-bar">
          <button
            type="button"
            className="pm-forecast__button pm-forecast__button--primary pm-forecast__button--small"
            onClick={() => void refreshBaseline()}
          >
            Refresh baseline
          </button>
          <button type="button" className="pm-forecast__button pm-forecast__button--small" onClick={() => onClose(false)}>
            Discard draft
          </button>
        </div>
      ) : (
        <div className="pm-forecast__group-bar">
          <button
            type="button"
            className="pm-forecast__button pm-forecast__button--primary pm-forecast__button--small"
            disabled={saveState.kind === 'saving' || saveState.kind === 'refreshing'}
            onClick={() => void save()}
          >
            {saveState.kind === 'saving' ? 'Saving…' : 'Save scenario'}
          </button>
          <button type="button" className="pm-forecast__button pm-forecast__button--small" onClick={requestClose}>
            Cancel
          </button>
        </div>
      )}
      </div>
    </div>
  );
}
