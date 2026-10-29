/**
 * Planning-level step (2026-09-07 planning surface).
 *
 * A plan operates at exactly one node level so every row is a like-for-like
 * comparison and a point means the same thing on every row. This one screen
 * offers the node types that exist in the project, each with a count and a
 * one-line trade-off. The choice is stored on the plan.
 *
 * Stage 2 (Epic 21, Story 21.10): every level with project nodes is enabled;
 * a level with 0 available nodes is disabled with a `0 available` badge
 * (UX-DR1).
 */

import { useState } from 'react';

export type PlanningLevel = 'Theme' | 'Component' | 'Feature';

export interface PlanningLevelOption {
  readonly level: PlanningLevel;
  readonly count: number;
  readonly blurb: string;
  /** True when the project has nodes of this level (UX-DR1). */
  readonly enabled: boolean;
}

export interface PlanningLevelStepProps {
  readonly options: readonly PlanningLevelOption[];
  readonly onChoose: (level: PlanningLevel) => void;
}

export function PlanningLevelStep({ options, onChoose }: PlanningLevelStepProps): React.ReactElement {
  const firstEnabled = options.find((o) => o.enabled)?.level ?? 'Feature';
  const [choice, setChoice] = useState<PlanningLevel>(firstEnabled);

  return (
    <div className="pm-forecast__level-step" role="group" aria-label="Choose a planning level">
      <p className="pm-forecast__level-title">What are you forecasting?</p>
      <p className="pm-forecast__level-copy">
        Rank and bucket work at one granularity so every row is a like-for-like comparison. You can
        switch later — the ranking and buckets don’t carry across.
      </p>

      <div className="pm-forecast__level-options">
        {options.map((opt) => {
          const id = `level-${opt.level}`;
          return (
            <label
              key={opt.level}
              htmlFor={id}
              className={`pm-forecast__level-option${choice === opt.level ? ' pm-forecast__level-option--on' : ''}${
                opt.enabled ? '' : ' pm-forecast__level-option--disabled'
              }`}
            >
              <input
                id={id}
                type="radio"
                name="planning-level"
                checked={choice === opt.level}
                disabled={!opt.enabled}
                onChange={() => setChoice(opt.level)}
              />
              <span className="pm-forecast__level-option-body">
                <span className="pm-forecast__level-option-head">
                  <b>{opt.level === 'Feature' ? 'Features' : `${opt.level}s`}</b>
                  <span className="pm-forecast__level-option-count">· {opt.count} available</span>
                  {!opt.enabled && <span className="pm-forecast__level-option-soon">0 available</span>}
                </span>
                <span className="pm-forecast__level-option-blurb">{opt.blurb}</span>
              </span>
            </label>
          );
        })}
      </div>

      <div className="pm-forecast__level-actions">
        <button
          type="button"
          className="pm-forecast__button pm-forecast__button--primary"
          onClick={() => onChoose(choice)}
        >
          Continue
        </button>
        <span className="pm-forecast__level-hint">
          Everything at this level lands in the Backlog; nothing is ranked yet.
        </span>
      </div>
    </div>
  );
}
