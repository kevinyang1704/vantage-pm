/**
 * ShareDialog — the owner's Share surface (Story 27.6, TC-UX4, AC 27.6-1/-3/-5).
 *
 * Regions: the invite link (role + expiry), pending join requests (Approve /
 * Deny), members and devices (roles, remove, replace link), and stop sharing.
 * Owners only; a viewer never sees it. Everything here is behind the
 * `collaboration` flag; a local project has no Share action.
 */

import { useEffect, useRef } from 'react';
import type { ProjectRole } from '../../../domain/collaboration/share-lifecycle';
import { CopyButton } from './copy-button';
import './share-dialog.css';

export interface InviteLinkView {
  readonly url: string;
  readonly role: ProjectRole;
  readonly singleUse: boolean;
  readonly expiresAtISO: string | null;
}

export interface JoinRequestView {
  readonly requestId: string;
  readonly displayName: string;
  readonly role: ProjectRole;
}

export interface MemberView {
  readonly deviceId: string;
  readonly displayName: string;
  readonly role: ProjectRole;
  readonly thisDevice: boolean;
}

export interface ShareDialogProps {
  readonly projectName: string;
  readonly invite: InviteLinkView | null;
  readonly joinRequests: readonly JoinRequestView[];
  readonly members: readonly MemberView[];
  readonly onApprove: (requestId: string) => void;
  readonly onDeny: (requestId: string) => void;
  readonly onRemoveDevice: (deviceId: string) => void;
  /** Resolves whether the link actually reached the clipboard. */
  readonly onCopyInvite: () => Promise<boolean>;
  readonly onReplaceInvite: () => void;
  readonly onStopSharing: () => void;
  readonly onClose: () => void;
  /** Creates a single-use, expiring link for the role (owner only). */
  readonly onCreateInvite?: (role: 'editor' | 'viewer') => void;
  /** A plain-language result or failure line, announced politely. */
  readonly statusMessage?: string | null;
  /** Owner approval for new joiners (AC 27.4-4); undefined hides the control. */
  readonly approvalRequired?: boolean;
  readonly onApprovalChange?: (required: boolean) => void;
  /** Owner changes another member's role (AC 27.4-5). */
  readonly onChangeRole?: (deviceId: string, role: ProjectRole) => void;
}

export function ShareDialog(props: ShareDialogProps): React.ReactElement {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    }
  };

  return (
    <div
      className="pm-share-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pm-share-dialog-title"
      onKeyDown={onKeyDown}
    >
      <div className="pm-share-dialog__inner">
        <div className="pm-share-dialog__header">
          <h2 id="pm-share-dialog-title" className="pm-share-dialog__title">
            Share “{props.projectName}”
          </h2>
          <button ref={closeRef} type="button" className="pm-share-dialog__close" aria-label="Close" onClick={props.onClose}>
            ✕
          </button>
        </div>

        <section className="pm-share-dialog__region" aria-labelledby="pm-share-invite-label">
          <h3 id="pm-share-invite-label" className="pm-share-dialog__label">Invite link</h3>
          {props.invite ? (
            <>
              <div className="pm-share-dialog__link-row">
                <input className="pm-share-dialog__link" readOnly value={props.invite.url} aria-label="Invite link" />
                <CopyButton className="pm-share-dialog__button" onCopy={props.onCopyInvite} />
                <button type="button" className="pm-share-dialog__button pm-share-dialog__button--ghost" onClick={props.onReplaceInvite}>Replace</button>
              </div>
              <p className="pm-share-dialog__meta">
                <span className="pm-badge" data-role={props.invite.role}>{roleLabel(props.invite.role)}</span>
                <span className="pm-chip">{props.invite.singleUse ? 'Single-use' : 'Multi-use'}</span>
                {props.invite.expiresAtISO ? <span className="pm-chip">Expires {props.invite.expiresAtISO.slice(0, 10)}</span> : null}
              </p>
            </>
          ) : (
            <>
              <p className="pm-share-dialog__meta">No active invite link.</p>
              {props.onCreateInvite ? (
                <div className="pm-share-dialog__link-row">
                  <button type="button" className="pm-share-dialog__button" onClick={() => props.onCreateInvite?.('editor')}>Create editor link</button>
                  <button type="button" className="pm-share-dialog__button pm-share-dialog__button--ghost" onClick={() => props.onCreateInvite?.('viewer')}>Create viewer link</button>
                </div>
              ) : null}
            </>
          )}
          {props.statusMessage ? <p className="pm-share-dialog__meta" role="status" aria-live="polite">{props.statusMessage}</p> : null}
        </section>

        <section className="pm-share-dialog__region" aria-labelledby="pm-share-requests-label">
          <h3 id="pm-share-requests-label" className="pm-share-dialog__label">Waiting for approval</h3>
          {props.approvalRequired !== undefined && props.onApprovalChange ? (
            <label className="pm-share-dialog__meta">
              <input type="checkbox" checked={props.approvalRequired} onChange={(e) => props.onApprovalChange?.(e.target.checked)} /> Require owner approval to join
            </label>
          ) : null}
          {props.approvalRequired === false ? (
            <p className="pm-share-dialog__meta pm-share-dialog__warning" role="alert">
              Approval is off: anyone with a valid link joins and can work immediately.
            </p>
          ) : null}
          {props.joinRequests.length === 0 ? (
            <p className="pm-share-dialog__meta">No one is waiting.</p>
          ) : (
            <ul className="pm-share-dialog__list">
              {props.joinRequests.map((request) => (
                <li key={request.requestId} className="pm-share-dialog__row">
                  <span className="pm-share-dialog__who">
                    {request.displayName} wants to join as <span className="pm-badge" data-role={request.role}>{roleLabel(request.role)}</span>
                  </span>
                  <span className="pm-share-dialog__actions">
                    <button type="button" className="pm-share-dialog__button" onClick={() => props.onApprove(request.requestId)}>Approve</button>
                    <button type="button" className="pm-share-dialog__button pm-share-dialog__button--ghost" onClick={() => props.onDeny(request.requestId)}>Deny</button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="pm-share-dialog__region" aria-labelledby="pm-share-members-label">
          <h3 id="pm-share-members-label" className="pm-share-dialog__label">Members and devices</h3>
          <ul className="pm-share-dialog__list">
            {props.members.map((member) => (
              <li key={member.deviceId} className="pm-share-dialog__row">
                <span className="pm-share-dialog__who">
                  {member.displayName}
                  {member.thisDevice ? <span className="pm-share-dialog__this"> · this device</span> : null}
                </span>
                {!member.thisDevice && props.onChangeRole ? (
                  <select aria-label={`Role for ${member.displayName}`} value={member.role} onChange={(e) => props.onChangeRole?.(member.deviceId, e.target.value as ProjectRole)}>
                    <option value="owner">Owner</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                ) : (
                  <span className="pm-badge" data-role={member.role}>{roleLabel(member.role)}</span>
                )}
                {!member.thisDevice ? (
                  <button type="button" className="pm-share-dialog__button pm-share-dialog__button--ghost" onClick={() => props.onRemoveDevice(member.deviceId)}>
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>

        <div className="pm-share-dialog__footer">
          <button type="button" className="pm-share-dialog__button pm-share-dialog__button--danger" onClick={props.onStopSharing}>
            Stop sharing
          </button>
          <span className="pm-share-dialog__hint">The last owner cannot leave or be demoted.</span>
        </div>
      </div>
    </div>
  );
}

function roleLabel(role: ProjectRole): string {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'editor':
      return 'Editor';
    case 'viewer':
      return 'Viewer';
  }
}
