/**
 * OutlineRow — individual virtualized outline row component (Epic 2, Epic 3).
 *
 * Implements the Meridian row grid:
 *   flag gutter 18 · indent guides 16*depth · caret 11 · type tag · title (flex) · count · metadata lane (92px reserved)
 */

import React, { forwardRef, useRef, useEffect, useState } from 'react';
import type { VisibleOutlineRow } from '../../../application/outline/outline-visible.projection';
import type { DeliveryStatus, NodeType } from '../../../domain/tree/node.entity';
import { NODE_TYPE_OPTIONS, matchNodeTypeFuzzy, formatNodeTypeLabel } from '../../../domain/tree/node-type.policy';
import { DELIVERY_STATUS_OPTIONS, deliveryStatusLabel, deliveryStatusModifier, findingSeverityLabel } from '../vocabulary';
import { MarkdownViewer } from '../markdown/markdown-viewer';
import { MarkdownEditor } from '../markdown/markdown-editor';
import { NODE_BRIEF_TEMPLATES, templateForNodeType } from '../../../domain/templates/node-brief-templates';
import './outline-row.css';

export interface OutlineRowProps {
  row: VisibleOutlineRow;
  isFocused?: boolean;
  isEditingBody?: boolean;
  bodyText?: string | null;
  constraintMessage?: string | null;
  isDragging?: boolean;
  dropZone?: {
    mode: 'before' | 'after' | 'reparent' | 'first-child' | 'root-last';
    valid: boolean;
    depth: number;
  } | null;
  onFocus?: () => void;
  onToggleExpand?: (nodeId: string) => void;
  onTitleChange?: (nodeId: string, title: string) => void;
  onTitleCommit?: (nodeId: string, title: string) => void;
  onBodyChange?: (nodeId: string, bodyText: string) => void;
  onBodyCommit?: (nodeId: string, bodyText: string) => void;
  onCloseBody?: (nodeId: string) => void;
  onRowKeyDown?: (e: React.KeyboardEvent, nodeId: string) => void;
  onSetNodeType?: (nodeId: string, nodeType: NodeType | null) => void;
  onSetDeliveryStatus?: (nodeId: string, deliveryStatus: DeliveryStatus) => void;
  onToggleCompleted?: (nodeId: string, completed: boolean) => void;
  onOpenScheduleEditor?: (nodeId: string) => void;
  onOpenEdgeInspector?: (nodeId: string) => void;
  onOpenPhaseSelector?: (nodeId: string) => void;
  onOpenEffortModal?: (nodeId: string) => void;
  onOpenInspector?: (nodeId: string, tab?: 'brief' | 'questions' | 'acceptance' | 'unlocks') => void;
  onToggleBodyEdit?: (nodeId: string) => void;
  coherenceFinding?: import('../../../contracts/analysis-protocol').CoherenceFinding | null;
  onDismissFinding?: (finding: import('../../../contracts/analysis-protocol').CoherenceFinding) => void;
  onDragStartInit?: (e: React.PointerEvent, nodeId: string) => void;
}

