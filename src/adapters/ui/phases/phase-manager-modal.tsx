/**
 * PhaseManagerModal — Modal for managing project phases (Story 3.7).
 * Allows creating, reordering, renaming, and deleting phases with node reassignment preview.
 */

import React, { useState } from 'react';
import type { Phase } from '../../../domain/phase/phase.entity';
import type { OutlineNodeReadModel } from '../../../application/outline/outline-read-model';
import { movePhaseInList, normalizePhaseName } from '../../../domain/phase/phase-position.policy';
import './phase-manager-modal.css';

export interface PhaseManagerModalProps {
  isOpen: boolean;
  phases: readonly Phase[];
  nodes: readonly OutlineNodeReadModel[];
  onClose: () => void;
  onCreatePhase: (name: string) => void;
  onRenamePhase: (phaseId: string, name: string) => void;
  onReorderPhases: (phases: readonly { phaseId: string; position: bigint }[]) => void;
  onDeletePhase: (phaseId: string, reassignments: Record<string, string | null>) => void;
}

export const PhaseManagerModal: React.FC<PhaseManagerModalProps> = ({
  isOpen,
  phases,
  nodes,
  onClose,
  onCreatePhase,
  onRenamePhase,
  onReorderPhases,
  onDeletePhase,
}) => {
  const [newPhaseName, setNewPhaseName] = useState('');
  const [editingPhaseId, setEditingPhaseId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [deletingPhaseId, setDeletingPhaseId] = useState<string | null>(null);
  const [reassignTargetId, setReassignTargetId] = useState<string>('unassigned');

  if (!isOpen) return null;

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = normalizePhaseName(newPhaseName);
    if (clean) {
      onCreatePhase(clean);
      setNewPhaseName('');
    }
  };

  const handleStartEdit = (phase: Phase) => {
    setEditingPhaseId(phase.id);
    setEditName(phase.name);
  };

  const handleSaveEdit = (phaseId: string) => {
    const clean = normalizePhaseName(editName);
    if (clean) {
      onRenamePhase(phaseId, clean);
    }
    setEditingPhaseId(null);
  };

  const handleMove = (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= phases.length) return;
    const reordered = movePhaseInList(phases, fromIndex, toIndex);
    const payload = reordered.map((p) => ({
      phaseId: p.id,
      position: p.position,
    }));
    onReorderPhases(payload);
  };

  const handleConfirmDelete = (phaseId: string) => {
    const affectedNodes = nodes.filter((n) => n.phaseId === phaseId);
    const reassignments: Record<string, string | null> = {};
    const target = reassignTargetId === 'unassigned' ? null : reassignTargetId;

    for (const n of affectedNodes) {
      reassignments[n.id] = target;
    }

    onDeletePhase(phaseId, reassignments);
    setDeletingPhaseId(null);
    setReassignTargetId('unassigned');
  };

  const deletingPhase = phases.find((p) => p.id === deletingPhaseId);
  const affectedCount = deletingPhaseId ? nodes.filter((n) => n.phaseId === deletingPhaseId).length : 0;
  const otherPhases = phases.filter((p) => p.id !== deletingPhaseId);

  return (
    <div className="pm-phase-modal__backdrop" role="dialog" aria-modal="true" aria-labelledby="phase-modal-title">
      <div className="pm-phase-modal">
        <div className="pm-phase-modal__header">
          <h2 id="phase-modal-title" className="pm-phase-modal__title">
            <span className="pm-phase-modal__icon">🏷</span> Manage Project Phases
          </h2>
          <button
            type="button"
            className="pm-phase-modal__close-btn"
            onClick={onClose}
            aria-label="Close phase manager"
          >
            ✕
          </button>
        </div>

        {deletingPhaseId ? (
          <div className="pm-phase-modal__delete-confirm">
            <h3 className="pm-phase-modal__confirm-title">Delete Phase: {deletingPhase?.name}</h3>
            {affectedCount > 0 ? (
              <div className="pm-phase-modal__reassign-prompt">
                <p>
                  <strong>{affectedCount}</strong> node{affectedCount > 1 ? 's are' : ' is'} currently assigned to this phase.
                  Choose where to reassign them:
                </p>
                <select
                  value={reassignTargetId}
                  onChange={(e) => setReassignTargetId(e.target.value)}
                  className="pm-phase-modal__select"
                >
                  <option value="unassigned">Remove phase assignment (None)</option>
                  {otherPhases.map((p) => (
                    <option key={p.id} value={p.id}>
                      Reassign to: {p.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <p>No items are assigned to this phase. It can be safely deleted.</p>
            )}
            <div className="pm-phase-modal__actions">
              <button
                type="button"
                className="pm-phase-modal__btn pm-phase-modal__btn--secondary"
                onClick={() => setDeletingPhaseId(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="pm-phase-modal__btn pm-phase-modal__btn--danger"
                onClick={() => handleConfirmDelete(deletingPhaseId)}
              >
                Delete Phase
              </button>
            </div>
          </div>
        ) : (
          <div className="pm-phase-modal__body">
            <form onSubmit={handleCreate} className="pm-phase-modal__create-form">
              <input
                type="text"
                placeholder="New phase name (e.g. Q1 Beta, GA, Sprint 1)..."
                value={newPhaseName}
                onChange={(e) => setNewPhaseName(e.target.value)}
                className="pm-phase-modal__input"
              />
              <button
                type="submit"
                disabled={!newPhaseName.trim()}
                className="pm-phase-modal__btn pm-phase-modal__btn--primary"
              >
                Add Phase
              </button>
            </form>

            <div className="pm-phase-modal__list-container">
              <h3 className="pm-phase-modal__section-title">Phases ({phases.length})</h3>
              {phases.length === 0 ? (
                <p className="pm-phase-modal__empty">No phases defined yet. Create your first phase above.</p>
              ) : (
                <ul className="pm-phase-modal__list">
                  {phases.map((phase, idx) => {
                    const nodeCount = nodes.filter((n) => n.phaseId === phase.id).length;
                    const isEditing = editingPhaseId === phase.id;

                    return (
                      <li key={phase.id} className="pm-phase-modal__item">
                        <div className="pm-phase-modal__reorder-btns">
                          <button
                            type="button"
                            disabled={idx === 0}
                            onClick={() => handleMove(idx, idx - 1)}
                            className="pm-phase-modal__arrow-btn"
                            title="Move up"
                          >
                            ▲
                          </button>
                          <button
                            type="button"
                            disabled={idx === phases.length - 1}
                            onClick={() => handleMove(idx, idx + 1)}
                            className="pm-phase-modal__arrow-btn"
                            title="Move down"
                          >
                            ▼
                          </button>
                        </div>

                        {isEditing ? (
                          <div className="pm-phase-modal__edit-row">
                            <input
                              type="text"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              className="pm-phase-modal__input pm-phase-modal__input--inline"
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSaveEdit(phase.id);
                                if (e.key === 'Escape') setEditingPhaseId(null);
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => handleSaveEdit(phase.id)}
                              className="pm-phase-modal__btn pm-phase-modal__btn--sm"
                            >
                              Save
                            </button>
                          </div>
                        ) : (
                          <div className="pm-phase-modal__item-content">
                            <span className="pm-phase-modal__phase-name">{phase.name}</span>
                            <span className="pm-phase-modal__node-count">
                              {nodeCount} node{nodeCount === 1 ? '' : 's'}
                            </span>
                          </div>
                        )}

                        <div className="pm-phase-modal__item-actions">
                          {!isEditing && (
                            <button
                              type="button"
                              onClick={() => handleStartEdit(phase)}
                              className="pm-phase-modal__action-btn"
                            >
                              Edit
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setDeletingPhaseId(phase.id)}
                            className="pm-phase-modal__action-btn pm-phase-modal__action-btn--delete"
                          >
                            Delete
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
