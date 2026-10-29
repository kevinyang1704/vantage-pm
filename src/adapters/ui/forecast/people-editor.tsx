/**
 * People Editor Component (Epic 22, Story 22.3, SF-FR2, SF-FR3, SF-UX2, SF-UX9).
 *
 * Manages project roster: add, rename, reweight, and remove people.
 * Enforces the fixed-capacity invariant: adding headcount redistributes team
 * capacity without increasing total team capacity C (points per sprint).
 *
 * Distinguishes exact fractional share (e.g. 20/3) from display rounded decimal
 * (e.g. 6.67), shows live redistribution preview before saving, and retains
 * drafts on error.
 */

import React, { useState, useEffect, useId, useRef, useMemo, useCallback } from 'react';
import type { ForecastPerson } from '../../../domain/forecast/forecast-plan.entity';
import { parseStaffingWeightToUnits } from '../../../domain/forecast/forecast-validators';

/** Field error for any weight the canonical decimal grammar rejects. */
export const WEIGHT_FIELD_ERROR =
  'Enter a weight greater than 0 with at most two decimal places, such as 1, 1.5 or 0.25.';

/**
 * Parse a weight draft with the domain's canonical grammar (Story 22.12,
 * R3): the exact hundredths every add, edit and preview must share. Returns
 * null for anything the grammar rejects — never a rounded substitute.
 */
export function parseWeightDraft(draft: string): number | null {
  try {
    return parseStaffingWeightToUnits(draft);
  } catch {
    return null;
  }
}

export interface ShareDetail {
  readonly exactFraction: string;
  readonly decimalRounded: string;
  readonly isExactInteger: boolean;
  readonly percentage: string;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

export function computePersonShare(
  weightUnits: number,
  totalWeightUnits: number,
  pointsPerSprint: number | null,
): ShareDetail {
  if (totalWeightUnits <= 0 || weightUnits <= 0) {
    return {
      exactFraction: '0',
      decimalRounded: '0.00',
      isExactInteger: true,
      percentage: '0.0%',
    };
  }

  const pct = ((weightUnits / totalWeightUnits) * 100).toFixed(1) + '%';

  if (pointsPerSprint === null) {
    const g = gcd(weightUnits, totalWeightUnits);
    const num = weightUnits / g;
    const den = totalWeightUnits / g;
    return {
      exactFraction: den === 1 ? `${num}` : `${num}/${den}`,
      decimalRounded: ((weightUnits / totalWeightUnits) * 100).toFixed(1) + '%',
      isExactInteger: den === 1,
      percentage: pct,
    };
  }

  const rawNum = pointsPerSprint * weightUnits;
  const rawDen = totalWeightUnits;
  const g = gcd(rawNum, rawDen);
  const num = rawNum / g;
  const den = rawDen / g;

  const isExactInteger = den === 1;
  const exactFraction = isExactInteger ? `${num}` : `${num}/${den}`;
  const decimalRounded = (rawNum / rawDen).toFixed(2);

  return {
    exactFraction,
    decimalRounded,
    isExactInteger,
    percentage: pct,
  };
}

export interface PeopleEditorProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly roster: readonly ForecastPerson[];
  readonly assignments?: Readonly<Record<string, readonly string[]>>;
  readonly items?: readonly { id: string; title: string }[];
  readonly pointsPerSprint: number | null;
  readonly onAddPerson: (name: string, weightUnits: number) => Promise<boolean>;
  readonly onUpdatePerson: (personId: string, name: string, weightUnits: number) => Promise<boolean>;
  readonly onRemovePerson: (personId: string) => Promise<boolean>;
  readonly triggerRef?: React.RefObject<HTMLElement | null>;
}

