/**
 * Gantt view container component (Story 7.1 - 7.8, AD-2, AD-5, AD-10, AD-14, AD-15, NFR-10).
 *
 * Coordinates the split Gantt presentation (control bar + hierarchy column + timeline canvas +
 * dependencies + phases + drag authoring + accessible date editor dialog).
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Node } from '../../../domain/tree/node.entity';
import type { UnlockEdge } from '../../../domain/edge/unlock-edge.entity';
import type { Phase } from '../../../domain/phase/phase.entity';
import type { GanttGranularity, GanttRow } from '../../../contracts/gantt';
import { projectGantt } from '../../../application/gantt/gantt.projection';
import {
  resolveGanttVisibleScope,
  getPixelsPerDayForGranularity,
  fitGanttZoom,
  type GanttFitZoom,
} from '../../../application/gantt/gantt-scope';
import { GanttControlBar } from './GanttControlBar';
import { GanttHierarchyColumn } from './GanttHierarchyColumn';
import {
  GanttTimelineCanvas,
  GANTT_HEADER_HEIGHT_PX,
  GANTT_PHASE_FOOTER_HEIGHT_PX,
} from './GanttTimelineCanvas';
import { GanttDateEditorDialog } from './GanttDateEditorDialog';
import {
  clampGanttHierarchyWidth,
  GANTT_HIERARCHY_DEFAULT_WIDTH,
  GANTT_HIERARCHY_MIN_WIDTH,
  GANTT_HIERARCHY_MAX_WIDTH,
  GANTT_HIERARCHY_WIDTH_STEP,
} from '../../../application/gantt/gantt-hierarchy-width';
import './GanttView.css';

export interface GanttViewProps {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly nodes: readonly Node[];
  readonly unlockEdges?: readonly UnlockEdge[];
  readonly phases?: readonly Phase[];
  readonly focusedNodeId: string | null;
  readonly collapsedNodeIds?: readonly string[];
  readonly dateWindowStart?: string | null;
  readonly dateWindowEnd?: string | null;
  readonly granularity?: GanttGranularity | null;
  /** Width in pixels of the left hierarchy column. */
  readonly hierarchyWidth?: number;
  /** Callback when the user resizes the left hierarchy column. */
  readonly onHierarchyWidthChange?: (width: number) => void;
  readonly onSelectNode: (nodeId: string) => void;
  readonly onToggleCollapse?: (nodeId: string) => void;
  readonly onCommitSchedule?: (
    nodeId: string,
    schedule: {
      startDate: string;
      endDate: string;
      durationDays: number;
      scheduleSourceMode: 'start_end';
    },
  ) => void;
  readonly onSetExplicitOverride?: (nodeId: string) => void;
  readonly onViewStateChange?: (patch: {
    collapsedNodeIds?: readonly string[];
    dateWindowStart?: string | null;
    dateWindowEnd?: string | null;
    granularity?: GanttGranularity | null;
  }) => void;
}

