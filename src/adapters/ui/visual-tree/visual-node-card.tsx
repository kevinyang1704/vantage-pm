import { useRef, useState, useEffect } from 'react';
import { formatNodeTypeTag, NODE_TYPE_OPTIONS, matchNodeTypeFuzzy } from '../../../domain/tree/node-type.policy';
import type { NodeType } from '../../../domain/tree/node.entity';
import type { VisualNodeCardModel } from './visual-node-card.types';
import { AcceptanceIndicator } from './ac-indicator';
import { AcceptancePanel } from './ac-panel';
import './visual-node-card.css';

export interface VisualNodeCardProps {
  model: VisualNodeCardModel;
  geometry: { x: number; y: number; width: number; height: number };
  ariaLevel: number;
  ariaPosinset: number;
  ariaSetsize: number;
  /** Begin editing (title). Sets interactionState to 'editing' in the caller. */
  onStartEditing?: (nodeId: string) => void;
  /** Commit a title edit through the shared SetNodeTitle handler. */
  onCommitTitle?: (nodeId: string, title: string) => void;
  /** Discard an in-progress title edit without dispatching (Esc). */
  onCancelEditing?: (nodeId: string) => void;
  /** Focus a node by model id (data-node-id + .focus), never by index. */
  onFocusRequest?: (nodeId: string) => void;
  /** Key down on the card container when not in text input editing mode. */
  onKeyDown?: (e: React.KeyboardEvent, nodeId: string) => void;
  /** Toggle an acceptance criterion checkbox. */
  onToggleCriterion?: (criterionId: string, completed: boolean) => void;
  /** Change this node's type through the shared SetNodeType handler. */
  onSetNodeType?: (nodeId: string, nodeType: NodeType | null) => void;
  /** Open the shared natural-language schedule editor for this node. */
  onOpenScheduleEditor?: (nodeId: string) => void;
  /** Open the side inspector drawer for this node (parity with Outline). */
  onOpenDetails?: (nodeId: string) => void;
  /** True while this card's body text is open for editing (Shift+Enter). */
  isEditingBody?: boolean;
  /** Current body-text draft, supplied by the caller. */
  bodyText?: string | null;
  /** Draft change while editing body text (not yet committed). */
  onBodyChange?: (nodeId: string, bodyText: string) => void;
  /** Commit and close the body-text editor. */
  onCloseBody?: (nodeId: string) => void;
}

/**
 * Accessible visual node card (Story 6.2, Story 6.3, Story 6.6, Story 6.7).
 *
 * Renders title, node type tag, schedule, orphan styling,
 * rest-state acceptance criteria pips/ratio, and expanded
 * checklist panel when selected.
 */