export function PeopleEditor({
  isOpen,
  onClose,
  roster,
  assignments,
  items,
  pointsPerSprint,
  onAddPerson,
  onUpdatePerson,
  onRemovePerson,
  triggerRef,
}: PeopleEditorProps): React.ReactElement | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const addNameInputRef = useRef<HTMLInputElement>(null);
  const addWeightInputRef = useRef<HTMLInputElement>(null);
  const discardConfirmRef = useRef<HTMLDivElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const removalConfirmRef = useRef<HTMLDivElement>(null);
  const removalCancelRef = useRef<HTMLButtonElement>(null);
  /** The draft input the user last worked in: where "Keep editing" returns. */
  const lastDraftInputRef = useRef<HTMLInputElement | null>(null);
  /** The Remove control that opened the removal confirmation. */
  const removalTriggerRef = useRef<HTMLElement | null>(null);
  const rowActionRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const addWeightErrorId = useId();
  const editWeightErrorId = useId();

  // Removal impact confirmation state (Story 22.6 AC 22.6-4)
  const [removalImpactPerson, setRemovalImpactPerson] = useState<{
    person: ForecastPerson;
    affectedItemTitles: readonly string[];
  } | null>(null);

  // New person form state
  const [newName, setNewName] = useState('');
  const [newWeight, setNewWeight] = useState('1.00');
  const [addError, setAddError] = useState<string | null>(null);
  const [addWeightError, setAddWeightError] = useState<string | null>(null);
  const [isSubmittingAdd, setIsSubmittingAdd] = useState(false);

  // Inline editing state for existing members: personId -> { name, weight }
  const [editingPersonId, setEditingPersonId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editWeight, setEditWeight] = useState('1.00');
  const [editError, setEditError] = useState<string | null>(null);
  const [editWeightError, setEditWeightError] = useState<string | null>(null);
  const [isSubmittingEdit, setIsSubmittingEdit] = useState(false);

  // Banner status / error message
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState('');

  // Discard confirmation state
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  const isAddDirty = newName.trim().length > 0 || newWeight !== '1.00';
  const isEditDirty = editingPersonId !== null;
  const isDirty = isAddDirty || isEditDirty;

  // Total current weight
  const currentTotalWeightUnits = useMemo(
    () => roster.reduce((sum, p) => sum + p.weightUnits, 0),
    [roster],
  );

  // Calculate proposed redistribution preview for Add Person: the same exact
  // hundredths the save would write, or no preview at all.
  const proposedAddWeightUnits = useMemo(() => parseWeightDraft(newWeight), [newWeight]);

  const addPreviewRoster = useMemo(() => {
    if (!newName.trim() || proposedAddWeightUnits === null) return null;
    const candidate: ForecastPerson = {
      id: 'candidate-new',
      name: newName.trim(),
      weightUnits: proposedAddWeightUnits,
    };
    return [...roster, candidate];
  }, [roster, newName, proposedAddWeightUnits]);

  const addPreviewTotalWeightUnits = useMemo(() => {
    if (!addPreviewRoster) return currentTotalWeightUnits;
    return addPreviewRoster.reduce((sum, p) => sum + p.weightUnits, 0);
  }, [addPreviewRoster, currentTotalWeightUnits]);

  // Track items assigned to each person (Story 22.6 AC 22.6-4)
  const assignedItemMap = useMemo(() => {
    const map = new Map<string, string[]>();
    if (!assignments) return map;
    for (const [itemId, personIds] of Object.entries(assignments)) {
      for (const pid of personIds) {
        const list = map.get(pid) ?? [];
        list.push(itemId);
        map.set(pid, list);
      }
    }
    return map;
  }, [assignments]);

  const confirmationOpen = showDiscardConfirm || removalImpactPerson !== null;

  const handleRequestClose = useCallback(() => {
    if (isDirty) {
      setShowDiscardConfirm(true);
    } else {
      onClose();
      triggerRef?.current?.focus();
    }
  }, [isDirty, onClose, triggerRef]);

  /** "Keep editing": back to the draft input the user was working in. */
  const handleKeepEditing = useCallback(() => {
    setShowDiscardConfirm(false);
    const last = lastDraftInputRef.current;
    const target =
      last && last.isConnected
        ? last
        : newName.trim().length === 0 && newWeight !== '1.00'
          ? addWeightInputRef.current
          : addNameInputRef.current;
    requestAnimationFrame(() => target?.focus());
  }, [newName, newWeight]);

  /** Dismiss the removal confirmation without mutation, back to its trigger. */
  const handleCancelRemoval = useCallback(() => {
    setRemovalImpactPerson(null);
    const trigger = removalTriggerRef.current;
    requestAnimationFrame(() => trigger?.focus());
  }, []);

  // Latest handlers/state for the window key listener, so it never acts on a
  // stale confirmation (review R4: Escape used to read an old removal state).
  const keyStateRef = useRef({ removalImpactPerson, showDiscardConfirm, handleRequestClose, handleKeepEditing, handleCancelRemoval });
  keyStateRef.current = { removalImpactPerson, showDiscardConfirm, handleRequestClose, handleKeepEditing, handleCancelRemoval };

  // Focus trap and Escape handling for whichever surface is active: a
  // confirmation owns the keyboard while it is open (AC 22.12-3/-4).
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const state = keyStateRef.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (state.removalImpactPerson) state.handleCancelRemoval();
        else if (state.showDiscardConfirm) state.handleKeepEditing();
        else state.handleRequestClose();
        return;
      }

      const container = state.removalImpactPerson
        ? removalConfirmRef.current
        : state.showDiscardConfirm
          ? discardConfirmRef.current
          : dialogRef.current;
      if (e.key === 'Tab' && container) {
        const focusable = container.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;

        if (!container.contains(active)) {
          // Focus is outside the active surface (e.g. still on the obscured
          // editor): bring it in rather than letting Tab walk the background.
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  // Focus management on open; a closed editor keeps no confirmation state,
  // so reopening never shows a stale confirmation (AC 22.12-4).
  useEffect(() => {
    if (!isOpen) {
      setShowDiscardConfirm(false);
      setRemovalImpactPerson(null);
      return;
    }
    // Initial focus only if the user has not already moved into the editor:
    // an unconditional delayed focus stole focus mid-typing, so text meant for
    // an inline weight edit landed in the add-name field.
    const frame = requestAnimationFrame(() => {
      if (!dialogRef.current?.contains(document.activeElement)) addNameInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  // Each confirmation receives focus on its least destructive action.
  useEffect(() => {
    if (showDiscardConfirm) keepEditingRef.current?.focus();
  }, [showDiscardConfirm]);
  useEffect(() => {
    if (removalImpactPerson) removalCancelRef.current?.focus();
  }, [removalImpactPerson]);

  const handleConfirmDiscard = useCallback(() => {
    setShowDiscardConfirm(false);
    setNewName('');
    setNewWeight('1.00');
    setAddError(null);
    setAddWeightError(null);
    setEditingPersonId(null);
    setEditError(null);
    setEditWeightError(null);
    setGeneralError(null);
    lastDraftInputRef.current = null;
    onClose();
    triggerRef?.current?.focus();
  }, [onClose, triggerRef]);

  // Handle Add Person
  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddError(null);
    setGeneralError(null);

    // The exact draft stays in the field; only the canonical grammar decides.
    const weightUnits = parseWeightDraft(newWeight);
    setAddWeightError(weightUnits === null ? WEIGHT_FIELD_ERROR : null);

    const trimmedName = newName.trim();
    if (!trimmedName) {
      setAddError('Name is required.');
      return;
    }
    if (weightUnits === null) {
      addWeightInputRef.current?.focus();
      return;
    }

    setIsSubmittingAdd(true);
    try {
      const ok = await onAddPerson(trimmedName, weightUnits);
      if (ok) {
        setNewName('');
        setNewWeight('1.00');
        setLiveAnnouncement(`${trimmedName} added to roster.`);
      } else {
        setAddError('Could not add person. Please check details and try again.');
      }
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Error adding person');
    } finally {
      setIsSubmittingAdd(false);
    }
  };

  // Start inline editing
  const handleStartEdit = (person: ForecastPerson) => {
    setEditingPersonId(person.id);
    setEditName(person.name);
    setEditWeight((person.weightUnits / 100).toFixed(2));
    setEditError(null);
    setEditWeightError(null);
  };

  // Cancel inline editing
  const handleCancelEdit = () => {
    setEditingPersonId(null);
    setEditError(null);
    setEditWeightError(null);
  };

  // Save inline editing
  const handleSaveEdit = async (personId: string) => {
    setEditError(null);
    const weightUnits = parseWeightDraft(editWeight);
    setEditWeightError(weightUnits === null ? WEIGHT_FIELD_ERROR : null);

    const trimmedName = editName.trim();
    if (!trimmedName) {
      setEditError('Name is required.');
      return;
    }
    if (weightUnits === null) return;

    setIsSubmittingEdit(true);
    try {
      const ok = await onUpdatePerson(personId, trimmedName, weightUnits);
      if (ok) {
        setEditingPersonId(null);
        setLiveAnnouncement(`${trimmedName} updated.`);
      } else {
        setEditError('Could not update person. Please try again.');
      }
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Error updating person');
    } finally {
      setIsSubmittingEdit(false);
    }
  };

  const executeRemovePerson = async (person: ForecastPerson) => {
    // Where focus goes once the row is gone: a neighbouring row, else the
    // add form — never the document body (AC 22.12-5).
    const index = roster.findIndex((p) => p.id === person.id);
    const neighbour = roster[index + 1] ?? roster[index - 1];
    try {
      const ok = await onRemovePerson(person.id);
      if (ok) {
        setLiveAnnouncement(`${person.name} removed from roster.`);
        requestAnimationFrame(() => {
          const target = (neighbour && rowActionRefs.current.get(neighbour.id)) || addNameInputRef.current;
          target?.focus();
        });
      } else {
        setGeneralError(`Could not remove ${person.name}.`);
        requestAnimationFrame(() => removalTriggerRef.current?.focus());
      }
    } catch (err) {
      setGeneralError(err instanceof Error ? err.message : 'Error removing person');
      requestAnimationFrame(() => removalTriggerRef.current?.focus());
    }
  };

  // Remove person (Story 22.6 AC 22.6-4)
  const handleRemove = async (person: ForecastPerson, trigger: HTMLElement) => {
    setGeneralError(null);
    removalTriggerRef.current = trigger;
    const affectedItemIds = assignedItemMap.get(person.id) ?? [];
    if (affectedItemIds.length > 0) {
      const titles = affectedItemIds.map(
        (id) => items?.find((it) => it.id === id)?.title || id,
      );
      setRemovalImpactPerson({ person, affectedItemTitles: titles });
      return;
    }
    await executeRemovePerson(person);
  };

  if (!isOpen) return null;

  const unitLabel = pointsPerSprint !== null ? 'pts/sprint' : 'share';

  return (
    <div
      className="pm-forecast__modal-backdrop"
      onClick={() => {
        // A click that lands behind an open confirmation must not stack a
        // second close request on top of it.
        if (!confirmationOpen) handleRequestClose();
      }}
    >
      {/* Screen reader polite announcement */}
      <div
        role="status"
        aria-live="polite"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          margin: -1,
          padding: 0,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {liveAnnouncement}
      </div>

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Manage project people and capacity"
        className="pm-people-editor"
        // While a confirmation is open the editor behind it is obscured: not
        // focusable, not clickable, not in the accessibility tree.
        inert={confirmationOpen}
        onClick={(e) => e.stopPropagation()}
        onFocus={(e) => {
          if (e.target instanceof HTMLInputElement) lastDraftInputRef.current = e.target;
        }}
      >
        {/* Header */}
        <div className="pm-people-editor__header">
          <div className="pm-people-editor__title-group">
            <h2 className="pm-people-editor__title">Project People & Capacity</h2>
            <p className="pm-people-editor__subtitle">
              Relative staffing weights and capacity distribution
            </p>
          </div>
          <button
            type="button"
            className="pm-people-editor__close-button"
            aria-label="Close people editor"
            onClick={handleRequestClose}
          >
            ✕
          </button>
        </div>

        {/* Capacity Notice Callout */}
        <div className="pm-people-editor__notice-card">
          <div className="pm-people-editor__notice-headline">
            {pointsPerSprint !== null ? (
              <span>
                Total team capacity: <strong>{pointsPerSprint} points/sprint</strong>
              </span>
            ) : (
              <span>Team capacity is not configured yet.</span>
            )}
          </div>
          <p className="pm-people-editor__notice-copy">
            Adding headcount alone does not increase team capacity. Total capacity remains{' '}
            {pointsPerSprint !== null ? `${pointsPerSprint} points/sprint` : 'as configured'}.
            Each person receives a relative capacity share proportional to their weight.
          </p>
          <div className="pm-people-editor__formula">
            Formula: <code>c_p = (C × w_p) / W</code> (where <code>W = ∑w_i</code> is total team weight)
          </div>
        </div>

        {generalError && (
          <div className="pm-people-editor__error-banner" role="alert">
            {generalError}
          </div>
        )}

        {/* Current Roster Section */}
        <div className="pm-people-editor__roster-section">
          <h3 className="pm-people-editor__section-heading">
            Current Roster ({roster.length} {roster.length === 1 ? 'person' : 'people'})
          </h3>

          {roster.length === 0 ? (
            <p className="pm-people-editor__empty-text">
              No people added yet. Add a person below to define capacity shares.
            </p>
          ) : (
            <div className="pm-people-editor__table-wrap">
              <table className="pm-people-editor__table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Weight</th>
                    <th>Capacity Share</th>
                    <th className="pm-people-editor__th-actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {roster.map((person) => {
                    const isEditing = editingPersonId === person.id;
                    const share = computePersonShare(
                      person.weightUnits,
                      currentTotalWeightUnits,
                      pointsPerSprint,
                    );

                    return (
                      <tr key={person.id} className="pm-people-editor__row">
                        <td className="pm-people-editor__cell-name">
                          {isEditing ? (
                            <div>
                              <input
                                type="text"
                                className="pm-people-editor__input pm-people-editor__input--inline"
                                value={editName}
                                aria-label={`Edit name for ${person.name}`}
                                onChange={(e) => setEditName(e.target.value)}
                              />
                              {editError && <div className="pm-people-editor__field-error">{editError}</div>}
                            </div>
                          ) : (
                            <span className="pm-people-editor__person-name">{person.name}</span>
                          )}
                        </td>
                        <td className="pm-people-editor__cell-weight">
                          {isEditing ? (
                            <div>
                              {/* Text, not type=number: the browser would blank
                                  "1.5x" and accept "1e2", hiding the exact draft
                                  from the canonical grammar (AC 22.12-1). */}
                              <input
                                type="text"
                                inputMode="decimal"
                                autoComplete="off"
                                className="pm-people-editor__input pm-people-editor__input--weight"
                                value={editWeight}
                                aria-label={`Edit weight for ${person.name}`}
                                aria-invalid={editWeightError ? true : undefined}
                                aria-describedby={editWeightError ? editWeightErrorId : undefined}
                                onChange={(e) => {
                                  setEditWeight(e.target.value);
                                  if (editWeightError && parseWeightDraft(e.target.value) !== null) {
                                    setEditWeightError(null);
                                  }
                                }}
                                // Validated on Save only. A blur-time error grows
                                // this row mid-click and moved Save out from under
                                // the pointer, so the click landed on Cancel.
                              />
                              {editWeightError && (
                                <div id={editWeightErrorId} className="pm-people-editor__field-error">
                                  {editWeightError}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="pm-people-editor__person-weight">
                              {(person.weightUnits / 100).toFixed(2)}
                            </span>
                          )}
                        </td>
                        <td className="pm-people-editor__cell-share">
                          <span className="pm-people-editor__share-exact">
                            {share.exactFraction} {unitLabel}
                          </span>
                          {!share.isExactInteger && pointsPerSprint !== null && (
                            <span className="pm-people-editor__share-rounded">
                              {' '}(~{share.decimalRounded})
                            </span>
                          )}
                        </td>
                        <td className="pm-people-editor__cell-actions">
                          {isEditing ? (
                            <div className="pm-people-editor__actions-group">
                              <button
                                type="button"
                                className="pm-forecast__button pm-forecast__button--primary pm-people-editor__btn-small"
                                aria-label={`Save changes for ${person.name}`}
                                disabled={isSubmittingEdit}
                                onClick={() => handleSaveEdit(person.id)}
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                className="pm-forecast__button pm-people-editor__btn-small"
                                aria-label={`Cancel editing ${person.name}`}
                                disabled={isSubmittingEdit}
                                onClick={handleCancelEdit}
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <div className="pm-people-editor__actions-group">
                              <button
                                type="button"
                                ref={(el) => {
                                  if (el) rowActionRefs.current.set(person.id, el);
                                  else rowActionRefs.current.delete(person.id);
                                }}
                                className="pm-people-editor__action-link"
                                aria-label={`Edit ${person.name}`}
                                onClick={() => handleStartEdit(person)}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                className="pm-people-editor__action-link pm-people-editor__action-link--danger"
                                aria-label={`Remove ${person.name}`}
                                onClick={(e) => void handleRemove(person, e.currentTarget)}
                              >
                                Remove
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Add Person Form */}
        <div className="pm-people-editor__add-section">
          <h3 className="pm-people-editor__section-heading">Add Person</h3>
          <form className="pm-people-editor__add-form" onSubmit={handleAddSubmit}>
            <div className="pm-people-editor__form-row">
              <div className="pm-people-editor__form-field">
                <label htmlFor="pm-pe-new-name" className="pm-people-editor__label">
                  Person Name
                </label>
                <input
                  ref={addNameInputRef}
                  id="pm-pe-new-name"
                  type="text"
                  placeholder="e.g. Robin"
                  className="pm-people-editor__input"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </div>

              <div className="pm-people-editor__form-field pm-people-editor__form-field--weight">
                <label htmlFor="pm-pe-new-weight" className="pm-people-editor__label">
                  Relative Weight
                </label>
                <input
                  ref={addWeightInputRef}
                  id="pm-pe-new-weight"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  className="pm-people-editor__input"
                  value={newWeight}
                  aria-invalid={addWeightError ? true : undefined}
                  aria-describedby={addWeightError ? addWeightErrorId : undefined}
                  onChange={(e) => {
                    setNewWeight(e.target.value);
                    if (addWeightError && parseWeightDraft(e.target.value) !== null) setAddWeightError(null);
                  }}
                  onBlur={() => {
                    if (parseWeightDraft(newWeight) === null) setAddWeightError(WEIGHT_FIELD_ERROR);
                  }}
                />
              </div>

              <div className="pm-people-editor__form-submit">
                <button
                  type="submit"
                  className="pm-forecast__button pm-forecast__button--primary"
                  disabled={isSubmittingAdd || !newName.trim()}
                >
                  {isSubmittingAdd ? 'Adding…' : 'Add Person'}
                </button>
              </div>
            </div>

            {addError && (
              <div className="pm-people-editor__field-error" role="alert">
                {addError}
              </div>
            )}
            {/* Below the row, not inside the weight field: the row bottom-aligns
                its fields, so an in-field error would lift the input out of line.
                Still associated through the input's aria-describedby. */}
            {addWeightError && (
              <div id={addWeightErrorId} className="pm-people-editor__field-error">
                {addWeightError}
              </div>
            )}
          </form>

          {/* Live Redistribution Preview before save */}
          {addPreviewRoster && (
            <div className="pm-people-editor__preview-card" aria-label="Redistribution preview">
              <div className="pm-people-editor__preview-title">
                Redistribution Preview (Before Save)
              </div>
              <p className="pm-people-editor__preview-desc">
                Adding <strong>{newName.trim()}</strong> with weight {newWeight} will redistribute
                team capacity as follows:
              </p>
              <div className="pm-people-editor__preview-list">
                {addPreviewRoster.map((candidate) => {
                  const isNewCandidate = candidate.id === 'candidate-new';
                  const priorPerson = roster.find((p) => p.id === candidate.id);
                  const priorShare = priorPerson
                    ? computePersonShare(priorPerson.weightUnits, currentTotalWeightUnits, pointsPerSprint)
                    : null;
                  const newShare = computePersonShare(
                    candidate.weightUnits,
                    addPreviewTotalWeightUnits,
                    pointsPerSprint,
                  );

                  return (
                    <div key={candidate.id} className="pm-people-editor__preview-item">
                      <span className="pm-people-editor__preview-name">
                        {candidate.name} {isNewCandidate && <span className="pm-people-editor__tag">New</span>}
                      </span>
                      <span className="pm-people-editor__preview-share">
                        {priorShare ? (
                          <>
                            <span className="pm-people-editor__prior-share">
                              {priorShare.exactFraction}
                              {!priorShare.isExactInteger && pointsPerSprint !== null && ` (~${priorShare.decimalRounded})`}
                            </span>
                            <span className="pm-people-editor__arrow"> → </span>
                          </>
                        ) : (
                          <span className="pm-people-editor__arrow">— → </span>
                        )}
                        <strong>
                          {newShare.exactFraction} {unitLabel}
                        </strong>
                        {!newShare.isExactInteger && pointsPerSprint !== null && (
                          <span className="pm-people-editor__share-rounded">
                            {' '}(~{newShare.decimalRounded})
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="pm-people-editor__preview-footer">
                Total capacity remains{' '}
                {pointsPerSprint !== null ? `${pointsPerSprint} points/sprint` : 'unchanged'}.
              </div>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="pm-people-editor__footer">
          <button
            type="button"
            className="pm-forecast__button"
            onClick={handleRequestClose}
          >
            Done
          </button>
        </div>
      </div>

      {/* Discard Confirmation Dialog */}
      {showDiscardConfirm && (
        <div
          ref={discardConfirmRef}
          role="alertdialog"
          aria-modal="true"
          aria-label="Discard unsaved changes"
          className="pm-forecast__level-dialog"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="pm-forecast__level-dialog-card">
            <p className="pm-forecast__level-dialog-title">Discard unsaved edits?</p>
            <p className="pm-forecast__level-dialog-copy">
              You have unsaved input in the People editor. Discarding will lose these draft changes.
            </p>
            <div className="pm-forecast__level-dialog-actions">
              <button
                type="button"
                className="pm-forecast__button pm-forecast__button--primary"
                onClick={handleConfirmDiscard}
              >
                Discard
              </button>
              <button
                ref={keepEditingRef}
                type="button"
                className="pm-forecast__button"
                onClick={handleKeepEditing}
              >
                Keep editing
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Removal Impact Dialog (Story 22.6 AC 22.6-4) */}
      {removalImpactPerson && (
        <div
          ref={removalConfirmRef}
          role="alertdialog"
          aria-modal="true"
          aria-label="Confirm person removal"
          className="pm-forecast__level-dialog"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="pm-forecast__level-dialog-card">
            <p className="pm-forecast__level-dialog-title">Remove {removalImpactPerson.person.name} from roster?</p>
            <p className="pm-forecast__level-dialog-copy">
              {removalImpactPerson.person.name} is assigned to {removalImpactPerson.affectedItemTitles.join(', ')}. Removing them will clear these assignments and may expose assignment gaps without removing work from scope.
            </p>
            <div className="pm-forecast__level-dialog-actions">
              <button
                type="button"
                className="pm-forecast__button pm-forecast__button--danger"
                onClick={async () => {
                  const person = removalImpactPerson.person;
                  setRemovalImpactPerson(null);
                  await executeRemovePerson(person);
                }}
              >
                Remove person
              </button>
              <button
                ref={removalCancelRef}
                type="button"
                className="pm-forecast__button"
                onClick={handleCancelRemoval}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