export const OutlineRow = forwardRef<HTMLDivElement, OutlineRowProps>(function OutlineRow(
  {
    row,
    isFocused = false,
    isEditingBody = false,
    bodyText = null,
    constraintMessage = null,
    isDragging = false,
    dropZone = null,
    onFocus,
    onToggleExpand,
    onTitleChange,
    onTitleCommit,
    onBodyChange,
    onBodyCommit,
    onCloseBody,
    onRowKeyDown,
    onSetNodeType,
    onSetDeliveryStatus,
    onToggleCompleted,
    onOpenScheduleEditor,
    onOpenEdgeInspector,
    onOpenPhaseSelector,
    onOpenEffortModal,
    onOpenInspector,
    onToggleBodyEdit,
    coherenceFinding = null,
    onDismissFinding,
    onDragStartInit,
  },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const statusContainerRef = useRef<HTMLDivElement>(null);
  const [isTypeDropdownOpen, setIsTypeDropdownOpen] = useState(false);
  const [typeSearch, setTypeSearch] = useState('');
  const [isStatusMenuOpen, setIsStatusMenuOpen] = useState(false);

  useEffect(() => {
    if (!isFocused || !inputRef.current || isEditingBody) return;
    const active = document.activeElement;
    if (active === inputRef.current) return;
    // Focus already sits on another control inside this row (type selector,
    // completion checkbox, expand caret) because the user just clicked it.
    // Pulling focus back to the title input re-renders the row mid-gesture,
    // which replaces the control between mousedown and mouseup — the browser
    // then retargets the click to the container and the control's onClick
    // never fires (Story 3.1 type selector under load).
    const rowEl = inputRef.current.closest('[role="treeitem"]');
    if (rowEl && active instanceof Node && rowEl.contains(active)) return;
    inputRef.current.focus({ preventScroll: true });
  }, [isFocused, isEditingBody]);

  useEffect(() => {
    if (isEditingBody && textareaRef.current) {
      textareaRef.current.focus({ preventScroll: true });
    }
  }, [isEditingBody]);

  // Close the delivery-status menu on an outside click or Escape.
  useEffect(() => {
    if (!isStatusMenuOpen) return;
    const onPointerDown = (e: PointerEvent): void => {
      if (!statusContainerRef.current?.contains(e.target as Node)) {
        setIsStatusMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setIsStatusMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [isStatusMenuOpen]);

  const indentGuides = Array.from({ length: row.depth }, (_, i) => (
    <span key={i} className="pm-outline-row__indent-guide" aria-hidden="true" />
  ));

  const handleCaretClick = (e: React.MouseEvent): void => {
    if (row.hasChildren && onToggleExpand) {
      e.stopPropagation();
      onToggleExpand(row.nodeId);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === ' ' && row.nodeType === 'AcceptanceCriterion' && document.activeElement !== inputRef.current && document.activeElement !== textareaRef.current) {
      e.preventDefault();
      onToggleCompleted?.(row.nodeId, !row.completed);
      return;
    }

    if (e.key === ':' && (e.ctrlKey || e.metaKey || document.activeElement !== inputRef.current)) {
      e.preventDefault();
      setIsTypeDropdownOpen(true);
      return;
    }

    if (onRowKeyDown) {
      onRowKeyDown(e, row.nodeId);
    }
  };

  const handleSelectType = (type: NodeType | null) => {
    onSetNodeType?.(row.nodeId, type);
    setIsTypeDropdownOpen(false);
    setTypeSearch('');
  };

  const handleSelectStatus = (status: DeliveryStatus) => {
    setIsStatusMenuOpen(false);
    if (status !== row.deliveryStatus) {
      onSetDeliveryStatus?.(row.nodeId, status);
    }
  };

  // Filter types by fuzzy match
  const filteredTypes = typeSearch
    ? NODE_TYPE_OPTIONS.filter((t) => matchNodeTypeFuzzy(typeSearch, t))
    : NODE_TYPE_OPTIONS;

  // Format schedule display
  const renderScheduleText = () => {
    if (row.startDate && row.endDate) {
      const dur = row.durationDays ? ` (${row.durationDays}d)` : '';
      return `${row.startDate} → ${row.endDate}${dur}`;
    }
    if (row.startDate) {
      return `${row.startDate}`;
    }
    if (row.durationDays) {
      return `${row.durationDays} days`;
    }
    return null;
  };

  // Derived ancestor span (UAT #8): rolled-up dates from dated descendants,
  // shown only when the node has no authored dates of its own.
  const derivedScheduleText = (() => {
    if (!row.derivedStartDate && !row.derivedEndDate) return null;
    if (row.derivedStartDate && row.derivedEndDate) {
      const dur = row.derivedDurationDays ? ` (${row.derivedDurationDays}d)` : '';
      return `${row.derivedStartDate} → ${row.derivedEndDate}${dur}`;
    }
    return row.derivedStartDate ?? row.derivedEndDate;
  })();

  const scheduleText = renderScheduleText();

  let dropClass = '';
  if (dropZone) {
    if (!dropZone.valid) {
      dropClass = 'pm-outline-row--drop-invalid';
    } else if (dropZone.mode === 'reparent') {
      dropClass = 'pm-outline-row--drop-reparent';
    } else if (dropZone.mode === 'before') {
      dropClass = 'pm-outline-row--drop-before';
    } else if (dropZone.mode === 'after' || dropZone.mode === 'first-child' || dropZone.mode === 'root-last') {
      dropClass = 'pm-outline-row--drop-after';
    }
  }

  const depthStyle = {
    '--outline-depth': row.depth,
    ...(dropZone ? { '--drop-depth': dropZone.depth } : {}),
  } as React.CSSProperties;

  return (
    <div
      ref={ref}
      className={`pm-outline-row ${isFocused ? 'pm-outline-row--focused' : ''} ${row.completed ? 'pm-outline-row--completed' : ''} ${row.nodeType === 'AcceptanceCriterion' ? 'pm-outline-row--acceptance-criterion' : ''} ${isDragging ? 'pm-outline-row--dragging' : ''} ${dropClass}`}
      style={depthStyle}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-posinset={row.posInSet}
      aria-setsize={row.setSize}
      aria-expanded={row.hasChildren ? row.isExpanded : undefined}
      aria-selected={isFocused}
      tabIndex={isFocused ? 0 : -1}
      data-node-id={row.nodeId}
      /* Stable hook for the muted per-type tag + accent-bar treatment
         (outline-row.css). Only ever Vision / Theme / Component / Feature /
         AcceptanceCriterion; the CSS styles the four structural types, so
         untyped rows and AC rows get no type cue. */
      data-node-type={row.nodeType ?? undefined}
      onFocus={onFocus}
      onClick={onFocus}
      onKeyDown={handleKeyDown}
    >
      {dropZone?.valid && (dropZone.mode === 'reparent' || dropZone.mode === 'first-child') && (
        <span className="pm-outline-row__drop-hint" aria-hidden="true">Move inside</span>
      )}
      {/* 1. Flag Gutter (18px reserved) */}
      <span className="pm-outline-row__flag-gutter" aria-hidden="true">
        {coherenceFinding && <span className="pm-outline-row__flag-dot" title={coherenceFinding.title} />}
      </span>

      {/* 2. Indent Guides (16px * depth) */}
      <span className="pm-outline-row__indent" aria-hidden="true">{indentGuides}</span>

      {/* Drag Handle */}
      <button
        type="button"
        className="pm-outline-row__drag-handle"
        aria-label={`Move ${row.title || 'untitled item'}`}
        onPointerDown={(e) => {
          e.stopPropagation();
          onDragStartInit?.(e, row.nodeId);
        }}
        tabIndex={-1}
      >
        ⋮⋮
      </button>

      {/* 3. Caret (11px) */}
      <span
        className={`pm-outline-row__caret ${!row.hasChildren ? 'pm-outline-row__caret--leaf' : ''}`}
        onClick={handleCaretClick}
        role="presentation"
        aria-hidden="true"
      >
        {row.hasChildren ? (row.isExpanded ? '▼' : '▶') : '•'}
      </span>

      {/* Acceptance Criteria Checkbox (Story 3.5) */}
      {row.nodeType === 'AcceptanceCriterion' && (
        <label className="pm-outline-row__checkbox-label" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={row.completed}
            onChange={(e) => onToggleCompleted?.(row.nodeId, e.target.checked)}
            className="pm-outline-row__checkbox"
            aria-label={`Mark "${row.title || 'criterion'}" completed`}
          />
        </label>
      )}

      {/* 4. Type Tag & Selector Popover (Story 3.1) */}
      <div className="pm-outline-row__type-container">
        <button
          type="button"
          className={`pm-outline-row__type-tag ${row.nodeType ? `pm-outline-row__type-tag--${row.nodeType.toLowerCase()}` : 'pm-outline-row__type-tag--none'}`}
          onClick={(e) => {
            e.stopPropagation();
            setIsTypeDropdownOpen((prev) => !prev);
          }}
          title="Click or press ':' to change type"
        >
          {row.typeTag ? row.typeTag.toUpperCase() : 'NO TYPE'}
        </button>

        {isTypeDropdownOpen && (
          <div className="pm-outline-row__type-dropdown" onClick={(e) => e.stopPropagation()}>
            <input
              type="text"
              placeholder="Search type..."
              value={typeSearch}
              onChange={(e) => setTypeSearch(e.target.value)}
              className="pm-outline-row__type-search"
              autoFocus
            />
            <div className="pm-outline-row__type-options">
              <button
                type="button"
                className="pm-outline-row__type-option"
                onClick={() => handleSelectType(null)}
              >
                (No Type)
              </button>
              {filteredTypes.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`pm-outline-row__type-option ${row.nodeType === t ? 'pm-outline-row__type-option--selected' : ''}`}
                  onClick={() => handleSelectType(t)}
                >
                  {formatNodeTypeLabel(t)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 5. Title & Inline Input */}
      <span className="pm-outline-row__title" title={row.title || undefined}>
        <input
          ref={inputRef}
          className={`pm-outline-row__title-input ${row.completed ? 'pm-outline-row__title-input--completed' : ''}`}
          value={row.title}
          placeholder={row.title === '' ? 'Type a title…' : ''}
          onFocus={onFocus}
          onChange={(e) => onTitleChange?.(row.nodeId, e.target.value)}
          onBlur={(e) => onTitleCommit?.(row.nodeId, e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label={`Item title ${row.title || 'untitled'}`}
        />
        {constraintMessage && (
          <span className="pm-outline-row__constraint" role="status">
            ({constraintMessage})
          </span>
        )}
      </span>

      <div className="pm-outline-row__details">
      {/* Risk / Blocker chip (handoff README → Copy & terminology changes).
          The raw reason code stays internal; the visible label is the severity. */}
      {coherenceFinding && (
        <span
          className={`pm-outline-row__risk-chip pm-outline-row__risk-chip--${findingSeverityLabel(coherenceFinding.kind).toLowerCase()}`}
          title={`${coherenceFinding.title}: ${coherenceFinding.narrative}`}
        >
          {findingSeverityLabel(coherenceFinding.kind)}
        </span>
      )}

      {/* Delivery status badge + menu (outline status badging).
          Replaces the Story 3.5 acceptance-criteria pill in this row slot;
          AC progress stays available in the inspector's Acceptance tab. */}
      <div className="pm-outline-row__status-container" ref={statusContainerRef}>
        <button
          type="button"
          className={`pm-outline-row__status-badge pm-outline-row__status-badge--${deliveryStatusModifier(row.deliveryStatus)}`}
          onClick={(e) => {
            e.stopPropagation();
            setIsStatusMenuOpen((prev) => !prev);
          }}
          aria-haspopup="menu"
          aria-expanded={isStatusMenuOpen}
          title="Delivery status (click to change)"
        >
          {deliveryStatusLabel(row.deliveryStatus)}
          <span className="pm-outline-row__status-chevron" aria-hidden="true">▾</span>
        </button>

        {isStatusMenuOpen && (
          <div className="pm-outline-row__status-menu" role="menu" onClick={(e) => e.stopPropagation()}>
            <div className="pm-outline-row__status-menu-head">Set status</div>
            {DELIVERY_STATUS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="menuitemradio"
                aria-checked={row.deliveryStatus === opt.value}
                className={`pm-outline-row__status-option pm-outline-row__status-option--${deliveryStatusModifier(opt.value)} ${
                  row.deliveryStatus === opt.value ? 'pm-outline-row__status-option--selected' : ''
                }`}
                onClick={() => handleSelectStatus(opt.value)}
              >
                <span className="pm-outline-row__status-dot" aria-hidden="true" />
                {opt.label}
                {row.deliveryStatus === opt.value && (
                  <span className="pm-outline-row__status-check" aria-hidden="true">✓</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Effort & Weight Pills (Story 3.6) */}
      {row.effortPoints !== null && (
        <button
          type="button"
          className="pm-outline-row__pill pm-outline-row__pill--effort"
          onClick={(e) => {
            e.stopPropagation();
            onOpenEffortModal?.(row.nodeId);
          }}
          title="Effort Points (Click to edit)"
        >
          ⚡ {row.effortPoints} pt
        </button>
      )}

      {row.effortPoints === null && row.nodeType === 'Feature' && (
        <button
          type="button"
          className="pm-outline-row__pill pm-outline-row__pill--effort-empty"
          onClick={(e) => {
            e.stopPropagation();
            onOpenEffortModal?.(row.nodeId);
          }}
          title="Set Effort Points (Click to edit)"
          aria-label={`Set effort points for ${row.title || 'Untitled'}`}
        >
          ⚡ + pt
        </button>
      )}

      {row.strategicWeight !== null && (
        <button
          type="button"
          className="pm-outline-row__pill pm-outline-row__pill--weight"
          onClick={(e) => {
            e.stopPropagation();
            onOpenEffortModal?.(row.nodeId);
          }}
          title="Strategic Weight (Click to edit)"
        >
          ⚖ {row.strategicWeight}
        </button>
      )}

      {/* Phase Badge (Story 3.7) */}
      {row.effectivePhaseName && (
        <button
          type="button"
          className={`pm-outline-row__pill pm-outline-row__pill--phase ${row.effectivePhaseSource === 'inherited' ? 'pm-outline-row__pill--inherited' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpenPhaseSelector?.(row.nodeId);
          }}
          title={`Phase: ${row.effectivePhaseName} (${row.effectivePhaseSource})`}
        >
          🏷 {row.effectivePhaseName}
        </button>
      )}

      {/* Schedule Pill (Story 3.4) */}
      {scheduleText && (
        <button
          type="button"
          className="pm-outline-row__pill pm-outline-row__pill--date"
          onClick={(e) => {
            e.stopPropagation();
            onOpenScheduleEditor?.(row.nodeId);
          }}
          title="Schedule span (Click to edit)"
        >
          📅 {scheduleText}
        </button>
      )}

      {/* Derived ancestor span pill (UAT #8) — rolled up from dated descendants,
          only when this node has no authored dates. Distinct style so authored
          vs. computed is visually distinguishable. */}
      {!scheduleText && derivedScheduleText && (
        <span
          className="pm-outline-row__pill pm-outline-row__pill--derived-date"
          title={`Derived span: earliest start / latest end across dated descendants`}
        >
          📅 {derivedScheduleText} (derived)
        </span>
      )}

      {/* Unlock Indicator (Story 3.8, 3.9) */}
      {(row.unlocksCount > 0 || row.unlockedByCount > 0) && (
        <button
          type="button"
          className="pm-outline-row__pill pm-outline-row__pill--unlock"
          onClick={(e) => {
            e.stopPropagation();
            if (onOpenInspector) {
              onOpenInspector(row.nodeId, 'unlocks');
            } else {
              onOpenEdgeInspector?.(row.nodeId);
            }
          }}
          title={`Unlocks: ${row.unlocksCount}, Unlocked by: ${row.unlockedByCount} (⌘U / click to edit)`}
        >
          🔓 {row.unlocksCount > 0 ? `→${row.unlocksCount}` : ''}{' '}
          {row.unlockedByCount > 0 ? `←${row.unlockedByCount}` : ''}
        </button>
      )}

      {/* Brief pill (Story 16.2, E16-FR4) — visible when bodyText is non-empty */}
      {bodyText !== null && bodyText.trim().length > 0 && (
        <button
          type="button"
          className="pm-outline-row__pill pm-outline-row__pill--brief"
          onClick={(e) => {
            e.stopPropagation();
            if (onOpenInspector) {
              onOpenInspector(row.nodeId, 'brief');
            } else if (onToggleBodyEdit) {
              onToggleBodyEdit(row.nodeId);
            }
          }}
          title="Brief (click to edit or Ctrl+E)"
        >
          📝 Brief
        </button>
      )}

      {/* Open questions pill (Story 16.3, E16-FR4) — amber when any question is OPEN */}
      {row.openQuestions.some((q) => q.status === 'OPEN') && (
        <button
          type="button"
          className="pm-outline-row__pill pm-outline-row__pill--questions-open"
          onClick={(e) => {
            e.stopPropagation();
            if (onOpenInspector) {
              onOpenInspector(row.nodeId, 'questions');
            }
          }}
          title="Open questions pending resolution (click to view/resolve)"
        >
          ❓ {row.openQuestions.filter((q) => q.status === 'OPEN').length} Open
        </button>
      )}

      {/* 6. Count (reserved) */}
      <span className="pm-outline-row__count" aria-hidden="true" />

      {/* 7. Metadata Lane */}
      <span className="pm-outline-row__metadata-lane">
        <button
          type="button"
          className="pm-outline-row__meta-btn pm-outline-row__meta-btn--brief"
          onClick={(e) => {
            e.stopPropagation();
            if (onOpenInspector) {
              onOpenInspector(row.nodeId, 'brief');
            } else if (onToggleBodyEdit) {
              onToggleBodyEdit(row.nodeId);
            }
          }}
          title="Brief & Inspector (Ctrl+E / Cmd+E or Shift+Enter)"
          aria-label={`Open brief for ${row.title || 'this item'}`}
        >
          📝
        </button>
        <button
          type="button"
          className="pm-outline-row__meta-btn"
          onClick={(e) => {
            e.stopPropagation();
            onOpenScheduleEditor?.(row.nodeId);
          }}
          title="Add/edit schedule"
        >
          📅
        </button>
        <button
          type="button"
          className="pm-outline-row__meta-btn"
          onClick={(e) => {
            e.stopPropagation();
            if (onOpenInspector) {
              onOpenInspector(row.nodeId, 'unlocks');
            } else {
              onOpenEdgeInspector?.(row.nodeId);
            }
          }}
          title="Unlock relationships (⌘U)"
        >
          🔓
        </button>
      </span>

      </div>

      {/* Inline Body Text Session (Story 2.3 AC3, Story 16.2) */}
      {isEditingBody ? (
        <div className="pm-outline-row__body-container">
          {bodyText === null && (
            <div className="pm-outline-row__template-row">
              {NODE_BRIEF_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="pm-outline-row__template-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onBodyChange?.(row.nodeId, t.markdown);
                  }}
                  title={t.description}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
          <MarkdownEditor
            value={bodyText ?? ''}
            placeholder="Write prose here…"
            ariaLabel={`Body text for ${row.title || 'this item'}`}
            onChange={(v) => onBodyChange?.(row.nodeId, v)}
            onCommit={(v) => onBodyCommit?.(row.nodeId, v)}
            onCancel={() => onCloseBody?.(row.nodeId)}
          />
        </div>
      ) : (
        bodyText !== null &&
        bodyText.trim().length > 0 && (
          <div className="pm-outline-row__body-container">
            <MarkdownViewer source={bodyText} />
          </div>
        )
      )}

      {/* Advisory finding banner on focus (Story 4.2 AC2) */}
      {isFocused && coherenceFinding && !isEditingBody && (
        <div className="pm-outline-row__advisory-banner">
          <span className="pm-outline-row__advisory-text">
            ⚠️ <strong>{coherenceFinding.title}:</strong> {coherenceFinding.narrative}
          </span>
          {onDismissFinding && (
            <button
              type="button"
              className="pm-outline-row__advisory-dismiss"
              onClick={(e) => {
                e.stopPropagation();
                onDismissFinding(coherenceFinding);
              }}
            >
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  );
});
