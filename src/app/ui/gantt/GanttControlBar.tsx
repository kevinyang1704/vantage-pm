/**
 * Gantt control bar component (Story 7.2, FR-44, FR-49, AD-10, EXPERIENCE.md).
 *
 * Controls visible timeline bounds, granularity, and reports explicit undated exclusions.
 */

import React from 'react';
import type { GanttGranularity } from '../../../contracts/gantt';
import './GanttControlBar.css';

export interface GanttControlBarProps {
  readonly dateWindowStart: string;
  readonly dateWindowEnd: string;
  readonly granularity: GanttGranularity;
  /** The timeline is zoomed to fit (Fit), so no fixed scale is selected. */
  readonly fitted?: boolean;
  readonly undatedCount: number;
  readonly outOfWindowCount?: number;
  readonly onChangeWindow: (patch: {
    dateWindowStart?: string;
    dateWindowEnd?: string;
    granularity?: GanttGranularity;
  }) => void;
  readonly onResetToProjectSpan?: () => void;
}

export function GanttControlBar({
  dateWindowStart,
  dateWindowEnd,
  granularity,
  fitted = false,
  undatedCount,
  outOfWindowCount = 0,
  onChangeWindow,
  onResetToProjectSpan,
}: GanttControlBarProps): React.JSX.Element {
  const granularities: readonly GanttGranularity[] = ['week', 'month', 'quarter'];

  return (
    <div
      role="toolbar"
      aria-label="Gantt Timeline Controls"
      className="pm-gantt-control-bar"
    >
      {/* Left section: Granularity Segmented Control */}
      <div className="pm-gantt-control-bar__left">
        <span className="pm-gantt-control-bar__scale-label">Scale:</span>
        <div
          role="group"
          aria-label="Timeline Granularity"
          className="pm-gantt-control-bar__group"
        >
          {granularities.map((g) => {
            const isSelected = granularity === g;
            return (
              <button
                key={g}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onChangeWindow({ granularity: g })}
                className={`pm-gantt-control-bar__seg-btn ${isSelected ? 'pm-gantt-control-bar__seg-btn--selected' : ''}`}
              >
                {g}
              </button>
            );
          })}
        </div>

        {/* Date Window Controls */}
        <div className="pm-gantt-control-bar__date-controls">
          <input
            type="date"
            aria-label="Timeline Start Date"
            value={dateWindowStart}
            onChange={(e) => {
              if (e.target.value && e.target.value <= dateWindowEnd) {
                onChangeWindow({ dateWindowStart: e.target.value });
              }
            }}
            className="pm-gantt-control-bar__date-input"
          />
          <span>–</span>
          <input
            type="date"
            aria-label="Timeline End Date"
            value={dateWindowEnd}
            onChange={(e) => {
              if (e.target.value && e.target.value >= dateWindowStart) {
                onChangeWindow({ dateWindowEnd: e.target.value });
              }
            }}
            className="pm-gantt-control-bar__date-input"
          />
          {onResetToProjectSpan && (
            <button
              type="button"
              onClick={onResetToProjectSpan}
              title="Show the whole project span"
              aria-pressed={fitted}
              className={`pm-gantt-control-bar__fit-btn${fitted ? ' pm-gantt-control-bar__fit-btn--active' : ''}`}
            >
              Fit
            </button>
          )}
        </div>
      </div>

      {/* Right section: Exclusion Indicators */}
      <div className="pm-gantt-control-bar__right">
        {/* Explicit Undated Exclusion Badge (FR-49) */}
        <div
          title={`${undatedCount} items have no scheduling dates and are excluded from the timeline`}
          className="pm-gantt-control-bar__badge pm-gantt-control-bar__badge--undated"
        >
          <span className="pm-gantt-control-bar__badge-count">{undatedCount}</span> undated · excluded
        </div>

        {/* Out of Window Indicator */}
        {outOfWindowCount > 0 && (
          <div
            title={`${outOfWindowCount} dated items fall outside the selected timeline window`}
            className="pm-gantt-control-bar__badge pm-gantt-control-bar__badge--out-of-window"
          >
            <span className="pm-gantt-control-bar__badge-count">{outOfWindowCount}</span> outside window
          </div>
        )}
      </div>
    </div>
  );
}
