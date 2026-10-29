/**
 * Item People Editor Component (Epic 22, Story 22.5, SF-FR4, SF-UX1, SF-UX3, SF-UX9).
 *
 * Modal dialog for assigning 1+ people from the project roster to a specific
 * positive-point work item. Supports searching/filtering the roster, multi-selection,
 * atomic commit via SetForecastAssignments, draft retention on conflict/error,
 * and returning focus to the triggering item control on close.
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { ForecastPerson } from '../../../domain/forecast/forecast-plan.entity';

export interface ItemPeopleEditorProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly featureId: string;
  readonly featureTitle: string;
  readonly roster: readonly ForecastPerson[];
  readonly currentPersonIds: readonly string[];
  /**
   * Saves the final set. `true` on success; otherwise a named explanation
   * (person and items, Story 23.10 / SF-UX4) or `false` when none is known.
   */
  readonly onSaveAssignments: (featureId: string, personIds: readonly string[]) => Promise<boolean | string>;
  readonly triggerRef?: React.RefObject<HTMLElement | null>;
  readonly onOpenRoster?: () => void;
}

export function ItemPeopleEditor({
  isOpen,
  onClose,
  featureId,
  featureTitle,
  roster,
  currentPersonIds,
  onSaveAssignments,
  triggerRef,
  onOpenRoster,
}: ItemPeopleEditorProps): React.ReactElement | null {
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set(currentPersonIds));
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);

  const openedRef = useRef<{ isOpen: boolean; featureId: string | null }>({
    isOpen: false,
    featureId: null,
  });

  // Sync draft selection with currentPersonIds when opened or feature changes
  useEffect(() => {
    const wasOpen = openedRef.current.isOpen;
    const prevFeatureId = openedRef.current.featureId;
    openedRef.current = { isOpen, featureId };

    if (isOpen && (!wasOpen || featureId !== prevFeatureId)) {
      setSelectedIds(new Set(currentPersonIds));
      setSearch('');
      setErrorMessage(null);
      setIsSaving(false);
      // Move focus into the search input on open
      queueMicrotask(() => {
        searchInputRef.current?.focus();
      });
    }
  }, [isOpen, featureId, currentPersonIds]);

  const handleClose = useCallback(() => {
    setErrorMessage(null);
    onClose();
    // Return focus to trigger element on close
    queueMicrotask(() => {
      triggerRef?.current?.focus();
    });
  }, [onClose, triggerRef]);

  // Handle Escape key and focus trap
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleClose();
        return;
      }

      if (e.key === 'Tab') {
        if (!dialogRef.current) return;
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
          ),
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose]);

  const filteredRoster = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return roster;
    return roster.filter((p) => p.name.toLowerCase().includes(q));
  }, [roster, search]);

  const handleTogglePerson = (personId: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(personId)) {
        next.delete(personId);
      } else {
        next.add(personId);
      }
      return next;
    });
    setErrorMessage(null);
  };

  const handleApply = async (): Promise<void> => {
    setIsSaving(true);
    setErrorMessage(null);
    try {
      const sortedIds = Array.from(selectedIds).sort((a, b) => a.localeCompare(b));
      const outcome = await onSaveAssignments(featureId, sortedIds);
      if (outcome === true) {
        handleClose();
      } else {
        setErrorMessage(
          typeof outcome === 'string'
            ? `Assignment could not be applied. ${outcome}`
            : 'Assignment could not be applied. Check for parallel bucket conflicts or invalid roster member.',
        );
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'An error occurred while saving assignments.',
      );
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="pm-people-editor__backdrop" role="presentation" onClick={handleClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pm-item-people-title"
        className="pm-people-editor pm-item-people-editor"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pm-people-editor__header">
          <div className="pm-people-editor__header-text">
            <h2 id="pm-item-people-title" className="pm-people-editor__title">
              Assign People
            </h2>
            <p className="pm-people-editor__subtitle">
              {featureTitle || 'Untitled Feature'}
            </p>
          </div>
          <button
            type="button"
            className="pm-people-editor__close"
            onClick={handleClose}
            aria-label="Close assignment editor"
          >
            ✕
          </button>
        </div>

        {errorMessage && (
          <div className="pm-forecast__rejection-banner" role="alert">
            <span className="pm-forecast__rejection-text">{errorMessage}</span>
            <button
              type="button"
              className="pm-forecast__rejection-dismiss"
              onClick={() => setErrorMessage(null)}
              aria-label="Dismiss error"
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="pm-item-people-editor__search-box">
          <input
            ref={searchInputRef}
            type="search"
            className="pm-forecast__config-input pm-item-people-editor__search"
            placeholder="Search roster members…"
            aria-label="Search roster members"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="pm-item-people-editor__list" role="group" aria-label="Roster members">
          {roster.length === 0 ? (
            <div className="pm-item-people-editor__empty">
              <p>No team members in project roster.</p>
              {onOpenRoster && (
                <button
                  type="button"
                  className="pm-forecast__button pm-forecast__button--small"
                  onClick={() => {
                    handleClose();
                    onOpenRoster();
                  }}
                >
                  Manage project roster…
                </button>
              )}
            </div>
          ) : filteredRoster.length === 0 ? (
            <div className="pm-item-people-editor__empty">
              <p>No roster members matching &ldquo;{search}&rdquo;</p>
            </div>
          ) : (
            filteredRoster.map((person) => {
              const isChecked = selectedIds.has(person.id);
              return (
                <label
                  key={person.id}
                  className={`pm-item-people-editor__item${
                    isChecked ? ' pm-item-people-editor__item--selected' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => handleTogglePerson(person.id)}
                    aria-label={`Assign ${person.name}`}
                  />
                  <div className="pm-item-people-editor__item-info">
                    <span className="pm-item-people-editor__item-name">{person.name}</span>
                    <span className="pm-item-people-editor__item-weight">
                      Weight: {(person.weightUnits / 100).toFixed(2)}
                    </span>
                  </div>
                </label>
              );
            })
          )}
        </div>

        <div className="pm-item-people-editor__footer">
          <div className="pm-item-people-editor__selection-summary">
            {selectedIds.size} {selectedIds.size === 1 ? 'person' : 'people'} selected
          </div>
          <div className="pm-people-editor__actions">
            <button
              ref={saveButtonRef}
              type="button"
              className="pm-forecast__button pm-forecast__button--primary"
              disabled={isSaving}
              onClick={handleApply}
            >
              {isSaving ? 'Saving…' : 'Apply'}
            </button>
            <button
              type="button"
              className="pm-forecast__button"
              disabled={isSaving}
              onClick={handleClose}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
