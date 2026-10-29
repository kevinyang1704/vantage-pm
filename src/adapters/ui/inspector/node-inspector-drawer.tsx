/**
 * Side Inspector Drawer (Story 16.3, E16-FR5, E16-UX1, E16-UX2, E16-AR4).
 *
 * A 4-tab right-rail panel (Brief, Questions & Decisions, Acceptance Criteria,
 * Unlocks) for the focused node. Docks as a 360px panel on desktop viewports
 * (>=1280px) and slides over as an overlay on narrow viewports with Esc
 * backdrop dismissal.
 *
 * View-state purity (E16-AR4): open/close and active-tab state travel strictly
 * in the React view-state lane — never SQLite, never ChangeSets, never
 * portable backups.
 */

import React, { useEffect, useRef } from 'react';
import type { OutlineNodeReadModel } from '../../../application/outline/outline-read-model';
import type { UnlockEdge } from '../../../domain/edge/unlock-edge.entity';
import type { NodeOpenQuestion } from '../../../domain/tree/node-question.entity';
import { MarkdownViewer } from '../markdown/markdown-viewer';
import { MarkdownEditor } from '../markdown/markdown-editor';
import { NODE_BRIEF_TEMPLATES } from '../../../domain/templates/node-brief-templates';
import { deliveryStatusLabel, deliveryStatusModifier } from '../vocabulary';
import { formatNodeTypeLabel } from '../../../domain/tree/node-type.policy';
import {
  clampInspectorWidth,
  INSPECTOR_DEFAULT_WIDTH,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  INSPECTOR_WIDTH_STEP,
} from './inspector-width';
import './node-inspector-drawer.css';

export type InspectorTab = 'brief' | 'questions' | 'acceptance' | 'unlocks';

export interface InspectorQuestionDraft {
  readonly questionText: string;
  readonly decisionText: string;
}

export interface NodeInspectorDrawerProps {
  readonly isOpen: boolean;
  readonly activeTab: InspectorTab;
  readonly node: OutlineNodeReadModel | null;
  readonly nodes: readonly OutlineNodeReadModel[];
  readonly unlockEdges: readonly UnlockEdge[];
  readonly onClose: () => void;
  readonly onTabChange: (tab: InspectorTab) => void;
  readonly onSetNodeBodyText: (nodeId: string, bodyText: string | null) => void;
  readonly onAddQuestion: (nodeId: string, questionText: string) => void;
  readonly onResolveQuestion: (questionId: string, decisionText: string) => void;
  readonly onDeleteQuestion: (questionId: string) => void;
  readonly onToggleNodeCompleted: (nodeId: string, completed: boolean) => void;
  readonly onFocusNode: (nodeId: string) => void;
  readonly onCreateCriterion?: (parentId: string, title: string) => void;
  readonly onDeleteCriterion?: (criterionId: string) => void;
  readonly onCreateUnlockEdge?: (sourceNodeId: string, targetNodeId: string) => void;
  readonly onDeleteUnlockEdge?: (edgeId: string, sourceNodeId: string, targetNodeId: string) => void;
  /** Story 16.4 (E16-FR6): export the focused Feature as a standalone 1-Pager. */
  readonly onExportFeatureOnePager?: (nodeId: string) => void;
  /** Set effort points for a node directly from the inspector. */
  readonly onSetNodeEffort?: (params: { nodeId: string; effortPoints: number | null }) => void;
  /** Current docked width in px (drag-resizable, E16-UX1). Defaults to 360. */
  readonly width?: number;
  /** Commit a new docked width (clamped by the drawer). */
  readonly onWidthChange?: (width: number) => void;
  /**
   * Story 27.8 (AC 27.8-1): "<Name> changed this · <relative time>" for an
   * item in a shared project; absent for local projects.
   */
  readonly changedBy?: string | null;
}

/** Short visible tab labels; each tab's accessible name keeps the full title. */
const TAB_LABELS: Readonly<Record<InspectorTab, string>> = Object.freeze({
  brief: 'Brief',
  questions: 'Questions',
  acceptance: 'Criteria',
  unlocks: 'Unlocks',
});

