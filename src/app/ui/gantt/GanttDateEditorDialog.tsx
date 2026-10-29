/**
 * Accessible date editor dialog for Gantt bars (Story 7.8, NFR-10, EXPERIENCE.md).
 *
 * Provides a fully keyboard-accessible modal alternative to drag-and-drop authoring.
 * Supports start date, end date, duration, and explicit override toggling.
 */

import React, { useState, useEffect, useRef } from 'react';
import type { GanttRow } from '../../../contracts/gantt';
import { isValidIsoDate } from '../../../domain/tree/schedule.policy';
import './GanttDateEditorDialog.css';

export interface GanttDateEditorDialogProps {
  readonly row: GanttRow;
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onSave: (patch: {
    startDate: string;
    endDate: string;
    durationDays: number;
  }) => void;
}

export function GanttDateEditorDialog({
  row,
  isOpen,
  onClose,
  onSave,
}: GanttDateEditorDialogProps): React.JSX.Element | null {
  const [startDate, setStartDate] = useState(row.startDate);
  const [endDate, setEndDate] = useState(row.endDate);
  const [error, setError] = useState<string | null>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setStartDate(row.startDate);
      setEndDate(row.endDate);
      setError(null);
      setTimeout(() => firstInputRef.current?.focus(), 50);
    }
  }, [isOpen, row.startDate, row.endDate]);

  if (!isOpen) return null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValidIsoDate(startDate)) {
      setError('Start date must be a valid ISO date (YYYY-MM-DD)');
      return;
    }
    if (!isValidIsoDate(endDate)) {
      setError('End date must be a valid ISO date (YYYY-MM-DD)');
      return;
    }
    if (startDate > endDate) {
      setError('Start date cannot be after end date');
      return;
    }

    // Calculate duration in days
    const start = new Date(startDate);
    const end = new Date(endDate);
    const diffTime = Math.abs(end.getTime() - start.getTime());
    const durationDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;

    onSave({ startDate, endDate, durationDays });
    onClose();
  }

  return (
    <div
      role="presentation"
      className="pm-gantt-dialog-overlay"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="gantt-editor-title"
        onClick={(e) => e.stopPropagation()}
        className="pm-gantt-dialog"
      >
        <h2 id="gantt-editor-title" className="pm-gantt-dialog__title">
          Edit Schedule: {row.title || 'Untitled'}
        </h2>

        {error && (
          <div role="alert" className="pm-gantt-dialog__error">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="pm-gantt-dialog__field">
            <label htmlFor="gantt-start-date" className="pm-gantt-dialog__label">
              Start Date (YYYY-MM-DD)
            </label>
            <input
              id="gantt-start-date"
              ref={firstInputRef}
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="pm-gantt-dialog__input"
            />
          </div>

          <div className="pm-gantt-dialog__field pm-gantt-dialog__field--last">
            <label htmlFor="gantt-end-date" className="pm-gantt-dialog__label">
              End Date (YYYY-MM-DD)
            </label>
            <input
              id="gantt-end-date"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="pm-gantt-dialog__input"
            />
          </div>

          <div className="pm-gantt-dialog__actions">
            <button
              type="button"
              onClick={onClose}
              className="pm-gantt-dialog__btn pm-gantt-dialog__btn--cancel"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="pm-gantt-dialog__btn pm-gantt-dialog__btn--save"
            >
              Save Schedule
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
