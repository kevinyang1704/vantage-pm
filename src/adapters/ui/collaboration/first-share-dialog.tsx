/**
 * FirstShareDialog — turn a local project into a shared one (Story 27.6,
 * TC-UX4, R7). Explicit and per project: nothing is uploaded until the owner
 * confirms. One step: the result shows a ready invite link (editor by default,
 * switchable to view-only) together with the once-shown recovery link. The owner's recovery code is shown exactly once, with a copy
 * action and an acknowledgement, because the service stores only its hash.
 * Behind the collaboration flag; loaded only in the lazy collaboration chunk.
 */

import { useEffect, useRef, useState } from 'react';
import { CopyButton } from './copy-button';
import './share-dialog.css';

export type FirstShareStatus =
  | Readonly<{ kind: 'confirm' }>
  | Readonly<{ kind: 'working' }>
  | Readonly<{ kind: 'done'; recoveryCode: string | null; invite: Readonly<{ link: string; role: 'editor' | 'viewer' }> | null; inviteNote?: string | null }>
  /** `offerCopy`: this project cannot be shared as itself here; a copy can. */
  | Readonly<{ kind: 'error'; message: string; offerCopy?: boolean }>;

export interface FirstShareDialogProps {
  readonly projectName: string;
  readonly status: FirstShareStatus;
  readonly defaultName: string;
  readonly onShare: (displayName: string) => void;
  /** Copy the project under a new ID and share the copy (original untouched). */
  readonly onShareCopy: (displayName: string) => void;
  /** Resolves whether the code actually reached the clipboard. */
  readonly onCopyRecovery: (code: string) => Promise<boolean>;
  /** Resolves whether the invite link actually reached the clipboard. */
  readonly onCopyInvite: (link: string) => Promise<boolean>;
  /** Replace the invite with one for the other role. */
  readonly onInviteRoleChange: (role: 'editor' | 'viewer') => void;
  readonly onClose: () => void;
}

export function FirstShareDialog(props: FirstShareDialogProps): React.ReactElement {
  const [name, setName] = useState(props.defaultName);
  const [acknowledged, setAcknowledged] = useState(false);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement & HTMLButtonElement>(null);
  const { status } = props;
  useEffect(() => { firstRef.current?.focus(); }, [status.kind]);
  const trimmed = name.trim();
  const canClose = status.kind !== 'working' && (status.kind !== 'done' || status.recoveryCode === null || acknowledged);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape' && canClose) { e.preventDefault(); props.onClose(); }
  };

  return (
    <div className="pm-share-dialog" role="dialog" aria-modal="true" aria-labelledby="pm-first-share-title" onKeyDown={onKeyDown} data-testid="first-share-dialog">
      <div className="pm-share-dialog__inner">
        <div className="pm-share-dialog__header">
          <h2 id="pm-first-share-title" className="pm-share-dialog__title">Share “{props.projectName}”</h2>
          {canClose ? (
            <button type="button" className="pm-share-dialog__close" aria-label="Close" onClick={props.onClose}>✕</button>
          ) : null}
        </div>

        {status.kind === 'confirm' || status.kind === 'error' ? (
          <form
            className="pm-share-dialog__region"
            onSubmit={(e) => { e.preventDefault(); if (trimmed) props.onShare(trimmed); }}
          >
            <p className="pm-share-dialog__meta">
              Sharing uploads this project to your team service so invited people can edit it with you. Other projects stay on this device.
            </p>
            <label className="pm-share-dialog__label" htmlFor="pm-first-share-name">Your name as teammates see it</label>
            <div className="pm-share-dialog__link-row">
              <input
                id="pm-first-share-name"
                ref={firstRef}
                className="pm-share-dialog__link"
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
                aria-describedby={status.kind === 'error' ? 'pm-first-share-error' : undefined}
              />
              <button type="submit" className="pm-share-dialog__button" disabled={!trimmed}>
                {status.kind === 'error' ? 'Try again' : 'Share'}
              </button>
            </div>
            {status.kind === 'error' ? (
              <p id="pm-first-share-error" className="pm-share-dialog__meta" role="alert">{status.message}</p>
            ) : null}
            {status.kind === 'error' && status.offerCopy ? (
              <>
                <p className="pm-share-dialog__meta">
                  You can share a copy instead. The copy gets its own identity on the team service; this original stays on this device, unshared.
                </p>
                <div className="pm-share-dialog__footer">
                  <button type="button" className="pm-share-dialog__button" disabled={!trimmed} onClick={() => props.onShareCopy(trimmed)}>Share as a new copy</button>
                </div>
              </>
            ) : null}
          </form>
        ) : null}

        {status.kind === 'working' ? (
          <p className="pm-share-dialog__meta" role="status" aria-live="polite">Sharing… your project stays usable on this device.</p>
        ) : null}

        {status.kind === 'done' ? (
          <section className="pm-share-dialog__region" aria-labelledby="pm-first-share-done">
            <h3 id="pm-first-share-done" className="pm-share-dialog__label">Shared. Invite your teammates</h3>
            {status.invite ? (
              <>
                <div className="pm-share-dialog__link-row">
                  <input className="pm-share-dialog__link" readOnly value={status.invite.link} aria-label="Invite link" />
                  <CopyButton buttonRef={firstRef} className="pm-share-dialog__button" onCopy={() => props.onCopyInvite(status.invite!.link)} />
                </div>
                <p className="pm-share-dialog__meta">
                  <label>
                    People who join with this link{' '}
                    <select aria-label="Invite role" value={status.invite.role} onChange={(e) => props.onInviteRoleChange(e.target.value as 'editor' | 'viewer')}>
                      <option value="editor">can edit</option>
                      <option value="viewer">can only view</option>
                    </select>
                  </label>
                </p>
                <p className="pm-share-dialog__meta">Works once and expires in 7 days. You approve each person who joins.</p>
              </>
            ) : (
              <p className="pm-share-dialog__meta" role="status">The invite link could not be created yet. Open Sharing to create one.</p>
            )}
            {status.inviteNote ? <p className="pm-share-dialog__meta" role="status" aria-live="polite">{status.inviteNote}</p> : null}

            {status.recoveryCode ? (
              <>
                <h3 className="pm-share-dialog__label">Save your owner recovery link</h3>
                <p className="pm-share-dialog__meta">
                  Keep this private; do not send it to teammates. It is shown only now, works once, and is the only way to get owner access back if you lose this browser or device.
                </p>
                <div className="pm-share-dialog__link-row">
                  <input className="pm-share-dialog__link" readOnly value={status.recoveryCode} aria-label="Owner recovery link" data-testid="recovery-code" />
                  <CopyButton className="pm-share-dialog__button" onCopy={() => props.onCopyRecovery(status.recoveryCode as string).then((copied) => {
                    setCopyNote(copied ? null : 'Copying is blocked here. Select the link, then press Ctrl+C.');
                    return copied;
                  })} />
                </div>
                {copyNote ? <p className="pm-share-dialog__meta" role="status" aria-live="polite">{copyNote}</p> : null}
                <label className="pm-share-dialog__meta">
                  <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} /> I saved the recovery link
                </label>
              </>
            ) : null}
            <div className="pm-share-dialog__footer">
              <button type="button" className="pm-share-dialog__button" disabled={!canClose} onClick={props.onClose}>Done</button>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
