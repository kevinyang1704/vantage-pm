import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { VisualTreeProjection, VisualTreeNode } from '../../../contracts/visual-tree';
import type { NodeGeometry } from '../../../contracts/layout-protocol';
import type {
  PhaseSequencingConflictFinding,
  DateSequencingConflictFinding,
} from '../../../contracts/analysis-protocol';
import { ComputeContainmentGeometryHelper } from './visual-canvas-geometry';
import { ContainmentConnectors } from './containment-connectors';
import { VisualNodeCard } from './visual-node-card';
import { UnlockEdgeConnector, type UnlockEdgeItem } from './unlock-edge-connector';
import { ViolationArrowLayer, type ViolationArrowItem } from './violation-arrow';
import { NodeCardGhost, type NodeCardGhostProps } from './node-card-ghost';
import { ViewportControls } from './viewport-controls';
import type { VisualNodeCardModel } from './visual-node-card.types';
import type { NodeType } from '../../../domain/tree/node.entity';
import {
  IDENTITY_VIEWPORT,
  fitAll,
  panBy,
  resetTransform,
  wheelDeltaScale,
  zoomTowardPointer,
  type ViewportTransform,
} from '../../../application/visual-tree/viewport-transform';
import './visual-tree-canvas.css';

export interface VisualTreeCanvasProps {
  projection: VisualTreeProjection;
  geometry: readonly NodeGeometry[];
  themeName?: string;
  orphanNodeIds?: ReadonlySet<string>;
  violationFindings?: ReadonlyMap<
    string,
    PhaseSequencingConflictFinding | DateSequencingConflictFinding
  >;
  getCardModel?: (node: VisualTreeNode) => VisualNodeCardModel;
  renderCardExtras?: (node: VisualTreeNode, geometry: NodeGeometry) => ReactNode;
  onStartEditing?: (nodeId: string) => void;
  onCommitTitle?: (nodeId: string, title: string) => void;
  onCancelEditing?: (nodeId: string) => void;
  onFocusRequest?: (nodeId: string) => void;
  onCardKeyDown?: (e: React.KeyboardEvent, nodeId: string) => void;
  onToggleCriterion?: (criterionId: string, completed: boolean) => void;
  onSetNodeType?: (nodeId: string, nodeType: NodeType | null) => void;
  onOpenScheduleEditor?: (nodeId: string) => void;
  onOpenDetails?: (nodeId: string) => void;
  editingBodyNodeId?: string | null;
  bodyTextDraft?: string | null;
  onBodyChange?: (nodeId: string, bodyText: string) => void;
  onCloseBody?: (nodeId: string) => void;
  /** Saved viewport for this project+theme (E10-FR12); identity when none. */
  initialViewport?: ViewportTransform;
  /** Emitted on every viewport change for coalesced persistence (E10-AR9). */
  onViewportChange?: (viewport: ViewportTransform) => void;
  /** Fit the whole tree on first open when no saved viewport exists (E10-UX10). */
  autoFitOnOpen?: boolean;
}

const PAN_KEY_STEP = 48;
const ZOOM_BUTTON_STEP = 1.25;

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('button, input, textarea, select, a, [role="treeitem"]'));
}

/**
 * Accessible hybrid canvas (Story 6.2, Epic 10 stories 10.5/10.6).
 *
 * role="tree" wrapper + HTML role="treeitem" cards (never <canvas>) + an
 * aria-hidden SVG connector layer. All visual content lives inside ONE
 * transformed world layer (`translate(panX, panY) scale(scale)`); geometry
 * and connector paths are never mutated during gestures (E10-AR7).
 *
 * Viewport interactions (E10-FR9..FR12):
 * - Space held + primary-button drag pans (pointer capture, grab cursors)
 * - Ctrl + wheel zooms toward the pointer (25%–200%, E10-NFR7)
 * - Canvas-background keyboard: arrows pan, +/- zoom, 0 reset, F fit
 * - Compact Meridian viewport control group (zoom %, fit, reset)
 */