export function VisualNodeCard({
  model,
  geometry,
  ariaLevel,
  ariaPosinset,
  ariaSetsize,
  onStartEditing,
  onCommitTitle,
  onCancelEditing,
  onFocusRequest,
  onKeyDown,
  onToggleCriterion,
  onSetNodeType,
  onOpenScheduleEditor,
  onOpenDetails,
  isEditingBody = false,
  bodyText = null,
  onBodyChange,
  onCloseBody,
}: VisualNodeCardProps): React.ReactElement {
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isTypeDropdownOpen, setIsTypeDropdownOpen] = useState(false);
  const [typeSearch, setTypeSearch] = useState('');

  const editing = model.interactionState === 'editing';

  useEffect(() => {
    if (isEditingBody && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isEditingBody]);

  const filteredTypes = typeSearch
    ? NODE_TYPE_OPTIONS.filter((t) => matchNodeTypeFuzzy(typeSearch, t))
    : NODE_TYPE_OPTIONS;

  const selectType = (type: NodeType | null) => {
    onSetNodeType?.(model.nodeId, type);
    setIsTypeDropdownOpen(false);
    setTypeSearch('');
  };

  const scheduleText = model.startDate
    ? model.endDate && model.endDate !== model.startDate
      ? `${model.startDate} → ${model.endDate}`
      : model.startDate
    : null;

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  useEffect(() => {
    if (editing) setDraft(model.title);
  }, [editing, model.title]);

  const commit = () => {
    if (draft !== null && draft !== model.title) {
      onCommitTitle?.(model.nodeId, draft);
    }
    onCancelEditing?.(model.nodeId);
  };

  const stateClass = model.isTrunk
    ? 'pm-visual-card--trunk'
    : model.interactionState === 'selected'
      ? 'pm-visual-card--selected'
      : editing
        ? 'pm-visual-card--editing'
        : model.isOrphan
          ? 'pm-visual-card--orphan'
          : 'pm-visual-card--rest';

  const selected = model.interactionState === 'selected';
  const hasAcceptanceCriteria = (model.acceptanceCriteria?.length ?? 0) > 0;
  const showAcceptance = model.nodeType === 'Feature' || hasAcceptanceCriteria;

  return (
    <div
      role="treeitem"
      aria-level={ariaLevel}
      aria-posinset={ariaPosinset}
      aria-setsize={ariaSetsize}
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-node-id={model.nodeId}
      className={`pm-visual-card ${stateClass}`}
      style={{
        transform: `translate(${geometry.x}px, ${geometry.y}px)`,
        width: geometry.width,
        height: (selected && showAcceptance) || isEditingBody ? 'auto' : geometry.height,
        minHeight: geometry.height,
      }}
      onClick={() => onFocusRequest?.(model.nodeId)}
      onKeyDown={(e) => {
        if (editing) {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setDraft(model.title);
            onCancelEditing?.(model.nodeId);
          }
        } else {
          onKeyDown?.(e, model.nodeId);
        }
      }}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="pm-visual-card-title-input"
          value={draft ?? ''}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setDraft(model.title);
              onCancelEditing?.(model.nodeId);
            }
          }}
          aria-label="Item title"
        />
      ) : (
        <div className="pm-visual-card-title" onDoubleClick={() => onStartEditing?.(model.nodeId)}>
          {model.title || '\u00A0'}
        </div>
      )}

      {selected && !editing && !model.isTrunk && onOpenDetails && (
        <button
          type="button"
          className="pm-visual-card-details-btn"
          aria-label={`Open details for ${model.title || 'this item'}`}
          title="Open details"
          onClick={(e) => {
            e.stopPropagation();
            onOpenDetails(model.nodeId);
          }}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 2H2v4M10 14h4v-4M14 2l-5 5M2 14l5-5" />
          </svg>
        </button>
      )}

      {showAcceptance && !selected && !model.isTrunk && (
        <AcceptanceIndicator criteria={model.acceptanceCriteria ?? []} />
      )}

      {showAcceptance && selected && !model.isTrunk && (
        <AcceptancePanel
          criteria={model.acceptanceCriteria ?? []}
          onToggleCriterion={onToggleCriterion}
        />
      )}

      <div className="pm-visual-card-meta">
        <div className="pm-visual-card-type-container" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="pm-visual-card-tag"
            onClick={() => setIsTypeDropdownOpen((prev) => !prev)}
            title="Click to change type"
          >
            {formatNodeTypeTag(model.nodeType)}
          </button>
          {isTypeDropdownOpen && (
            <div className="pm-visual-card-type-dropdown">
              <input
                type="text"
                placeholder="Search type..."
                value={typeSearch}
                onChange={(e) => setTypeSearch(e.target.value)}
                className="pm-visual-card-type-search"
                autoFocus
              />
              <div className="pm-visual-card-type-options">
                <button type="button" className="pm-visual-card-type-option" onClick={() => selectType(null)}>
                  (No Type)
                </button>
                {filteredTypes.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`pm-visual-card-type-option ${model.nodeType === t ? 'pm-visual-card-type-option--selected' : ''}`}
                    onClick={() => selectType(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        {onOpenScheduleEditor && !model.isTrunk && (
          <button
            type="button"
            className="pm-visual-card-schedule-btn"
            onClick={(e) => {
              e.stopPropagation();
              onOpenScheduleEditor(model.nodeId);
            }}
            title="Add/edit schedule"
          >
            📅{scheduleText ? ` ${scheduleText}` : ''}
          </button>
        )}
        {model.isOrphan && (
          <span
            className="pm-visual-card-badge pm-visual-card-badge--orphan"
            title="Not contained by any theme — this work has no strategic parent."
          >
            Risk
          </span>
        )}
        {editing && (
          <span className="pm-visual-card-badge pm-visual-card-badge--editing">EDITING</span>
        )}
        {model.interactionState === 'selected' && (
          <span className="pm-visual-card-badge pm-visual-card-badge--selected">SELECTED</span>
        )}
      </div>

      {isEditingBody && (
        <div className="pm-visual-card-body-container" onClick={(e) => e.stopPropagation()}>
          <textarea
            ref={textareaRef}
            className="pm-visual-card-body-textarea"
            value={bodyText ?? ''}
            placeholder="Write prose here..."
            onChange={(e) => onBodyChange?.(model.nodeId, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onCloseBody?.(model.nodeId);
              }
            }}
            aria-label={`Body text for ${model.title || 'this item'}`}
          />
        </div>
      )}
    </div>
  );
}