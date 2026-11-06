/**
 * Gantt timeline canvas component (Story 7.1, Story 7.2, Story 7.4, Story 7.5, AD-10, AD-14, AD-15).
 *
 * Renders header columns, vertical grid guidelines, dependency routes, phase footer rail,
 * interactive bar dragging/resizing with granularity snapping, and derived span refusal dialog.
 */

import React, { useMemo, useState, useEffect, useRef } from 'react';
import type { GanttRow, GanttHeaderColumn, GanttGranularity } from '../../../contracts/gantt';
import type { UnlockEdge } from '../../../domain/edge/unlock-edge.entity';
import type { Phase } from '../../../domain/phase/phase.entity';
import type { Node } from '../../../domain/tree/node.entity';
import { resolveGanttDependencies } from '../../../application/gantt/gantt-dependencies';
import { resolveGanttPhases } from '../../../application/gantt/gantt-phases';
import { computeDragDates, type GanttDragState, type GanttDragHandle } from '../../../application/gantt/gantt-drag.policy';
import { GANTT_ROW_HEIGHT_PX } from './GanttHierarchyColumn';
import { createDateToUnit } from '../../../application/gantt/gantt-geometry';
import { Temporal } from 'temporal-polyfill';
import './GanttTimelineCanvas.css';

/**
 * Sticky-band heights. These MUST match the `height`/`min-height` on
 * `.pm-gantt-canvas__header` and `.pm-gantt-canvas__phase-footer` in
 * GanttTimelineCanvas.css. The hierarchy column consumes the same values as
 * spacer heights so both halves start their first row on the same y — this is
 * the single source of truth for the vertical alignment contract.
 */
export const GANTT_HEADER_HEIGHT_PX = 24;
export const GANTT_PHASE_FOOTER_HEIGHT_PX = 24;

/**
 * The Gantt renders two visual vocabularies:
 *   - a slim **summary rail** for strategic altitudes (Vision, Theme) and for
 *     any parent whose span is rolled up from descendants (`barKind === 'derived'`)
 *   - a solid **task box** for delivery-altitude authored work (Feature,
 *     Component, and untyped leaves with their own dates)
 * so a row's treatment is decided by what it represents, not merely by whether
 * it happens to carry authored dates.
 */
function usesSummaryRail(nodeType: string | null, barKind: 'authored' | 'derived'): boolean {
  return barKind === 'derived' || nodeType === 'Vision' || nodeType === 'Theme';
}

export interface GanttTimelineCanvasProps {
  readonly rows: readonly GanttRow[];
  readonly minDate: string; // ISO YYYY-MM-DD (window start)
  readonly maxDate: string; // ISO YYYY-MM-DD (window end)
  readonly granularity?: GanttGranularity;
  readonly headerColumns?: readonly GanttHeaderColumn[];
  readonly unlockEdges?: readonly UnlockEdge[];
  readonly phases?: readonly Phase[];
  readonly nodes?: readonly Node[];
  readonly pixelsPerDay?: number;
  /**
   * Narrowest the timeline draws, in px. The fixed scales keep a short window
   * at least 800 px wide; Fit passes 0 so the timeline matches the canvas.
   */
  readonly minWidthPx?: number;
  readonly onHorizontalScroll?: (left: number, width: number) => void;
  readonly focusedNodeId: string | null;
  /**
   * Optional handle onto the scrolling root, so the parent can mirror this
   * pane's vertical scroll onto the hierarchy column (they scroll as one).
   */
  readonly scrollRef?: React.MutableRefObject<HTMLDivElement | null>;
  readonly onSelectNode: (nodeId: string) => void;
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
}

/**
 * Inline custom property carrying a row's workstream hue token into the CSS.
 * `--pm-ws` resolves to one of the six `--pm-workstream-N` ramp tokens; the
 * bar/rail/tick rules in GanttTimelineCanvas.css consume it. Returns an empty
 * object for rows above the first Theme (no workstream) so those keep the
 * default accent treatment.
 */
function workstreamHueStyle(hueIndex: number | null): React.CSSProperties {
  if (hueIndex === null) return {};
  return { ['--pm-ws']: `var(--pm-workstream-${hueIndex})` } as React.CSSProperties;
}

