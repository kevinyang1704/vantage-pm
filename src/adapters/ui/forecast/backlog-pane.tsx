/**
 * Backlog pane (2026-09-07 planning surface, Story 21.2).
 *
 * The left pane of the Forecast Workspace: every peer-level item that isn't
 * in the Priority list yet, searchable by title, with an inline points field
 * so an estimate can be set before the item enters the plan. `＋` / `Enter`
 * adds it to the end of the Priority list. An item already in the plan shows
 * dimmed with an `in plan` marker — the Backlog and Priority list share one
 * source of truth for scope. Replaces the modal Feature source picker.
 *
 * Points editing uses a local draft buffer and commits `SetNodeEffortCommand`
 * only on blur or Enter (AC 21.2-3) — never one command per keystroke.
 * Clearing the field commits `null` ('Estimate needed'); negative values are
 * rejected; `Esc` reverts uncommitted changes.
 *
 * The list implements roving tabindex (AC 21.2-8): one row is tabbable at a
 * time, `↑`/`↓` move focus between rows, and `Enter` on the focused row adds
 * it. Adding via `＋` / `Enter` keeps focus in the Backlog on the next
 * available unranked item and announces `Added <title> to Priority list`
 * through the workspace's polite live region (AC 21.2-5, UX-DR8).
 *
 * `/` from anywhere in the workspace (when not editing text) focuses the
 * search input (AC 21.2-2, UX-DR3).
 */

import { useEffect, useMemo, useRef, useState, useId, useCallback } from 'react';
import { useVirtualizer, defaultRangeExtractor } from '@tanstack/react-virtual';
import type { Range } from '@tanstack/react-virtual';
import { filterBacklogItems, backlogParentIds, visibleBacklogItems } from './forecast-placement';

export interface BacklogItem {
  readonly id: string;
  readonly title: string;
  readonly points: number | null;
  /** True when this item is already ranked in the Priority list. */
  readonly inPlan: boolean;
  /** Adding would overlap an already-selected ancestor/descendant (AC 18.6-4). */
  readonly overlap?: boolean;
  /**
   * Which side of the tree already covers this row's points, and therefore
   * why it cannot be added: an ancestor in the plan (`parent`) or a
   * descendant in it (`child`). Null when the row is addable.
   */
  readonly blockedBy?: 'parent' | 'child' | null;
  /** Nearest ancestor that is also a Backlog row, or null for a root. */
  readonly parentId?: string | null;
  /** Nesting depth among Backlog rows — 0 for a root (indentation only). */
  readonly depth?: number;
}

export interface BacklogPaneProps {
  readonly levelLabel: string;
  readonly items: readonly BacklogItem[];
  /** Resolves true when the add was applied (Story 21.11 AC 11). */
  readonly onAdd: (id: string) => void | Promise<boolean>;
  readonly onSetPoints: (id: string, points: number | null) => void;
  /** Polite-live-region announcements go to the workspace's status region. */
  readonly onAnnounce?: (message: string) => void;
  /** When in responsive drawer mode (UX-DR7), an explicit close affordance. */
  readonly onCloseDrawer?: () => void;
  /** The pane is open as a drawer on narrow viewports (UX-DR7). */
  readonly drawerOpen?: boolean;
  /** Ref to the drawer close button, for focus management (Story 21.11 AC 27). */
  readonly closeButtonRef?: React.Ref<HTMLButtonElement>;
  /** Width in pixels of the backlog panel in desktop layout (defaults to 280). */
  readonly width?: number;
  /**
   * An `in plan` row is being dragged: the Priority list treats it exactly
   * like one of its own rows, so a drop moves it to that rank.
   */
  readonly onDragPlannedStart?: (id: string) => void;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest('input, textarea, select, a, [contenteditable="true"]'))
  );
}