const TAB_NAMES: Readonly<Record<InspectorTab, string>> = Object.freeze({
  brief: 'Brief',
  questions: 'Questions & Decisions',
  acceptance: 'Acceptance Criteria',
  unlocks: 'Unlocks',
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "Nov 2 – Nov 6, 2026" from ISO plain dates (string parsing only, no Date objects). */
export function formatInspectorDateRange(start: string | null, end: string | null): string | null {
  const parse = (iso: string | null): { readonly year: string; readonly label: string } | null => {
    const m = iso ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
    return m ? { year: m[1], label: `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` } : null;
  };
  const from = parse(start);
  const to = parse(end);
  if (from && to) {
    return from.year === to.year
      ? `${from.label} – ${to.label}, ${to.year}`
      : `${from.label}, ${from.year} – ${to.label}, ${to.year}`;
  }
  if (from) return `From ${from.label}, ${from.year}`;
  if (to) return `Until ${to.label}, ${to.year}`;
  return null;
}

type InspectorIconName = 'close' | 'download' | 'edit' | 'preview';

const ICON_PATHS: Readonly<Record<InspectorIconName, string>> = Object.freeze({
  close: 'M4 4l8 8M12 4l-8 8',
  download: 'M8 2.5v7.5M5 7l3 3 3-3M3 12.5h10',
  edit: 'M10.5 2.8l2.7 2.7L6 12.7 3 13l.3-3z',
  preview: 'M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8 11.9 12.2 8 12.2 1.8 8 1.8 8zM8 9.8a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z',
});

/** Monochrome line icon (currentColor), used in place of emoji glyphs. */
function InspectorIcon({ name }: { readonly name: InspectorIconName }): React.ReactElement {
  return (
    <svg
      className="pm-inspector__icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

export function NodeInspectorDrawer({
  isOpen,
  activeTab,
  node,
  nodes,
  unlockEdges,
  onClose,
  onTabChange,
  onSetNodeBodyText,
  onAddQuestion,
  onResolveQuestion,
  onDeleteQuestion,
  onToggleNodeCompleted,
  onFocusNode,
  onCreateCriterion,
  onDeleteCriterion,
  onCreateUnlockEdge,
  onDeleteUnlockEdge,
  onExportFeatureOnePager,
  onSetNodeEffort,
  width = INSPECTOR_DEFAULT_WIDTH,
  onWidthChange,
  changedBy,
}: NodeInspectorDrawerProps): React.ReactElement | null {
  const [draftQuestion, setDraftQuestion] = React.useState('');
  const [draftCriterion, setDraftCriterion] = React.useState('');
  const [unlockDirection, setUnlockDirection] = React.useState<'unlocks' | 'unlockedBy'>('unlocks');
  const [selectedUnlockTargetId, setSelectedUnlockTargetId] = React.useState<string>('');
  const [decisionDrafts, setDecisionDrafts] = React.useState<Readonly<Record<string, string>>>({});
  const [isPreview, setIsPreview] = React.useState(false);
  const [draftBody, setDraftBody] = React.useState<string>(node?.bodyText ?? '');
  const [showUnsavedPrompt, setShowUnsavedPrompt] = React.useState(false);
  const currentNodeIdRef = useRef<string | null>(null);
  const previousBodyRef = useRef('');
  const panelRef = useRef<HTMLDivElement>(null);

  // Drag-to-resize (E16-UX1). Width lives in the caller's view-state lane;
  // the drag tracks a local value and commits on each move for a live feel.
  const [isResizing, setIsResizing] = React.useState(false);
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null);

  const commitWidth = (px: number): void => {
    onWidthChange?.(clampInspectorWidth(px));
  };

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!onWidthChange) return;
    resizeStartRef.current = { x: e.clientX, width };
    setIsResizing(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const handleResizePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const start = resizeStartRef.current;
    if (!start) return;
    // Handle sits on the panel's left edge: dragging left widens the panel.
    commitWidth(start.width + (start.x - e.clientX));
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
    if (!onWidthChange) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      commitWidth(width + INSPECTOR_WIDTH_STEP);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      commitWidth(width - INSPECTOR_WIDTH_STEP);
    } else if (e.key === 'Home') {
      e.preventDefault();
      commitWidth(INSPECTOR_DEFAULT_WIDTH);
    }
  };

  // Sync draft when node changes
  useEffect(() => {
    if (!node) {
      currentNodeIdRef.current = null;
      previousBodyRef.current = '';
      setDraftBody('');
      setShowUnsavedPrompt(false);
      return;
    }
    if (currentNodeIdRef.current !== node.id) {
      currentNodeIdRef.current = node.id;
      setDraftBody(node.bodyText ?? '');
      setShowUnsavedPrompt(false);
    } else {
      const previousBody = previousBodyRef.current;
      setDraftBody((draft) => draft === previousBody ? (node.bodyText ?? '') : draft);
    }
    previousBodyRef.current = node.bodyText ?? '';
  }, [node, isOpen]);

  const isDirty = node ? draftBody !== (node.bodyText ?? '') : false;

  const handleSaveDraft = (): void => {
    if (!node) return;
    const trimmed = draftBody.trim();
    const bodyText = trimmed.length === 0 ? null : draftBody;
    // The central handler compares persisted and pending values. Calling it
    // again permits retry after rejection and reverting an in-flight save.
    onSetNodeBodyText(node.id, bodyText);
    setShowUnsavedPrompt(false);
  };

  const handleDiscardDraft = (): void => {
    setDraftBody(node?.bodyText ?? '');
    setShowUnsavedPrompt(false);
  };

  const handleRequestClose = (): void => {
    if (isDirty) {
      setShowUnsavedPrompt(true);
    } else {
      onClose();
    }
  };

  const handleSelectTab = (tab: InspectorTab): void => {
    if (isDirty && activeTab === 'brief' && tab !== 'brief') {
      setShowUnsavedPrompt(true);
      return;
    }
    onTabChange(tab);
  };

  // Esc closes the drawer (or prompts if dirty), ⌘S/Ctrl+S saves draft.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (showUnsavedPrompt) {
          setShowUnsavedPrompt(false);
        } else if (isDirty) {
          setShowUnsavedPrompt(true);
        } else {
          onClose();
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        if (activeTab === 'brief' && isDirty) {
          e.preventDefault();
          handleSaveDraft();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose, isDirty, showUnsavedPrompt, activeTab, draftBody, node]);

  // Move focus into the active tab's primary control on open (E16-UX2).
  useEffect(() => {
    if (isOpen && panelRef.current) {
      const primary = panelRef.current.querySelector<HTMLElement>('[data-inspector-primary]');
      primary?.focus({ preventScroll: true });
    }
  }, [isOpen, activeTab]);

  if (!isOpen) return null;

  const directChildren = node
    ? nodes
        .filter((n) => n.parentId === node.id)
        .slice()
        .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))
    : [];

  const inboundEdges = node ? unlockEdges.filter((e) => e.targetNodeId === node.id) : [];
  const outboundEdges = node ? unlockEdges.filter((e) => e.sourceNodeId === node.id) : [];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const openCount = node?.openQuestions.filter((q) => q.status === 'OPEN').length ?? 0;
  const acTotal = directChildren.filter((c) => c.nodeType === 'AcceptanceCriterion').length;
  const acMet = directChildren.filter((c) => c.nodeType === 'AcceptanceCriterion' && c.completed).length;
  const dateRange = node
    ? formatInspectorDateRange(node.startDate ?? node.derivedStartDate, node.endDate ?? node.derivedEndDate)
    : null;

  const handleAddQuestion = (): void => {
    if (!node || draftQuestion.trim().length === 0) return;
    onAddQuestion(node.id, draftQuestion.trim());
    setDraftQuestion('');
  };

  const handleAddCriterion = (): void => {
    if (!node || draftCriterion.trim().length === 0) return;
    onCreateCriterion?.(node.id, draftCriterion.trim());
    setDraftCriterion('');
  };

  const handleAddUnlockEdge = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!node || !selectedUnlockTargetId) return;
    if (unlockDirection === 'unlocks') {
      onCreateUnlockEdge?.(node.id, selectedUnlockTargetId);
    } else {
      onCreateUnlockEdge?.(selectedUnlockTargetId, node.id);
    }
    setSelectedUnlockTargetId('');
  };

  const handleResolveAll = (): void => {
    if (!node) return;
    for (const q of node.openQuestions) {
      if (q.status === 'OPEN') {
        const decision = decisionDrafts[q.id]?.trim() ?? '';
        if (decision.length > 0) {
          onResolveQuestion(q.id, decision);
        }
      }
    }
  };

  return (
    <div
      ref={panelRef}
      className={`pm-inspector${isResizing ? ' pm-inspector--resizing' : ''}`}
      style={onWidthChange ? { width, minWidth: width } : undefined}
      role="region"
      aria-label="Node inspector"
      data-testid="node-inspector"
    >
      {onWidthChange && (
        <div
          className="pm-inspector__resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize inspector"
          aria-valuemin={INSPECTOR_MIN_WIDTH}
          aria-valuemax={INSPECTOR_MAX_WIDTH}
          aria-valuenow={Math.round(width)}
          tabIndex={0}
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerUp}
          onDoubleClick={() => commitWidth(INSPECTOR_DEFAULT_WIDTH)}
          onKeyDown={handleResizeKeyDown}
        />
      )}

      <div className="pm-inspector__header">
        <div className="pm-inspector__heading">
          <span className="pm-inspector__title" title={node?.title ?? 'No item selected'}>
            {node?.title || 'No item selected'}
          </span>
          {node && changedBy ? (
            <span className="pm-inspector__changed-by" data-testid="inspector-changed-by">{changedBy}</span>
          ) : null}
        </div>
        <button
          type="button"
          className="pm-inspector__close"
          aria-label="Close inspector"
          title="Close"
          onClick={handleRequestClose}
        >
          <InspectorIcon name="close" />
        </button>
      </div>

      {node && (
        <dl className="pm-inspector__props">
          <dt>Type</dt>
          <dd>{node.nodeType ? formatNodeTypeLabel(node.nodeType) : (node.typeTag ?? 'No type')}</dd>
          {node.nodeType === 'Feature' && onSetNodeEffort && (
            <>
              <dt id="inspector-effort-label">Effort</dt>
              <dd className="pm-inspector__effort-control">
                <input
                  type="number"
                  min={0}
                  step={1}
                  className="pm-inspector__effort-input"
                  aria-labelledby="inspector-effort-label"
                  placeholder="—"
                  value={node.effortPoints ?? ''}
                  onChange={(e) => {
                    const val = e.target.value.trim();
                    onSetNodeEffort({
                      nodeId: node.id,
                      effortPoints: val === '' ? null : Math.max(0, parseInt(val, 10)),
                    });
                  }}
                />
                <span className="pm-inspector__effort-unit">{node.effortPoints === 1 ? 'point' : 'points'}</span>
              </dd>
            </>
          )}
          {node.effectivePhaseName && (
            <>
              <dt>Phase</dt>
              <dd title={`Phase: ${node.effectivePhaseName} (${node.effectivePhaseSource})`}>
                {node.effectivePhaseName}
                {node.effectivePhaseSource === 'inherited' && <span className="pm-inspector__prop-note"> · inherited</span>}
              </dd>
            </>
          )}
          {dateRange && (
            <>
              <dt>Dates</dt>
              <dd>{dateRange}</dd>
            </>
          )}
          <dt>Status</dt>
          <dd>
            <span
              className={`pm-inspector__status-dot pm-inspector__status-dot--${deliveryStatusModifier(node.deliveryStatus)}`}
              aria-hidden="true"
            />
            {deliveryStatusLabel(node.deliveryStatus)}
          </dd>
          {node.nodeType === 'Feature' && (
            <>
              <dt>Criteria</dt>
              <dd className={acTotal > 0 && acMet === acTotal ? 'pm-inspector__prop--met' : undefined}>
                {acTotal === 0 ? 'None yet' : `${acMet} of ${acTotal} met`}
              </dd>
            </>
          )}
          {(inboundEdges.length > 0 || outboundEdges.length > 0) && (
            <>
              <dt>Dependencies</dt>
              <dd>
                {[
                  outboundEdges.length > 0 ? `Unlocks ${outboundEdges.length}` : null,
                  inboundEdges.length > 0 ? `Waits on ${inboundEdges.length}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </dd>
            </>
          )}
        </dl>
      )}

      <div className="pm-inspector__tabs" role="tablist" aria-label="Inspector tabs">
        {(Object.keys(TAB_LABELS) as InspectorTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            aria-label={TAB_NAMES[tab]}
            title={TAB_NAMES[tab]}
            className={`pm-inspector__tab ${activeTab === tab ? 'pm-inspector__tab--active' : ''}`}
            onClick={() => handleSelectTab(tab)}
          >
            {TAB_LABELS[tab]}
          </button>
        ))}
      </div>

      <div className="pm-inspector__body" role="tabpanel">
        {!node ? (
          <p className="pm-inspector__empty">Select an item to inspect it.</p>
        ) : activeTab === 'brief' ? (
          <div className="pm-inspector__brief">
            {showUnsavedPrompt && (
              <div className="pm-inspector__unsaved-banner" role="alert">
                <p className="pm-inspector__unsaved-text">You have unsaved changes in this brief.</p>
                <div className="pm-inspector__unsaved-actions">
                  <button
                    type="button"
                    className="pm-inspector__toolbar-btn pm-inspector__toolbar-btn--primary"
                    onClick={() => {
                      handleSaveDraft();
                      onClose();
                    }}
                  >
                    Save & Close
                  </button>
                  <button
                    type="button"
                    className="pm-inspector__toolbar-btn pm-inspector__toolbar-btn--danger"
                    onClick={() => {
                      handleDiscardDraft();
                      onClose();
                    }}
                  >
                    Discard Changes
                  </button>
                  <button
                    type="button"
                    className="pm-inspector__toolbar-btn"
                    onClick={() => setShowUnsavedPrompt(false)}
                  >
                    Keep Editing
                  </button>
                </div>
              </div>
            )}

            <div className="pm-inspector__brief-toolbar">
              <div className="pm-inspector__brief-toolbar-group">
                {isDirty && (
                  <>
                    <span className="pm-inspector__dirty-badge">Unsaved changes</span>
                    <button
                      type="button"
                      className="pm-inspector__toolbar-btn"
                      onClick={handleDiscardDraft}
                      title="Discard unsaved changes"
                    >
                      Discard
                    </button>
                    <button
                      type="button"
                      className="pm-inspector__toolbar-btn pm-inspector__toolbar-btn--primary"
                      onClick={handleSaveDraft}
                      title="Save changes (Ctrl+S / ⌘S)"
                    >
                      Save
                    </button>
                  </>
                )}
              </div>
              <div className="pm-inspector__brief-toolbar-group">
                {node.nodeType === 'Feature' && onExportFeatureOnePager && (
                  <button
                    type="button"
                    className="pm-inspector__icon-btn"
                    onClick={() => onExportFeatureOnePager(node.id)}
                    aria-label="Export .docx"
                    title="Export .docx"
                  >
                    <InspectorIcon name="download" />
                  </button>
                )}
                <button
                  type="button"
                  className="pm-inspector__icon-btn"
                  onClick={() => setIsPreview((prev) => !prev)}
                  aria-label={isPreview ? 'Edit' : 'Preview'}
                  title={isPreview ? 'Edit brief' : 'Preview brief'}
                >
                  <InspectorIcon name={isPreview ? 'edit' : 'preview'} />
                </button>
              </div>
            </div>

            {draftBody.trim().length === 0 && !isPreview && (
              <div className="pm-inspector__template-row">
                {NODE_BRIEF_TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="pm-inspector__template-btn"
                    title={t.description}
                    onClick={() => {
                      setDraftBody(t.markdown);
                      setIsPreview(false);
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}

            {isPreview ? (
              <MarkdownViewer source={draftBody.length === 0 ? null : draftBody} />
            ) : (
              <MarkdownEditor
                dataInspectorPrimary
                value={draftBody}
                ariaLabel="Node brief"
                onChange={setDraftBody}
                onCommit={handleSaveDraft}
                onCancel={handleDiscardDraft}
              />
            )}
          </div>
        ) : activeTab === 'questions' ? (
          <div className="pm-inspector__questions">
            <div className="pm-inspector__add-row">
              <input
                data-inspector-primary
                type="text"
                className="pm-inspector__question-input"
                placeholder="Add an open question…"
                value={draftQuestion}
                onChange={(e) => setDraftQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddQuestion();
                  }
                }}
                aria-label="New open question"
              />
              <button
                type="button"
                className="pm-inspector__toolbar-btn"
                onClick={handleAddQuestion}
                disabled={draftQuestion.trim().length === 0}
              >
                Add
              </button>
            </div>

            {openCount > 0 && (
              <button
                type="button"
                className="pm-inspector__resolve-all"
                onClick={handleResolveAll}
                disabled={node.openQuestions.filter((q) => q.status === 'OPEN' && (decisionDrafts[q.id]?.trim() ?? '').length > 0).length === 0}
              >
                Resolve All
              </button>
            )}

            <ul className="pm-inspector__question-list">
              {node.openQuestions.map((q) => (
                <QuestionCard
                  key={q.id}
                  question={q}
                  decisionDraft={decisionDrafts[q.id] ?? ''}
                  onDecisionDraftChange={(v) =>
                    setDecisionDrafts((prev) => ({ ...prev, [q.id]: v }))
                  }
                  onResolve={() => {
                    const decision = decisionDrafts[q.id]?.trim() ?? '';
                    if (decision.length > 0) onResolveQuestion(q.id, decision);
                  }}
                  onDelete={() => onDeleteQuestion(q.id)}
                />
              ))}
            </ul>
          </div>
        ) : activeTab === 'acceptance' ? (
          <div className="pm-inspector__ac">
            {onCreateCriterion && (
              <div className="pm-inspector__add-row">
                <input
                  data-inspector-primary
                  type="text"
                  className="pm-inspector__question-input"
                  placeholder="Add acceptance criterion…"
                  value={draftCriterion}
                  onChange={(e) => setDraftCriterion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddCriterion();
                    }
                  }}
                  aria-label="New acceptance criterion"
                />
                <button
                  type="button"
                  className="pm-inspector__toolbar-btn pm-inspector__toolbar-btn--primary"
                  onClick={handleAddCriterion}
                  disabled={draftCriterion.trim().length === 0}
                >
                  Add
                </button>
              </div>
            )}

            <p className="pm-inspector__ac-ratio">
              {acTotal === 0 ? 'No acceptance criteria yet.' : `${acMet} of ${acTotal} criteria met`}
            </p>

            <ul className="pm-inspector__ac-list">
              {directChildren
                .filter((c) => c.nodeType === 'AcceptanceCriterion')
                .map((c) => (
                  <li key={c.id} className="pm-inspector__ac-item">
                    <label className="pm-inspector__ac-label">
                      <input
                        type="checkbox"
                        checked={c.completed}
                        onChange={(e) => onToggleNodeCompleted(c.id, e.target.checked)}
                        aria-label={`Mark "${c.title || 'criterion'}" completed`}
                      />
                      <span>{c.title || 'Untitled criterion'}</span>
                    </label>
                    {onDeleteCriterion && (
                      <button
                        type="button"
                        className="pm-inspector__ac-delete"
                        onClick={() => onDeleteCriterion(c.id)}
                        aria-label={`Delete criterion "${c.title || 'criterion'}"`}
                        title="Delete criterion"
                      >
                        <InspectorIcon name="close" />
                      </button>
                    )}
                  </li>
                ))}
            </ul>
          </div>
        ) : (
          <div className="pm-inspector__unlocks">
            {onCreateUnlockEdge && (
              <form className="pm-inspector__unlock-form" onSubmit={handleAddUnlockEdge}>
                <div className="pm-inspector__unlock-row">
                  <select
                    className="pm-inspector__unlock-select"
                    value={unlockDirection}
                    onChange={(e) => setUnlockDirection(e.target.value as 'unlocks' | 'unlockedBy')}
                    aria-label="Unlock direction"
                  >
                    <option value="unlocks">This item unlocks →</option>
                    <option value="unlockedBy">This item is unlocked by ←</option>
                  </select>
                </div>
                <div className="pm-inspector__unlock-row">
                  <select
                    data-inspector-primary
                    className="pm-inspector__unlock-select"
                    value={selectedUnlockTargetId}
                    onChange={(e) => setSelectedUnlockTargetId(e.target.value)}
                    aria-label="Select target item for unlock relationship"
                  >
                    <option value="">Select an item…</option>
                    {nodes
                      .filter((n) => n.id !== node.id && n.nodeType !== 'AcceptanceCriterion')
                      .map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.title || 'Untitled'}{n.effectivePhaseName ? ` (${n.effectivePhaseName})` : ''}
                        </option>
                      ))}
                  </select>
                  <button
                    type="submit"
                    className="pm-inspector__toolbar-btn pm-inspector__toolbar-btn--primary"
                    disabled={!selectedUnlockTargetId}
                  >
                    Add Link
                  </button>
                </div>
              </form>
            )}

            <section className="pm-inspector__unlock-section">
              <h4 className="pm-inspector__unlock-heading">Waits on</h4>
              {inboundEdges.length === 0 ? (
                <p className="pm-inspector__empty">Nothing needs to finish first.</p>
              ) : (
                <ul className="pm-inspector__unlock-list">
                  {inboundEdges.map((e) => {
                    const source = nodeById.get(e.sourceNodeId);
                    return (
                      <li key={e.id} className="pm-inspector__unlock-item">
                        <button
                          type="button"
                          className="pm-inspector__unlock-link"
                          onClick={() => source && onFocusNode(source.id)}
                          title={`Focus ${source?.title || 'Untitled'}`}
                        >
                          ← {source?.title || 'Untitled'}
                        </button>
                        {onDeleteUnlockEdge && (
                          <button
                            type="button"
                            className="pm-inspector__unlock-delete"
                            onClick={() => onDeleteUnlockEdge(e.id, e.sourceNodeId, e.targetNodeId)}
                            aria-label={`Remove prerequisite ${source?.title || 'item'}`}
                            title="Remove dependency"
                          >
                            <InspectorIcon name="close" />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="pm-inspector__unlock-section">
              <h4 className="pm-inspector__unlock-heading">Unlocks</h4>
              {outboundEdges.length === 0 ? (
                <p className="pm-inspector__empty">Nothing depends on this yet.</p>
              ) : (
                <ul className="pm-inspector__unlock-list">
                  {outboundEdges.map((e) => {
                    const target = nodeById.get(e.targetNodeId);
                    return (
                      <li key={e.id} className="pm-inspector__unlock-item">
                        <button
                          type="button"
                          className="pm-inspector__unlock-link"
                          onClick={() => target && onFocusNode(target.id)}
                          title={`Focus ${target?.title || 'Untitled'}`}
                        >
                          → {target?.title || 'Untitled'}
                        </button>
                        {onDeleteUnlockEdge && (
                          <button
                            type="button"
                            className="pm-inspector__unlock-delete"
                            onClick={() => onDeleteUnlockEdge(e.id, e.sourceNodeId, e.targetNodeId)}
                            aria-label={`Remove unlock ${target?.title || 'item'}`}
                            title="Remove dependency"
                          >
                            <InspectorIcon name="close" />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function QuestionCard({
  question,
  decisionDraft,
  onDecisionDraftChange,
  onResolve,
  onDelete,
}: {
  readonly question: NodeOpenQuestion;
  readonly decisionDraft: string;
  readonly onDecisionDraftChange: (value: string) => void;
  readonly onResolve: () => void;
  readonly onDelete: () => void;
}): React.ReactElement {
  const isOpen = question.status === 'OPEN';
  return (
    <li className={`pm-inspector__question-card ${isOpen ? 'pm-inspector__question-card--open' : 'pm-inspector__question-card--decided'}`}>
      <div className="pm-inspector__question-row">
        <span className={`pm-inspector__question-status ${isOpen ? 'pm-inspector__question-status--open' : 'pm-inspector__question-status--decided'}`}>
          {isOpen ? 'Open' : 'Decided'}
        </span>
        <span className="pm-inspector__question-text">{question.questionText}</span>
        <button
          type="button"
          className="pm-inspector__question-delete"
          aria-label="Delete question"
          onClick={onDelete}
        >
          <InspectorIcon name="close" />
        </button>
      </div>
      {isOpen ? (
        <div className="pm-inspector__decision-row">
          <input
            type="text"
            className="pm-inspector__decision-input"
            placeholder="Decision note…"
            value={decisionDraft}
            onChange={(e) => onDecisionDraftChange(e.target.value)}
            aria-label={`Decision for ${question.questionText}`}
          />
          <button
            type="button"
            className="pm-inspector__toolbar-btn"
            onClick={onResolve}
            disabled={decisionDraft.trim().length === 0}
          >
            Resolve
          </button>
        </div>
      ) : (
        <p className="pm-inspector__decision-text">{question.decisionText}</p>
      )}
    </li>
  );
}
