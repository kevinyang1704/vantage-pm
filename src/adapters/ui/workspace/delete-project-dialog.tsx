import { useEffect, useRef, useState } from 'react';
import { isDeleteConfirmationValid } from '../../../domain/project/delete-confirmation.policy';
import './delete-project-dialog.css';

export interface DeleteProjectDialogProps {
  projectName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteProjectDialog({
  projectName,
  onConfirm,
  onCancel,
}: DeleteProjectDialogProps): React.ReactElement {
  const [typedName, setTypedName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const valid = isDeleteConfirmationValid(typedName, projectName);

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div
      className="pm-delete-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pm-delete-dialog-title"
      onKeyDown={handleKeyDown}
      onClick={onCancel}
    >
      <div className="pm-delete-dialog-inner" onClick={(e) => e.stopPropagation()}>
        <h3 id="pm-delete-dialog-title" className="pm-delete-dialog-title">
          Delete project “{projectName}”?
        </h3>
        <p className="pm-delete-dialog-copy">
          This permanently deletes the project, all of its nodes, phases, findings, and settings.
          There is no undo. Type the project name to confirm.
        </p>
        <input
          ref={inputRef}
          className="pm-delete-dialog-input"
          value={typedName}
          onChange={(e) => setTypedName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && valid) {
              e.preventDefault();
              onConfirm();
            }
          }}
          aria-label="Type project name to confirm deletion"
          placeholder="Type the project name to confirm"
        />
        <div className="pm-delete-dialog-actions">
          <button
            type="button"
            className="pm-delete-dialog-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="pm-delete-dialog-confirm"
            disabled={!valid}
            onClick={onConfirm}
          >
            Delete project
          </button>
        </div>
      </div>
    </div>
  );
}