export function BacklogPane({
  levelLabel,
  items,
  width,
  onAdd,
  onSetPoints,
  onAnnounce,
  onCloseDrawer,
  drawerOpen = false,
  closeButtonRef,
  onDragPlannedStart,
}: BacklogPaneProps): React.ReactElement {
  const [query, setQuery] = useState('');
  const searchId = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const pointsInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const [activeIndex, setActiveIndex] = useState(0);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  /**
   * The Backlog list is virtualized too (Story 23.11 AC 23.11-2): at the
   * 5,000-item benchmark the pane alone would otherwise mount 5,000 rows and
   * dominate the DOM. Roving focus, drafts and the dragged row are pinned.
   */
  const listRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [listScrollMargin, setListScrollMargin] = useState(0);
  /** The row a native HTML5 drag started from — never unmounted mid-drag. */
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set());
  const hierarchyRows = useMemo(
    () => items.map((it) => ({ ...it, parentId: it.parentId ?? null })),
    [items],
  );
  const parentIds = useMemo(() => backlogParentIds(hierarchyRows), [hierarchyRows]);
  /**
   * A search flattens the pane: matches are shown wherever they sit, so a
   * collapsed ancestor must not hide a row the query just matched. Carets
   * are suppressed while searching for the same reason — the subtree they
   * would open is not the list being shown.
   */
  const searching = query.trim() !== '';
  const filtered = useMemo(
    () =>
      searching
        ? filterBacklogItems(hierarchyRows, query)
        : visibleBacklogItems(hierarchyRows, collapsedIds),
    [hierarchyRows, query, searching, collapsedIds],
  );

  /** Rows that must stay mounted: the active row, focus, drafts, dragged. */
  const pinnedBacklogIndexes = useCallback(
    (range: Range): readonly number[] => {
      const pinned: number[] = [];
      const pinnedIds = new Set<string>();
      if (pendingFocusId) pinnedIds.add(pendingFocusId);
      if (draggingId) pinnedIds.add(draggingId);
      for (const id of Object.keys(drafts)) pinnedIds.add(id);
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      if (active !== null && typeof document !== 'undefined' && active instanceof HTMLElement) {
        for (const [id, el] of rowRefs.current) {
          if (el === active || el.contains(active)) {
            pinnedIds.add(id);
            break;
          }
        }
      }
      filtered.forEach((item, index) => {
        if (pinnedIds.has(item.id)) pinned.push(index);
      });
      return pinned;
    },
    [pendingFocusId, draggingId, drafts, filtered],
  );

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listRef.current,
    initialRect: { width: 0, height: 600 },
    // See the Priority list: defer the rect observer to an animation frame
    // to avoid a ResizeObserver loop warning during slot mount/unmount.
    useAnimationFrameWithResizeObserver: true,
    estimateSize: () => 34,
    overscan: 12,
    scrollMargin: listScrollMargin,
    getItemKey: (index) => filtered[index]?.id ?? index,
    rangeExtractor: (range: Range) => {
      const pinned = pinnedBacklogIndexes(range);
      if (pinned.length === 0) return defaultRangeExtractor(range);
      const start = Math.max(range.startIndex - range.overscan, 0);
      const end = Math.min(range.endIndex + range.overscan, range.count - 1);
      const wanted = new Set<number>();
      for (let i = start; i <= end; i += 1) wanted.add(i);
      for (const i of pinned) if (i >= 0 && i < range.count) wanted.add(i);
      return [...wanted].sort((a, b) => a - b);
    },
  });

  // The list scroll container starts below the head; the margin is its offset
  // within the scroller (the list div itself is the scroll element). The state
  // update is deferred out of the observer callback — measuring and
  // re-rendering synchronously inside a ResizeObserver notification raises
  // "loop completed with undelivered notifications" (and some specs assert a
  // clean console).
  useEffect(() => {
    const scroller = listRef.current;
    const inner = innerRef.current;
    if (!scroller || !inner) return;
    let frame: number | null = null;
    const measureMargin = (): void => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const scrollerRect = scroller.getBoundingClientRect();
        const innerRect = inner.getBoundingClientRect();
        const margin = innerRect.top - scrollerRect.top + scroller.scrollTop;
        setListScrollMargin((prev) => (Math.abs(prev - margin) < 0.5 ? prev : margin));
      });
    };
    measureMargin();
    const observer = new ResizeObserver(measureMargin);
    observer.observe(scroller);
    observer.observe(inner);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  /**
   * Bring a requested row into view and focus it. `filtered` may be far
   * larger than the window, so focus goes through the virtualizer; the row is
   * pinned while pending so it is always mounted once `scrollToIndex` settles.
   */
  useEffect(() => {
    const pendingId = pendingFocusId;
    if (!pendingId) return;
    const item = items.find((it) => it.id === pendingId);
    // The item either disappeared (removed) or is still awaiting its inPlan
    // flip — only focus once it is unranked and rendered. A target that is
    // filtered out or became inPlan clears the pending id so a stale id can
    // never steal focus later (Story 21.11 AC 10).
    if (!item || item.inPlan) {
      setPendingFocusId(null);
      return;
    }
    const index = filtered.findIndex((it) => it.id === pendingId);
    if (index === -1) {
      setPendingFocusId(null);
      return;
    }
    const mounted = rowRefs.current.get(pendingId);
    if (mounted) {
      mounted.focus();
      if (document.activeElement === mounted || mounted.contains(document.activeElement)) {
        setPendingFocusId(null);
      }
      setActiveIndex(index);
      return;
    }
    virtualizer.scrollToIndex(index, { align: 'auto' });
  }, [items, filtered, pendingFocusId, virtualizer, virtualizer.range?.startIndex, virtualizer.range?.endIndex]);

  const focusRowAt = (index: number): void => {
    const row = filtered[index];
    if (!row) return;
    setActiveIndex(index);
    // The row may sit outside the rendered window; route through the pending
    // path so the virtualizer scrolls it in before focusing.
    setPendingFocusId(row.id);
  };

  const toggleCollapsed = (id: string): void => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const notInPlan = items.filter((it) => !it.inPlan).length;

  // ── `/` focuses search from anywhere in the workspace (AC 21.2-2) ─────────
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== '/') return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      searchInputRef.current?.focus();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // ── Roving tabindex: keep the active index inside a shrinking list ────────
  useEffect(() => {
    setActiveIndex((prev) => Math.max(0, Math.min(prev, filtered.length - 1)));
  }, [filtered.length]);

  const commitDraft = (item: BacklogItem, raw: string | number): void => {
    // Callers pass `drafts[id] ?? (item.points ?? '')`, which is a number whenever
    // the row has a stored estimate and no draft — coerce before trimming.
    const trimmed = String(raw).trim();
    const value = trimmed === '' ? null : Number(trimmed);
    // Reject NaN, negatives, and non-integers (step={1} contract) — and clear
    // the draft so the field returns to the committed model value instead of
    // staying stuck on rejected text (Story 21.11 AC 6/7).
    const rejected =
      value !== null && (Number.isNaN(value) || value < 0 || !Number.isSafeInteger(value));
    setDrafts((prev) => {
      if (!(item.id in prev)) return prev;
      const next = { ...prev };
      delete next[item.id];
      return Object.freeze(next);
    });
    if (rejected) return;
    onSetPoints(item.id, value);
  };

  const isActiveEditable = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement && target.closest('input, textarea, select') !== null;

  const handleRowKeyDown = (
    event: React.KeyboardEvent<HTMLLIElement>,
    item: BacklogItem,
    index: number,
  ): void => {
    // Inner controls (points input, add button) handle their own keys; a key
    // pressed inside them must never bubble into row-level actions (AC 21.2-3).
    if (isActiveEditable(event.target)) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      focusRowAt(Math.max(0, Math.min(filtered.length - 1, index + delta)));
      return;
    }
    // ← / → collapse and expand the nesting, as in the outline tree. ← on a
    // row that is not an expanded parent moves focus to its parent instead,
    // the standard tree behaviour.
    if (!searching && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
      const isParent = parentIds.has(item.id);
      const isCollapsed = collapsedIds.has(item.id);
      if (event.key === 'ArrowRight' && isParent && isCollapsed) {
        event.preventDefault();
        toggleCollapsed(item.id);
        return;
      }
      if (event.key === 'ArrowLeft') {
        if (isParent && !isCollapsed) {
          event.preventDefault();
          toggleCollapsed(item.id);
          return;
        }
        const parentIndex = filtered.findIndex((row) => row.id === item.parentId);
        if (parentIndex !== -1) {
          event.preventDefault();
          focusRowAt(parentIndex);
        }
        return;
      }
      return;
    }
    if (event.key === 'Enter') {
      if (item.overlap || item.inPlan) return; // AC 21.2-9: no-op
      event.preventDefault();
      addItem(item);
      return;
    }
    if (event.key === 'Escape' && onCloseDrawer && drawerOpen) {
      event.preventDefault();
      onCloseDrawer();
    }
  };

  const addItem = (item: BacklogItem): void => {
    if (item.overlap || item.inPlan) return;
    const outcome = onAdd(item.id);
    const failureMessage = `Could not add ${item.title || 'Untitled'} to the Priority list`;
    // Announce only when the add is acknowledged as applied — a rejected add
    // must not claim success (Story 21.11 AC 11). A resolved `false` (domain
    // rejection) is announced too: the failure text must not live only in
    // the `.catch` (Story 21.13 D3).
    const announceIfApplied = (applied: boolean): void => {
      if (!applied) {
        onAnnounce?.(failureMessage);
        return;
      }
      onAnnounce?.(`Added ${item.title || 'Untitled'} to Priority list`);
    };
    if (outcome) {
      void outcome.then(announceIfApplied).catch(() => {
        onAnnounce?.(failureMessage);
      });
    } else {
      announceIfApplied(true);
    }
    // Focus the next unranked item in the current filter (AC 21.2-5).
    const visible = filtered;
    const start = visible.findIndex((it) => it.id === item.id);
    let next: BacklogItem | undefined;
    for (let i = start + 1; i < visible.length; i += 1) {
      if (!visible[i].inPlan) {
        next = visible[i];
        break;
      }
    }
    if (!next) {
      for (let i = start - 1; i >= 0; i -= 1) {
        if (!visible[i].inPlan) {
          next = visible[i];
          break;
        }
      }
    }
    setPendingFocusId(next ? next.id : null);
  };

  return (
    <aside
      role="region"
      aria-label="Backlog"
      className={`pm-forecast__backlog${drawerOpen ? ' pm-forecast__backlog--drawer-open' : ''}`}
      style={!drawerOpen && width !== undefined ? { width: `${width}px`, minWidth: `${width}px`, maxWidth: `${width}px` } : undefined}
    >
      <div className="pm-forecast__backlog-head">
        <div className="pm-forecast__backlog-title">
          <span>BACKLOG</span>
          <span className="pm-forecast__backlog-count">
            {notInPlan} of {items.length}
          </span>
          {onCloseDrawer && (
            <button
              ref={closeButtonRef}
              type="button"
              className="pm-forecast__backlog-close"
              aria-label="Close the Add work drawer"
              onClick={onCloseDrawer}
            >
              ✕
            </button>
          )}
        </div>
        <input
          ref={searchInputRef}
          id={searchId}
          type="search"
          className="pm-forecast__backlog-search"
          placeholder={`Search ${levelLabel}…`}
          aria-label={`Search the ${levelLabel} backlog`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {filtered.length === 0 && (
        <p className="pm-forecast__backlog-empty">
          {items.length === 0 ? `No ${levelLabel} in this project yet.` : 'No matches.'}
        </p>
      )}
      <div
        ref={listRef}
        className="pm-forecast__backlog-list"
        role="tree"
        aria-label={`${levelLabel} backlog`}
      >
        <div ref={innerRef} className="pm-forecast__backlog-list-inner" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const index = virtualItem.index;
          const it = filtered[index];
          if (!it) return null;
          return (
          <div
            key={virtualItem.key}
            data-index={index}
            ref={virtualizer.measureElement}
            className="pm-forecast__backlog-slot"
            style={{ transform: `translateY(${virtualItem.start - listScrollMargin}px)` }}
          >
          <li
            role="treeitem"
            aria-level={(it.depth ?? 0) + 1}
            aria-expanded={parentIds.has(it.id) && !searching ? !collapsedIds.has(it.id) : undefined}
            style={{ '--pm-backlog-depth': it.depth ?? 0 } as React.CSSProperties}
            ref={(el) => {
              if (el) rowRefs.current.set(it.id, el);
              else rowRefs.current.delete(it.id);
            }}
            aria-current={activeIndex === index ? 'true' : undefined}
            className={`pm-forecast__backlog-row${it.inPlan ? ' pm-forecast__backlog-row--in-plan' : ''}${
              activeIndex === index ? ' pm-forecast__backlog-row--active' : ''
            }`}
            tabIndex={activeIndex === index ? 0 : -1}
            // Every row whose grip promises a drag can be dragged: an unranked
            // item is added at the drop slot, an `in plan` item is re-ranked
            // there (same payload as a Priority row drag).
            draggable={!it.overlap}
            onDragStart={(e) => {
              setDraggingId(it.id);
              if (it.inPlan) {
                onDragPlannedStart?.(it.id);
                e.dataTransfer.setData('text/plain', it.id);
                e.dataTransfer.effectAllowed = 'move';
                return;
              }
              e.dataTransfer.setData('application/x-forecast-backlog', it.id);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onDragEnd={() => setDraggingId(null)}
            onFocus={() => setActiveIndex(index)}
            onKeyDown={(e) => handleRowKeyDown(e, it, index)}
          >
            {/* Caret column, as in the outline: only a parent carries one,
                and a search flattens the list so none are shown. */}
            {parentIds.has(it.id) && !searching ? (
              <button
                type="button"
                className="pm-forecast__backlog-caret"
                tabIndex={-1}
                aria-label={`${collapsedIds.has(it.id) ? 'Expand' : 'Collapse'} ${it.title || 'Untitled'}`}
                onClick={() => toggleCollapsed(it.id)}
              >
                {collapsedIds.has(it.id) ? '▶' : '▼'}
              </button>
            ) : (
              <span className="pm-forecast__backlog-caret" aria-hidden="true" />
            )}
            <span
              className="pm-forecast__backlog-grip"
              aria-hidden="true"
              title={
                it.overlap
                  ? undefined
                  : it.inPlan
                    ? 'Drag onto the Priority list to change its rank'
                    : 'Drag onto the Priority list to add it at that rank'
              }
            >
              ⣿
            </span>
            <span className="pm-forecast__backlog-name">{it.title || 'Untitled'}</span>
            {it.inPlan ? (
              <span className="pm-forecast__backlog-tag">in plan</span>
            ) : (
              <input
                ref={(el) => {
                  if (el) pointsInputRefs.current.set(it.id, el);
                  else pointsInputRefs.current.delete(it.id);
                }}
                type="number"
                min={0}
                step={1}
                className="pm-forecast__backlog-points"
                aria-label={`Points for ${it.title || 'Untitled'}`}
                value={drafts[it.id] ?? (it.points ?? '')}
                placeholder="–"
                onChange={(e) => {
                  // A partial/invalid numeric entry (a lone '-') reports value ''
                  // with badInput set; treating it as a clear destroys the estimate.
                  if (e.target.validity.badInput) return;
                  const v = e.target.value;
                  const parsed = v.trim() === '' ? null : Number(v);
                  if (parsed !== null && (Number.isNaN(parsed) || parsed < 0)) return;
                  setDrafts((prev) => Object.freeze({ ...prev, [it.id]: v }));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitDraft(it, drafts[it.id] ?? (it.points ?? ''));
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setDrafts((prev) => {
                      if (!(it.id in prev)) return prev;
                      const next = { ...prev };
                      delete next[it.id];
                      return Object.freeze(next);
                    });
                  }
                }}
                onBlur={() => {
                  if (drafts[it.id] === undefined) return;
                  commitDraft(it, drafts[it.id]);
                }}
              />
            )}
            {/* A blocked row keeps its points field but trades the disabled ＋
                for a visible reason: a disabled button fires no tooltip, so
                'cannot be added' would otherwise be silent to a mouse user. */}
            {!it.inPlan && it.overlap && (
              <span
                className="pm-forecast__backlog-tag pm-forecast__backlog-tag--blocked"
                title={
                  it.blockedBy === 'child'
                    ? 'A child of this item is already in the plan and counts this work'
                    : 'A parent of this item is already in the plan and counts this work'
                }
              >
                {it.blockedBy === 'child' ? 'in child' : 'in parent'}
              </span>
            )}
            {!it.inPlan && !it.overlap && (
              <button
                type="button"
                className="pm-forecast__backlog-add"
                aria-label={`Add ${it.title || 'Untitled'} to the priority list`}
                title="Add to the priority list"
                onClick={() => {
                  // Commit only this row's own draft — a focused input on a
                  // *different* row must not be committed by this click
                  // (Story 21.11 AC 8).
                  const ownInput = pointsInputRefs.current.get(it.id);
                  if (ownInput && document.activeElement === ownInput) {
                    commitDraft(it, drafts[it.id] ?? (it.points ?? ''));
                  }
                  addItem(it);
                }}
              >
                ＋
              </button>
            )}
          </li>
          </div>
          );
        })}
        </div>
      </div>
    </aside>
  );
}
