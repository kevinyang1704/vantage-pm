/**
 * EdgeInspectionPanel — 320px sidebar for inspecting & managing directional unlock edges (Stories 3.8, 3.9, 6.5).
 */

import React, { useState, useMemo } from 'react';
import type { UnlockEdge } from '../../../domain/edge/unlock-edge.entity';
import type { OutlineNodeReadModel } from '../../../application/outline/outline-read-model';
import './edge-inspection-panel.css';

export interface EdgeInspectionPanelProps {
  currentNodeId: string | null;
  nodes: readonly OutlineNodeReadModel[];
  inboundEdges: readonly UnlockEdge[];
  outboundEdges: readonly UnlockEdge[];
  allEdges?: readonly UnlockEdge[];
  violationEdgeIds?: ReadonlySet<string>;
  isOpen: boolean;
  onClose: () => void;
  onNavigateToNode: (nodeId: string) => void;
  onCreateEdge: (sourceNodeId: string, targetNodeId: string) => void;
  onDeleteEdge: (edgeId: string, sourceNodeId: string, targetNodeId: string) => void;
}

export const EdgeInspectionPanel: React.FC<EdgeInspectionPanelProps> = ({
  currentNodeId,
  nodes,
  inboundEdges,
  outboundEdges,
  allEdges,
  violationEdgeIds,
  isOpen,
  onClose,
  onNavigateToNode,
  onCreateEdge,
  onDeleteEdge,
}) => {
  const [scope, setScope] = useState<'node' | 'subtree'>('node');
  const [selectedTargetNodeId, setSelectedTargetNodeId] = useState<string>('');
  const [selectedDirection, setSelectedDirection] = useState<'unlocks' | 'unlockedBy'>('unlocks');

  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // Compute all descendants of currentNodeId for subtree scope
  const subtreeNodeIds = useMemo(() => {
    if (!currentNodeId) return new Set<string>();
    const set = new Set<string>([currentNodeId]);
    let added = true;
    while (added) {
      added = false;
      for (const n of nodes) {
        if (n.parentId && set.has(n.parentId) && !set.has(n.id)) {
          set.add(n.id);
          added = true;
        }
      }
    }
    return set;
  }, [currentNodeId, nodes]);

  // Subtree-scoped edges
  const subtreeEdges = useMemo(() => {
    if (scope !== 'subtree') return [];
    const pool = allEdges ?? [...inboundEdges, ...outboundEdges];
    const seen = new Set<string>();
    const result: UnlockEdge[] = [];
    for (const e of pool) {
      if (seen.has(e.id)) continue;
      if (subtreeNodeIds.has(e.sourceNodeId) || subtreeNodeIds.has(e.targetNodeId)) {
        seen.add(e.id);
        result.push(e);
      }
    }
    return result;
  }, [scope, allEdges, inboundEdges, outboundEdges, subtreeNodeIds]);

  if (!isOpen || !currentNodeId) return null;

  const currentNode = nodeMap.get(currentNodeId);

  // Eligible targets (excluding self)
  const candidateNodes = nodes.filter((n) => n.id !== currentNodeId);

  const handleAddEdge = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTargetNodeId) return;

    if (selectedDirection === 'unlocks') {
      onCreateEdge(currentNodeId, selectedTargetNodeId);
    } else {
      onCreateEdge(selectedTargetNodeId, currentNodeId);
    }
    setSelectedTargetNodeId('');
  };

  const renderNodeMetaBadge = (node: OutlineNodeReadModel | undefined) => {
    if (!node) return null;
    const parts: string[] = [];
    if (node.effectivePhaseName) parts.push(node.effectivePhaseName);
    else if (node.phaseName) parts.push(node.phaseName);

    if (parts.length === 0) return null;
    return <span className="pm-edge-inspection-panel__node-badge">{parts.join(' • ')}</span>;
  };

  return (
    <aside className="pm-edge-inspection-panel" aria-label="Unlock Edge Inspector">
      <div className="pm-edge-inspection-panel__header">
        <h2 className="pm-edge-inspection-panel__title">
          <span className="pm-edge-inspection-panel__icon">🔓</span> Unlock Relationships
        </h2>
        <button
          type="button"
          className="pm-edge-inspection-panel__close-btn"
          onClick={onClose}
          aria-label="Close unlock inspector"
        >
          ✕
        </button>
      </div>

      {/* Scope Segmented Control (Story 6.5 Task 4) */}
      <div className="pm-edge-inspection-panel__scope-control" role="group" aria-label="Inspection scope">
        <button
          type="button"
          className={`pm-edge-inspection-panel__scope-btn ${scope === 'node' ? 'pm-edge-inspection-panel__scope-btn--active' : ''}`}
          onClick={() => setScope('node')}
          aria-pressed={scope === 'node'}
        >
          This Node
        </button>
        <button
          type="button"
          className={`pm-edge-inspection-panel__scope-btn ${scope === 'subtree' ? 'pm-edge-inspection-panel__scope-btn--active' : ''}`}
          onClick={() => setScope('subtree')}
          aria-pressed={scope === 'subtree'}
        >
          This Subtree
        </button>
      </div>

      <div className="pm-edge-inspection-panel__node-summary">
        <span className="pm-edge-inspection-panel__node-type">
          {currentNode?.nodeType ?? 'Item'}
        </span>
        <span className="pm-edge-inspection-panel__node-title">
          {currentNode?.title || 'Untitled'}
        </span>
      </div>

      {scope === 'subtree' ? (
        <div className="pm-edge-inspection-panel__section">
          <h3 className="pm-edge-inspection-panel__section-title">
            Subtree Unlock Edges ({subtreeEdges.length})
          </h3>
          {subtreeEdges.length === 0 ? (
            <p className="pm-edge-inspection-panel__empty">no unlock edges in this scope</p>
          ) : (
            <ul className="pm-edge-inspection-panel__list">
              {subtreeEdges.map((edge) => {
                const src = nodeMap.get(edge.sourceNodeId);
                const tgt = nodeMap.get(edge.targetNodeId);
                const isViolation = violationEdgeIds?.has(edge.id);
                return (
                  <li key={edge.id} className="pm-edge-inspection-panel__item pm-edge-inspection-panel__item--subtree">
                    <div className="pm-edge-inspection-panel__item-main">
                      <div className="pm-edge-inspection-panel__edge-endpoints">
                        <button
                          type="button"
                          className="pm-edge-inspection-panel__nav-link"
                          onClick={() => onNavigateToNode(edge.sourceNodeId)}
                          title={`Go to ${src?.title || edge.sourceNodeId}`}
                        >
                          {src?.title || 'Untitled'}
                        </button>
                        <span className="pm-edge-inspection-panel__arrow">→</span>
                        <button
                          type="button"
                          className="pm-edge-inspection-panel__nav-link"
                          onClick={() => onNavigateToNode(edge.targetNodeId)}
                          title={`Go to ${tgt?.title || edge.targetNodeId}`}
                        >
                          {tgt?.title || 'Untitled'}
                        </button>
                      </div>
                      <div className="pm-edge-inspection-panel__edge-details">
                        {renderNodeMetaBadge(tgt)}
                        {isViolation && (
                          <span className="pm-edge-inspection-panel__violation-badge" title="Sequencing violation detected">
                            ⚠️ Conflict
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="pm-edge-inspection-panel__del-btn"
                      onClick={() => onDeleteEdge(edge.id, edge.sourceNodeId, edge.targetNodeId)}
                      aria-label="Remove unlock edge"
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : (
        <>
          <div className="pm-edge-inspection-panel__section">
            <h3 className="pm-edge-inspection-panel__section-title">
              Unlocked By ({inboundEdges.length})
            </h3>
            {inboundEdges.length === 0 ? (
              <p className="pm-edge-inspection-panel__empty">No prerequisites. This work is ready to start.</p>
            ) : (
              <ul className="pm-edge-inspection-panel__list">
                {inboundEdges.map((edge) => {
                  const src = nodeMap.get(edge.sourceNodeId);
                  const isViolation = violationEdgeIds?.has(edge.id);
                  return (
                    <li key={edge.id} className="pm-edge-inspection-panel__item">
                      <div className="pm-edge-inspection-panel__item-main">
                        <button
                          type="button"
                          className="pm-edge-inspection-panel__nav-link"
                          onClick={() => onNavigateToNode(edge.sourceNodeId)}
                          title={`Go to ${src?.title || edge.sourceNodeId}`}
                        >
                          ← {src?.title || 'Untitled item'}
                        </button>
                        <div className="pm-edge-inspection-panel__edge-details">
                          {renderNodeMetaBadge(src)}
                          {isViolation && (
                            <span className="pm-edge-inspection-panel__violation-badge" title="Sequencing violation detected">
                              ⚠️ Conflict
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="pm-edge-inspection-panel__del-btn"
                        onClick={() => onDeleteEdge(edge.id, edge.sourceNodeId, edge.targetNodeId)}
                        aria-label="Remove unlock edge"
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="pm-edge-inspection-panel__section">
            <h3 className="pm-edge-inspection-panel__section-title">
              Unlocks ({outboundEdges.length})
            </h3>
            {outboundEdges.length === 0 ? (
              <p className="pm-edge-inspection-panel__empty">Does not block any subsequent work.</p>
            ) : (
              <ul className="pm-edge-inspection-panel__list">
                {outboundEdges.map((edge) => {
                  const tgt = nodeMap.get(edge.targetNodeId);
                  const isViolation = violationEdgeIds?.has(edge.id);
                  return (
                    <li key={edge.id} className="pm-edge-inspection-panel__item">
                      <div className="pm-edge-inspection-panel__item-main">
                        <button
                          type="button"
                          className="pm-edge-inspection-panel__nav-link"
                          onClick={() => onNavigateToNode(edge.targetNodeId)}
                          title={`Go to ${tgt?.title || edge.targetNodeId}`}
                        >
                          → {tgt?.title || 'Untitled item'}
                        </button>
                        <div className="pm-edge-inspection-panel__edge-details">
                          {renderNodeMetaBadge(tgt)}
                          {isViolation && (
                            <span className="pm-edge-inspection-panel__violation-badge" title="Sequencing violation detected">
                              ⚠️ Conflict
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="pm-edge-inspection-panel__del-btn"
                        onClick={() => onDeleteEdge(edge.id, edge.sourceNodeId, edge.targetNodeId)}
                        aria-label="Remove unlock edge"
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}

      <div className="pm-edge-inspection-panel__section pm-edge-inspection-panel__section--add">
        <h3 className="pm-edge-inspection-panel__section-title">Add Unlock Link</h3>
        <form onSubmit={handleAddEdge} className="pm-edge-inspection-panel__form">
          <div className="pm-edge-inspection-panel__field">
            <label htmlFor="edge-direction">Direction:</label>
            <select
              id="edge-direction"
              value={selectedDirection}
              onChange={(e) => setSelectedDirection(e.target.value as 'unlocks' | 'unlockedBy')}
              className="pm-edge-inspection-panel__select"
            >
              <option value="unlocks">This item unlocks...</option>
              <option value="unlockedBy">This item is unlocked by...</option>
            </select>
          </div>

          <div className="pm-edge-inspection-panel__field">
            <label htmlFor="edge-target-node">Target item:</label>
            <select
              id="edge-target-node"
              value={selectedTargetNodeId}
              onChange={(e) => setSelectedTargetNodeId(e.target.value)}
              className="pm-edge-inspection-panel__select"
            >
              <option value="">Select an item...</option>
              {candidateNodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title || '(Untitled)'} {n.nodeType ? `[${n.nodeType}]` : ''}
                </option>
              ))}
            </select>
          </div>

          <button
            type="submit"
            disabled={!selectedTargetNodeId}
            className="pm-edge-inspection-panel__submit-btn"
          >
            Connect Unlock Edge
          </button>
        </form>
      </div>
    </aside>
  );
};
