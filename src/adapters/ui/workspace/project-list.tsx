/**
 * ProjectList — bare project list with create and inline rename (Story 1.6 Task 1, migrated Story 2.1 Task 4).
 *
 * Uses Meridian CSS custom properties (--pm-*) from the generated token sheet.
 * This is NOT Story 5.2's workspace overview — no theme rows, effort bars,
 * span lanes, or per-project counts.
 */

import { useState, useEffect, useRef } from 'react';
import { isDeleteConfirmationValid } from '../../../domain/project/delete-confirmation.policy';
import './project-list.css';

export interface ProjectListProps {
  projects: ReadonlyArray<{ id: string; name: string; revision: number }>;
  onCreateProject: (name: string) => void;
  onRenameProject: (id: string, name: string) => void;
  onDeleteProject: (id: string) => void;
}

export function ProjectList({
  projects,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
}: ProjectListProps): React.ReactElement {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [typedName, setTypedName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const deleteInputRef = useRef<HTMLInputElement>(null);
  const prevLengthRef = useRef(projects.length);

  // Auto-edit the most recently created project so the user can name it inline.
  useEffect(() => {
    if (projects.length > prevLengthRef.current && projects.length > 0) {
      const newest = projects[projects.length - 1];
      setEditingId(newest.id);
      setEditValue(newest.name);
    }
    prevLengthRef.current = projects.length;
  }, [projects]);

  // Focus and select the input whenever we enter edit mode.
  useEffect(() => {
    if (editingId !== null && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  // Focus the typed-name confirmation input when the dialog opens.
  useEffect(() => {
    if (pendingDelete !== null && deleteInputRef.current) {
      deleteInputRef.current.focus();
    }
  }, [pendingDelete]);

  const openDeleteDialog = (id: string, name: string): void => {
    setPendingDelete({ id, name });
    setTypedName('');
  };

  const confirmDelete = (): void => {
    if (pendingDelete && isDeleteConfirmationValid(typedName, pendingDelete.name)) {
      onDeleteProject(pendingDelete.id);
      setPendingDelete(null);
      setTypedName('');
    }
  };

  const cancelDelete = (): void => {
    setPendingDelete(null);
    setTypedName('');
  };

  const startEdit = (id: string, name: string): void => {
    setEditingId(id);
    setEditValue(name);
  };

  const confirmEdit = (): void => {
    if (editingId !== null && editValue.trim().length > 0) {
      onRenameProject(editingId, editValue.trim());
    }
    setEditingId(null);
    setEditValue('');
  };

  const cancelEdit = (): void => {
    setEditingId(null);
    setEditValue('');
  };

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  };

  const handleCreate = (): void => {
    onCreateProject('New Project');
  };

  return (
    <div className="pm-project-list">
      <div className="pm-project-list-header">Projects</div>

      {projects.length === 0 ? (
        <div className="pm-project-list-empty">
          No projects yet. Create one to get started.
        </div>
      ) : (
        projects.map((project) => {
          const isEditing = editingId === project.id;

          return (
            <div key={project.id} className="pm-project-card">
              {isEditing ? (
                <input
                  ref={inputRef}
                  className="pm-project-card-input"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={confirmEdit}
                  onKeyDown={handleEditKeyDown}
                  aria-label="Project name"
                />
              ) : (
                <span
                  className="pm-project-card-name"
                  onClick={() => startEdit(project.id, project.name)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      startEdit(project.id, project.name);
                    }
                  }}
                >
                  {project.name}
                </span>
              )}
              <span className="pm-project-card-revision">v{project.revision}</span>
              <button
                type="button"
                className="pm-project-card-delete"
                aria-label={`Delete project ${project.name}`}
                onClick={() => openDeleteDialog(project.id, project.name)}
              >
                Delete
              </button>
            </div>
          );
        })
      )}

      {pendingDelete !== null && (
        <div
          className="pm-project-delete-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pm-project-delete-title"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              cancelDelete();
            }
          }}
        >
          <div className="pm-project-delete-dialog-inner">
            <h3 id="pm-project-delete-title" className="pm-project-delete-title">
              Delete project “{pendingDelete.name}”?
            </h3>
            <p className="pm-project-delete-copy">
              This permanently deletes the project and all of its nodes, phases, and findings.
              Type the project name to confirm.
            </p>
            <input
              ref={deleteInputRef}
              className="pm-project-delete-input"
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  confirmDelete();
                }
              }}
              aria-label="Type project name to confirm deletion"
              placeholder={pendingDelete.name}
            />
            <div className="pm-project-delete-actions">
              <button
                type="button"
                className="pm-project-delete-cancel"
                onClick={cancelDelete}
              >
                Cancel
              </button>
              <button
                type="button"
                className="pm-project-delete-confirm"
                disabled={!isDeleteConfirmationValid(typedName, pendingDelete.name)}
                onClick={confirmDelete}
              >
                Delete project
              </button>
            </div>
          </div>
        </div>
      )}

      <button
        className="pm-project-list-create"
        onClick={handleCreate}
        type="button"
      >
        New project
      </button>
    </div>
  );
}
