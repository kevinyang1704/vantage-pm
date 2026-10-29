import { useEffect, useId, useRef, useState } from 'react';
import type { MergeReview } from '../../../application/portable-file/local-merge';
import './local-file-dialog.css';

export type LocalFileDecision = 'accept' | 'decline' | 'defer';

export interface LocalFileDialogProps {
  readonly fileName: string;
  readonly projectName: string;
  readonly projects: readonly Readonly<{ id: string; name: string }>[];
  readonly mode: 'standalone' | 'merge';
  readonly onModeChange: (mode: 'standalone' | 'merge') => void;
  readonly targetId: string;
  readonly onTargetChange: (id: string) => void;
  readonly parentId: string;
  readonly onParentChange: (id: string) => void;
  readonly parents: readonly Readonly<{ id: string; title: string }>[];
  readonly linked: boolean;
  readonly canLink: boolean;
  readonly onLinkedChange: (linked: boolean) => void;
  readonly review: MergeReview | null;
  readonly choices: Readonly<Record<string, LocalFileDecision>>;
  readonly onChoice: (id: string, decision: LocalFileDecision) => void;
  readonly onAcceptSafe: () => void;
  readonly onReviewDeclined: () => void;
  readonly showDeclined: boolean;
  readonly forceBranch: boolean;
  readonly onForceBranchChange: (value: boolean) => void;
  readonly error: string | null;
  readonly busy: boolean;
  readonly preparing: boolean;
  readonly onApprove: () => void;
  readonly onCancel: () => void;
}

const FIELD_NAMES: Readonly<Record<string, string>> = {
  id: 'Identifier', parentId: 'Parent', title: 'Title', bodyText: 'Brief', position: 'Order',
  nodeType: 'Type', startDate: 'Start date', endDate: 'End date', durationDays: 'Duration in days',
  scheduleSourceMode: 'Date inputs', completed: 'Completed', effortPoints: 'Effort', effortPointsDone: 'Points done',
  strategicWeight: 'Strategic weight', phaseId: 'Phase', deliveryStatus: 'Delivery status',
  sourceNodeId: 'From item', targetNodeId: 'To item', nodeId: 'Item', fieldKey: 'Field', fieldValue: 'Value',
  fieldLabel: 'Label', questionText: 'Question', decisionText: 'Decision', status: 'Status',
  resolvedAtISO: 'Decided at', createdAtISO: 'Created at', selectedFeatureIds: 'Forecast scope',
  parallelGroups: 'Parallel groups', blockedFeatureIds: 'Blocked items', pointsPerSprint: 'Points per sprint',
  sprintLengthDays: 'Sprint length in days', startSprintOrdinal: 'Starting sprint', cadence: 'Cadence',
  policyVersion: 'Forecast method', planningLevel: 'Planning level', roster: 'People', assignments: 'Assignments',
  featureIds: 'Items', personId: 'Person', displayName: 'Name',
};
function displayValue(value: unknown, review: MergeReview | null): string {
  if (value === undefined) return 'Not present';
  if (value === null) return 'Not set';
  if (typeof value === 'string') return value.length > 0 ? value : '(empty)';
  const names = new Map([
    ...(review?.local.nodes ?? []).map(n => [n.id, n.title] as const),
    ...(review?.proposed.nodes ?? []).map(n => [n.id, n.title] as const),
    ...(review?.local.phases ?? []).map(n => [n.id, n.name] as const),
    ...(review?.proposed.phases ?? []).map(n => [n.id, n.name] as const),
  ]);
  const readable = (entry: unknown): unknown => {
    if (typeof entry === 'string') return names.get(entry) ?? ({ not_started: 'Not started', in_progress: 'In progress', delivered: 'Delivered', OPEN: 'Open', DECIDED: 'Decided' } as Record<string, string>)[entry] ?? entry;
    if (Array.isArray(entry)) return entry.map(readable);
    if (entry && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).map(([key, child]) => [FIELD_NAMES[key] ?? key, readable(child)]));
    return entry;
  };
  return JSON.stringify(readable(value), null, 2) ?? 'Not present';
}

