/**
 * MemberDialog — a member's view of a shared project (Story 27.6, AC 27.6-5).
 * Shows their role and lets them leave. Leaving makes this device's copy
 * read-only; the member may then delete it from the workspace. Behind the
 * collaboration flag; loaded only in the lazy collaboration chunk.
 */

import { useEffect, useRef, useState } from 'react';
import './share-dialog.css';

export interface MemberDialogProps {
  readonly projectName: string;
  readonly role: 'editor' | 'viewer';
  readonly busy: boolean;
  readonly message: string | null;
  readonly onLeave: () => void;
  readonly onClose: () => void;
}

export function MemberDialog(props: MemberDialogProps): React.ReactElement {
  const [confirming, setConfirming] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); }, []);
  return (
    <div className="pm-share-dialog" role="dialog" aria-modal="true" aria-labelledby="pm-member-title"
      onKeyDown={(e) => { if (e.key === 'Escape' && !props.busy) { e.preventDefault(); props.onClose(); } }}>
      <div className="pm-share-dialog__inner">
        <div className="pm-share-dialog__header">
          <h2 id="pm-member-title" className="pm-share-dialog__title">“{props.projectName}” is shared with you</h2>
          <button ref={closeRef} type="button" className="pm-share-dialog__close" aria-label="Close" onClick={props.onClose} disabled={props.busy}>✕</button>
        </div>
        <p className="pm-share-dialog__meta">You are {props.role === 'editor' ? 'an Editor' : 'a Viewer'}. Only an owner can invite people or change roles.</p>
        {props.message ? <p className="pm-share-dialog__meta" role="status" aria-live="polite">{props.message}</p> : null}
        <div className="pm-share-dialog__footer">
          {confirming ? (
            <>
              <span className="pm-share-dialog__hint">Leave? This copy stays on this device but becomes read-only.</span>
              <button type="button" className="pm-share-dialog__button pm-share-dialog__button--danger" disabled={props.busy} onClick={props.onLeave}>Leave project</button>
              <button type="button" className="pm-share-dialog__button pm-share-dialog__button--ghost" disabled={props.busy} onClick={() => setConfirming(false)}>Cancel</button>
            </>
          ) : (
            <button type="button" className="pm-share-dialog__button pm-share-dialog__button--danger" onClick={() => setConfirming(true)}>Leave this project</button>
          )}
        </div>
      </div>
    </div>
  );
}