export function VisualTreeCanvas({
  projection,
  geometry,
  themeName,
  orphanNodeIds,
  violationFindings,
  getCardModel,
  renderCardExtras,
  onStartEditing,
  onCommitTitle,
  onCancelEditing,
  onFocusRequest,
  onCardKeyDown,
  onToggleCriterion,
  onSetNodeType,
  onOpenScheduleEditor,
  onOpenDetails,
  editingBodyNodeId,
  bodyTextDraft,
  onBodyChange,
  onCloseBody,
  initialViewport = IDENTITY_VIEWPORT,
  onViewportChange,
  autoFitOnOpen = false,
}: VisualTreeCanvasProps): React.ReactElement {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<ViewportTransform>(initialViewport);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const panStartRef = useRef<{ pointerX: number; pointerY: number; viewport: ViewportTransform } | null>(null);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  const autoFitDoneRef = useRef(false);

  // E10-FR12 / E10-AR9: re-initialize the viewport when the saved viewport
  // for this project+theme changes by VALUE (theme switch, project switch,
  // or load). The parent recomputes the prop inline each render, so object
  // identity is meaningless; a value comparison prevents the effect from
  // fighting live panning (the coalescer echoes the user's own values back).
  const lastSavedRef = useRef<ViewportTransform>(initialViewport);
  useEffect(() => {
    const saved = lastSavedRef.current;
    const next = initialViewport;
    if (saved.panX !== next.panX || saved.panY !== next.panY || saved.scale !== next.scale) {
      setViewport(next);
      autoFitDoneRef.current = false;
      lastSavedRef.current = next;
    }
  }, [initialViewport]);

  const emitViewport = (next: ViewportTransform): void => {
    setViewport(next);
    onViewportChange?.(next);
  };

  const geomByNode = useMemo(() => {
    const map = new Map<string, NodeGeometry>();
    for (const g of geometry) map.set(g.nodeId, g);
    return map;
  }, [geometry]);

  const layout = useMemo(() => {
    return ComputeContainmentGeometryHelper.computeAll(projection, geomByNode, orphanNodeIds);
  }, [projection, geomByNode, orphanNodeIds]);

  // Compute normal unlock edges, violation arrows, and ghost cards
  const { unlockEdgeItems, violationItems, ghostCards, maxGhostX, maxGhostY } = useMemo(() => {
    const items: UnlockEdgeItem[] = [];
    const violations: ViolationArrowItem[] = [];
    const ghosts: NodeCardGhostProps[] = [];
    const seenGhostNodeIds = new Set<string>();
    let maxX = 0;
    let maxY = 0;

    for (const edge of projection.unlockEdges ?? []) {
      const srcGeom = geomByNode.get(edge.sourceNodeId);
      const violation = violationFindings?.get(edge.edgeId);

      if (edge.sourceInSubtree && edge.targetInSubtree) {
        const tgtGeom = geomByNode.get(edge.targetNodeId);
        if (srcGeom && tgtGeom) {
          if (violation) {
            const laterIsSrc = srcGeom.x >= tgtGeom.x;
            const laterGeom = laterIsSrc ? srcGeom : tgtGeom;
            const earlierGeom = laterIsSrc ? tgtGeom : srcGeom;
            const x1 = laterGeom.x;
            const y1 = laterGeom.y + laterGeom.height / 2;
            const x2 = earlierGeom.x + earlierGeom.width;
            const y2 = earlierGeom.y + earlierGeom.height / 2;
            const dx = Math.max(30, Math.abs(x2 - x1) / 3);
            const path = `M ${x1} ${y1} C ${x1 - dx} ${y1}, ${x2 + dx} ${y2}, ${x2} ${y2}`;
            violations.push({
              edgeId: edge.edgeId,
              path,
              origin: { x: x1, y: y1 },
              narrative: violation.narrative,
            });
          } else {
            const x1 = srcGeom.x + srcGeom.width;
            const y1 = srcGeom.y + srcGeom.height / 2;
            const x2 = tgtGeom.x;
            const y2 = tgtGeom.y + tgtGeom.height / 2;
            const dx = Math.max(30, Math.abs(x2 - x1) / 3);
            const path = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
            items.push({
              edgeId: edge.edgeId,
              path,
              origin: { x: x1, y: y1 },
            });
          }
        }
      } else if (edge.sourceInSubtree && edge.outsideEndpoint) {
        if (srcGeom) {
          const ghostNodeId = edge.outsideEndpoint.nodeId;
          const ghostWidth = 208;
          const ghostHeight = 72;
          const gx = srcGeom.x + srcGeom.width + 48;
          const gy = srcGeom.y;

          if (!seenGhostNodeIds.has(ghostNodeId)) {
            seenGhostNodeIds.add(ghostNodeId);
            ghosts.push({
              ghostId: `ghost-${ghostNodeId}`,
              targetTitle: edge.outsideEndpoint.title,
              targetThemeName: edge.outsideEndpoint.themeName,
              geometry: { x: gx, y: gy, width: ghostWidth, height: ghostHeight },
            });
            maxX = Math.max(maxX, gx + ghostWidth);
            maxY = Math.max(maxY, gy + ghostHeight);
          }

          const x1 = srcGeom.x + srcGeom.width;
          const y1 = srcGeom.y + srcGeom.height / 2;
          const x2 = gx;
          const y2 = gy + ghostHeight / 2;
          items.push({
            edgeId: edge.edgeId,
            path: `M ${x1} ${y1} L ${x2} ${y2}`,
            origin: { x: x1, y: y1 },
          });
        }
      } else if (!edge.sourceInSubtree && edge.targetInSubtree && edge.outsideEndpoint) {
        const tgtGeom = geomByNode.get(edge.targetNodeId);
        if (tgtGeom) {
          const ghostNodeId = edge.outsideEndpoint.nodeId;
          const ghostWidth = 208;
          const ghostHeight = 72;
          const gx = tgtGeom.x + tgtGeom.width + 48;
          const gy = tgtGeom.y;

          if (!seenGhostNodeIds.has(ghostNodeId)) {
            seenGhostNodeIds.add(ghostNodeId);
            ghosts.push({
              ghostId: `ghost-${ghostNodeId}`,
              targetTitle: edge.outsideEndpoint.title,
              targetThemeName: edge.outsideEndpoint.themeName,
              geometry: { x: gx, y: gy, width: ghostWidth, height: ghostHeight },
              variant: 'source',
            });
            maxX = Math.max(maxX, gx + ghostWidth);
            maxY = Math.max(maxY, gy + ghostHeight);
          }

          const x1 = gx;
          const y1 = gy + ghostHeight / 2;
          const x2 = tgtGeom.x + tgtGeom.width;
          const y2 = tgtGeom.y + tgtGeom.height / 2;
          items.push({
            edgeId: edge.edgeId,
            path: `M ${x1} ${y1} L ${x2} ${y2}`,
            origin: { x: x1, y: y1 },
          });
        }
      }
    }

    return {
      unlockEdgeItems: items,
      violationItems: violations,
      ghostCards: ghosts,
      maxGhostX: maxX,
      maxGhostY: maxY,
    };
  }, [projection.unlockEdges, geomByNode, violationFindings]);

  // Compute sibling rows with 2+ dated nodes to render "by start date →" headers (Story 6.6 AC3)
  const siblingRowHeaders = useMemo(() => {
    const headers: { key: string; x: number; y: number }[] = [];
    const childrenByParent = new Map<string, VisualTreeNode[]>();

    for (const n of projection.nodes) {
      if (n.parentId !== null) {
        const list = childrenByParent.get(n.parentId) ?? [];
        list.push(n);
        childrenByParent.set(n.parentId, list);
      }
    }

    for (const [parentId, children] of childrenByParent.entries()) {
      const datedChildren = children.filter((c) => c.startDate !== null);
      if (datedChildren.length >= 2) {
        const firstGeom = geomByNode.get(datedChildren[0].nodeId);
        if (firstGeom) {
          headers.push({
            key: `header-${parentId}`,
            x: firstGeom.x,
            y: Math.max(0, firstGeom.y - 18),
          });
        }
      }
    }

    return headers;
  }, [projection.nodes, geomByNode]);

  const worldWidth = Math.max(layout.bounds.width, maxGhostX + 40);
  const worldHeight = Math.max(layout.bounds.height, maxGhostY + 40);

  // E10-UX10: fit the complete tree on first open when no saved viewport exists.
  useLayoutEffect(() => {
    if (!autoFitOnOpen || autoFitDoneRef.current) return;
    if (viewportRef.current !== IDENTITY_VIEWPORT) {
      // A saved (non-identity) viewport exists — keep it.
      autoFitDoneRef.current = true;
      return;
    }
    const el = canvasRef.current;
    if (!el || worldWidth <= 0 || worldHeight <= 0) return;
    if (el.clientWidth <= 0 || el.clientHeight <= 0) return;
    const fitted = fitAll({ width: worldWidth, height: worldHeight }, { width: el.clientWidth, height: el.clientHeight });
    if (fitted) {
      autoFitDoneRef.current = true;
      setViewport(fitted);
      onViewportChange?.(fitted);
    }
  }, [autoFitOnOpen, worldWidth, worldHeight, onViewportChange]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0 && autoFitOnOpen && !autoFitDoneRef.current && worldWidth > 0 && worldHeight > 0) {
          const fitted = fitAll({ width: worldWidth, height: worldHeight }, { width, height });
          if (fitted) {
            autoFitDoneRef.current = true;
            setViewport(fitted);
            onViewportChange?.(fitted);
          }
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [autoFitOnOpen, worldWidth, worldHeight, onViewportChange]);

  // Native non-passive wheel listener so Ctrl+wheel can preventDefault (E10-FR10).
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        emitViewport(zoomTowardPointer(anchor, wheelDeltaScale(e.deltaY), viewportRef.current));
      } else {
        // Plain wheel: ordinary two-dimensional navigation in the transformed
        // world; never changes zoom (E10-UX8).
        e.preventDefault();
        const dx = e.shiftKey ? e.deltaY : (e.deltaX ?? 0);
        const dy = e.shiftKey ? 0 : e.deltaY;
        if (dx !== 0 || dy !== 0) {
          emitViewport(panBy({ x: -dx, y: -dy }, viewportRef.current));
        }
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Space key tracking for grab/pan (E10-FR9, E10-UX7). Only when the canvas
  // background itself is focused — card/keyboard handling is untouched.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return;
    if (e.key === ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      setSpaceHeld(true);
      return;
    }
    const el = canvasRef.current;
    const center = el ? { x: el.clientWidth / 2, y: el.clientHeight / 2 } : { x: 0, y: 0 };
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        emitViewport(panBy({ x: PAN_KEY_STEP, y: 0 }, viewportRef.current));
        break;
      case 'ArrowRight':
        e.preventDefault();
        emitViewport(panBy({ x: -PAN_KEY_STEP, y: 0 }, viewportRef.current));
        break;
      case 'ArrowUp':
        e.preventDefault();
        emitViewport(panBy({ x: 0, y: PAN_KEY_STEP }, viewportRef.current));
        break;
      case 'ArrowDown':
        e.preventDefault();
        emitViewport(panBy({ x: 0, y: -PAN_KEY_STEP }, viewportRef.current));
        break;
      case '+':
      case '=':
        e.preventDefault();
        emitViewport(zoomTowardPointer(center, ZOOM_BUTTON_STEP, viewportRef.current));
        break;
      case '-':
        e.preventDefault();
        emitViewport(zoomTowardPointer(center, 1 / ZOOM_BUTTON_STEP, viewportRef.current));
        break;
      case '0':
        e.preventDefault();
        if (el) emitViewport(resetTransform({ width: el.clientWidth, height: el.clientHeight }));
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        if (el) {
          const fitted = fitAll({ width: worldWidth, height: worldHeight }, { width: el.clientWidth, height: el.clientHeight });
          if (fitted) emitViewport(fitted);
        }
        break;
      default:
        break;
    }
  };

  const handleKeyUp = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === ' ') {
      setSpaceHeld(false);
      endPan();
    }
  };

  const handleBlur = (): void => {
    setSpaceHeld(false);
    endPan();
  };

  const startPan = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!spaceHeld) return;
    if (isInteractiveTarget(e.target)) return; // E10-UX7: gestures on controls never pan
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    panStartRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      viewport: viewportRef.current,
    };
    setPanning(true);
  };

  const movePan = (e: React.PointerEvent<HTMLDivElement>): void => {
    const start = panStartRef.current;
    if (!start) return;
    const dx = e.clientX - start.pointerX;
    const dy = e.clientY - start.pointerY;
    emitViewport(panBy({ x: dx, y: dy }, start.viewport));
  };

  const endPan = (): void => {
    panStartRef.current = null;
    setPanning(false);
  };

  const handlePointerUp = (): void => endPan();
  const handlePointerCancel = (): void => endPan();
  const handleLostPointerCapture = (): void => endPan();

  const zoomIn = (): void => {
    const el = canvasRef.current;
    const center = el ? { x: el.clientWidth / 2, y: el.clientHeight / 2 } : { x: 0, y: 0 };
    emitViewport(zoomTowardPointer(center, ZOOM_BUTTON_STEP, viewportRef.current));
  };

  const zoomOut = (): void => {
    const el = canvasRef.current;
    const center = el ? { x: el.clientWidth / 2, y: el.clientHeight / 2 } : { x: 0, y: 0 };
    emitViewport(zoomTowardPointer(center, 1 / ZOOM_BUTTON_STEP, viewportRef.current));
  };

  const fitTree = (): void => {
    const el = canvasRef.current;
    if (!el) return;
    const fitted = fitAll({ width: worldWidth, height: worldHeight }, { width: el.clientWidth, height: el.clientHeight });
    if (fitted) emitViewport(fitted);
  };

  const resetView = (): void => {
    const el = canvasRef.current;
    if (el) emitViewport(resetTransform({ width: el.clientWidth, height: el.clientHeight }));
  };

  const worldStyle: React.CSSProperties = {
    width: worldWidth,
    height: worldHeight,
    transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.scale})`,
  };

  const canvasClass = [
    'pm-visual-tree-canvas',
    spaceHeld ? 'pm-visual-tree-canvas--grab' : '',
    panning ? 'pm-visual-tree-canvas--grabbing' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const buildCard = (node: VisualTreeNode): ReactNode => {
    const childGeom = geomByNode.get(node.nodeId);
    if (!childGeom) return null;
    const isOrphan = Boolean(orphanNodeIds?.has(node.nodeId));

    const model =
      getCardModel?.(node) ??
      ({
        nodeId: node.nodeId,
        title: node.title,
        nodeType: node.nodeType,
        startDate: node.startDate,
        endDate: node.endDate,
        durationDays: node.durationDays,
        completed: node.completed,
        interactionState: 'rest',
        isTrunk: node.depth === 0,
        isOrphan,
      } satisfies VisualNodeCardModel);

    return (
      <VisualNodeCard
        key={node.nodeId}
        model={model}
        geometry={childGeom}
        ariaLevel={node.depth + 1}
        ariaPosinset={node.siblingIndex + 1}
        ariaSetsize={node.siblingSetSize}
        onStartEditing={onStartEditing}
        onCommitTitle={onCommitTitle}
        onCancelEditing={onCancelEditing}
        onFocusRequest={onFocusRequest}
        onKeyDown={onCardKeyDown}
        onToggleCriterion={onToggleCriterion}
        onSetNodeType={onSetNodeType}
        onOpenScheduleEditor={onOpenScheduleEditor}
        onOpenDetails={onOpenDetails}
        isEditingBody={editingBodyNodeId === node.nodeId}
        bodyText={editingBodyNodeId === node.nodeId ? (bodyTextDraft ?? null) : null}
        onBodyChange={onBodyChange}
        onCloseBody={onCloseBody}
      />
    );
  };

  return (
    <div
      ref={canvasRef}
      tabIndex={0}
      aria-label={`${themeName ?? 'Theme'}, revision ${projection.projectRevision}`}
      className={canvasClass}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onBlur={handleBlur}
      onPointerDown={startPan}
      onPointerMove={movePan}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handleLostPointerCapture}
    >
      {/* The tree role must contain only treeitems (axe aria-required-children);
          the viewport controls live outside it as siblings on the fixed
          interaction surface (E10-AR8 separation). */}
      <div role="tree" aria-label={`${themeName ?? 'Theme'}, revision ${projection.projectRevision}`}>
        <div className="pm-visual-world" style={worldStyle}>
          <ContainmentConnectors
            rails={layout.rails}
            drops={layout.drops}
            width={worldWidth}
            height={worldHeight}
          />
          <UnlockEdgeConnector
            edges={unlockEdgeItems}
            width={worldWidth}
            height={worldHeight}
          />
          <ViolationArrowLayer
            violations={violationItems}
            width={worldWidth}
            height={worldHeight}
          />
          {siblingRowHeaders.map((hdr) => (
            <div
              key={hdr.key}
              aria-hidden="true"
              className="pm-visual-row-header"
              style={{ transform: `translate(${hdr.x}px, ${hdr.y}px)` }}
            >
              by start date →
            </div>
          ))}
          {ghostCards.map((ghost) => (
            <NodeCardGhost
              key={ghost.ghostId}
              ghostId={ghost.ghostId}
              targetTitle={ghost.targetTitle}
              targetThemeName={ghost.targetThemeName}
              geometry={ghost.geometry}
              variant={ghost.variant}
            />
          ))}
          {projection.nodes.map((node) => {
            const card = buildCard(node);
            if (!card) return null; // UAT #7: never render an empty box for a node without geometry
            const extras = renderCardExtras?.(node, geomByNode.get(node.nodeId) ?? { nodeId: node.nodeId, x: 0, y: 0, width: 0, height: 0 });
            return (
              <div key={node.nodeId}>
                {card}
                {extras}
              </div>
            );
          })}
        </div>
      </div>
      <ViewportControls
        scale={viewport.scale}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onFitAll={fitTree}
        onReset={resetView}
      />
    </div>
  );
}
