/**
 * Workspace create / rename dialog (Epic 17).
 *
 * One component for both operations — they differ only in title, copy, and
 * the confirm label, and sharing them means the name rules can never drift
 * between "new workspace" and "rename workspace". Validation comes from the
 * domain policy, not a local regex.
 */

import { useEffect, useRef, useState } from 'react';
import {
  validateWorkspaceName,
  MAX_WORKSPACE_NAME_LENGTH,
} from '../../../domain/workspace/workspace.policy';
import './workspace-name-dialog.css';

export interface WorkspaceNameDialogProps {
  readonly mode: 'create' | 'rename';
  /** Pre-filled for rename; empty for create. */
  readonly initialName?: string;
  readonly onConfirm: (name: string) => void;
  readonly onCancel: () => void;
}

export function WorkspaceNameDialog({
  mode,
  initialName = '',
  onConfirm,
  onCancel,
}: WorkspaceNameDialogProps): React.ReactElement {
  const [name, setName] = useState(initialName);
  // Errors appear only after a submit attempt, never while the user is still
  // typing their first character into an empty field.
  const [submitted, setSubmitted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const validation = validateWorkspaceName(name);
  const titleId = 'pm-ws-dialog-title';

  const errorMessage = (): string | null => {
    if (!submitted || validation.valid) return null;
    return validation.cause === 'EMPTY_NAME'
      ? 'Enter a name for this workspace.'
      : `Keep the name to ${MAX_WORKSPACE_NAME_LENGTH} characters or fewer.`;
  };

  const submit = (): void => {
    setSubmitted(true);
    if (!validation.valid) {
      inputRef.current?.focus();
      return;
    }
    onConfirm(validation.trimmed);
  };

  const message = errorMessage();

  return (
    <div
      className="pm-ws-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      onClick={onCancel}
    >
      <div className="pm-ws-dialog-inner" onClick={(e) => e.stopPropagation()}>
        <h3 id={titleId} className="pm-ws-dialog-title">
          {mode === 'create' ? 'New workspace' : 'Rename workspace'}
        </h3>
        <p className="pm-ws-dialog-copy">
          {mode === 'create'
            ? 'A workspace is a named group of projects. It starts empty — you can move existing projects into it from the project shelf.'
            : 'Renaming a workspace does not affect the projects inside it.'}
        </p>

        <label className="pm-ws-dialog-label" htmlFor="pm-ws-dialog-name">
          Name
        </label>
        <input
          ref={inputRef}
          id="pm-ws-dialog-name"
          className="pm-ws-dialog-input"
          value={name}
          placeholder="Workspace name"
          aria-invalid={message !== null}
          aria-describedby={message ? 'pm-ws-dialog-message' : undefined}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />

        {message ? (
          <p id="pm-ws-dialog-message" className="pm-ws-dialog-error" role="alert">
            {message}
          </p>
        ) : (
          <p className="pm-ws-dialog-hint">Stored on this device. Nothing is uploaded.</p>
        )}

        <div className="pm-ws-dialog-actions">
          <button type="button" className="pm-ws-dialog-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="pm-ws-dialog-confirm"
            disabled={!validation.valid}
            onClick={submit}
          >
            {mode === 'create' ? 'Create workspace' : 'Rename workspace'}
          </button>
        </div>
      </div>
    </div>
  );
}
