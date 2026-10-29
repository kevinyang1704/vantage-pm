/**
 * OutlineView — virtualized semantic outline with keyboard authoring, restructuring,
 * and planning controls (Epic 2, Epic 3).
 */

import React, {
  useRef,
  useState,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  forwardRef,
} from 'react';
import { useVirtualizer, defaultRangeExtractor } from '@tanstack/react-virtual';
import type { Range } from '@tanstack/react-virtual';
import type { OutlineNodeReadModel, OutlineReadModel } from '../../../application/outline/outline-read-model';
import { projectVisibleOutline } from '../../../application/outline/outline-visible.projection';
import { resolveFocusTarget } from '../../../application/outline/outline-focus';
import { createUuidV7 } from '../../../../spikes/phase-0-durability/src/command-receipt';
import {
  positionBetween,
  positionForAppend,
} from '../../../domain/tree/sibling-position.policy';
import { computeSiblingInsertion } from '../../../application/outline/create-sibling-node';
import {
  resolveStructuralMove,
  isMoveAcyclic,
  isMoveWithinProject,
  type StructuralGesture,
} from '../../../domain/tree/move-node.policy';
import {
  canParentNodeType,
  formatHierarchyInversionReason,
} from '../../../domain/tree/node-hierarchy.policy';
import {
  mapKeyboardEventToGesture,
  formatMoveConstraint,
} from './structural-keys';
import { calculateAcceptanceRatio } from '../../../domain/tree/acceptance-criteria.policy';
import { formatNodeTypeTag } from '../../../domain/tree/node-type.policy';
import type { DeliveryStatus, NodeType, ScheduleSourceMode } from '../../../domain/tree/node.entity';
import type { Phase } from '../../../domain/phase/phase.entity';
import type { UnlockEdge } from '../../../domain/edge/unlock-edge.entity';
import { OutlineRow } from './outline-row';
import { EdgeInspectionPanel } from '../edges/edge-inspection-panel';
import { PhaseManagerModal } from '../phases/phase-manager-modal';
import { ScheduleEditorModal } from '../scheduling/schedule-editor-modal';
import { EffortWeightModal } from '../planning/effort-weight-modal';
import './outline-view.css';

export type DragDropMode = 'before' | 'after' | 'reparent' | 'first-child' | 'root-last';

export interface DropTargetState {
  targetNodeId: string | null;
  mode: DragDropMode;
  depth: number;
  valid: boolean;
  reason?: string;
}

export interface OutlineViewHandle {
  focusNodeById(nodeId: string): Promise<boolean>;
  focusFirstVisibleRow(): boolean;
  focusTreeContainer(): void;
  openPhaseManager(): void;
  openPlanningModal(nodeId?: string): void;
  openEdgeInspector(nodeId?: string): void;
  toggleEdgeInspector(): void;
}

export interface OutlineViewProps {
  model: OutlineReadModel;
  projectName?: string;
  zoomRootId?: string | null;
  initialCollapsedNodeIds?: readonly string[];
  onFocusNode?: (nodeId: string | null) => void;
  onZoomChange?: (newZoomRootId: string | null) => void;
  onViewStateChange?: (patch: { collapsedNodeIds?: readonly string[]; zoomRootId?: string | null }) => void;
  onCreateNode?: (params: {
    nodeId: string;
    parentId: string | null;
    position: bigint;
    title: string;
    nodeType?: NodeType | null;
  }) => void;
  onSetNodeTitle?: (params: { nodeId: string; title: string }) => void;
  onSetNodeBodyText?: (params: { nodeId: string; bodyText: string | null }) => void;
  onMoveNode?: (params: {
    nodeId: string;
    newParentId: string | null;
    newPosition: bigint;
  }) => void;
  onDeleteSubtree?: (nodeId: string) => void;
  onDuplicateSubtree?: (nodeId: string) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onOpenPalette?: () => void;
  onOpenJump?: () => void;
  onSetNodeType?: (params: { nodeId: string; nodeType: NodeType | null }) => void;
  onSetNodeCustomField?: (params: { nodeId: string; fieldKey: string; fieldValue: string | null }) => void;
  onPromoteFieldToTemplate?: (params: { nodeType: NodeType; fieldKey: string; fieldLabel: string }) => void;
  onSetNodeSchedule?: (params: {
    nodeId: string;
    startDate: string | null;
    endDate: string | null;
    durationDays: number | null;
    sourceMode: ScheduleSourceMode;
  }) => void;
  onToggleNodeCompleted?: (params: { nodeId: string; completed: boolean }) => void;
  onSetNodeEffort?: (params: { nodeId: string; effortPoints: number | null }) => void;
  onSetDeliveryStatus?: (params: { nodeId: string; deliveryStatus: DeliveryStatus }) => void;
  onSetThemeWeight?: (params: { nodeId: string; strategicWeight: number | null }) => void;
  onCreatePhase?: (name: string) => void;
  onRenamePhase?: (params: { phaseId: string; name: string }) => void;
  onReorderPhases?: (phases: readonly { phaseId: string; position: bigint }[]) => void;
  onAssignNodePhase?: (params: { nodeId: string; phaseId: string | null }) => void;
  onDeletePhase?: (params: { phaseId: string; reassignments: Record<string, string | null> }) => void;
  onCreateUnlockEdge?: (params: { sourceNodeId: string; targetNodeId: string }) => void;
  onDeleteUnlockEdge?: (params: { edgeId: string; sourceNodeId: string; targetNodeId: string }) => void;
  coherenceFindings?: readonly import('../../../contracts/analysis-protocol').CoherenceFinding[];
  onDismissFinding?: (finding: import('../../../contracts/analysis-protocol').CoherenceFinding) => void;
  onOpenInspector?: (params: { nodeId: string; tab?: 'brief' | 'questions' | 'acceptance' | 'unlocks' }) => void;
}