export function GanttTimelineCanvas({
  rows,
  minDate,
  maxDate,
  granularity = 'month',
  headerColumns = [],
  unlockEdges = [],
  phases = [],
  nodes = [],
  pixelsPerDay = 8,
  minWidthPx = 800,
  onHorizontalScroll,
  focusedNodeId,
  scrollRef,
  onSelectNode,
  onCommitSchedule,
  onSetExplicitOverride,
}: GanttTimelineCanvasProps): React.JSX.Element {
  const [dragState, setDragState] = useState<GanttDragState | null>(null);
  const [refusedSpanInfo, setRefusedSpanInfo] = useState<{ nodeId: string; title: string; topPx: number; leftPx: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const setContainer = (node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (scrollRef) scrollRef.current = node;
  };

  const startPlain = Temporal.PlainDate.from(minDate);
  const endPlain = Temporal.PlainDate.from(maxDate);
  const totalDays = Math.max(1, startPlain.until(endPlain, { largestUnit: 'day' }).days + 1);
  const canvasWidth = Math.max(
    totalDays * pixelsPerDay,
    headerColumns.reduce((sum, col) => sum + col.pixelWidth, 0),
    minWidthPx,
  );

  // Shared date->unit geometry (Story 8.3 Task 1): this exact formula is reused
  // by the PPTX export, so preview and slide parity holds by construction.
  const dateToX = useMemo(
    () => createDateToUnit({ windowStart: minDate, windowEnd: maxDate, unitsPerDay: pixelsPerDay, totalUnits: canvasWidth }),
    [minDate, maxDate, pixelsPerDay, canvasWidth],
  );

  // 1. Resolve dependency routes
  const dependencyRoutes = useMemo(() => {
    return resolveGanttDependencies({
      visibleRows: rows,
      unlockEdges,
      dateToX,
      rowHeight: GANTT_ROW_HEIGHT_PX,
    });
  }, [rows, unlockEdges, minDate, maxDate, pixelsPerDay, canvasWidth]);

  // 2. Resolve phase bands
  const phaseBands = useMemo(() => {
    return resolveGanttPhases({
      phases,
      nodes,
      dateToX,
      windowStart: minDate,
      windowEnd: maxDate,
    });
  }, [phases, nodes, minDate, maxDate, pixelsPerDay, canvasWidth]);

  // Escape key cancels active drag
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (dragState) {
          e.preventDefault();
          setDragState(null);
        }
        if (refusedSpanInfo) {
          setRefusedSpanInfo(null);
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dragState, refusedSpanInfo]);

  function handleStartDrag(
    e: React.PointerEvent,
    row: GanttRow,
    handle: GanttDragHandle,
  ) {
    if (row.barKind === 'derived') {
      // Refuse drag on derived spans
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      const containerRect = containerRef.current?.getBoundingClientRect() ?? { top: 0, left: 0 };
      setRefusedSpanInfo({
        nodeId: row.nodeId,
        title: row.title || 'Untitled',
        topPx: rect.bottom - containerRect.top + 4,
        leftPx: rect.left - containerRect.left,
      });
      return;
    }

    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    setRefusedSpanInfo(null);
    setDragState({
      active: true,
      nodeId: row.nodeId,
      handle,
      initialStartDate: row.startDate,
      initialEndDate: row.endDate,
      initialDurationDays: row.durationDays,
      currentStartDate: row.startDate,
      currentEndDate: row.endDate,
      currentDurationDays: row.durationDays,
      initialPointerX: e.clientX,
      currentPointerX: e.clientX,
    });
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!dragState || !dragState.active) return;
    const deltaX = e.clientX - dragState.initialPointerX;
    const deltaDays = Math.round(deltaX / pixelsPerDay);

    const updated = computeDragDates({
      handle: dragState.handle,
      initialStartDate: dragState.initialStartDate,
      initialEndDate: dragState.initialEndDate,
      deltaDays,
      granularity,
    });

    setDragState((prev) =>
      prev
        ? {
            ...prev,
            currentStartDate: updated.startDate,
            currentEndDate: updated.endDate,
            currentDurationDays: updated.durationDays,
            currentPointerX: e.clientX,
          }
        : null,
    );
  }

  function handlePointerUp(e: React.PointerEvent) {
    if (!dragState || !dragState.active) return;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);

    const hasChanged =
      dragState.currentStartDate !== dragState.initialStartDate ||
      dragState.currentEndDate !== dragState.initialEndDate;

    if (hasChanged && onCommitSchedule) {
      onCommitSchedule(dragState.nodeId, {
        startDate: dragState.currentStartDate,
        endDate: dragState.currentEndDate,
        durationDays: dragState.currentDurationDays,
        scheduleSourceMode: 'start_end',
      });
    }

    setDragState(null);
  }

  return (
    <div
      ref={setContainer}
      role="region"
      aria-label="Gantt Timeline Chart"
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      className="pm-gantt-canvas"
      data-axis-start={minDate}
      data-axis-end={maxDate}
      data-pixels-per-day={pixelsPerDay}
      onScroll={(event) => onHorizontalScroll?.(event.currentTarget.scrollLeft, event.currentTarget.clientWidth)}
    >
      {/* Header Columns Track — major intervals only (E14-AR3) */}
      {headerColumns.length > 0 && (
        <div
          role="row"
          aria-label="Timeline Header Intervals"
          className="pm-gantt-canvas__header"
          style={{ width: `${canvasWidth}px` }}
        >
          {headerColumns
            .filter((col) => col.level === 'major')
            .map((col) => (
              <div
                key={col.id}
                role="columnheader"
                data-start-date={col.startDate}
                data-end-date={col.endDate}
                className="pm-gantt-canvas__header-col"
                style={{
                  width: `${col.pixelWidth}px`,
                  minWidth: `${col.pixelWidth}px`,
                  maxWidth: `${col.pixelWidth}px`,
                }}
              >
                {col.label}
              </div>
            ))}
        </div>
      )}

      {/* Main Grid & Rows Area */}
      <div
        style={{
          width: `${canvasWidth}px`,
          minHeight: `${rows.length * GANTT_ROW_HEIGHT_PX}px`,
          position: 'relative',
          flex: 1,
        }}
      >
        {/* Vertical Column Grid Lines — geometry-owned (E14-AR1): major
            columns render as cells; minor sub-interval guides render as
            faint positioned hairlines. No CSS repeating gradient. */}
        <div aria-hidden="true" className="pm-gantt-canvas__grid">
          {headerColumns
            .filter((col) => col.level === 'major')
            .map((col) => (
              <div
                key={`grid-${col.id}`}
                className="pm-gantt-canvas__grid-col"
                style={{ width: `${col.pixelWidth}px`, minWidth: `${col.pixelWidth}px` }}
              />
            ))}
          {headerColumns
            .filter((col) => col.level === 'minor')
            .map((col) => (
              <div
                key={`grid-minor-${col.id}`}
                className="pm-gantt-canvas__grid-minor"
                style={{ left: `${dateToX(col.startDate, false)}px` }}
              />
            ))}
        </div>

        {/* Phase Demarcation Vertical Lines */}
        {phaseBands.map((phase) => (
          <div
            key={`phase-line-${phase.phaseId}`}
            aria-hidden="true"
            className="pm-gantt-canvas__phase-band"
            data-start-date={phase.startDate}
            data-end-date={phase.endDate}
            style={{
              left: `${phase.startX}px`,
              width: `${Math.max(1, phase.endX - phase.startX)}px`,
            }}
          />
        ))}

        {/* SVG Dependency Overlay Layer */}
        {dependencyRoutes.length > 0 && (
          <svg
            aria-label="Dependency Routes"
            className="pm-gantt-canvas__deps"
            style={{
              width: `${canvasWidth}px`,
              height: `${rows.length * GANTT_ROW_HEIGHT_PX}px`,
            }}
          >
            <defs>
              <marker
                id="gantt-arrow-default"
                viewBox="0 0 6 6"
                refX="5"
                refY="3"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 6 3 L 0 6 z" fill="var(--pm-border-strong)" />
              </marker>
              <marker
                id="gantt-arrow-violating"
                viewBox="0 0 6 6"
                refX="5"
                refY="3"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 6 3 L 0 6 z" fill="var(--pm-flag-seq)" />
              </marker>
            </defs>
            {dependencyRoutes.map((route) => (
              <path
                key={route.edgeId}
                data-source-id={route.sourceNodeId}
                data-target-id={route.targetNodeId}
                d={route.pathD}
                fill="none"
                stroke={
                  route.isViolating
                    ? 'var(--pm-flag-seq)'
                    : 'var(--pm-border-strong)'
                }
                strokeWidth={route.isViolating ? 2 : 1.5}
                strokeDasharray={route.isViolating ? '4 2' : 'none'}
                markerEnd={
                  route.isViolating
                    ? 'url(#gantt-arrow-violating)'
                    : 'url(#gantt-arrow-default)'
                }
              />
            ))}
          </svg>
        )}

        {/* Row guidelines & bars */}
        {rows.map((row, index) => {
          const isFocused = row.nodeId === focusedNodeId;
          const isBeingDragged = dragState?.nodeId === row.nodeId;
          const topPx = index * GANTT_ROW_HEIGHT_PX;

          const activeStartDate = isBeingDragged ? dragState.currentStartDate : row.startDate;
          const activeEndDate = isBeingDragged ? dragState.currentEndDate : row.endDate;

          const isClippedLeft = activeStartDate < minDate;
          const isClippedRight = activeEndDate > maxDate;

          const barLeft = dateToX(activeStartDate, false);
          const rawRight = isClippedRight ? canvasWidth : dateToX(activeEndDate, true);
          const barWidth = Math.max(pixelsPerDay, rawRight - barLeft);

          const summaryRail = usesSummaryRail(row.nodeType, row.barKind);
          const isStrategicSummary = row.nodeType === 'Vision' || row.nodeType === 'Theme';
          const spanNoun = row.barKind === 'derived' ? 'Derived span' : `${row.nodeType ?? 'Summary'} span`;

          return (
            <div
              key={row.nodeId}
              data-node-id={row.nodeId}
              className={`pm-gantt-canvas__row ${isFocused ? 'pm-gantt-canvas__row--focused' : ''}`}
              style={{
                top: `${topPx}px`,
                height: `${GANTT_ROW_HEIGHT_PX}px`,
                zIndex: isBeingDragged ? 5 : 2,
              }}
            >
              {/* Gantt Bar — solid task box for delivery-altitude authored work;
                  slim summary rail for Vision/Theme and rolled-up parents. */}
              {!summaryRail ? (
                <div
                  role="button"
                  tabIndex={-1}
                  aria-label={`${row.title || 'Untitled'}: ${activeStartDate} to ${activeEndDate}`}
                  onClick={() => onSelectNode(row.nodeId)}
                  onPointerDown={(e) => handleStartDrag(e, row, 'body')}
                  title={`${row.title || 'Untitled'} (${activeStartDate} – ${activeEndDate}, ${isBeingDragged ? dragState.currentDurationDays : row.durationDays}d)`}
                  data-node-id={row.nodeId}
                  data-start-date={activeStartDate}
                  data-end-date={activeEndDate}
                  className={`pm-gantt-canvas__bar
                    ${row.workstreamHueIndex !== null ? `pm-gantt-canvas__bar--ws is-ws${row.workstreamHueIndex}` : ''}
                    ${isBeingDragged ? 'pm-gantt-canvas__bar--dragging' : ''}
                    ${isFocused && !isBeingDragged ? 'pm-gantt-canvas__bar--focused' : ''}
                    ${isClippedLeft && isClippedRight ? 'pm-gantt-canvas__bar--clip-both' : ''}
                    ${isClippedLeft && !isClippedRight ? 'pm-gantt-canvas__bar--clip-left' : ''}
                    ${isClippedRight && !isClippedLeft ? 'pm-gantt-canvas__bar--clip-right' : ''}`}
                  style={{
                    left: `${barLeft}px`,
                    width: `${barWidth}px`,
                    ...workstreamHueStyle(row.workstreamHueIndex),
                  }}
                >
                  {/* Left resize handle */}
                  <div
                    aria-label="Resize start date"
                    onPointerDown={(e) => handleStartDrag(e, row, 'start')}
                    className="pm-gantt-canvas__bar-handle"
                  />

                  <span className="pm-gantt-canvas__bar-label">
                    {row.title || 'Untitled'}
                  </span>

                  {/* Right resize handle */}
                  <div
                    aria-label="Resize end date"
                    onPointerDown={(e) => handleStartDrag(e, row, 'end')}
                    className="pm-gantt-canvas__bar-handle"
                  />
                </div>
              ) : (
                /* Summary rail (bracket treatment). Rolled-up spans refuse
                   drag with guidance; authored Vision/Theme spans stay
                   selectable and body-movable. */
                <div
                  role="button"
                  tabIndex={-1}
                  aria-label={`${spanNoun} for ${row.title || 'Untitled'}: ${row.startDate} to ${row.endDate}`}
                  onClick={() => onSelectNode(row.nodeId)}
                  onPointerDown={(e) => handleStartDrag(e, row, 'body')}
                  title={`${spanNoun}: ${row.title || 'Untitled'} (${row.startDate} – ${row.endDate}, ${row.durationDays}d)`}
                  data-node-id={row.nodeId}
                  data-start-date={activeStartDate}
                  data-end-date={activeEndDate}
                  className={`pm-gantt-canvas__derived
                    ${isStrategicSummary ? 'pm-gantt-canvas__derived--summary' : ''}
                    ${row.barKind !== 'derived' ? 'pm-gantt-canvas__derived--movable' : ''}
                    ${isFocused ? 'pm-gantt-canvas__derived--focused' : ''}`}
                  style={{
                    left: `${barLeft}px`,
                    width: `${barWidth}px`,
                    ...workstreamHueStyle(row.workstreamHueIndex),
                  }}
                >
                  {/* Bracket top line */}
                  <div
                    className={`pm-gantt-canvas__derived-rail ${
                      row.workstreamHueIndex !== null ? 'pm-gantt-canvas__derived-rail--ws' : ''
                    }`}
                  />
                  {/* Left tick */}
                  {!isClippedLeft && (
                    <div
                      className={`pm-gantt-canvas__derived-tick ${
                        row.workstreamHueIndex !== null ? 'pm-gantt-canvas__derived-tick--ws' : ''
                      }`}
                      style={{ left: 0 }}
                    />
                  )}
                  {/* Right tick */}
                  {!isClippedRight && (
                    <div
                      className={`pm-gantt-canvas__derived-tick ${
                        row.workstreamHueIndex !== null ? 'pm-gantt-canvas__derived-tick--ws' : ''
                      }`}
                      style={{ right: 0 }}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* Derived Span Drag Refusal Guidance Popover */}
        {refusedSpanInfo && (
          <div
            role="alert"
            className="pm-gantt-canvas__popover"
            style={{
              top: `${refusedSpanInfo.topPx}px`,
              left: `${refusedSpanInfo.leftPx}px`,
            }}
          >
            <div className="pm-gantt-canvas__popover-title">
              Derived Parent Span
            </div>
            <div className="pm-gantt-canvas__popover-body">
              This span is derived from its descendants. To set an explicit date commitment, establish an override on this node.
            </div>
            <div className="pm-gantt-canvas__popover-actions">
              <button
                type="button"
                onClick={() => setRefusedSpanInfo(null)}
                className="pm-gantt-canvas__popover-btn"
              >
                Dismiss
              </button>
              {onSetExplicitOverride && (
                <button
                  type="button"
                  onClick={() => {
                    onSetExplicitOverride(refusedSpanInfo.nodeId);
                    setRefusedSpanInfo(null);
                  }}
                  className="pm-gantt-canvas__popover-btn pm-gantt-canvas__popover-btn--primary"
                >
                  Set Override
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Phase Footer Rail */}
      {phaseBands.length > 0 && (
        <div
          role="row"
          aria-label="Phase Boundaries Rail"
          className="pm-gantt-canvas__phase-footer"
          style={{ width: `${canvasWidth}px` }}
        >
          {phaseBands.map((phase) => (
            <div
              key={`phase-footer-${phase.phaseId}`}
              className="pm-gantt-canvas__phase-footer-chip"
              style={{
                left: `${phase.startX}px`,
                width: `${Math.max(20, phase.endX - phase.startX)}px`,
              }}
              title={`${phase.phaseName} (${phase.startDate} – ${phase.endDate})`}
            >
              {phase.phaseName}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
