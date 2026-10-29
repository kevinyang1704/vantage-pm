/**
 * CoherenceReviewPanel — Exhaustive Coherence Review Surface (Story 4.7).
 *
 * Presents an exhaustive list of all open findings grouped A (Orphan),
 * B (Sequencing/Cycles), C (Imbalance), with click-to-focus navigation and inline dismiss.
 */

import React from 'react';
import type { CoherenceFinding } from '../../../contracts/analysis-protocol';
import type { GroupedCoherenceReview } from '../../../application/review/coherence-review.projection';
import { riskCountPhrase } from '../vocabulary';
import './coherence-review-panel.css';

export interface CoherenceReviewPanelProps {
  isOpen: boolean;
  review: GroupedCoherenceReview;
  onClose: () => void;
  onFocusNode: (nodeId: string) => void;
  onDismissFinding: (finding: CoherenceFinding) => void;
}

export const CoherenceReviewPanel: React.FC<CoherenceReviewPanelProps> = ({
  isOpen,
  review,
  onClose,
  onFocusNode,
  onDismissFinding,
}) => {
  if (!isOpen) return null;

  return (
    <aside className="pm-coherence-panel" role="complementary" aria-label="Coherence Review Panel">
      <div className="pm-coherence-panel__header">
        <div className="pm-coherence-panel__title-wrap">
          <h2 className="pm-coherence-panel__title">
            <span className="pm-coherence-panel__icon">🔍</span> Coherence Review
          </h2>
          <span className="pm-coherence-panel__badge">
            {riskCountPhrase(review.totalOpenCount)}
          </span>
        </div>
        <button
          type="button"
          className="pm-coherence-panel__close-btn"
          onClick={onClose}
          aria-label="Close review panel"
        >
          ✕
        </button>
      </div>

      <div className="pm-coherence-panel__body">
        {review.totalOpenCount === 0 ? (
          <div className="pm-coherence-panel__empty">
            <span className="pm-coherence-panel__empty-icon">✓</span>
            <p className="pm-coherence-panel__empty-text">{riskCountPhrase(0)}</p>
            <p className="pm-coherence-panel__empty-sub">
              Your vision tree, schedules, and dependencies are coherent.
            </p>
          </div>
        ) : (
          <div className="pm-coherence-panel__groups">
            {/* Group A: Orphaned Work */}
            {review.groupAOrphans.length > 0 && (
              <section className="pm-coherence-panel__group">
                <h3 className="pm-coherence-panel__group-title">
                  <span className="pm-coherence-panel__group-tag">A</span> Orphaned Features ({review.groupAOrphans.length})
                </h3>
                <ul className="pm-coherence-panel__list">
                  {review.groupAOrphans.map((finding) => (
                    <li key={finding.id} className="pm-coherence-panel__item">
                      <div className="pm-coherence-panel__item-main">
                        <button
                          type="button"
                          className="pm-coherence-panel__node-link"
                          onClick={() => onFocusNode(finding.targetNodeId)}
                        >
                          {finding.title}
                        </button>
                        <p className="pm-coherence-panel__narrative">{finding.narrative}</p>
                        {finding.actionableEditPrompt && (
                          <p className="pm-coherence-panel__action-hint">
                            💡 {finding.actionableEditPrompt}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        className="pm-coherence-panel__dismiss-btn"
                        onClick={() => onDismissFinding(finding)}
                        title="Dismiss this advisory"
                      >
                        Dismiss
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Group B: Sequencing & Cycles */}
            {review.groupBSequencingAndCycles.length > 0 && (
              <section className="pm-coherence-panel__group">
                <h3 className="pm-coherence-panel__group-title">
                  <span className="pm-coherence-panel__group-tag">B</span> Sequencing & Cycles ({review.groupBSequencingAndCycles.length})
                </h3>
                <ul className="pm-coherence-panel__list">
                  {review.groupBSequencingAndCycles.map((finding) => (
                    <li key={finding.id} className="pm-coherence-panel__item">
                      <div className="pm-coherence-panel__item-main">
                        <button
                          type="button"
                          className="pm-coherence-panel__node-link"
                          onClick={() => onFocusNode(finding.targetNodeId)}
                        >
                          {finding.title}
                        </button>
                        <p className="pm-coherence-panel__narrative">{finding.narrative}</p>
                        {finding.actionableEditPrompt && (
                          <p className="pm-coherence-panel__action-hint">
                            💡 {finding.actionableEditPrompt}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        className="pm-coherence-panel__dismiss-btn"
                        onClick={() => onDismissFinding(finding)}
                        title="Dismiss this advisory"
                      >
                        Dismiss
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Group C: Strategic Imbalances */}
            {review.groupCImbalances.length > 0 && (
              <section className="pm-coherence-panel__group">
                <h3 className="pm-coherence-panel__group-title">
                  <span className="pm-coherence-panel__group-tag">C</span> Strategic Imbalances ({review.groupCImbalances.length})
                </h3>
                <ul className="pm-coherence-panel__list">
                  {review.groupCImbalances.map((finding) => (
                    <li key={finding.id} className="pm-coherence-panel__item">
                      <div className="pm-coherence-panel__item-main">
                        <button
                          type="button"
                          className="pm-coherence-panel__node-link"
                          onClick={() => onFocusNode(finding.targetNodeId)}
                        >
                          {finding.themeName}
                        </button>
                        <p className="pm-coherence-panel__narrative">{finding.narrative}</p>
                        <div className="pm-coherence-panel__shares">
                          <span>Weight: <strong>{finding.strategicWeightShare}%</strong></span>
                          <span>Effort: <strong>{finding.effortShare}%</strong></span>
                          <span>Coverage: <strong>{finding.coveragePercentage}%</strong></span>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="pm-coherence-panel__dismiss-btn"
                        onClick={() => onDismissFinding(finding)}
                        title="Dismiss this advisory"
                      >
                        Dismiss
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>
    </aside>
  );
};