export function GanttView({
  projectId,
  projectRevision,
  nodes,
  unlockEdges = [],
  phases = [],
  focusedNodeId,
  collapsedNodeIds = [],
  dateWindowStart,
  dateWindowEnd,
  granularity = 'month',
  hierarchyWidth,
  onHierarchyWidthChange,
  onSelectNode,
  onToggleCollapse,
  onCommitSchedule,
  onSetExplicitOverride,
  onViewStateChange,
}: GanttViewProps): React.JSX.Element {
  const [editingRow, setEditingRow] = useState<GanttRow | null>(null);
  const [localGranularity, setLocalGranularity] = useState<GanttGranularity | null>(granularity ?? null);
  const [localDateWindowStart, setLocalDateWindowStart] = useState<string | null>(dateWindowStart ?? null);
  const [localDateWindowEnd, setLocalDateWindowEnd] = useState<string | null>(dateWindowEnd ?? null);
  const [localCollapsedNodeIds, setLocalCollapsedNodeIds] = useState<readonly string[]>(collapsedNodeIds);

  const [localHierarchyWidth, setLocalHierarchyWidth] = useState<number>(
    hierarchyWidth ?? GANTT_HIERARCHY_DEFAULT_WIDTH,
  );

  useEffect(() => {
    if (hierarchyWidth !== undefined) {
      setLocalHierarchyWidth(hierarchyWidth);
    }
  }, [hierarchyWidth]);

  const activeHierarchyWidth = hierarchyWidth ?? localHierarchyWidth;

  const splitRef = useRef<HTMLDivElement | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null);

  const commitWidth = (px: number): void => {
    const containerWidth =
      splitRef.current?.clientWidth ?? (typeof window !== 'undefined' ? window.innerWidth : undefined);
    const clamped = clampGanttHierarchyWidth(px, containerWidth);
    setLocalHierarchyWidth(clamped);
    onHierarchyWidthChange?.(clamped);
  };

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    resizeStartRef.current = { x: e.clientX, width: activeHierarchyWidth };
    setIsResizing(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const handleResizePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const start = resizeStartRef.current;
    if (!start) return;
    commitWidth(start.width + (e.clientX - start.x));
  };

  const handleResizePointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    resizeStartRef.current = null;
    setIsResizing(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };

  const handleResizeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? GANTT_HIERARCHY_WIDTH_STEP * 3 : GANTT_HIERARCHY_WIDTH_STEP;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      commitWidth(activeHierarchyWidth + step);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      commitWidth(activeHierarchyWidth - step);
    } else if (e.key === 'Home') {
      e.preventDefault();
      commitWidth(GANTT_HIERARCHY_DEFAULT_WIDTH);
    } else if (e.key === 'End') {
      e.preventDefault();
      commitWidth(GANTT_HIERARCHY_MAX_WIDTH);
    }
  };

  useEffect(() => {
    setLocalGranularity(granularity ?? null);
  }, [granularity]);

  useEffect(() => {
    setLocalDateWindowStart(dateWindowStart ?? null);
  }, [dateWindowStart]);

  useEffect(() => {
    setLocalDateWindowEnd(dateWindowEnd ?? null);
  }, [dateWindowEnd]);

  useEffect(() => {
    setLocalCollapsedNodeIds(collapsedNodeIds);
  }, [collapsedNodeIds]);

  // Handles onto the two scroll roots — wired to a shared vertical offset below.
  const hierarchyScrollRef = useRef<HTMLDivElement | null>(null);
  const canvasScrollRef = useRef<HTMLDivElement | null>(null);

  // 1. Build canonical projection
  const baseProjection = useMemo(() => {
    return projectGantt({
      projectId,
      projectRevision,
      nodes,
      collapsedNodeIds: localCollapsedNodeIds,
    });
  }, [projectId, projectRevision, nodes, localCollapsedNodeIds]);

  // Determine active window fallback
  const effectiveGranularity: GanttGranularity = localGranularity ?? granularity ?? 'month';
  const effectiveWindowStart = localDateWindowStart ?? dateWindowStart ?? baseProjection.minProjectDate ?? '2026-01-01';
  const effectiveWindowEnd = localDateWindowEnd ?? dateWindowEnd ?? baseProjection.maxProjectDate ?? '2026-12-31';

  // Fit shows the whole window in the canvas's visible width. The fixed
  // scales draw at a set zoom, so a long project always overflowed and a
  // second press, with the window already at the project span, changed
  // nothing. While fitted, the zoom follows the canvas width; choosing a
  // scale or editing the window returns to that scale's fixed zoom. The
  // fitted state is not persisted: the view reopens at its saved scale.
  const [fitted, setFitted] = useState(false);
  const [fitZoom, setFitZoom] = useState<GanttFitZoom | null>(null);
  const [fitRequest, setFitRequest] = useState(0);
  const activeFit = fitted ? fitZoom : null;
  const displayGranularity: GanttGranularity = activeFit?.granularity ?? effectiveGranularity;
  const pixelsPerDay = activeFit?.pixelsPerDay ?? getPixelsPerDayForGranularity(effectiveGranularity);

  useLayoutEffect(() => {
    if (!fitted) return;
    const canvas = canvasScrollRef.current;
    if (!canvas) return;
    const measure = () => {
      const next = fitGanttZoom(
        effectiveWindowStart,
        effectiveWindowEnd,
        canvas.clientWidth,
        effectiveGranularity,
      );
      setFitZoom((prev) =>
        prev && prev.pixelsPerDay === next.pixelsPerDay && prev.granularity === next.granularity ? prev : next,
      );
    };
    measure();
    // Every press returns to the start of the project, even when already fitted.
    canvas.scrollLeft = 0;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [fitted, fitRequest, effectiveWindowStart, effectiveWindowEnd, effectiveGranularity]);

  // 2. Resolve visible scope (window bounds, clipping, collapse, exclusions)
  const scopedResult = useMemo(() => {
    return resolveGanttVisibleScope({
      projection: baseProjection,
      window: {
        dateWindowStart: effectiveWindowStart,
        dateWindowEnd: effectiveWindowEnd,
        granularity: displayGranularity,
      },
      collapsedNodeIds: localCollapsedNodeIds,
      pixelsPerDay,
    });
  }, [baseProjection, effectiveWindowStart, effectiveWindowEnd, displayGranularity, pixelsPerDay, localCollapsedNodeIds]);

  // Keep the hierarchy column and the timeline canvas on the same vertical
  // scroll offset so a row's label and its bar never drift apart. The canvas
  // shows the scrollbar; the hierarchy column follows it (and vice-versa when
  // the wheel is over the labels).
  useEffect(() => {
    const hierarchy = hierarchyScrollRef.current;
    const canvas = canvasScrollRef.current;
    if (!hierarchy || !canvas) return;

    // Mirror on value difference alone: assigning an already-equal scrollTop
    // fires no scroll event, so the echo back stops itself — no lock, and
    // nothing to get wedged if a frame is dropped or the tab is backgrounded.
    const mirror = (from: HTMLElement, to: HTMLElement) => () => {
      if (Math.abs(to.scrollTop - from.scrollTop) < 1) return;
      to.scrollTop = from.scrollTop;
    };
    const onHierarchyScroll = mirror(hierarchy, canvas);
    const onCanvasScroll = mirror(canvas, hierarchy);
    hierarchy.addEventListener('scroll', onHierarchyScroll, { passive: true });
    canvas.addEventListener('scroll', onCanvasScroll, { passive: true });
    return () => {
      hierarchy.removeEventListener('scroll', onHierarchyScroll);
      canvas.removeEventListener('scroll', onCanvasScroll);
    };
    // Re-bind once the panes mount (empty state → populated) and whenever the
    // visible row count changes.
  }, [scopedResult.visibleRows.length]);

  // 3. Compute sequencing conflicts for hierarchy column warning glyph (▲)
  const violatingNodeIds = useMemo(() => {
    const rowMap = new Map<string, { startDate: string; endDate: string }>();
    for (const r of scopedResult.visibleRows) {
      rowMap.set(r.nodeId, { startDate: r.startDate, endDate: r.endDate });
    }
    const ids = new Set<string>();
    for (const edge of unlockEdges) {
      const src = rowMap.get(edge.sourceNodeId);
      const tgt = rowMap.get(edge.targetNodeId);
      if (src && tgt && src.endDate > tgt.startDate) {
        ids.add(edge.targetNodeId);
      }
    }
    return ids;
  }, [scopedResult.visibleRows, unlockEdges]);

  // 4. Compute dated orphans for hierarchy indicator (Class A)
  const orphanNodeIds = useMemo(() => {
    const edgeConnected = new Set<string>();
    for (const edge of unlockEdges) {
      edgeConnected.add(edge.sourceNodeId);
      edgeConnected.add(edge.targetNodeId);
    }
    const orphans = new Set<string>();
    for (const row of scopedResult.visibleRows) {
      if (row.parentId === null && !row.hasChildren && !edgeConnected.has(row.nodeId)) {
        orphans.add(row.nodeId);
      }
    }
    return orphans;
  }, [scopedResult.visibleRows, unlockEdges]);

  if (baseProjection.rows.length === 0) {
    return (
      <div
        role="region"
        aria-label="Gantt View"
        className="pm-gantt-view pm-gantt-view--empty"
      >
        <div className="pm-gantt-view__empty-title">
          No Scheduled Work in Timeline
        </div>
        <div className="pm-gantt-view__empty-copy">
          {baseProjection.totalProjectNodes > 0
            ? `All ${baseProjection.totalProjectNodes} items in this project are undated. Set start and end dates in the Outline view to project them onto the Gantt timeline.`
            : 'Add items with dates to project your canonical plan onto the Gantt timeline.'}
        </div>
      </div>
    );
  }

  const handleChangeWindow = (patch: {
    dateWindowStart?: string;
    dateWindowEnd?: string;
    granularity?: GanttGranularity;
  }) => {
    setFitted(false);
    if (patch.granularity !== undefined) {
      setLocalGranularity(patch.granularity);
    }
    if (patch.dateWindowStart !== undefined) {
      setLocalDateWindowStart(patch.dateWindowStart);
    }
    if (patch.dateWindowEnd !== undefined) {
      setLocalDateWindowEnd(patch.dateWindowEnd);
    }
    onViewStateChange?.(patch);
  };

  const handleToggleCollapse = (nodeId: string) => {
    const next = localCollapsedNodeIds.includes(nodeId)
      ? localCollapsedNodeIds.filter((c) => c !== nodeId)
      : [...localCollapsedNodeIds, nodeId];
    setLocalCollapsedNodeIds(next);
    onToggleCollapse?.(nodeId);
    onViewStateChange?.({ collapsedNodeIds: next });
  };

  return (
    <div
      role="region"
      aria-label="Gantt View"
      className="pm-gantt-view"
      style={
        {
          // Single source of truth for the sticky band heights: the canvas
          // paints its header/footer from these, and the hierarchy column
          // sizes its matching spacers from the same constants. Alignment
          // cannot drift by someone editing one side's CSS.
          '--pm-gantt-band-h': `${GANTT_HEADER_HEIGHT_PX}px`,
          '--pm-gantt-footer-band-h': `${GANTT_PHASE_FOOTER_HEIGHT_PX}px`,
        } as React.CSSProperties
      }
    >
      {/* Control Bar */}
      <GanttControlBar
        dateWindowStart={effectiveWindowStart}
        dateWindowEnd={effectiveWindowEnd}
        granularity={effectiveGranularity}
        fitted={activeFit !== null}
        undatedCount={scopedResult.undatedCount}
        outOfWindowCount={scopedResult.outOfWindowCount}
        onChangeWindow={handleChangeWindow}
        onResetToProjectSpan={() => {
          if (baseProjection.minProjectDate && baseProjection.maxProjectDate) {
            handleChangeWindow({
              dateWindowStart: baseProjection.minProjectDate,
              dateWindowEnd: baseProjection.maxProjectDate,
            });
            setFitted(true);
            setFitRequest((n) => n + 1);
          }
        }}
      />

      {/* Split Pane: Hierarchy Column + Timeline Canvas */}
      <div
        ref={splitRef}
        className={`pm-gantt-view__split${isResizing ? ' pm-gantt-view__split--resizing' : ''}`}
      >
        <GanttHierarchyColumn
          rows={scopedResult.visibleRows}
          focusedNodeId={focusedNodeId}
          violatingNodeIds={violatingNodeIds}
          orphanNodeIds={orphanNodeIds}
          scrollRef={hierarchyScrollRef}
          headerSpacerPx={scopedResult.headerColumns.length > 0 ? GANTT_HEADER_HEIGHT_PX : 0}
          footerSpacerPx={phases.length > 0 ? GANTT_PHASE_FOOTER_HEIGHT_PX : 0}
          width={activeHierarchyWidth}
          onSelectNode={(id) => {
            onSelectNode(id);
            const found = scopedResult.visibleRows.find((r) => r.nodeId === id);
            if (found && focusedNodeId === id) {
              setEditingRow(found);
            }
          }}
          onToggleCollapse={handleToggleCollapse}
        />
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize left panel"
          aria-valuemin={GANTT_HIERARCHY_MIN_WIDTH}
          aria-valuemax={GANTT_HIERARCHY_MAX_WIDTH}
          aria-valuenow={Math.round(activeHierarchyWidth)}
          tabIndex={0}
          title="Drag to resize left panel (double-click to reset)"
          className={`pm-gantt-split__resizer${isResizing ? ' pm-gantt-split__resizer--resizing' : ''}`}
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerUp}
          onPointerCancel={handleResizePointerUp}
          onDoubleClick={() => commitWidth(GANTT_HIERARCHY_DEFAULT_WIDTH)}
          onKeyDown={handleResizeKeyDown}
        />
        <GanttTimelineCanvas
          rows={scopedResult.visibleRows}
          minDate={effectiveWindowStart}
          maxDate={effectiveWindowEnd}
          granularity={displayGranularity}
          headerColumns={scopedResult.headerColumns}
          unlockEdges={unlockEdges}
          phases={phases}
          nodes={nodes}
          pixelsPerDay={pixelsPerDay}
          minWidthPx={activeFit ? 0 : undefined}
          focusedNodeId={focusedNodeId}
          scrollRef={canvasScrollRef}
          onSelectNode={onSelectNode}
          onCommitSchedule={onCommitSchedule}
          onSetExplicitOverride={onSetExplicitOverride}
        />
      </div>

      {/* Accessible Date Editor Modal */}
      {editingRow && (
        <GanttDateEditorDialog
          row={editingRow}
          isOpen={true}
          onClose={() => setEditingRow(null)}
          onSave={(patch) => {
            if (onCommitSchedule) {
              onCommitSchedule(editingRow.nodeId, {
                startDate: patch.startDate,
                endDate: patch.endDate,
                durationDays: patch.durationDays,
                scheduleSourceMode: 'start_end',
              });
            }
          }}
        />
      )}
    </div>
  );
}
