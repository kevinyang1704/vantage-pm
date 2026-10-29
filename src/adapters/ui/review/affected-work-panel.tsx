/**
 * AffectedWorkPanel — Downstream Affected Work Review (Story 4.8).
 *
 * Displays all downstream affected consequences caused by upstream date changes.
 * Allows click-to-focus navigation and explicit per-reason acknowledgement.
 */

import React from 'react';
import type { AffectedReason } from '../../../contracts/analysis-protocol';
import './affected-work-panel.css';

export interface AffectedWorkPanelProps {
  isOpen: boolean;
  reasons: readonly AffectedReason[];
  onClose: () => void;
  onFocusNode: (nodeId: string) => void;
  onAcknowledgeReason: (reasonId: string) => void;
}

export const AffectedWorkPanel: React.FC<AffectedWorkPanelProps> = ({
  isOpen,
  reasons,
  onClose,
  onFocusNode,
  onAcknowledgeReason,
}) => {
  if (!isOpen) return null;

  const openReasons = reasons.filter((r) => !r.acknowledgedAt);

  return (
    <aside className="pm-affected-panel" role="complementary" aria-label="Affected Work Panel">
      <div className="pm-affected-panel__header">
        <div className="pm-affected-panel__title-wrap">
          <h2 className="pm-affected-panel__title">
            <span className="pm-affected-panel__icon">⚠️</span> Downstream Consequences
          </h2>
          <span className="pm-affected-panel__badge">
            {openReasons.length} affected {openReasons.length === 1 ? 'item' : 'items'}
          </span>
        </div>
        <button
          type="button"
          className="pm-affected-panel__close-btn"
          onClick={onClose}
          aria-label="Close affected work panel"
        >
          ✕
        </button>
      </div>

      <div className="pm-affected-panel__body">
        {openReasons.length === 0 ? (
          <div className="pm-affected-panel__empty">
            <span className="pm-affected-panel__empty-icon">✓</span>
            <p className="pm-affected-panel__empty-text">no pending date consequences</p>
            <p className="pm-affected-panel__empty-sub">
              All downstream dependencies have been reviewed or acknowledged.
            </p>
          </div>
        ) : (
          <ul className="pm-affected-panel__list">
            {openReasons.map((reason) => (
              <li key={reason.id} className="pm-affected-panel__item">
                <div className="pm-affected-panel__item-header">
                  <button
                    type="button"
                    className="pm-affected-panel__node-link"
                    onClick={() => onFocusNode(reason.affectedNodeId)}
                  >
                    Affected Node
                  </button>
                  <span className={`pm-affected-panel__shift-pill ${reason.deltaDays > 0 ? 'pm-affected-panel__shift-pill--delay' : 'pm-affected-panel__shift-pill--advance'}`}>
                    {reason.deltaDays > 0 ? `+${reason.deltaDays}d` : `${reason.deltaDays}d`}
                  </span>
                </div>

                <p className="pm-affected-panel__detail">
                  Caused by date change on prerequisite <strong>&ldquo;{reason.causalNodeTitle}&rdquo;</strong>.
                </p>
                <p className="pm-affected-panel__summary">{reason.causalDateSummary}</p>

                <div className="pm-affected-panel__actions">
                  <button
                    type="button"
                    className="pm-affected-panel__btn pm-affected-panel__btn--secondary"
                    onClick={() => onFocusNode(reason.affectedNodeId)}
                  >
                    Go to Node
                  </button>
                  <button
                    type="button"
                    className="pm-affected-panel__btn pm-affected-panel__btn--primary"
                    onClick={() => onAcknowledgeReason(reason.id)}
                  >
                    Acknowledge
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
};
