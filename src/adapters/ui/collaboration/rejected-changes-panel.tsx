/**
 * RejectedChangesPanel — “Changes that couldn’t be applied” (Story 27.7, TC-UX3, R8).
 *
 * Each rejected edit shows the item, the user's value, the plain reason, and
 * Retry / Copy / Discard. Nothing is dropped without the user choosing it.
 * Retry creates a NEW command id (handled by the caller). The whole panel is a
 * polite live region so new rejections are announced.
 */

import './rejected-changes-panel.css';

export interface RejectedChangeView {
  readonly commandId: string;
  readonly label: string;
  readonly yourValue: string;
  readonly reason: string;
}

export interface RejectedChangesPanelProps {
  readonly changes: readonly RejectedChangeView[];
  readonly onRetry: (commandId: string) => void;
  readonly onCopy: (commandId: string) => void;
  readonly onDiscard: (commandId: string) => void;
}

export function RejectedChangesPanel(props: RejectedChangesPanelProps): React.ReactElement | null {
  if (props.changes.length === 0) return null;
  const count = props.changes.length;
  return (
    <section className="pm-rejected" aria-labelledby="pm-rejected-title" role="status">
      <h2 id="pm-rejected-title" className="pm-rejected__title">
        {count === 1 ? '1 change couldn’t be applied' : `${count} changes couldn’t be applied`}
      </h2>
      <ul className="pm-rejected__list">
        {props.changes.map((change) => (
          <li key={change.commandId} className="pm-rejected__item">
            <div className="pm-rejected__head">
              <span className="pm-rejected__label">{change.label}</span>
              <span className="pm-rejected__badge">Not applied</span>
            </div>
            <p className="pm-rejected__value">Your value: {change.yourValue}</p>
            <p className="pm-rejected__reason">{change.reason}</p>
            <div className="pm-rejected__actions">
              <button type="button" className="pm-rejected__button" onClick={() => props.onRetry(change.commandId)}>Retry</button>
              <button type="button" className="pm-rejected__button pm-rejected__button--ghost" onClick={() => props.onCopy(change.commandId)}>Copy</button>
              <button type="button" className="pm-rejected__button pm-rejected__button--ghost" onClick={() => props.onDiscard(change.commandId)}>Discard</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
