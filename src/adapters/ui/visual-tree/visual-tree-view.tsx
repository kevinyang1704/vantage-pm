import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Node, NodeType, ScheduleSourceMode } from '../../../domain/tree/node.entity';
import type { UnlockEdge } from '../../../domain/edge/unlock-edge.entity';
import { projectVisualTree } from '../../../application/visual-tree/visual-tree.projection';
import { computeLayout } from '../../../application/visual-tree/layout-engine';
import type { NodeGeometry } from '../../../contracts/layout-protocol';
import type { VisualTreeNode } from '../../../contracts/visual-tree';
import { VisualTreeCanvas } from './visual-tree-canvas';
import { mapVisualCardKey } from './visual-tree-keys';
import { resolveStructuralMove, type StructuralNode } from '../../../domain/tree/move-node.policy';
import { formatMoveConstraint } from '../outline/structural-keys';
import { computeSiblingInsertion } from '../../../application/outline/create-sibling-node';
import { positionForAppend } from '../../../domain/tree/sibling-position.policy';
import { createUuidV7 } from '../../../../spikes/phase-0-durability/src/command-receipt';
import { EdgeInspectionPanel } from '../edges/edge-inspection-panel';
import { ScheduleEditorModal } from '../scheduling/schedule-editor-modal';
import type { OutlineNodeReadModel } from '../../../application/outline/outline-read-model';
import type { VisualNodeCardModel } from './visual-node-card.types';
import { projectVisualFindings } from '../../../application/visual/visual-findings.projection';
import { narrateVisualTree } from '../../../application/visual-tree/visual-tree-narration';
import type { ViewportTransform } from '../../../application/visual-tree/viewport-transform';
import type { CoherenceFinding } from '../../../contracts/analysis-protocol';
import './visual-tree-view.css';

export interface VisualTreeViewProps {
  projectId: string;
  projectRevision: number;
  nodes: readonly Node[];
  unlockEdges: readonly UnlockEdge[];
  themeId: string | null;
  coherenceFindings?: readonly CoherenceFinding[];
  onCreateNode?: (params: { nodeId: string; parentId: string | null; position: bigint; title: string; nodeType?: NodeType | null }) => void;
  onMoveNode?: (params: { nodeId: string; newParentId: string | null; newPosition: bigint }) => void;
  onSetNodeTitle?: (params: { nodeId: string; title: string }) => void;
  onSetNodeBodyText?: (params: { nodeId: string; bodyText: string }) => void;
  onSetNodeType?: (params: { nodeId: string; nodeType: NodeType | null }) => void;
  onSetNodeSchedule?: (params: {
    nodeId: string;
    startDate: string | null;
    endDate: string | null;
    durationDays: number | null;
    sourceMode: ScheduleSourceMode;
  }) => void;
  onToggleNodeCompleted?: (params: { nodeId: string; completed: boolean }) => void;
  onCreateUnlockEdge?: (params: { sourceNodeId: string; targetNodeId: string }) => void;
  onDeleteUnlockEdge?: (params: { edgeId: string; sourceNodeId: string; targetNodeId: string }) => void;
  isEdgeInspectorOpen?: boolean;
  onCloseEdgeInspector?: () => void;
  /** Mirror the focused card into app-level focus so ⌘E / ⌘U target it. */
  onFocusNode?: (nodeId: string | null) => void;
  /** Open the shared side inspector drawer for a node (Outline parity). */
  onOpenInspector?: (params: {
    nodeId: string;
    tab?: 'brief' | 'questions' | 'acceptance' | 'unlocks';
  }) => void;
  /** Saved viewport for this project+theme (E10-FR12, E10-AR9). */
  viewport?: ViewportTransform;
  /** Emitted on every viewport change for coalesced persistence (E10-AR9). */
  onViewportChange?: (viewport: ViewportTransform) => void;
  /** Fit the whole tree on first open when no saved viewport exists (E10-UX10). */
  autoFitOnOpen?: boolean;
}

export const FALLBACK_WIDTH = 208;
export const FALLBACK_HEIGHT = 98;
export const FALLBACK_TRUNK_WIDTH = 400;
export const FALLBACK_TRUNK_HEIGHT = 76;

/**
 * Visual surface with in-place graph authoring (Story 6.2 / 6.3).
 *
 * Resolves a focused theme's VisualTreeProjection, computes disposable ELK
 * geometry, and supports inline creation, renaming, reordering, indent/outdent,
 * and keyboard navigation with exact Outline parity.
 */
