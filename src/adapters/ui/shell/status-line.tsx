/**
 * StatusLine — the bottom rail of the authoring shell.
 *
 * Renders the session-state segment (AD-5 provisional copy) and reserves
 * space for the counts segment (nodes, phases, undated, unphased — Stories 2.2/2.3).
 *
 * The session-state segment is a polite live region (role="status").
 * The counts segment is NOT live — counts must not narrate on every revision.
 */

import './status-line.css';

export interface StatusLineProps {
  /** Session state text (AD-5 provisional copy). */
  readonly sessionState: string;
}

export function StatusLine({ sessionState }: StatusLineProps): React.ReactElement {
  return (
    <div className="pm-status-line-inner">
      <span className="pm-status-line-session" role="status">
        {sessionState}
      </span>
      {/* Reserved counts segment — filled by Stories 2.2/2.3 */}
      <span className="pm-status-line-counts" data-testid="status-line-counts" />
    </div>
  );
}
