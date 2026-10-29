/**
 * EffortWeightModal — Modal for setting effort points, strategic weights, custom fields, and phase (Stories 3.2, 3.6, 3.7).
 */

import React, { useState, useEffect } from 'react';
import type { OutlineNodeReadModel } from '../../../application/outline/outline-read-model';
import type { Phase } from '../../../domain/phase/phase.entity';
import { normalizeFieldKey } from '../../../domain/tree/field.policy';
import './effort-weight-modal.css';

export interface EffortWeightModalProps {
  isOpen: boolean;
  node: OutlineNodeReadModel | null;
  phases: readonly Phase[];
  onClose: () => void;
  onSetEffort: (nodeId: string, effortPoints: number | null) => void;
  onSetThemeWeight: (nodeId: string, strategicWeight: number | null) => void;
  onSetCustomField: (nodeId: string, fieldKey: string, fieldValue: string | null) => void;
  onPromoteFieldToTemplate: (nodeType: import('../../../domain/tree/node.entity').NodeType, fieldKey: string, fieldLabel: string) => void;
  onAssignPhase: (nodeId: string, phaseId: string | null) => void;
  onCreatePhase?: (name: string) => void;
  onOpenPhaseManager?: () => void;
}

export const EffortWeightModal: React.FC<EffortWeightModalProps> = ({
  isOpen,
  node,
  phases,
  onClose,
  onSetEffort,
  onSetThemeWeight,
  onSetCustomField,
  onPromoteFieldToTemplate,
  onAssignPhase,
  onCreatePhase,
  onOpenPhaseManager,
}) => {
  const [effortInput, setEffortInput] = useState('');
  const [weightInput, setWeightInput] = useState('');
  const [newFieldKey, setNewFieldKey] = useState('');
  const [newFieldValue, setNewFieldValue] = useState('');
  const [selectedPhaseId, setSelectedPhaseId] = useState<string>('none');
  const [isCreatingPhase, setIsCreatingPhase] = useState(false);
  const [newPhaseName, setNewPhaseName] = useState('');
  const prevPhasesLengthRef = React.useRef(phases.length);

  // When a new phase is created, auto-select it
  useEffect(() => {
    if (phases.length > prevPhasesLengthRef.current) {
      const latest = phases[phases.length - 1];
      if (latest) {
        setSelectedPhaseId(latest.id);
      }
    }
    prevPhasesLengthRef.current = phases.length;
  }, [phases]);

  useEffect(() => {
    if (isOpen && node) {
      setEffortInput(node.effortPoints !== null ? String(node.effortPoints) : '');
      setWeightInput(node.strategicWeight !== null ? String(node.strategicWeight) : '');
      setSelectedPhaseId(node.phaseId ?? 'none');
      setNewFieldKey('');
      setNewFieldValue('');
      setIsCreatingPhase(false);
      setNewPhaseName('');
    }
  }, [isOpen, node]);

  if (!isOpen || !node) return null;

  const handleSavePlanning = (e: React.FormEvent) => {
    e.preventDefault();
    const eff = effortInput.trim() ? Number(effortInput.trim()) : null;
    const wt = weightInput.trim() ? Number(weightInput.trim()) : null;
    const pId = selectedPhaseId === 'none' ? null : selectedPhaseId;

    if (eff !== node.effortPoints && (eff === null || !isNaN(eff))) {
      onSetEffort(node.id, eff);
    }
    if (wt !== node.strategicWeight && (wt === null || !isNaN(wt))) {
      onSetThemeWeight(node.id, wt);
    }
    if (pId !== node.phaseId) {
      onAssignPhase(node.id, pId);
    }
    onClose();
  };

  const handleAddCustomField = (e: React.FormEvent) => {
    e.preventDefault();
    const normKey = normalizeFieldKey(newFieldKey);
    if (!normKey) return;
    onSetCustomField(node.id, normKey, newFieldValue.trim() || null);
    setNewFieldKey('');
    setNewFieldValue('');
  };

  const handleRemoveCustomField = (key: string) => {
    onSetCustomField(node.id, key, null);
  };

  const handlePromoteField = (key: string) => {
    if (!node.nodeType) return;
    onPromoteFieldToTemplate(node.nodeType, key, key);
  };

  const customFieldEntries = Object.entries(node.customFields ?? {});

  return (
    <div className="pm-effort-modal__backdrop" role="dialog" aria-modal="true" aria-labelledby="effort-modal-title">
      <div className="pm-effort-modal">
        <div className="pm-effort-modal__header">
          <h2 id="effort-modal-title" className="pm-effort-modal__title">
            <span className="pm-effort-modal__icon">⚡</span> Planning & Metadata
          </h2>
          <button
            type="button"
            className="pm-effort-modal__close-btn"
            onClick={onClose}
            aria-label="Close planning modal"
          >
            ✕
          </button>
        </div>

        <div className="pm-effort-modal__node-summary">
          <span className="pm-effort-modal__node-title">{node.title || '(Untitled Node)'}</span>
        </div>

        <form onSubmit={handleSavePlanning} className="pm-effort-modal__body">
          <div className="pm-effort-modal__grid">
            <div className="pm-effort-modal__field">
              <label htmlFor="effort-points-input" className="pm-effort-modal__label">
                ⚡ Effort Points:
              </label>
              <input
                id="effort-points-input"
                type="number"
                min="0"
                step="0.5"
                placeholder="e.g. 5"
                value={effortInput}
                onChange={(e) => setEffortInput(e.target.value)}
                className="pm-effort-modal__input"
              />
            </div>

            {node.nodeType === 'Theme' && (
              <div className="pm-effort-modal__field">
                <label htmlFor="strategic-weight-input" className="pm-effort-modal__label">
                  ⚖ Strategic Weight:
                </label>
                <input
                  id="strategic-weight-input"
                  type="number"
                  min="0"
                  max="100"
                  placeholder="e.g. 35"
                  value={weightInput}
                  onChange={(e) => setWeightInput(e.target.value)}
                  className="pm-effort-modal__input"
                />
              </div>
            )}

            <div className="pm-effort-modal__field">
              <div className="pm-effort-modal__field-header">
                <label htmlFor="phase-select" className="pm-effort-modal__label">
                  🏷 Project Phase:
                </label>
                {onCreatePhase && !isCreatingPhase && (
                  <button
                    type="button"
                    className="pm-effort-modal__link-btn"
                    onClick={() => setIsCreatingPhase(true)}
                  >
                    + New Phase
                  </button>
                )}
              </div>

              {isCreatingPhase ? (
                <div className="pm-effort-modal__quick-phase-row">
                  <input
                    type="text"
                    placeholder="Phase name (e.g. Phase 1 — MVP)..."
                    value={newPhaseName}
                    onChange={(e) => setNewPhaseName(e.target.value)}
                    className="pm-effort-modal__input pm-effort-modal__input--sm"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        const name = newPhaseName.trim();
                        if (name && onCreatePhase) {
                          onCreatePhase(name);
                          setNewPhaseName('');
                          setIsCreatingPhase(false);
                        }
                      } else if (e.key === 'Escape') {
                        setIsCreatingPhase(false);
                        setNewPhaseName('');
                      }
                    }}
                  />
                  <button
                    type="button"
                    disabled={!newPhaseName.trim()}
                    onClick={() => {
                      const name = newPhaseName.trim();
                      if (name && onCreatePhase) {
                        onCreatePhase(name);
                        setNewPhaseName('');
                        setIsCreatingPhase(false);
                      }
                    }}
                    className="pm-effort-modal__btn pm-effort-modal__btn--primary pm-effort-modal__btn--sm"
                  >
                    Create
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsCreatingPhase(false);
                      setNewPhaseName('');
                    }}
                    className="pm-effort-modal__btn pm-effort-modal__btn--secondary pm-effort-modal__btn--sm"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="pm-effort-modal__phase-select-row">
                  <select
                    id="phase-select"
                    value={selectedPhaseId}
                    onChange={(e) => setSelectedPhaseId(e.target.value)}
                    className="pm-effort-modal__select"
                  >
                    <option value="none">
                      {node.effectivePhaseSource === 'inherited'
                        ? `Inherited (${node.effectivePhaseName})`
                        : 'No Phase (None)'}
                    </option>
                    {phases.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  {onOpenPhaseManager && (
                    <button
                      type="button"
                      className="pm-effort-modal__manage-phases-btn"
                      onClick={() => {
                        onClose();
                        onOpenPhaseManager();
                      }}
                      title="Manage project phases (reorder, rename, delete)"
                    >
                      Manage...
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="pm-effort-modal__section">
            <div className="pm-effort-modal__section-header">
              <h3 className="pm-effort-modal__section-title">Custom Fields</h3>
              <p className="pm-effort-modal__section-desc">
                Attach custom key-value metadata to this node. Use <strong>Promote</strong> to make a key standard across all {node.nodeType ?? 'item'} nodes.
              </p>
            </div>
            {customFieldEntries.length === 0 ? (
              <p className="pm-effort-modal__empty">No custom fields added to this node.</p>
            ) : (
              <ul className="pm-effort-modal__field-list">
                {customFieldEntries.map(([key, val]) => (
                  <li key={key} className="pm-effort-modal__field-item">
                    <div className="pm-effort-modal__field-info">
                      <span className="pm-effort-modal__field-key">{key}:</span>
                      <span className="pm-effort-modal__field-val">{val}</span>
                    </div>
                    <div className="pm-effort-modal__field-actions">
                      {node.nodeType && (
                        <button
                          type="button"
                          onClick={() => handlePromoteField(key)}
                          className="pm-effort-modal__promote-btn"
                          title="Promote this field key to all items of this type"
                        >
                          Promote
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleRemoveCustomField(key)}
                        className="pm-effort-modal__del-btn"
                        aria-label={`Remove field ${key}`}
                      >
                        ×
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <div className="pm-effort-modal__add-field-row">
              <input
                type="text"
                placeholder="Field key (e.g. priority, risk)..."
                value={newFieldKey}
                onChange={(e) => setNewFieldKey(e.target.value)}
                className="pm-effort-modal__input pm-effort-modal__input--sm"
              />
              <input
                type="text"
                placeholder="Value..."
                value={newFieldValue}
                onChange={(e) => setNewFieldValue(e.target.value)}
                className="pm-effort-modal__input pm-effort-modal__input--sm"
              />
              <button
                type="button"
                disabled={!newFieldKey.trim()}
                onClick={handleAddCustomField}
                className="pm-effort-modal__btn pm-effort-modal__btn--secondary pm-effort-modal__btn--sm"
              >
                + Add
              </button>
            </div>
          </div>

          <div className="pm-effort-modal__actions">
            <button
              type="button"
              className="pm-effort-modal__btn pm-effort-modal__btn--secondary"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="pm-effort-modal__btn pm-effort-modal__btn--primary"
            >
              Save Changes
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
