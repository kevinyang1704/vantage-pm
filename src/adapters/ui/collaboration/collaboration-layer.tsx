/**
 * CollaborationLayer (Story 27.6/27.7/27.8, AD-20).
 *
 * The single mount point for every collaboration surface, rendered beside the
 * repository UI only when the `collaboration` flag is on AND the open project is
 * shared. With the flag off it renders `null` and nothing else in the app
 * changes — no import is even evaluated beyond the flag check, and a local
 * project never mounts it (TC-NFR1).
 *
 * It is intentionally small: it renders the title-bar sync indicator, the
 * “Changes that couldn’t be applied” panel, presence, and the Share dialog,
 * driven entirely by props. The app supplies the live state from the
 * `CollaborationService`; this component owns no I/O.
 */

import { useEffect } from 'react';
import { SyncIndicator } from './sync-indicator';
import { RejectedChangesPanel, type RejectedChangeView } from './rejected-changes-panel';
import { ShareDialog, type ShareDialogProps } from './share-dialog';
import type { SyncState } from '../../../domain/collaboration/sync-state';
import type { PresenceEntry } from '../../../domain/collaboration/attribution';
import { PresenceAvatars } from './presence-avatars';
import { ActivityPanel, type ActivityPanelProps } from './activity-panel';
import { applyViewOnly } from './view-only';
import './collaboration-layer.css';

export interface CollaborationLayerProps {
  readonly enabled: boolean;
  readonly syncState: SyncState;
  readonly rejected: readonly RejectedChangeView[];
  readonly present: readonly PresenceEntry[];
  readonly onRetry: (commandId: string) => void;
  readonly onCopy: (commandId: string) => void;
  readonly onDiscard: (commandId: string) => void;
  readonly shareDialog: ShareDialogProps | null;
  /** Story 27.8: the attributed activity feed, shown when open. */
  readonly activity?: ActivityPanelProps | null;
  readonly activityOpen?: boolean;
  readonly onToggleActivity?: () => void;
  /** A persistent notice, e.g. view-only or a read-only copy (AC 27.6-4/-5). */
  readonly notice?: string | null;
  /** The device may not edit this project: edit controls look and act unavailable. */
  readonly viewOnly?: boolean;
}

export function CollaborationLayer(props: CollaborationLayerProps): React.ReactElement | null {
  const viewOnly = props.enabled && props.viewOnly === true;
  useEffect(() => {
    if (!viewOnly) return;
    const root = document.querySelector<HTMLElement>('.pm-shell-body');
    return root ? applyViewOnly(root) : undefined;
  }, [viewOnly]);
  if (!props.enabled) return null;
  return (
    <div className="pm-collaboration-layer">
      <div className="pm-collaboration-layer__titlebar">
        <SyncIndicator state={props.syncState} />
        <PresenceAvatars members={props.present} />
        {props.onToggleActivity ? (
          <button type="button" className="pm-collaboration-layer__activity-toggle" aria-expanded={props.activityOpen === true} onClick={props.onToggleActivity}>
            Activity
          </button>
        ) : null}
      </div>
      {props.notice ? <p className="pm-collaboration-layer__notice" role="status">{props.notice}</p> : null}
      {props.activityOpen && props.activity ? <ActivityPanel {...props.activity} /> : null}
      <RejectedChangesPanel
        changes={props.rejected}
        onRetry={props.onRetry}
        onCopy={props.onCopy}
        onDiscard={props.onDiscard}
      />
      {props.shareDialog ? <ShareDialog {...props.shareDialog} /> : null}
    </div>
  );
}