export function VisualTreeView({
  projectId,
  projectRevision,
  nodes,
  unlockEdges,
  themeId,
  coherenceFindings,
  onCreateNode,
  onMoveNode,
  onSetNodeTitle,
  onSetNodeBodyText,
  onSetNodeType,
  onSetNodeSchedule,
  onToggleNodeCompleted,
  onCreateUnlockEdge,
  onDeleteUnlockEdge,
  isEdgeInspectorOpen,
  onCloseEdgeInspector,
  onFocusNode,
  onOpenInspector,
  viewport,
  onViewportChange,
  autoFitOnOpen = false,
}: VisualTreeViewProps): React.ReactElement {
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [constraintMessage, setConstraintMessage] = useState<string | null>(null);
  const [editingBodyNodeId, setEditingBodyNodeId] = useState<string | null>(null);
  const [bodyDraft, setBodyDraft] = useState<string>('');
  const [scheduleNodeId, setScheduleNodeId] = useState<string | null>(null);

  const projection = useMemo(() => {
    if (!themeId) return null;
    return projectVisualTree({
      projectId,
      projectRevision,
      themeId,
      nodes,
      unlockEdges,
    });
  }, [themeId, projectId, projectRevision, nodes, unlockEdges]);

  const geometry = useMemo<readonly NodeGeometry[]>(() => {
    if (!projection) return [];
    const res = computeLayout({ type: 'LayoutSnapshot', visualTree: projection });
    return res.type === 'LayoutResult' ? res.nodeGeometry : [];
  }, [projection]);

  const visualFindings = useMemo(() => {
    if (!projection) return null;
    const subtreeNodeIds = new Set(projection.nodes.map((n) => n.nodeId));
    const subtreeEdgeIds = new Set(projection.unlockEdges.map((e) => e.edgeId));
    return projectVisualFindings({
      coherenceFindings: coherenceFindings ?? [],
      subtreeNodeIds,
      subtreeEdgeIds,
    });
  }, [projection, coherenceFindings]);

  // If selected node is deleted / not in projection, clear or fallback
  useEffect(() => {
    if (selectedNodeId && projection && !projection.nodes.some((n) => n.nodeId === selectedNodeId)) {
      setSelectedNodeId(null);
      setEditingNodeId(null);
    }
  }, [projection, selectedNodeId]);

  const handleCardKeyDown = useCallback(
    (e: React.KeyboardEvent, nodeId: string) => {
      const action = mapVisualCardKey(e);
      if (!action) return;

      if (action.kind === 'structural') {
        e.preventDefault();
        e.stopPropagation();

        const structuralNodes: StructuralNode[] = nodes.map((n) => ({
          id: n.id,
          parentId: n.parentId,
          position: n.position,
          projectId: n.projectId,
        }));

        const resolution = resolveStructuralMove(structuralNodes, nodeId, action.gesture);
        if (resolution.kind === 'Constrained') {
          const text = formatMoveConstraint(resolution.constraint);
          setConstraintMessage(text);
          setTimeout(() => setConstraintMessage(null), 3000);
          return;
        }

        const newParentId = resolution.newParentId;
        const newPosition = resolution.kind === 'Move' ? resolution.newPosition : positionForAppend(null);

        onMoveNode?.({
          nodeId,
          newParentId,
          newPosition,
        });
        return;
      }

      if (action.kind === 'card') {
        if (action.gesture === 'CreateSibling') {
          e.preventDefault();
          e.stopPropagation();
          const newId = createUuidV7();
          const insertion = computeSiblingInsertion({
            nodes,
            referenceNodeId: nodeId,
            newId,
          });

          onCreateNode?.({
            nodeId: newId,
            parentId: insertion.parentId,
            position: insertion.position,
            title: '',
            nodeType: insertion.nodeType,
          });

          setSelectedNodeId(newId);
          onFocusNode?.(newId);
          setEditingNodeId(newId);
          return;
        }

        if (action.gesture === 'DiscardOrClose') {
          e.preventDefault();
          e.stopPropagation();
          setEditingNodeId(null);
          void document.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`)?.focus();
          return;
        }

        if (action.gesture === 'ToggleBodyText') {
          e.preventDefault();
          e.stopPropagation();
          if (editingBodyNodeId === nodeId) {
            onSetNodeBodyText?.({ nodeId, bodyText: bodyDraft });
            setEditingBodyNodeId(null);
          } else {
            const current = nodes.find((n) => n.id === nodeId);
            setBodyDraft(current?.bodyText ?? '');
            setEditingBodyNodeId(nodeId);
          }
          return;
        }

        if (
          action.gesture === 'NavigateDown' ||
          action.gesture === 'NavigateUp' ||
          action.gesture === 'NavigateLeft' ||
          action.gesture === 'NavigateRight'
        ) {
          if (!projection) return;
          e.preventDefault();
          e.stopPropagation();

          const curr = projection.nodes.find((n) => n.nodeId === nodeId);
          if (!curr) return;

          let target: VisualTreeNode | undefined;
          const children = projection.nodes.filter((n) => n.parentId === curr.nodeId);
          const siblings = projection.nodes.filter((n) => n.parentId === curr.parentId);
          const currSiblingIdx = siblings.findIndex((n) => n.nodeId === curr.nodeId);

          if (action.gesture === 'NavigateDown') {
            target = children.length > 0 ? children[0] : siblings[currSiblingIdx + 1];
          } else if (action.gesture === 'NavigateUp') {
            target = currSiblingIdx > 0 ? siblings[currSiblingIdx - 1] : projection.nodes.find((n) => n.nodeId === curr.parentId);
          } else if (action.gesture === 'NavigateLeft') {
            target = projection.nodes.find((n) => n.nodeId === curr.parentId) ?? (currSiblingIdx > 0 ? siblings[currSiblingIdx - 1] : undefined);
          } else if (action.gesture === 'NavigateRight') {
            target = children.length > 0 ? children[0] : siblings[currSiblingIdx + 1];
          }

          if (target) {
            setSelectedNodeId(target.nodeId);
            onFocusNode?.(target.nodeId);
            void document.querySelector<HTMLElement>(`[data-node-id="${target.nodeId}"]`)?.focus();
          }
        }
      }
    },
    [nodes, projection, onMoveNode, onCreateNode, onFocusNode, editingBodyNodeId, bodyDraft, onSetNodeBodyText],
  );

  const handleCloseBody = useCallback(
    (nodeId: string) => {
      onSetNodeBodyText?.({ nodeId, bodyText: bodyDraft });
      setEditingBodyNodeId(null);
      void document.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`)?.focus();
    },
    [bodyDraft, onSetNodeBodyText],
  );

  if (!themeId) {
    return <div className="pm-visual-tree-view-empty">No theme is focused.</div>;
  }

  if (!projection) return <div className="pm-visual-tree-view-empty">Theme not found.</div>;

  const themeNode = projection.nodes.find((n) => n.depth === 0);
  const orphanNodeIds = visualFindings?.orphanFindingsByNodeId;

  const buildModel = (node: VisualTreeNode): VisualNodeCardModel => {
    const criteria = nodes
      .filter((n) => n.parentId === node.nodeId && n.nodeType === 'AcceptanceCriterion')
      .map((n) => ({
        id: n.id,
        title: n.title,
        completed: n.completed,
      }));

    return {
      nodeId: node.nodeId,
      title: node.title,
      nodeType: node.nodeType,
      startDate: node.startDate,
      endDate: node.endDate,
      durationDays: node.durationDays,
      completed: node.completed,
      interactionState:
        editingNodeId === node.nodeId
          ? 'editing'
          : selectedNodeId === node.nodeId
            ? 'selected'
            : 'rest',
      isTrunk: node.depth === 0,
      isOrphan: orphanNodeIds?.has(node.nodeId) ?? false,
      acceptanceCriteria: criteria,
    };
  };

  const outlineNodeModels: readonly OutlineNodeReadModel[] = useMemo(() => {
    return nodes.map((n) => ({
      id: n.id,
      parentId: n.parentId,
      bodyText: null,
      position: n.position,
      title: n.title,
      typeTag: n.nodeType,
      nodeType: n.nodeType,
      startDate: n.startDate,
      endDate: n.endDate,
      durationDays: n.durationDays,
      scheduleSourceMode: n.scheduleSourceMode,
      derivedStartDate: null,
      derivedEndDate: null,
      derivedDurationDays: null,
      completed: n.completed,
      effortPoints: n.effortPoints,
      effortPointsDone: null,
      strategicWeight: n.strategicWeight,
      deliveryStatus: n.deliveryStatus,
      phaseId: n.phaseId,
      phaseName: null,
      effectivePhaseName: null,
      effectivePhaseSource: 'none',
      unlocksCount: 0,
      unlockedByCount: 0,
      customFields: Object.freeze({}),
      acceptanceSummary: null,
      openQuestions: Object.freeze([]),
    }));
  }, [nodes]);

  const scheduleEditNode = scheduleNodeId
    ? outlineNodeModels.find((n) => n.id === scheduleNodeId) ?? null
    : null;

  const inspectedInbound = useMemo(() => {
    if (!selectedNodeId) return [];
    return unlockEdges.filter((e) => e.targetNodeId === selectedNodeId);
  }, [unlockEdges, selectedNodeId]);

  const inspectedOutbound = useMemo(() => {
    if (!selectedNodeId) return [];
    return unlockEdges.filter((e) => e.sourceNodeId === selectedNodeId);
  }, [unlockEdges, selectedNodeId]);

  return (
    <div className="pm-visual-tree-view">
      <div className="pm-sr-only" aria-live="polite" aria-atomic="true">
        {narrateVisualTree(projection, themeNode?.title, visualFindings ?? undefined)}
      </div>
      {constraintMessage && (
        <div className="pm-visual-constraint-notice" role="status">
          {constraintMessage}
        </div>
      )}
      {projection.degraded && (
        <div className="pm-visual-degraded-notice" role="status">
          This theme has {projection.nodeCount} nodes — beyond the {projection.renderLimit}-node rendering budget.
        </div>
      )}
      <VisualTreeCanvas
        projection={projection}
        geometry={
          geometry.length > 0
            ? geometry
            : projection.nodes.map((n) => ({
                nodeId: n.nodeId,
                x: 0,
                y: 0,
                width: n.depth === 0 ? FALLBACK_TRUNK_WIDTH : FALLBACK_WIDTH,
                height: n.depth === 0 ? FALLBACK_TRUNK_HEIGHT : FALLBACK_HEIGHT,
              }))
        }
        themeName={themeNode?.title}
        orphanNodeIds={new Set(visualFindings?.orphanFindingsByNodeId.keys())}
        violationFindings={visualFindings?.violationFindingsByEdgeId}
        getCardModel={buildModel}
        onStartEditing={(nodeId) => {
          setSelectedNodeId(nodeId);
          onFocusNode?.(nodeId);
          setEditingNodeId(nodeId);
        }}
        onCommitTitle={(nodeId, title) => onSetNodeTitle?.({ nodeId, title })}
        onCancelEditing={(nodeId) => {
          setEditingNodeId(null);
          void document.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`)?.focus();
        }}
        onFocusRequest={(nodeId) => {
          setSelectedNodeId(nodeId);
          onFocusNode?.(nodeId);
        }}
        onCardKeyDown={handleCardKeyDown}
        onToggleCriterion={(id, completed) =>
          onToggleNodeCompleted?.({ nodeId: id, completed })
        }
        onSetNodeType={(nodeId, nodeType) => onSetNodeType?.({ nodeId, nodeType })}
        onOpenScheduleEditor={(nodeId) => setScheduleNodeId(nodeId)}
        onOpenDetails={(nodeId) => {
          setSelectedNodeId(nodeId);
          onFocusNode?.(nodeId);
          onOpenInspector?.({ nodeId });
        }}
        editingBodyNodeId={editingBodyNodeId}
        bodyTextDraft={bodyDraft}
        onBodyChange={(_nodeId, text) => setBodyDraft(text)}
        onCloseBody={handleCloseBody}
        initialViewport={viewport}
        onViewportChange={onViewportChange}
        autoFitOnOpen={autoFitOnOpen}
      />
      <ScheduleEditorModal
        isOpen={Boolean(scheduleNodeId)}
        node={scheduleEditNode}
        onClose={() => setScheduleNodeId(null)}
        onApplySchedule={(nodeId, startDate, endDate, durationDays, sourceMode) => {
          onSetNodeSchedule?.({ nodeId, startDate, endDate, durationDays, sourceMode });
        }}
      />
      <EdgeInspectionPanel
        isOpen={Boolean(isEdgeInspectorOpen && selectedNodeId)}
        currentNodeId={selectedNodeId}
        nodes={outlineNodeModels}
        inboundEdges={inspectedInbound}
        outboundEdges={inspectedOutbound}
        allEdges={unlockEdges}
        violationEdgeIds={new Set(visualFindings?.violationFindingsByEdgeId.keys())}
        onClose={() => onCloseEdgeInspector?.()}
        onNavigateToNode={(targetId) => {
          setSelectedNodeId(targetId);
          void document.querySelector<HTMLElement>(`[data-node-id="${targetId}"]`)?.focus();
        }}
        onCreateEdge={(sourceNodeId, targetNodeId) => {
          onCreateUnlockEdge?.({ sourceNodeId, targetNodeId });
        }}
        onDeleteEdge={(edgeId, sourceNodeId, targetNodeId) => {
          onDeleteUnlockEdge?.({ edgeId, sourceNodeId, targetNodeId });
        }}
      />
    </div>
  );
}