/** A controlled review surface: selecting a file never commits project changes. */
export function LocalFileDialog(props: LocalFileDialogProps): React.ReactElement {
  const id = useId();
  const [visibleCount, setVisibleCount] = useState(100);
  useEffect(() => { setVisibleCount(100); }, [props.review]);
  const rootRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const latest = useRef({ busy: props.busy, cancel: props.onCancel });
  latest.current = { busy: props.busy, cancel: props.onCancel };
  const unavailable = props.busy || props.preparing;
  const unresolved = props.mode === 'merge' && (props.review?.changes.some(
    (change) => change.conflict && props.choices[change.id] === undefined,
  ) ?? false);
  const cannotApply = unavailable || props.error !== null || (
    props.mode === 'merge' && (!props.targetId || !props.review || unresolved)
  );
  const acceptedCount = props.review?.changes.filter((change) => (
    props.choices[change.id] ?? change.defaultDecision
  ) === 'accept').length ?? 0;

  useEffect(() => {
    const invoker = document.activeElement;
    cancelRef.current?.focus();
    const outsideKey = (event: KeyboardEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!latest.current.busy) latest.current.cancel();
      } else if (event.key === 'Tab') {
        event.preventDefault(); event.stopImmediatePropagation(); cancelRef.current?.focus();
      }
    };
    const retainFocus = (event: FocusEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) cancelRef.current?.focus();
    };
    document.addEventListener('keydown', outsideKey, true);
    document.addEventListener('focusin', retainFocus);
    return () => {
      document.removeEventListener('keydown', outsideKey, true);
      document.removeEventListener('focusin', retainFocus);
      if (invoker instanceof HTMLElement && invoker.isConnected) invoker.focus();
    };
  }, []);

  return (
    <div className="pm-local-file-backdrop">
      <div
        ref={rootRef}
        className="pm-local-file-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        aria-busy={unavailable}
        tabIndex={-1}
        onKeyDown={(event) => {
          // Keep authoring shortcuts behind the modal from changing the plan.
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            if (!props.busy) props.onCancel();
          }
          if (event.key !== 'Tab') return;
          const controls = Array.from(rootRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
          ) ?? []).filter((element) => element.getClientRects().length > 0);
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (!first || !last) {
            event.preventDefault();
            rootRef.current?.focus();
          } else if (event.shiftKey && (document.activeElement === first || document.activeElement === rootRef.current)) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === rootRef.current)) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header className="pm-local-file-dialog__header">
          <div>
            <p className="pm-local-file-dialog__eyebrow">Local file exchange</p>
            <h2 id={`${id}-title`}>Import “{props.projectName}”</h2>
          </div>
          <button
            ref={cancelRef}
            type="button"
            className="pm-local-file-dialog__button"
            disabled={props.busy}
            onClick={props.onCancel}
            aria-label="Cancel import"
          >Close</button>
        </header>

        <div className="pm-local-file-dialog__body">
          <p id={`${id}-description`} className="pm-local-file-dialog__copy">
            Review this file before changing your plan. You approve what is imported; no server is involved.
          </p>
          <p className="pm-local-file-dialog__filename">File: {props.fileName}</p>
          <fieldset className="pm-local-file-dialog__modes" disabled={unavailable}>
            <legend>How would you like to import it?</legend>
            <label>
              <input type="radio" name={`${id}-mode`} checked={props.mode === 'standalone'} onChange={() => props.onModeChange('standalone')} />
              <span>Import as standalone project</span>
            </label>
            <label>
              <input type="radio" name={`${id}-mode`} checked={props.mode === 'merge'} onChange={() => props.onModeChange('merge')} />
              <span>Merge into existing project</span>
            </label>
          </fieldset>

          {props.mode === 'standalone' ? (
            <section className="pm-local-file-dialog__region" aria-label="Standalone import options">
              <p className="pm-local-file-dialog__copy">Your existing projects stay unchanged.</p>
              {props.canLink ? (
                <>
                  <label className="pm-local-file-dialog__check">
                    <input type="checkbox" checked={props.linked} disabled={unavailable} onChange={(event) => props.onLinkedChange(event.target.checked)} />
                    Keep linked for future file exchanges
                  </label>
                  <p className="pm-local-file-dialog__hint">Keep shared item identities to return edits to your teammate. Uncheck to create an independent copy.</p>
                </>
              ) : <p className="pm-local-file-dialog__hint">This file creates an independent project. Use Share for editing for future exchanges.</p>}
            </section>
          ) : (
            <section className="pm-local-file-dialog__region" aria-labelledby={`${id}-merge-heading`}>
              <h3 id={`${id}-merge-heading`}>Choose where the contribution goes</h3>
              <label className="pm-local-file-dialog__field" htmlFor={`${id}-target`}>
                Destination project
                <select id={`${id}-target`} value={props.targetId} disabled={unavailable} onChange={(event) => props.onTargetChange(event.target.value)}>
                  <option value="">Choose a project</option>
                  {props.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </label>
              {props.projects.length === 0 ? <p className="pm-local-file-dialog__hint">Create a project first, or import this file as a standalone project.</p> : null}
              <label className="pm-local-file-dialog__check">
                <input type="checkbox" checked={props.forceBranch} disabled={unavailable} onChange={event => props.onForceBranchChange(event.target.checked)} />
                Add as a separate branch instead of matching shared items
              </label>
              {props.review?.mode === 'branch' ? (
                <>
                  <p className="pm-local-file-dialog__copy">This contribution has no shared editing history with the destination. Add it as a new branch; matching titles are kept separate.</p>
                  <label className="pm-local-file-dialog__field" htmlFor={`${id}-parent`}>
                    Add branch beneath
                    <select id={`${id}-parent`} value={props.review.branch?.parentId ?? props.parentId} disabled={unavailable || Boolean(props.review.branchKey && props.review.state.branches[props.review.branchKey])} onChange={(event) => props.onParentChange(event.target.value)}>
                      <option value="">Project root</option>
                      {props.parents.map((parent) => <option key={parent.id} value={parent.id}>{parent.title}</option>)}
                    </select>
                  </label>
                  {props.review.branchKey && props.review.state.branches[props.review.branchKey] ? <p className="pm-local-file-dialog__hint">This branch was imported before. Its original destination is remembered; move its items in the outline to reorganize them.</p> : null}
                </>
              ) : props.review ? <p className="pm-local-file-dialog__copy">Shared editing history found. Review your teammate’s changes alongside your current plan.</p> : null}

              {props.review ? (
                <section className="pm-local-file-dialog__review" aria-labelledby={`${id}-review-heading`}>
                  <div className="pm-local-file-dialog__review-header">
                    <h3 id={`${id}-review-heading`}>Review changes</h3>
                    <span className="pm-local-file-dialog__hint" role="status">{acceptedCount} selected of {props.review.changes.length}</span>
                  </div>
                  <div className="pm-local-file-dialog__tools">
                    <button type="button" className="pm-local-file-dialog__button" disabled={unavailable} onClick={props.onAcceptSafe}>Accept nonconflicting changes</button>
                    <button type="button" className="pm-local-file-dialog__button" disabled={unavailable} aria-pressed={props.showDeclined} onClick={props.onReviewDeclined}>
                      {props.showDeclined ? 'Hide previously declined changes' : 'Review previously declined changes'}
                    </button>
                  </div>
                  <p className="pm-local-file-dialog__hint">Use incoming applies the contribution. Keep mine remembers your decision. Decide later leaves the change pending.</p>
                  {props.review.changes.length === 0 ? <p className="pm-local-file-dialog__copy">No new changes to apply. This contribution may already be incorporated.</p> : (
                    <ol className="pm-local-file-dialog__changes">
                      {props.review.changes.slice(0, visibleCount).map((change, index) => {
                        const choice = props.choices[change.id] ?? (change.conflict ? '' : change.defaultDecision);
                        return (
                          <li key={change.id} className="pm-local-file-dialog__change" data-conflict={change.conflict}>
                            <div className="pm-local-file-dialog__change-heading">
                              <div>
                                <span className="pm-local-file-dialog__kind">{change.kind}{change.conflict ? ' · Needs your decision' : ''}</span>
                                <h4 id={`${id}-change-${index}`}>{change.label}</h4>
                              </div>
                              <label className="pm-local-file-dialog__decision">
                                Decision
                                <select aria-labelledby={`${id}-change-${index}`} value={choice} disabled={unavailable} onChange={(event) => props.onChoice(change.id, event.target.value as LocalFileDecision)}>
                                  <option value="" disabled>Choose a decision</option>
                                  <option value="accept">Use incoming</option>
                                  <option value="decline">Keep mine</option>
                                  <option value="defer">Decide later</option>
                                </select>
                              </label>
                            </div>
                            <details className="pm-local-file-dialog__values">
                              <summary>Compare current and incoming values</summary>
                              <div className="pm-local-file-dialog__comparison">
                                <div><h5>Current plan</h5><pre>{displayValue(change.before, props.review)}</pre></div>
                                <div><h5>Incoming contribution</h5><pre>{displayValue(change.after, props.review)}</pre></div>
                              </div>
                            </details>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                  {props.review.changes.length > visibleCount ? (
                    <button type="button" className="pm-local-file-dialog__button" disabled={unavailable} onClick={() => setVisibleCount(count => count + 100)}>
                      Show more changes ({visibleCount} of {props.review.changes.length} shown)
                    </button>
                  ) : null}
                  {unresolved ? <p className="pm-local-file-dialog__notice">Choose a decision for each conflict, including Decide later for changes you want to leave pending.</p> : null}
                </section>
              ) : null}
            </section>
          )}

          {props.preparing ? <p role="status" className="pm-local-file-dialog__copy">Preparing the comparison…</p> : null}
          {props.error ? <p role="alert" className="pm-local-file-dialog__error">{props.error}</p> : null}
          <p className="pm-local-file-dialog__hint">Shared files can contain the whole project. Names in a file are supplied by its author and are not verified.</p>
        </div>

        <div className="pm-local-file-dialog__footer">
          <span className="pm-local-file-dialog__hint">{props.mode === 'merge' ? 'A recovery point is saved before applying changes.' : 'Nothing is imported until you approve.'}</span>
          <div className="pm-local-file-dialog__actions">
            <button type="button" className="pm-local-file-dialog__button" disabled={props.busy} onClick={props.onCancel}>Cancel</button>
            <button type="button" className="pm-local-file-dialog__button pm-local-file-dialog__button--primary" disabled={cannotApply} onClick={props.onApprove}>
              {props.busy ? 'Applying…' : props.mode === 'standalone' ? 'Import project' : 'Approve contribution'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export interface LocalFileRecoveryDialogProps {
  readonly projectName: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function LocalFileRecoveryDialog(props: LocalFileRecoveryDialogProps): React.ReactElement {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const latest = useRef({ busy: props.busy, cancel: props.onCancel });
  latest.current = { busy: props.busy, cancel: props.onCancel };
  useEffect(() => {
    const invoker = document.activeElement;
    cancelRef.current?.focus();
    const outsideKey = (event: KeyboardEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!latest.current.busy) latest.current.cancel();
      } else if (event.key === 'Tab') {
        event.preventDefault(); event.stopImmediatePropagation(); cancelRef.current?.focus();
      }
    };
    const retainFocus = (event: FocusEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) cancelRef.current?.focus();
    };
    document.addEventListener('keydown', outsideKey, true);
    document.addEventListener('focusin', retainFocus);
    return () => {
      document.removeEventListener('keydown', outsideKey, true);
      document.removeEventListener('focusin', retainFocus);
      if (invoker instanceof HTMLElement && invoker.isConnected) invoker.focus();
    };
  }, []);
  return (
    <div className="pm-local-file-backdrop">
      <div
        ref={rootRef}
        className="pm-local-file-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        aria-busy={props.busy}
        tabIndex={-1}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            if (!props.busy) props.onCancel();
          }
          if (event.key !== 'Tab') return;
          const buttons = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
          const first = buttons[0];
          const last = buttons[buttons.length - 1];
          if (!first || !last) {
            event.preventDefault();
            rootRef.current?.focus();
          } else if (event.shiftKey && (document.activeElement === first || document.activeElement === rootRef.current)) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === rootRef.current)) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header className="pm-local-file-dialog__header"><h2 id={`${id}-title`}>Recover “{props.projectName}”</h2></header>
        <div className="pm-local-file-dialog__body">
          <p id={`${id}-description`} className="pm-local-file-dialog__copy">Restore the saved recovery point from before the last file merge. This replaces the current plan, including edits made since that merge.</p>
          <p className="pm-local-file-dialog__copy">Your current plan is saved as the next recovery point, so you can return to it if needed. Existing portable backups are unchanged.</p>
          {props.error ? <p role="alert" className="pm-local-file-dialog__error">{props.error}</p> : null}
        </div>
        <div className="pm-local-file-dialog__footer">
          <span className="pm-local-file-dialog__hint">Only this project on this device is affected.</span>
          <div className="pm-local-file-dialog__actions">
            <button ref={cancelRef} type="button" className="pm-local-file-dialog__button" disabled={props.busy} onClick={props.onCancel}>Cancel</button>
            <button type="button" className="pm-local-file-dialog__button pm-local-file-dialog__button--primary" disabled={props.busy} onClick={props.onConfirm}>{props.busy ? 'Recovering…' : 'Restore recovery point'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
