/**
 * JoinDialog — join a shared project from a pasted invite link (Story 27.4,
 * AC 27.4-3/-4). The joiner gives a name; nothing else is asked (no account,
 * no password). With approval on, the joiner waits and can check again; the
 * project opens only once an owner approves. Behind the collaboration flag;
 * loaded only in the lazy collaboration chunk.
 */

import { useEffect, useRef, useState } from 'react';
import './share-dialog.css';

export type JoinStatus =
  | Readonly<{ kind: 'entry' }>
  | Readonly<{ kind: 'working' }>
  | Readonly<{ kind: 'waiting' }>
  | Readonly<{ kind: 'approved' }>
  | Readonly<{ kind: 'denied' }>
  | Readonly<{ kind: 'error'; message: string }>;

export interface JoinDialogProps {
  readonly status: JoinStatus;
  /** A `vantage://` link the OS opened the app with (Story 28.2); pre-filled, never auto-submitted. */
  readonly initialLink?: string;
  readonly onJoin: (link: string, displayName: string) => void;
  readonly onCheckAgain: () => void;
  readonly onClose: () => void;
}

export function JoinDialog(props: JoinDialogProps): React.ReactElement {
  const [link, setLink] = useState(props.initialLink ?? '');
  const [name, setName] = useState('');
  const [missing, setMissing] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement & HTMLButtonElement>(null);
  const { status } = props;
  useEffect(() => { firstRef.current?.focus(); }, [status.kind]);
  const missingMessage = (): string | null => {
    if (!link.trim() && !name.trim()) return 'Paste the invite link and enter your name.';
    if (!link.trim()) return 'Paste the invite link.';
    if (!name.trim()) return 'Enter your name so teammates know who is joining.';
    return null;
  };
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape' && status.kind !== 'working') { e.preventDefault(); props.onClose(); }
  };

  return (
    <div className="pm-share-dialog" role="dialog" aria-modal="true" aria-labelledby="pm-join-title" onKeyDown={onKeyDown} data-testid="join-dialog">
      <div className="pm-share-dialog__inner">
        <div className="pm-share-dialog__header">
          <h2 id="pm-join-title" className="pm-share-dialog__title">Join a shared project</h2>
          {status.kind !== 'working' ? (
            <button type="button" className="pm-share-dialog__close" aria-label="Close" onClick={props.onClose}>✕</button>
          ) : null}
        </div>

        {status.kind === 'entry' || status.kind === 'error' ? (
          <form className="pm-share-dialog__region" onSubmit={(e) => {
            e.preventDefault();
            const why = missingMessage();
            setMissing(why);
            if (!why) props.onJoin(link.trim(), name.trim());
          }}>
            <label className="pm-share-dialog__label" htmlFor="pm-join-link">Invite or owner recovery link</label>
            <div className="pm-share-dialog__link-row pm-share-dialog__field">
              <input id="pm-join-link" ref={firstRef} className="pm-share-dialog__link" value={link} onChange={(e) => { setLink(e.target.value); setMissing(null); }}
                placeholder="Paste the vantage://join?… link here" autoComplete="off" spellCheck={false} />
            </div>
            <label className="pm-share-dialog__label" htmlFor="pm-join-name">Your name as teammates see it</label>
            <div className="pm-share-dialog__link-row">
              <input id="pm-join-name" className="pm-share-dialog__link" value={name} maxLength={80} onChange={(e) => { setName(e.target.value); setMissing(null); }}
                aria-describedby={missing ? 'pm-join-missing' : status.kind === 'error' ? 'pm-join-error' : undefined} />
              <button type="submit" className="pm-share-dialog__button">Join</button>
            </div>
            {missing ? <p id="pm-join-missing" className="pm-share-dialog__meta" role="alert">{missing}</p> : null}
            {!missing && status.kind === 'error' ? <p id="pm-join-error" className="pm-share-dialog__meta" role="alert">{status.message}</p> : null}
          </form>
        ) : null}

        {status.kind === 'working' ? <p className="pm-share-dialog__meta" role="status" aria-live="polite">Joining…</p> : null}

        {status.kind === 'waiting' ? (
          <section className="pm-share-dialog__region" aria-live="polite">
            <p className="pm-share-dialog__meta">Request sent. Waiting for an owner to approve you; this updates by itself. You can close this and check again later.</p>
            <div className="pm-share-dialog__footer">
              <button ref={firstRef} type="button" className="pm-share-dialog__button" onClick={props.onCheckAgain}>Check again</button>
            </div>
          </section>
        ) : null}

        {status.kind === 'approved' ? (
          <section className="pm-share-dialog__region" aria-live="polite">
            <p className="pm-share-dialog__meta">You were approved. The project is opening.</p>
            <div className="pm-share-dialog__footer">
              <button ref={firstRef} type="button" className="pm-share-dialog__button" onClick={props.onClose}>Done</button>
            </div>
          </section>
        ) : null}

        {status.kind === 'denied' ? (
          <section className="pm-share-dialog__region" aria-live="polite">
            <p className="pm-share-dialog__meta">An owner declined this request. Ask them for a new link if this was a mistake.</p>
            <div className="pm-share-dialog__footer">
              <button ref={firstRef} type="button" className="pm-share-dialog__button" onClick={props.onClose}>Close</button>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
