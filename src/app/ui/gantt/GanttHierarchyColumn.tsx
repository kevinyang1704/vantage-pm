/**
 * Gantt hierarchy column component (Story 7.1, Story 7.3, Story 7.4, AD-10, AD-14, EXPERIENCE.md).
 *
 * Fixed 268px width column mirroring Outline carets, indentation, icons, 28px row height,
 * sequencing conflict warnings (▲), and orphan indicators.
 */

import React from 'react';
import type { GanttRow } from '../../../contracts/gantt';
import { GANTT_HIERARCHY_DEFAULT_WIDTH } from '../../../application/gantt/gantt-hierarchy-width';
import './GanttHierarchyColumn.css';

export interface GanttHierarchyColumnProps {
  readonly rows: readonly GanttRow[];
  readonly focusedNodeId: string | null;
  readonly violatingNodeIds?: ReadonlySet<string> | readonly string[];
  readonly orphanNodeIds?: ReadonlySet<string> | readonly string[];
  /**
   * Height of the timeline canvas's sticky header band. Mirrored here as a
   * sticky top spacer so row 0 in this column lines up with row 0 of the
   * timeline instead of sitting a header's-worth higher.
   */
  readonly headerSpacerPx?: number;
  /** Height of the timeline canvas's sticky phase-footer band, if present. */
  readonly footerSpacerPx?: number;
  /** Handle onto the scrolling root, so the parent can mirror scroll here. */
  readonly scrollRef?: React.MutableRefObject<HTMLDivElement | null>;
  /** Width in pixels of the hierarchy column. Defaults to GANTT_HIERARCHY_DEFAULT_WIDTH (268px). */
  readonly width?: number;
  readonly onSelectNode: (nodeId: string) => void;
  readonly onToggleCollapse?: (nodeId: string) => void;
}

export const GANTT_HIERARCHY_COL_WIDTH_PX = GANTT_HIERARCHY_DEFAULT_WIDTH;
export const GANTT_ROW_HEIGHT_PX = 28;

export function GanttHierarchyColumn({
  rows,
  focusedNodeId,
  violatingNodeIds = [],
  orphanNodeIds = [],
  headerSpacerPx = 0,
  footerSpacerPx = 0,
  scrollRef,
  width = GANTT_HIERARCHY_DEFAULT_WIDTH,
  onSelectNode,
  onToggleCollapse,
}: GanttHierarchyColumnProps): React.JSX.Element {
  const violatingSet = new Set(violatingNodeIds);
  const orphanSet = new Set(orphanNodeIds);

  return (
    <div
      ref={scrollRef}
      role="tree"
      aria-label="Gantt Plan Hierarchy"
      className="pm-gantt-hierarchy"
      style={{
        width: `${width}px`,
        minWidth: `${width}px`,
        maxWidth: `${width}px`,
        borderRight: '1px solid var(--pm-border)',
        backgroundColor: 'var(--pm-surface)',
      }}
    >
      {headerSpacerPx > 0 && (
        <div
          aria-hidden="true"
          className="pm-gantt-hierarchy__header-spacer"
          style={{ height: `${headerSpacerPx}px` }}
        />
      )}

      {rows.map((row) => {
        const isFocused = row.nodeId === focusedNodeId;
        const isViolating = violatingSet.has(row.nodeId);
        const isOrphan = orphanSet.has(row.nodeId);
        const indentPx = row.depth * 16 + 8;

        return (
          <div
            key={row.nodeId}
            role="treeitem"
            tabIndex={isFocused ? 0 : -1}
            aria-expanded={row.hasChildren ? !row.isCollapsed : undefined}
            aria-selected={isFocused}
            onClick={() => onSelectNode(row.nodeId)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelectNode(row.nodeId);
              } else if (e.key === 'ArrowRight' && row.hasChildren && row.isCollapsed) {
                e.preventDefault();
                onToggleCollapse?.(row.nodeId);
              } else if (e.key === 'ArrowLeft' && row.hasChildren && !row.isCollapsed) {
                e.preventDefault();
                onToggleCollapse?.(row.nodeId);
              }
            }}
            className={`pm-gantt-hierarchy__row ${isFocused ? 'pm-gantt-hierarchy__row--focused' : ''}`}
            style={{
              height: `${GANTT_ROW_HEIGHT_PX}px`,
              minHeight: `${GANTT_ROW_HEIGHT_PX}px`,
              maxHeight: `${GANTT_ROW_HEIGHT_PX}px`,
              paddingLeft: `${indentPx}px`,
            }}
          >
            {/* Collapse Caret */}
            {row.hasChildren ? (
              <button
                type="button"
                aria-label={row.isCollapsed ? 'Expand branch' : 'Collapse branch'}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleCollapse?.(row.nodeId);
                }}
                className="pm-gantt-hierarchy__caret"
              >
                {row.isCollapsed ? '▶' : '▼'}
              </button>
            ) : (
              <span className="pm-gantt-hierarchy__caret-spacer" />
            )}

            {/* Type Indicator */}
            {row.nodeType && (
              <span
                className={`pm-gantt-hierarchy__type ${
                  row.nodeType === 'Theme'
                    ? 'pm-gantt-hierarchy__type--theme'
                    : row.nodeType === 'Feature'
                    ? 'pm-gantt-hierarchy__type--feature'
                    : 'pm-gantt-hierarchy__type--other'
                }`}
              >
                {row.nodeType.slice(0, 3)}
              </span>
            )}

            {/* Title */}
            <span
              title={row.title || 'Untitled'}
              className={`pm-gantt-hierarchy__title ${row.hasChildren ? 'pm-gantt-hierarchy__title--parent' : ''}`}
            >
              {row.title || 'Untitled'}
            </span>

            {/* Sequencing Conflict Glyph (▲) */}
            {isViolating && (
              <span
                title="Sequencing conflict: dependency order violated"
                className="pm-gantt-hierarchy__flag pm-gantt-hierarchy__flag--violating"
              >
                ▲
              </span>
            )}

            {/* Orphan Glyph */}
            {isOrphan && (
              <span
                title="Risk — no unlock relationships or hierarchy connections"
                className="pm-gantt-hierarchy__flag pm-gantt-hierarchy__flag--orphan"
              >
                ●
              </span>
            )}
          </div>
        );
      })}

      {footerSpacerPx > 0 && (
        <div
          aria-hidden="true"
          className="pm-gantt-hierarchy__footer-spacer"
          style={{ height: `${footerSpacerPx}px` }}
        />
      )}
    </div>
  );
}
