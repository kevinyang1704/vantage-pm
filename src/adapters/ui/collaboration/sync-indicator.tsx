/**
 * SyncIndicator — the title-bar sync-state control (Story 27.7, TC-UX1, R8).
 *
 * Renders one of the five labels and an accompanying accessible notice. A local
 * project renders nothing (today's title bar, TC-NFR1). State changes are
 * announced politely via role="status".
 */

import { type SyncState, resolveSyncIndicator } from '../../../domain/collaboration/sync-state';
import './sync-indicator.css';

export interface SyncIndicatorProps {
  readonly state: SyncState;
}

export function SyncIndicator({ state }: SyncIndicatorProps): React.ReactElement | null {
  const indicator = resolveSyncIndicator(state);
  if (indicator.text === null) return null;

  return (
    <span className="pm-sync-indicator" data-sync-label={indicator.label}>
      <span className="pm-sync-indicator__glyph" aria-hidden="true">{glyphFor(indicator.label)}</span>
      <span className="pm-sync-indicator__text">{indicator.text}</span>
      <span className="pm-sync-indicator__notice" role="status">
        {indicator.notice ?? indicator.text}
      </span>
    </span>
  );
}

function glyphFor(label: string): string {
  switch (label) {
    case 'synced':
      return '✓';
    case 'n-changes-waiting':
      return '↻';
    case 'offline':
      return '⏻';
    case 'update-to-keep-syncing':
      return '↑';
    default:
      return '⌂';
  }
}
