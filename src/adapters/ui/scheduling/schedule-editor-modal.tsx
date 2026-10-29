/**
 * ScheduleEditorModal — Natural-Language Schedule Editor (Story 3.4).
 * Real-time parsing of natural phrases into ISO dates & durations with live feedback.
 */

import React, { useState, useEffect } from 'react';
import type { OutlineNodeReadModel } from '../../../application/outline/outline-read-model';
import type { ScheduleSourceMode } from '../../../domain/tree/node.entity';
import { deriveNodeSchedule } from '../../../domain/tree/schedule.policy';
import { parseNaturalLanguageSchedule } from './natural-language-date.adapter';
import './schedule-editor-modal.css';

export interface ScheduleEditorModalProps {
  isOpen: boolean;
  node: OutlineNodeReadModel | null;
  onClose: () => void;
  onApplySchedule: (
    nodeId: string,
    startDate: string | null,
    endDate: string | null,
    durationDays: number | null,
    sourceMode: ScheduleSourceMode,
  ) => void;
}

export const ScheduleEditorModal: React.FC<ScheduleEditorModalProps> = ({
  isOpen,
  node,
  onClose,
  onApplySchedule,
}) => {
  const [inputPhrase, setInputPhrase] = useState('');

  useEffect(() => {
    if (isOpen && node) {
      if (node.startDate && node.endDate) {
        setInputPhrase(`${node.startDate} to ${node.endDate}`);
      } else if (node.startDate) {
        setInputPhrase(node.startDate);
      } else if (node.durationDays) {
        setInputPhrase(`${node.durationDays} days`);
      } else {
        setInputPhrase('');
      }
    }
  }, [isOpen, node?.id]);

  if (!isOpen || !node) return null;

  const parsed = inputPhrase.trim() ? parseNaturalLanguageSchedule(inputPhrase) : null;

  let scheduleParams: {
    startDate: string | null;
    endDate: string | null;
    durationDays: number | null;
    sourceMode: ScheduleSourceMode;
  } | null = null;

  if (parsed) {
    if (parsed.kind === 'date') {
      scheduleParams = {
        startDate: parsed.isoDate,
        endDate: parsed.isoDate,
        durationDays: 1,
        sourceMode: 'start_duration',
      };
    } else if (parsed.kind === 'duration') {
      scheduleParams = {
        startDate: null,
        endDate: null,
        durationDays: parsed.durationDays,
        sourceMode: 'start_duration',
      };
    } else if (parsed.kind === 'range') {
      const derived = deriveNodeSchedule({
        startDate: parsed.startDate,
        endDate: parsed.endDate,
        durationDays: null,
        sourceMode: 'start_end',
      });
      scheduleParams = {
        startDate: derived.startDate,
        endDate: derived.endDate,
        durationDays: derived.durationDays,
        sourceMode: 'start_end',
      };
    }
  }

  const handleApply = (e: React.FormEvent) => {
    e.preventDefault();
    if (!scheduleParams) return;
    onApplySchedule(
      node.id,
      scheduleParams.startDate,
      scheduleParams.endDate,
      scheduleParams.durationDays,
      scheduleParams.sourceMode,
    );
    onClose();
  };

  const handleClear = () => {
    onApplySchedule(node.id, null, null, null, 'none');
    onClose();
  };

  return (
    <div className="pm-schedule-modal__backdrop" role="dialog" aria-modal="true" aria-labelledby="schedule-modal-title">
      <div className="pm-schedule-modal">
        <div className="pm-schedule-modal__header">
          <h2 id="schedule-modal-title" className="pm-schedule-modal__title">
            <span className="pm-schedule-modal__icon">📅</span> Set Schedule
          </h2>
          <button
            type="button"
            className="pm-schedule-modal__close-btn"
            onClick={onClose}
            aria-label="Close schedule editor"
          >
            ✕
          </button>
        </div>

        <div className="pm-schedule-modal__node-summary">
          <span className="pm-schedule-modal__node-title">{node.title || '(Untitled Node)'}</span>
        </div>

        <form onSubmit={handleApply} className="pm-schedule-modal__body">
          <div className="pm-schedule-modal__field">
            <label htmlFor="schedule-phrase-input" className="pm-schedule-modal__label">
              Type dates or natural language:
            </label>
            <input
              id="schedule-phrase-input"
              type="text"
              className="pm-schedule-modal__input"
              placeholder="e.g. 'Oct 12 to Nov 1', '3 weeks starting monday', 'tomorrow'..."
              value={inputPhrase}
              onChange={(e) => setInputPhrase(e.target.value)}
              autoFocus
            />
          </div>

          <div className="pm-schedule-modal__preview">
            <h4 className="pm-schedule-modal__preview-title">Parsed Schedule</h4>
            {scheduleParams ? (
              <div className="pm-schedule-modal__preview-grid">
                <div className="pm-schedule-modal__preview-item">
                  <span className="pm-schedule-modal__preview-label">Start Date:</span>
                  <span className="pm-schedule-modal__preview-value">{scheduleParams.startDate ?? '—'}</span>
                </div>
                <div className="pm-schedule-modal__preview-item">
                  <span className="pm-schedule-modal__preview-label">End Date:</span>
                  <span className="pm-schedule-modal__preview-value">{scheduleParams.endDate ?? '—'}</span>
                </div>
                <div className="pm-schedule-modal__preview-item">
                  <span className="pm-schedule-modal__preview-label">Duration:</span>
                  <span className="pm-schedule-modal__preview-value">
                    {scheduleParams.durationDays ? `${scheduleParams.durationDays} calendar days` : '—'}
                  </span>
                </div>
              </div>
            ) : (
              <p className="pm-schedule-modal__preview-empty">
                {inputPhrase.trim() ? 'Could not parse date expression' : 'Type an expression above'}
              </p>
            )}
          </div>

          <div className="pm-schedule-modal__actions">
            {(node.startDate || node.endDate || node.durationDays) && (
              <button
                type="button"
                className="pm-schedule-modal__btn pm-schedule-modal__btn--secondary"
                onClick={handleClear}
              >
                Clear Schedule
              </button>
            )}
            <button
              type="button"
              className="pm-schedule-modal__btn pm-schedule-modal__btn--secondary"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!scheduleParams}
              className="pm-schedule-modal__btn pm-schedule-modal__btn--primary"
            >
              Apply Schedule
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