export const OutlineView = forwardRef<OutlineViewHandle, OutlineViewProps>(function OutlineView(
  {
    model,
    projectName = 'Project outline',
    zoomRootId = null,
    initialCollapsedNodeIds,
    onFocusNode,
    onZoomChange,
    onViewStateChange,
    onCreateNode,
    onSetNodeTitle,
    onSetNodeBodyText,
    onMoveNode,
    onDeleteSubtree,
    onDuplicateSubtree,
    onUndo,
    onRedo,
    onOpenPalette,
    onOpenJump,
    onSetNodeType,
    onSetNodeCustomField,
    onPromoteFieldToTemplate,
    onSetNodeSchedule,
    onToggleNodeCompleted,
    onSetNodeEffort,
    onSetDeliveryStatus,
    onSetThemeWeight,
    onCreatePhase,
    onRenamePhase,
    onReorderPhases,
    onAssignNodePhase,
    onDeletePhase,
    onCreateUnlockEdge,
    onDeleteUnlockEdge,
    coherenceFindings = [],
    onDismissFinding,
    onOpenInspector,
  },
  ref,
) {
  const parentRef = useRef<HTMLDivElement>(null);
  const findingMap = useMemo(() => {
    const map = new Map<string, import('../../../contracts/analysis-protocol').CoherenceFinding>();
    for (const f of coherenceFindings) {
      map.set(f.targetNodeId, f);
    }
    return map;
  }, [coherenceFindings]);
  const [localNodes, setLocalNodes] = useState<readonly OutlineNodeReadModel[]>(model.nodes);
  const [bodyTexts, setBodyTexts] = useState<ReadonlyMap<string, string | null>>(new Map());
  const [collapsedNodeIds, setCollapsedNodeIds] = useState<ReadonlySet<string>>(
    new Set(initialCollapsedNodeIds ?? []),
  );
  const [currentZoomRootId, setCurrentZoomRootId] = useState<string | null>(zoomRootId);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [editingBodyNodeId, setEditingBodyNodeId] = useState<string | null>(null);
  const [pendingFocusNodeId, setPendingFocusNodeId] = useState<string | null>(null);
  const pendingFocusNodeIdRef = useRef<string | null>(null);
  const setPendingFocus = useCallback((id: string | null) => {
    pendingFocusNodeIdRef.current = id;
    setPendingFocusNodeId(id);
  }, []);
  const [constraintMessage, setConstraintMessage] = useState<{ nodeId: string; text: string } | null>(null);
  const deletedNodeIdsRef = useRef<Set<string>>(new Set());

  // Drag and Drop state & refs
  const [isDragging, setIsDragging] = useState(false);
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTargetState | null>(null);
  const [dragAnnouncement, setDragAnnouncement] = useState<string | null>(null);

  const dragStartRef = useRef<{
    nodeId: string;
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  const isDraggingRef = useRef(false);
  // nodeId -> title typed but not yet reflected back by the read model.
  const pendingTitleEditsRef = useRef<Map<string, string>>(new Map());
  const dropTargetRef = useRef<DropTargetState | null>(null);
  const hoverExpandTimerRef = useRef<NodeJS.Timeout | null>(null);
  const hoveredReparentNodeIdRef = useRef<string | null>(null);
  const autoScrollRafRef = useRef<number | null>(null);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollRafRef.current !== null) {
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
  }, []);

  // Unmount is the one teardown that must always stop the frame loop, drag in
  // progress or not.
  useEffect(() => stopAutoScroll, [stopAutoScroll]);

  const startAutoScroll = useCallback((speed: number) => {
    stopAutoScroll();
    const scrollStep = () => {
      if (parentRef.current) {
        parentRef.current.scrollTop += speed;
      }
      autoScrollRafRef.current = requestAnimationFrame(scrollStep);
    };
    autoScrollRafRef.current = requestAnimationFrame(scrollStep);
  }, [stopAutoScroll]);

  // Whether a click gesture on a row is in flight. Deliberately a ref rather
  // than state: the gesture itself must not cause a render, because a render
  // at pointerdown re-runs the drag effect below and its cleanup would stop
  // the auto-scroll frame loop. The renders that matter are the ones the
  // gesture's focus change already causes, and those read this ref.
  const pointerGestureRef = useRef(false);
  const heldCueNodeIdRef = useRef<string | null>(null);
  const [, setCueReleaseTick] = useState(0);

  useEffect(() => {
    const begin = (e: PointerEvent): void => {
      // Only gestures that are meant to end in a click on a row's own controls
      // need the cue held. A press on the drag handle starts a drag, whose
      // edge-scrolling depends on rows moving normally, so leave it alone.
      const target = e.target instanceof Element ? e.target : null;
      pointerGestureRef.current =
        target !== null &&
        target.closest('[role="treeitem"]') !== null &&
        target.closest('.pm-outline-row__drag-handle') === null;
    };
    const end = (): void => {
      if (!pointerGestureRef.current) return;
      pointerGestureRef.current = false;
      // The focus change that should have moved the cue already rendered while
      // the hold was on, so releasing the ref alone leaves the cue anchored to
      // the previous row — and the cue's anchor decides where an insertion
      // lands. Force one render to let it catch up, after the click that this
      // pointerup is about to produce has been delivered.
      setTimeout(() => setCueReleaseTick((t) => t + 1), 0);
    };
    document.addEventListener('pointerdown', begin, true);
    document.addEventListener('pointerup', end, true);
    document.addEventListener('pointercancel', end, true);
    return () => {
      document.removeEventListener('pointerdown', begin, true);
      document.removeEventListener('pointerup', end, true);
      document.removeEventListener('pointercancel', end, true);
    };
  }, []);

  // Epic 3 UI Dialogs/Panels state
  const [isEdgeInspectorOpen, setIsEdgeInspectorOpen] = useState(false);
  const [selectedEdgeNodeId, setSelectedEdgeNodeId] = useState<string | null>(null);
  const [isPhaseModalOpen, setIsPhaseModalOpen] = useState(false);
  const [scheduleNodeId, setScheduleNodeId] = useState<string | null>(null);
  const [planningModalNodeId, setPlanningModalNodeId] = useState<string | null>(null);

  // Sync external model nodes into local overlay when model revisions update.
  //
  // Typed titles live here until their SetNodeTitle round-trips. Inferring
  // "still being edited" from the overlay array is not sound: an unrelated
  // command (a Tab/Shift+Tab move, say) can land a model update whose effect
  // closes over an overlay snapshot taken before the keystrokes, and the typed
  // title is then overwritten by the model's older value — the edit vanishes
  // from the row with no error. Track edits explicitly instead, and retire an
  // entry only once the model has caught up with it.
  useEffect(() => {
    for (const modelNode of model.nodes) {
      deletedNodeIdsRef.current.delete(modelNode.id);
    }
    setLocalNodes(() =>
      model.nodes.map((modelNode) => {
        const pendingTitle = pendingTitleEditsRef.current.get(modelNode.id);
        if (pendingTitle === undefined) return modelNode;
        if (pendingTitle === modelNode.title) {
          pendingTitleEditsRef.current.delete(modelNode.id);
          return modelNode;
        }
        return { ...modelNode, title: pendingTitle };
      }),
    );
  }, [model.nodes, model.projectRevision]);

  useEffect(() => {
    setCurrentZoomRootId(zoomRootId);
  }, [zoomRootId]);

  // Compute zoomed read model and dynamic acceptance summary if zoomRootId is set or localNodes change
  const effectiveModel: OutlineReadModel = React.useMemo(() => {
    // Map children for acceptance summary calculation
    const childrenMap = new Map<string | null, { id: string; nodeType: string | null; completed: boolean }[]>();
    for (const n of localNodes) {
      let list = childrenMap.get(n.parentId);
      if (!list) {
        list = [];
        childrenMap.set(n.parentId, list);
      }
      list.push({ id: n.id, nodeType: n.nodeType, completed: Boolean(n.completed) });
    }

    const nodesWithAcceptance = localNodes.map((n) => {
      if (n.nodeType === 'Feature') {
        const children = childrenMap.get(n.id) ?? [];
        const acceptance = calculateAcceptanceRatio(children);
        return { ...n, acceptanceSummary: acceptance.ratioText };
      }
      return n;
    });

    if (!currentZoomRootId) {
      return { ...model, nodes: Object.freeze(nodesWithAcceptance) };
    }

    const subtreeNodeIds = new Set<string>([currentZoomRootId]);
    let added = true;
    while (added) {
      added = false;
      for (const node of nodesWithAcceptance) {
        if (node.parentId && subtreeNodeIds.has(node.parentId) && !subtreeNodeIds.has(node.id)) {
          subtreeNodeIds.add(node.id);
          added = true;
        }
      }
    }

    const zoomedNodes = nodesWithAcceptance
      .filter((n) => subtreeNodeIds.has(n.id))
      .map((n) => (n.id === currentZoomRootId ? { ...n, parentId: null } : n));

    return {
      projectId: model.projectId,
      projectRevision: model.projectRevision,
      nodes: Object.freeze(zoomedNodes),
      phases: model.phases,
      unlockEdges: model.unlockEdges,
    };
  }, [model, localNodes, currentZoomRootId]);

  const visibleOutline = React.useMemo(
    () => projectVisibleOutline(effectiveModel, collapsedNodeIds),
    [effectiveModel, collapsedNodeIds],
  );

  const rows = visibleOutline.rows;

  // Epic 11 (E11-AR2, E11-FR1/2/7): the contextual sibling-insertion cue is a
  // measured virtualized item placed immediately beneath the focused row. The
  // anchor is derived from stable model identity (`focusedNodeId` resolved in
  // the visible projection), never a DOM index. When the focused identity is
  // absent from the visible rows (collapsed, zoomed out, deleted, or empty),
  // no cue item exists (E11-AR5).
  // Relocating the cue between pointerdown and pointerup reflows every row
  // below it: clicking a control on an unfocused row moves the cue up to that
  // row, the row slides out from under the cursor, and mouseup lands on the
  // cue instead. The browser then retargets the click to the shared ancestor
  // and the control never fires. Hold the anchor still for the duration of the
  // gesture and let it catch up once the click has landed — E11-FR2 placement
  // is unchanged, only deferred. Once the pointer has travelled far enough to
  // become a drag there is no click left to protect, so the hold ends there.
  const holdCue = pointerGestureRef.current && !isDraggingRef.current;
  const cueNodeId = holdCue ? heldCueNodeIdRef.current : focusedNodeId;
  if (!holdCue) heldCueNodeIdRef.current = focusedNodeId;
  const focusedRowIndex = cueNodeId ? rows.findIndex((r) => r.nodeId === cueNodeId) : -1;
  const cueAnchor =
    focusedRowIndex !== -1 && cueNodeId !== null
      ? { rowIndex: focusedRowIndex, nodeId: cueNodeId }
      : null;

  const items = useMemo(() => {
    const list: Array<
      | { kind: 'row'; rowIndex: number; nodeId: string }
      | { kind: 'cue'; anchorNodeId: string; depth: number }
    > = [];
    for (let i = 0; i < rows.length; i += 1) {
      list.push({ kind: 'row', rowIndex: i, nodeId: rows[i].nodeId });
      if (cueAnchor && cueAnchor.rowIndex === i) {
        list.push({ kind: 'cue', anchorNodeId: cueAnchor.nodeId, depth: rows[i].depth });
      }
    }
    return list;
  }, [rows, cueAnchor]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 20,
    getItemKey: (index) => {
      const item = items[index];
      if (!item) return index;
      return item.kind === 'cue' ? `contextual-insert:${item.anchorNodeId}` : item.nodeId;
    },
    rangeExtractor: defaultRangeExtractor,
  });

  // Imperative handle for Jump to Node and external programmatic focus
  const focusNodeByIdInner = useCallback(
    async (targetNodeId: string): Promise<boolean> => {
      const resolution = resolveFocusTarget(effectiveModel, collapsedNodeIds, targetNodeId);
      if (resolution.kind === 'NotInProject') {
        return false;
      }

      if (resolution.ancestorsExpanded.length > 0) {
        setCollapsedNodeIds(resolution.collapsedAfterExpand);
        onViewStateChange?.({
          collapsedNodeIds: Array.from(resolution.collapsedAfterExpand),
        });
      }

      setPendingFocus(targetNodeId);
      setFocusedNodeId(targetNodeId);
      onFocusNode?.(targetNodeId);
      return true;
    },
    [effectiveModel, collapsedNodeIds, onViewStateChange, onFocusNode],
  );

  useImperativeHandle(
    ref,
    () => ({
      focusNodeById: focusNodeByIdInner,
      openPhaseManager() {
        setIsPhaseModalOpen(true);
      },
      openPlanningModal(nodeId?: string) {
        setPlanningModalNodeId(nodeId ?? focusedNodeId ?? (rows[0]?.nodeId ?? null));
      },
      openEdgeInspector(nodeId?: string) {
        setSelectedEdgeNodeId(nodeId ?? focusedNodeId ?? (rows[0]?.nodeId ?? null));
        setIsEdgeInspectorOpen(true);
      },
      toggleEdgeInspector() {
        setIsEdgeInspectorOpen((prev) => !prev);
      },
      focusFirstVisibleRow(): boolean {
        const first = rows[0];
        if (!first) return false;
        void focusNodeByIdInner(first.nodeId);
        return true;
      },
      focusTreeContainer(): void {
        parentRef.current?.focus({ preventScroll: true });
      },
    }),
    [focusNodeByIdInner, focusedNodeId, rows],
  );

  // Scroll to pending focus target once virtualized
  useEffect(() => {
    if (!pendingFocusNodeId) return;

    const rowIndex = rows.findIndex((r) => r.nodeId === pendingFocusNodeId);
    if (rowIndex !== -1) {
      virtualizer.scrollToIndex(rowIndex, { align: 'auto' });
      const el = parentRef.current?.querySelector<HTMLElement>(`[data-node-id="${pendingFocusNodeId}"]`);
      if (el) {
        const input = el.querySelector<HTMLInputElement>('input.pm-outline-row__title-input');
        if (input && editingBodyNodeId !== pendingFocusNodeId) {
          input.focus({ preventScroll: true });
          // UAT #16: the row container (tabIndex 0) can steal focus back from
          // the input in the same commit. Verify the input actually won and
          // retry once after paint if the container did.
          if (document.activeElement !== input) {
            requestAnimationFrame(() => {
              if (pendingFocusNodeIdRef.current === pendingFocusNodeId && document.activeElement !== input) {
                input.focus({ preventScroll: true });
              }
            });
          }
        } else {
          el.focus({ preventScroll: true });
        }
        pendingFocusNodeIdRef.current = null;
        setPendingFocusNodeId(null);
      }
      // Element not mounted yet: keep pendingFocusNodeId so this effect
      // re-runs when the virtualizer's next render mounts the row.
    }
  }, [pendingFocusNodeId, rows, virtualizer, editingBodyNodeId]);

  // Focus and Selection handlers
  const handleRowFocus = useCallback(
    (nodeId: string) => {
      setFocusedNodeId(nodeId);
      onFocusNode?.(nodeId);
    },
    [onFocusNode],
  );

  const handleCanvasClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('.pm-outline-row, .pm-outline-cue')) return;

      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && parentRef.current?.contains(activeElement)) {
        activeElement.blur();
      }
      setPendingFocus(null);
      setFocusedNodeId(null);
      onFocusNode?.(null);
    },
    [onFocusNode, setPendingFocus],
  );

  const toggleExpand = useCallback(
    (nodeId: string) => {
      setCollapsedNodeIds((prev) => {
        const next = new Set(prev);
        if (next.has(nodeId)) {
          next.delete(nodeId);
        } else {
          next.add(nodeId);
        }
        onViewStateChange?.({ collapsedNodeIds: Array.from(next) });
        return next;
      });
    },
    [onViewStateChange],
  );

  // Inline editing handlers
  const handleTitleChange = useCallback((nodeId: string, title: string) => {
    pendingTitleEditsRef.current.set(nodeId, title);
    setLocalNodes((prev) => prev.map((n) => (n.id === nodeId ? { ...n, title } : n)));
  }, []);

  const handleTitleCommit = useCallback(
    (nodeId: string, title: string) => {
      if (deletedNodeIdsRef.current.has(nodeId)) return;
      const node = localNodes.find((n) => n.id === nodeId);
      if (!node) return;
      // A commit fires on every blur, including the blur that merely follows
      // focus landing on a row (project switch, view change). Committing an
      // unchanged title would dispatch SetNodeTitle and bump the project
      // revision, making read-only navigation look like an edit (Story 5.4/5.8).
      // Compare against the persisted read model, not the local overlay, so a
      // genuine edit still commits while it is in flight.
      const persisted = model.nodes.find((n) => n.id === nodeId);
      if (persisted && persisted.title === title) return;
      if (onSetNodeTitle) {
        onSetNodeTitle({ nodeId, title });
      }
    },
    [localNodes, model.nodes, onSetNodeTitle],
  );

  const handleBodyChange = useCallback((nodeId: string, bodyText: string) => {
    setBodyTexts((prev) => {
      const next = new Map(prev);
      next.set(nodeId, bodyText);
      return next;
    });
  }, []);

  const handleCloseBody = useCallback(
    (nodeId: string) => {
      setEditingBodyNodeId(null);
      const text = bodyTexts.get(nodeId);
      if (onSetNodeBodyText && text !== undefined) {
        onSetNodeBodyText({ nodeId, bodyText: text });
      }
    },
    [bodyTexts, onSetNodeBodyText],
  );

  // Story 16.2 AC4 (AC-BRIEF-TRIM): whitespace-only drafts coerce to null on
  // commit so the `📝 Brief` pill never renders for blank prose.
  const handleBodyCommit = useCallback(
    (nodeId: string, bodyText: string) => {
      const trimmed = bodyText.trim();
      const next = trimmed.length === 0 ? null : bodyText;
      setBodyTexts((prev) => {
        const map = new Map(prev);
        if (next === null) {
          map.delete(nodeId);
        } else {
          map.set(nodeId, next);
        }
        return map;
      });
      if (onSetNodeBodyText) {
        onSetNodeBodyText({ nodeId, bodyText: next });
      }
    },
    [onSetNodeBodyText],
  );

  // Sibling insertion (Story 2.3)
  const createSibling = useCallback(
    (referenceNodeId: string | null) => {
      const newId = createUuidV7();
      const insertion = computeSiblingInsertion({
        nodes: localNodes,
        referenceNodeId,
        newId,
      });

      const newNode: OutlineNodeReadModel = {
        id: newId,
        parentId: insertion.parentId,
        bodyText: null,
        position: insertion.position,
        title: '',
        typeTag: insertion.nodeType ? formatNodeTypeTag(insertion.nodeType) : null,
        nodeType: insertion.nodeType,
        startDate: null,
        endDate: null,
        durationDays: null,
        scheduleSourceMode: null,
        derivedStartDate: null,
        derivedEndDate: null,
        derivedDurationDays: null,
        completed: false,
        effortPoints: null,
        effortPointsDone: null,
        strategicWeight: null,
        deliveryStatus: 'not_started',
        phaseId: null,
        phaseName: null,
        effectivePhaseName: null,
        effectivePhaseSource: 'none',
        unlocksCount: 0,
        unlockedByCount: 0,
        customFields: Object.freeze({}),
        acceptanceSummary: null,
        openQuestions: Object.freeze([]),
      };

      setLocalNodes((prev) => [...prev, newNode]);
      setFocusedNodeId(newId);
      setPendingFocus(newId);

      if (onCreateNode) {
        onCreateNode({
          nodeId: newId,
          parentId: insertion.parentId,
          position: insertion.position,
          title: '',
          nodeType: insertion.nodeType,
        });
      }
    },
    [localNodes, onCreateNode],
  );

  // Structural movement (Story 2.4)
  const handleStructuralMove = useCallback(
    (nodeId: string, gesture: StructuralGesture) => {
      const domainNodes = localNodes.map((n) => ({
        id: n.id,
        projectId: model.projectId,
        parentId: n.parentId,
        title: n.title,
        bodyText: bodyTexts.get(n.id) ?? null,
        position: n.position,
        nodeType: n.nodeType ?? null,
      }));

      const resolution = resolveStructuralMove(domainNodes, nodeId, gesture);

      if (resolution.kind === 'Constrained') {
        const text = formatMoveConstraint(resolution.constraint);
        setConstraintMessage({ nodeId, text });
        setTimeout(() => setConstraintMessage(null), 3000);
        return;
      }

      const newParentId = resolution.newParentId;
      const newPos =
        resolution.kind === 'Move'
          ? resolution.newPosition
          : positionForAppend(null);

      // Optimistic local update
      setLocalNodes((prev) =>
        prev.map((n) => (n.id === nodeId ? { ...n, parentId: newParentId, position: newPos } : n)),
      );

      if (onMoveNode) {
        onMoveNode({
          nodeId,
          newParentId,
          newPosition: newPos,
        });
      }
    },
    [localNodes, model.projectId, bodyTexts, onMoveNode],
  );

  const handleDragStartInit = useCallback(
    (e: React.PointerEvent, nodeId: string) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;

      // Flush any pending title edit before drag acts
      const pending = localNodes.find((n) => n.id === focusedNodeId);
      if (pending && pending.title !== '') {
        handleTitleCommit(pending.id, pending.title);
      }

      dragStartRef.current = {
        nodeId,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
      };
      isDraggingRef.current = false;
      dropTargetRef.current = null;
    },
    [localNodes, focusedNodeId, handleTitleCommit],
  );

  // Global pointer tracking for drag-and-drop
  useEffect(() => {
    const handleGlobalPointerMove = (e: PointerEvent) => {
      if (!dragStartRef.current) return;

      if (!isDraggingRef.current) {
        const dist = Math.hypot(
          e.clientX - dragStartRef.current.startX,
          e.clientY - dragStartRef.current.startY,
        );
        if (dist > 4) {
          isDraggingRef.current = true;
          setIsDragging(true);
          setDraggedNodeId(dragStartRef.current.nodeId);
        } else {
          return;
        }
      }

      const draggedId = dragStartRef.current.nodeId;
      const draggedNode = localNodes.find((n) => n.id === draggedId);

      // Auto-scroll container
      if (parentRef.current) {
        const containerRect = parentRef.current.getBoundingClientRect();
        const topEdge = containerRect.top + 40;
        const bottomEdge = containerRect.bottom - 40;

        if (e.clientY < topEdge && parentRef.current.scrollTop > 0) {
          const factor = Math.min(1, Math.max(0.1, (topEdge - e.clientY) / 40));
          startAutoScroll(-12 * factor);
        } else if (
          e.clientY > bottomEdge &&
          parentRef.current.scrollTop < parentRef.current.scrollHeight - parentRef.current.clientHeight
        ) {
          const factor = Math.min(1, Math.max(0.1, (e.clientY - bottomEdge) / 40));
          startAutoScroll(12 * factor);
        } else {
          stopAutoScroll();
        }
      }

      // Hit-test element from point
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const rowEl = el?.closest<HTMLElement>('[data-node-id]');
      const targetNodeId = rowEl?.getAttribute('data-node-id') ?? null;

      if (rowEl && targetNodeId) {
        const targetRow = rows.find((r) => r.nodeId === targetNodeId);
        const targetNode = localNodes.find((n) => n.id === targetNodeId);
        if (targetRow && targetNode) {
          const rowRect = rowEl.getBoundingClientRect();
          const offset = e.clientY - rowRect.top;
          // Keep reorder edges narrow: the row itself is a nesting target.
          const edge = Math.min(6, rowRect.height * 0.15);

          let mode: DragDropMode;
          let resultingParentId: string | null;
          let depth: number;

          if (offset < edge) {
            mode = 'before';
            resultingParentId = targetNode.parentId;
            depth = targetRow.depth;
          } else if (offset > rowRect.height - edge) {
            // The gap above an expanded group's children belongs to that
            // group, not to its parent's sibling list.
            const intoGroup = targetRow.hasChildren && targetRow.isExpanded;
            mode = intoGroup ? 'first-child' : 'after';
            resultingParentId = intoGroup ? targetNodeId : targetNode.parentId;
            depth = targetRow.depth + (intoGroup ? 1 : 0);
          } else {
            mode = 'reparent';
            resultingParentId = targetRow.nodeId;
            depth = targetRow.depth + 1;
          }

          // Validation
          let valid = true;
          let reason: string | undefined;

          // 1. Self target
          if (targetNodeId === draggedId) {
            valid = false;
            reason = 'Cannot move an item onto itself.';
          }
          // 2. Descendant target
          else if (!isMoveAcyclic(localNodes, draggedId, resultingParentId)) {
            valid = false;
            reason = 'Cannot move an item into its own subtree.';
          }
          // 3. Project scoping
          else if (!isMoveWithinProject(localNodes, draggedId, resultingParentId)) {
            valid = false;
            reason = 'Cannot move item across projects.';
          }
          // 4. Hierarchy ranking
          else {
            const parentNode = resultingParentId
              ? localNodes.find((n) => n.id === resultingParentId)
              : null;
            if (
              parentNode &&
              draggedNode &&
              !canParentNodeType(parentNode.nodeType ?? null, draggedNode.nodeType ?? null)
            ) {
              valid = false;
              reason = formatHierarchyInversionReason(
                parentNode.nodeType!,
                draggedNode.nodeType!,
              );
            }
          }

          const newDropTarget: DropTargetState = {
            targetNodeId,
            mode,
            depth,
            valid,
            reason,
          };
          dropTargetRef.current = newDropTarget;
          setDropTarget(newDropTarget);
          setDragAnnouncement(reason ?? (
            mode === 'reparent' || mode === 'first-child'
              ? `Move inside ${targetRow.title || 'untitled item'}`
              : `Move ${mode} ${targetRow.title || 'untitled item'}`
          ));

          // 600ms hover timer for auto-expanding collapsed parent
          if (
            mode === 'reparent' &&
            valid &&
            targetRow.hasChildren &&
            !targetRow.isExpanded
          ) {
            if (hoveredReparentNodeIdRef.current !== targetNodeId) {
              if (hoverExpandTimerRef.current) {
                clearTimeout(hoverExpandTimerRef.current);
              }
              hoveredReparentNodeIdRef.current = targetNodeId;
              hoverExpandTimerRef.current = setTimeout(() => {
                toggleExpand(targetNodeId);
              }, 600);
            }
          } else {
            if (hoverExpandTimerRef.current) {
              clearTimeout(hoverExpandTimerRef.current);
              hoverExpandTimerRef.current = null;
            }
            hoveredReparentNodeIdRef.current = null;
          }
          return;
        }
      }

      // Check if hovering below rows inside outline view container
      if (parentRef.current) {
        const containerRect = parentRef.current.getBoundingClientRect();
        if (
          e.clientX >= containerRect.left &&
          e.clientX <= containerRect.right &&
          e.clientY >= containerRect.top &&
          e.clientY <= containerRect.bottom
        ) {
          // Drop last at root
          const newDropTarget: DropTargetState = {
            targetNodeId: null,
            mode: 'root-last',
            depth: 0,
            valid: true,
          };
          dropTargetRef.current = newDropTarget;
          setDropTarget(newDropTarget);
          setDragAnnouncement(null);
          return;
        }
      }

      // Outside valid target
      dropTargetRef.current = null;
      setDropTarget(null);
      setDragAnnouncement(null);
    };

    const cleanupDrag = () => {
      stopAutoScroll();
      if (hoverExpandTimerRef.current) {
        clearTimeout(hoverExpandTimerRef.current);
        hoverExpandTimerRef.current = null;
      }
      hoveredReparentNodeIdRef.current = null;
      isDraggingRef.current = false;
      dragStartRef.current = null;
      dropTargetRef.current = null;
      setIsDragging(false);
      setDraggedNodeId(null);
      setDropTarget(null);
      setDragAnnouncement(null);
    };

    const handleGlobalPointerUp = () => {
      if (!dragStartRef.current) return;

      const wasDragging = isDraggingRef.current;
      const target = dropTargetRef.current;
      const draggedId = dragStartRef.current.nodeId;

      cleanupDrag();

      if (wasDragging && target && target.valid) {
        let newParentId: string | null = null;
        let newPosition: bigint = positionForAppend(null);

        if (target.mode === 'root-last') {
          newParentId = null;
          const rootSiblings = localNodes
            .filter((n) => n.parentId === null && n.id !== draggedId)
            .sort((a, b) => (a.position < b.position ? -1 : 1));
          const lastPos =
            rootSiblings.length > 0
              ? rootSiblings[rootSiblings.length - 1].position
              : null;
          newPosition = positionForAppend(lastPos);
        } else if ((target.mode === 'reparent' || target.mode === 'first-child') && target.targetNodeId) {
          newParentId = target.targetNodeId;
          const children = localNodes
            .filter((n) => n.parentId === newParentId && n.id !== draggedId)
            .sort((a, b) => (a.position < b.position ? -1 : 1));
          const lastPos =
            children.length > 0
              ? children[children.length - 1].position
              : null;
          if (target.mode === 'first-child') {
            const firstPosition = positionBetween(null, children[0]?.position ?? null);
            newPosition = firstPosition.kind === 'Position' ? firstPosition.position : positionForAppend(null);
          } else {
            newPosition = positionForAppend(lastPos);
          }

          // Reveal moved item by expanding parent in view state
          setCollapsedNodeIds((prev) => {
            if (!prev.has(target.targetNodeId!)) return prev;
            const next = new Set(prev);
            next.delete(target.targetNodeId!);
            onViewStateChange?.({ collapsedNodeIds: Array.from(next) });
            return next;
          });
        } else if (target.mode === 'before' && target.targetNodeId) {
          const targetNode = localNodes.find((n) => n.id === target.targetNodeId);
          newParentId = targetNode?.parentId ?? null;
          const siblings = localNodes
            .filter((n) => n.parentId === newParentId && n.id !== draggedId)
            .sort((a, b) => (a.position < b.position ? -1 : 1));
          const targetIndex = siblings.findIndex((s) => s.id === target.targetNodeId);
          const prevSibling = targetIndex > 0 ? siblings[targetIndex - 1] : undefined;
          const targetSibling = siblings[targetIndex];
          const posRes = positionBetween(
            prevSibling?.position ?? null,
            targetSibling?.position ?? null,
          );
          newPosition =
            posRes.kind === 'Position' ? posRes.position : positionForAppend(null);
        } else if (target.mode === 'after' && target.targetNodeId) {
          const targetNode = localNodes.find((n) => n.id === target.targetNodeId);
          newParentId = targetNode?.parentId ?? null;
          const siblings = localNodes
            .filter((n) => n.parentId === newParentId && n.id !== draggedId)
            .sort((a, b) => (a.position < b.position ? -1 : 1));
          const targetIndex = siblings.findIndex((s) => s.id === target.targetNodeId);
          const targetSibling = siblings[targetIndex];
          const nextSibling =
            targetIndex !== -1 && targetIndex < siblings.length - 1
              ? siblings[targetIndex + 1]
              : undefined;
          const posRes = positionBetween(
            targetSibling?.position ?? null,
            nextSibling?.position ?? null,
          );
          newPosition =
            posRes.kind === 'Position'
              ? posRes.position
              : positionForAppend(targetSibling?.position ?? null);
        }

        // Optimistic local update
        setLocalNodes((prev) =>
          prev.map((n) =>
            n.id === draggedId ? { ...n, parentId: newParentId, position: newPosition } : n,
          ),
        );

        if (onMoveNode) {
          onMoveNode({
            nodeId: draggedId,
            newParentId,
            newPosition,
          });
        }

        setFocusedNodeId(draggedId);
        setPendingFocus(draggedId);
      }
    };

    const handleGlobalPointerCancel = () => {
      cleanupDrag();
    };

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isDraggingRef.current) {
        e.preventDefault();
        e.stopPropagation();
        cleanupDrag();
      }
    };

    window.addEventListener('pointermove', handleGlobalPointerMove);
    window.addEventListener('pointerup', handleGlobalPointerUp);
    window.addEventListener('pointercancel', handleGlobalPointerCancel);
    window.addEventListener('keydown', handleGlobalKeyDown, true);

    return () => {
      window.removeEventListener('pointermove', handleGlobalPointerMove);
      window.removeEventListener('pointerup', handleGlobalPointerUp);
      window.removeEventListener('pointercancel', handleGlobalPointerCancel);
      window.removeEventListener('keydown', handleGlobalKeyDown, true);
      // Not during an active drag. This effect re-registers its listeners
      // whenever one of its dependencies changes, and edge auto-scrolling
      // re-renders continuously by design — so tearing the frame loop down
      // here killed the scroll one frame in, with no further pointermove
      // coming to restart it. The drag's own cleanupDrag stops the loop on
      // pointerup, pointercancel and Escape; unmount is covered by the
      // dedicated effect beside startAutoScroll.
      if (!isDraggingRef.current) {
        stopAutoScroll();
      }
      if (hoverExpandTimerRef.current) {
        clearTimeout(hoverExpandTimerRef.current);
      }
    };
  }, [
    localNodes,
    rows,
    onMoveNode,
    onViewStateChange,
    setPendingFocus,
    startAutoScroll,
    stopAutoScroll,
    toggleExpand,
  ]);

  const handleSetNodeType = useCallback(
    (nodeId: string, nodeType: NodeType | null) => {
      setLocalNodes((prev) =>
        prev.map((n) =>
          n.id === nodeId
            ? { ...n, nodeType, typeTag: nodeType ? formatNodeTypeTag(nodeType) : null }
            : n,
        ),
      );
      if (onSetNodeType) {
        onSetNodeType({ nodeId, nodeType });
      }
    },
    [onSetNodeType],
  );

  const handleToggleCompleted = useCallback(
    (nodeId: string, completed: boolean) => {
      setLocalNodes((prev) =>
        prev.map((n) => (n.id === nodeId ? { ...n, completed } : n)),
      );
      if (onToggleNodeCompleted) {
        onToggleNodeCompleted({ nodeId, completed });
      }
    },
    [onToggleNodeCompleted],
  );

  const handleSetDeliveryStatus = useCallback(
    (nodeId: string, deliveryStatus: DeliveryStatus) => {
      const node = localNodes.find((n) => n.id === nodeId);
      const prior = node?.deliveryStatus ?? 'not_started';
      if (deliveryStatus === prior) return;

      setLocalNodes((prev) =>
        prev.map((n) => (n.id === nodeId ? { ...n, deliveryStatus } : n)),
      );
      if (onSetDeliveryStatus) {
        onSetDeliveryStatus({ nodeId, deliveryStatus });
      }

      // Keep the timeline honest on a status transition:
      //  • → In progress with no start date yet → prompt for the expected span
      //  • → Delivered → prompt to review / update the end date
      const hasAuthoredStart = Boolean(node?.startDate);
      if (
        (deliveryStatus === 'in_progress' && !hasAuthoredStart) ||
        deliveryStatus === 'delivered'
      ) {
        setScheduleNodeId(nodeId);
      }
    },
    [localNodes, onSetDeliveryStatus],
  );

  // Row Keyboard Shortcuts
  const handleRowKeyDown = useCallback(
    (e: React.KeyboardEvent, nodeId: string) => {
      // 0. Flush any pending title edit before a structural key acts (UAT #3):
      // structural keys preventDefault, so blur never fires and the typed text
      // would otherwise be lost when the model syncs. Mirror handleCloseBody's
      // flush — dispatch SetNodeTitle now, before the structural command.
      const gesture = mapKeyboardEventToGesture(e);
      if (gesture) {
        const pending = localNodes.find((n) => n.id === nodeId);
        if (pending && pending.title !== '') {
          handleTitleCommit(nodeId, pending.title);
        }
      }

      // 1. Structural keys
      if (gesture) {
        e.preventDefault();
        e.stopPropagation();
        handleStructuralMove(nodeId, gesture);
        return;
      }

      // 2. Command Palette (⌘K / Ctrl+K)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        e.stopPropagation();
        onOpenPalette?.();
        return;
      }

      // 3. Jump to Node (⌘J / Ctrl+J)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        e.stopPropagation();
        onOpenJump?.();
        return;
      }

      // 4. Unlock Inspector (⌘U / Ctrl+U) (Story 3.8, 3.9)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'u') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedEdgeNodeId(nodeId);
        setIsEdgeInspectorOpen(true);
        return;
      }

      // 5. Undo / Redo (⌘Z / ⌘Shift+Z / ⌘Y / Ctrl+Y)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        const persistedTitle = model.nodes.find((n) => n.id === nodeId)?.title ?? '';
        const pendingTitle = pendingTitleEditsRef.current.get(nodeId);
        const hasUncommittedTitleEdit = pendingTitle !== undefined && pendingTitle !== persistedTitle;
        const isEditingBody = editingBodyNodeId === nodeId;

        if (hasUncommittedTitleEdit || isEditingBody) {
          // Allow browser native text undo while editing text in active input/textarea
          return;
        }

        e.preventDefault();
        e.stopPropagation();
        pendingTitleEditsRef.current.clear();
        if (e.shiftKey) {
          onRedo?.();
        } else {
          onUndo?.();
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
        const persistedTitle = model.nodes.find((n) => n.id === nodeId)?.title ?? '';
        const pendingTitle = pendingTitleEditsRef.current.get(nodeId);
        const hasUncommittedTitleEdit = pendingTitle !== undefined && pendingTitle !== persistedTitle;
        const isEditingBody = editingBodyNodeId === nodeId;

        if (hasUncommittedTitleEdit || isEditingBody) {
          // Allow browser native text redo while editing text in active input/textarea
          return;
        }

        e.preventDefault();
        e.stopPropagation();
        pendingTitleEditsRef.current.clear();
        onRedo?.();
        return;
      }

      // 6. Enter -> Create Sibling Node
      if (e.key === 'Enter' && !e.shiftKey && editingBodyNodeId !== nodeId) {
        e.preventDefault();
        e.stopPropagation();
        // Flush the pending title of the current node before creating a sibling
        // (the sibling creation blurs the input, but a synchronous flush keeps
        // the title commit from racing the model sync).
        const pending = localNodes.find((n) => n.id === nodeId);
        if (pending && pending.title !== '') {
          handleTitleCommit(nodeId, pending.title);
        }
        createSibling(nodeId);
        return;
      }

      // 7. Shift+Enter -> Toggle Body Text Editor
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        setEditingBodyNodeId((prev) => (prev === nodeId ? null : nodeId));
        return;
      }

      // 8. ⌘D / Ctrl+D -> Duplicate Subtree
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        e.stopPropagation();
        const pending = localNodes.find((n) => n.id === nodeId);
        if (pending && pending.title !== '') {
          handleTitleCommit(nodeId, pending.title);
        }
        onDuplicateSubtree?.(nodeId);
        return;
      }

      // 9. Delete Subtree (Shift+Delete / ⌘Shift+Delete / ⌘Shift+Backspace / Ctrl+Shift+Delete / Ctrl+Shift+Backspace)
      const currentIndex = rows.findIndex((r) => r.nodeId === nodeId);
      const isShiftDelete =
        (e.key === 'Delete' && e.shiftKey && !e.altKey) ||
        ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'Backspace' || e.key === 'Delete'));

      if (isShiftDelete) {
        e.preventDefault();
        e.stopPropagation();
        deletedNodeIdsRef.current.add(nodeId);
        setLocalNodes((prev) => prev.filter((n) => n.id !== nodeId));
        const targetFocusId =
          currentIndex > 0
            ? rows[currentIndex - 1].nodeId
            : rows.length > 1
              ? rows[currentIndex + 1]?.nodeId
              : null;
        if (targetFocusId) {
          setFocusedNodeId(targetFocusId);
          setPendingFocus(targetFocusId);
        }
        onDeleteSubtree?.(nodeId);
        return;
      }

      // 10. Collapse / Expand branch (⌘↑ / ⌘↓ / Ctrl+Up / Ctrl+Down)
      if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowUp') {
        e.preventDefault();
        setCollapsedNodeIds((prev) => {
          const next = new Set(prev);
          next.add(nodeId);
          onViewStateChange?.({ collapsedNodeIds: Array.from(next) });
          return next;
        });
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowDown') {
        e.preventDefault();
        setCollapsedNodeIds((prev) => {
          const next = new Set(prev);
          next.delete(nodeId);
          onViewStateChange?.({ collapsedNodeIds: Array.from(next) });
          return next;
        });
        return;
      }

      // 11. Arrow navigation
      if (e.key === 'ArrowUp' && !e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (currentIndex > 0) {
          const prevId = rows[currentIndex - 1].nodeId;
          setFocusedNodeId(prevId);
          setPendingFocus(prevId);
        }
        return;
      }
      if (e.key === 'ArrowDown' && !e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (currentIndex !== -1 && currentIndex < rows.length - 1) {
          const nextId = rows[currentIndex + 1].nodeId;
          setFocusedNodeId(nextId);
          setPendingFocus(nextId);
        }
        return;
      }

      // 11. ArrowLeft / ArrowRight expand & collapse
      if (e.key === 'ArrowLeft' && !e.altKey) {
        const row = rows[currentIndex];
        if (row && row.hasChildren && row.isExpanded) {
          e.preventDefault();
          toggleExpand(nodeId);
        }
        return;
      }
      if (e.key === 'ArrowRight' && !e.altKey) {
        const row = rows[currentIndex];
        if (row && row.hasChildren && !row.isExpanded) {
          e.preventDefault();
          toggleExpand(nodeId);
        }
        return;
      }

      // 12. Zoom in/out (⌘. / ⌘, / Alt+Right / Alt+Left)
      if (((e.metaKey || e.ctrlKey) && e.key === '.') || (e.altKey && e.key === 'ArrowRight')) {
        e.preventDefault();
        setCurrentZoomRootId(nodeId);
        onZoomChange?.(nodeId);
        onViewStateChange?.({ zoomRootId: nodeId });
        return;
      }
      if (((e.metaKey || e.ctrlKey) && e.key === ',') || (e.altKey && e.key === 'ArrowLeft')) {
        e.preventDefault();
        if (currentZoomRootId) {
          const currentZoomNode = localNodes.find((n) => n.id === currentZoomRootId);
          const parentZoomId = currentZoomNode?.parentId ?? null;
          setCurrentZoomRootId(parentZoomId);
          onZoomChange?.(parentZoomId);
          onViewStateChange?.({ zoomRootId: parentZoomId });
        }
        return;
      }
    },
    [
      rows,
      localNodes,
      currentZoomRootId,
      createSibling,
      handleStructuralMove,
      handleTitleCommit,
      editingBodyNodeId,
      onOpenPalette,
      onOpenJump,
      onUndo,
      onRedo,
      onDuplicateSubtree,
      onDeleteSubtree,
      onZoomChange,
      onViewStateChange,
      toggleExpand,
    ],
  );

  // Find inspected node and related unlock edges
  const inspectedNodeId = selectedEdgeNodeId ?? focusedNodeId;
  const inspectedEdges = React.useMemo(() => {
    const allEdges = model.unlockEdges ?? [];
    if (!inspectedNodeId) return { inbound: [], outbound: [] };
    return {
      inbound: allEdges.filter((e) => e.targetNodeId === inspectedNodeId),
      outbound: allEdges.filter((e) => e.sourceNodeId === inspectedNodeId),
    };
  }, [inspectedNodeId, model.unlockEdges]);

  const scheduleNode = scheduleNodeId ? localNodes.find((n) => n.id === scheduleNodeId) ?? null : null;
  const planningNode = planningModalNodeId ? localNodes.find((n) => n.id === planningModalNodeId) ?? null : null;

  return (
    <div className="pm-outline-container">
      <div className="pm-outline-main">
        {rows.length === 0 && (
          <div className="pm-outline-empty-state" role="status">
            <p className="pm-outline-empty-state__copy">This outline is empty.</p>
            <button
              type="button"
              className="pm-outline-empty-state__add"
              onClick={() => createSibling(null)}
            >
              + Add node
            </button>
            <p className="pm-outline-empty-state__hint">…or press Enter to create the first node.</p>
          </div>
        )}
        <div
          ref={parentRef}
          className="pm-outline-view"
          role="tree"
          aria-label={projectName}
          data-project-revision={model.projectRevision}
          tabIndex={0}
          onClick={handleCanvasClick}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              createSibling(focusedNodeId ?? (rows.length > 0 ? rows[rows.length - 1].nodeId : null));
            }
          }}
        >
        <div
          className="pm-outline-view__inner"
          role="presentation"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const item = items[virtualRow.index];
            if (!item) return null;

            if (item.kind === 'cue') {
              const anchorRow = rows.find((r) => r.nodeId === item.anchorNodeId);
              if (!anchorRow) return null;
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  data-cue-anchor={item.anchorNodeId}
                  ref={virtualizer.measureElement}
                  className="pm-outline-view__item"
                  style={{
                    transform: `translateY(${virtualRow.start}px)`,
                    '--pm-outline-cue-depth': item.depth,
                  } as React.CSSProperties}
                >
                  <button
                    type="button"
                    className="pm-outline-cue"
                    data-depth={item.depth}
                    aria-label={`Add sibling after ${anchorRow.title || 'untitled item'}`}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.stopPropagation();
                      }
                    }}
                    onClick={() => {
                      // Same path as Enter: flush a pending title first, then
                      // create the sibling through the existing policy (E11-FR4/5).
                      const pending = localNodes.find((n) => n.id === item.anchorNodeId);
                      if (pending && pending.title !== '') {
                        handleTitleCommit(item.anchorNodeId, pending.title);
                      }
                      createSibling(item.anchorNodeId);
                    }}
                  >
                    <span className="pm-outline-cue__guide" aria-hidden="true" />
                    <span className="pm-outline-cue__plus" aria-hidden="true">+</span>
                    <span className="pm-outline-cue__label">Add sibling</span>
                    <span className="pm-outline-cue__hint" aria-hidden="true">Enter</span>
                  </button>
                </div>
              );
            }

            const row = rows[item.rowIndex];
            if (!row) return null;

            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                className="pm-outline-view__item"
                style={{
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <OutlineRow
                  row={row}
                  isFocused={focusedNodeId === row.nodeId}
                  isEditingBody={editingBodyNodeId === row.nodeId}
                  bodyText={bodyTexts.get(row.nodeId) ?? null}
                  constraintMessage={
                    constraintMessage?.nodeId === row.nodeId ? constraintMessage.text : null
                  }
                  isDragging={isDragging && draggedNodeId === row.nodeId}
                  dropZone={
                    dropTarget?.targetNodeId === row.nodeId
                      ? {
                          mode: dropTarget.mode,
                          valid: dropTarget.valid,
                          depth: dropTarget.depth,
                        }
                      : dropTarget?.mode === 'root-last' && item.rowIndex === rows.length - 1
                        ? {
                            mode: 'root-last',
                            valid: true,
                            depth: 0,
                          }
                        : null
                  }
                  onFocus={() => handleRowFocus(row.nodeId)}
                  onToggleExpand={toggleExpand}
                  onTitleChange={handleTitleChange}
                  onTitleCommit={handleTitleCommit}
                  onBodyChange={handleBodyChange}
                  onBodyCommit={handleBodyCommit}
                  onCloseBody={handleCloseBody}
                  onRowKeyDown={handleRowKeyDown}
                  onSetNodeType={handleSetNodeType}
                  onSetDeliveryStatus={handleSetDeliveryStatus}
                  onToggleCompleted={handleToggleCompleted}
                  onOpenScheduleEditor={(nodeId) => setScheduleNodeId(nodeId)}
                  onOpenEdgeInspector={(nodeId) => {
                    setSelectedEdgeNodeId(nodeId);
                    setIsEdgeInspectorOpen(true);
                  }}
                  onOpenPhaseSelector={(nodeId) => setPlanningModalNodeId(nodeId)}
                  onOpenEffortModal={(nodeId) => setPlanningModalNodeId(nodeId)}
                  onOpenInspector={(nodeId, tab) => {
                    if (onOpenInspector) {
                      onOpenInspector({ nodeId, tab });
                    } else {
                      setEditingBodyNodeId(nodeId);
                    }
                  }}
                  onToggleBodyEdit={(nodeId) => {
                    setEditingBodyNodeId((prev) => (prev === nodeId ? null : nodeId));
                  }}
                  coherenceFinding={findingMap.get(row.nodeId)}
                  onDismissFinding={onDismissFinding}
                  onDragStartInit={handleDragStartInit}
                />
              </div>
            );
          })}
        </div>
        </div>
      </div>

      {/* Accessible Drag Announcement Live Region */}
      <div
        className="pm-outline-drag-live-region"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: 'absolute',
          width: '1px',
          height: '1px',
          padding: 0,
          margin: '-1px',
          overflow: 'hidden',
          clip: 'rect(0, 0, 0, 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {dragAnnouncement}
      </div>

      {/* 320px Edge Inspection Panel (Stories 3.8, 3.9) */}
      <EdgeInspectionPanel
        currentNodeId={inspectedNodeId}
        nodes={localNodes}
        inboundEdges={inspectedEdges.inbound}
        outboundEdges={inspectedEdges.outbound}
        allEdges={model.unlockEdges}
        isOpen={isEdgeInspectorOpen}
        onClose={() => setIsEdgeInspectorOpen(false)}
        onNavigateToNode={(targetId) => {
          setFocusedNodeId(targetId);
          setPendingFocus(targetId);
        }}
        onCreateEdge={(sourceNodeId, targetNodeId) => {
          onCreateUnlockEdge?.({ sourceNodeId, targetNodeId });
        }}
        onDeleteEdge={(edgeId, sourceNodeId, targetNodeId) => {
          onDeleteUnlockEdge?.({ edgeId, sourceNodeId, targetNodeId });
        }}
      />

      {/* Phase Manager Modal (Story 3.7) */}
      <PhaseManagerModal
        isOpen={isPhaseModalOpen}
        phases={model.phases ?? []}
        nodes={localNodes}
        onClose={() => setIsPhaseModalOpen(false)}
        onCreatePhase={(name) => onCreatePhase?.(name)}
        onRenamePhase={(phaseId, name) => onRenamePhase?.({ phaseId, name })}
        onReorderPhases={(phases) => onReorderPhases?.(phases)}
        onDeletePhase={(phaseId, reassignments) => onDeletePhase?.({ phaseId, reassignments })}
      />

      {/* Natural Language Schedule Modal (Story 3.4) */}
      <ScheduleEditorModal
        isOpen={scheduleNodeId !== null}
        node={scheduleNode}
        onClose={() => setScheduleNodeId(null)}
        onApplySchedule={(nodeId, startDate, endDate, durationDays, sourceMode) => {
          onSetNodeSchedule?.({ nodeId, startDate, endDate, durationDays, sourceMode });
        }}
      />

      {/* Planning & Metadata Modal (Stories 3.2, 3.6, 3.7) */}
      <EffortWeightModal
        isOpen={planningModalNodeId !== null}
        node={planningNode}
        phases={model.phases ?? []}
        onClose={() => setPlanningModalNodeId(null)}
        onSetEffort={(nodeId, effortPoints) => onSetNodeEffort?.({ nodeId, effortPoints })}
        onSetThemeWeight={(nodeId, strategicWeight) => onSetThemeWeight?.({ nodeId, strategicWeight })}
        onSetCustomField={(nodeId, fieldKey, fieldValue) => onSetNodeCustomField?.({ nodeId, fieldKey, fieldValue })}
        onPromoteFieldToTemplate={(nodeType, fieldKey, fieldLabel) => onPromoteFieldToTemplate?.({ nodeType, fieldKey, fieldLabel })}
        onAssignPhase={(nodeId, phaseId) => onAssignNodePhase?.({ nodeId, phaseId })}
        onCreatePhase={(name) => onCreatePhase?.(name)}
        onOpenPhaseManager={() => setIsPhaseModalOpen(true)}
      />
    </div>
  );
});
