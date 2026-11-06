/**
 * Compact Backlog column for the Delivery Board.
 *
 * The existing BacklogPane remains the full hierarchical editor in List view.
 * This compact surface keeps the board's core add/search/estimate gestures
 * without duplicating the pane's tree management.
 */

import { useMemo, useState } from 'react';
import type { BacklogItem } from './backlog-pane';

export interface DeliveryBacklogProps {
  readonly levelLabel: string;
  readonly items: readonly BacklogItem[];
  readonly onAdd: (id: string) => void | Promise<boolean>;
  readonly onSetPoints?: (id: string, points: number | null) => void;
  readonly onAnnounce?: (message: string) => void;
  /** When set, unplanned items can be dragged onto a sprint to add them there. */
  readonly onDragItemStart?: (id: string) => void;
  readonly onDragItemEnd?: () => void;
}

function blockedReason(item: BacklogItem): string | null {
  if (item.blockedBy === 'parent') return 'Covered by a parent in the plan';
  if (item.blockedBy === 'child') return 'Covered by a child in the plan';
  if (item.overlap) return 'Overlaps the current scope';
  return null;
}

function addLabel(item: BacklogItem): string {
  return `Add ${item.title || 'Untitled work'} to the plan`;
}

export function DeliveryBacklog({
  levelLabel,
  items,
  onAdd,
  onSetPoints,
  onAnnounce,
  onDragItemStart,
  onDragItemEnd,
}: DeliveryBacklogProps): React.ReactElement {
  const [query, setQuery] = useState('');
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return items;
    return items.filter((item) => item.title.toLowerCase().includes(needle));
  }, [items, query]);
  const openCount = items.filter((item) => !item.inPlan && !item.blockedBy && !item.overlap).length;

  const setDraft = (id: string, value: string): void => {
    setDrafts((current) => Object.freeze({ ...current, [id]: value }));
  };

  const clearDraft = (id: string): void => {
    setDrafts((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return Object.freeze(next);
    });
  };

  const commitPoints = (item: BacklogItem): void => {
    if (!onSetPoints) return;
    const raw = drafts[item.id];
    if (raw === undefined) return;
    const next = raw.trim() === '' ? null : Number(raw);
    if (next !== null && (!Number.isSafeInteger(next) || next < 0)) return;
    onSetPoints(item.id, next);
    clearDraft(item.id);
  };

  const add = (item: BacklogItem): void => {
    const outcome = onAdd(item.id);
    const settled = (applied: boolean): void => {
      onAnnounce?.(
        applied
          ? `Added ${item.title || 'Untitled work'} to the plan`
          : `Could not add ${item.title || 'Untitled work'} to the plan`,
      );
    };
    if (outcome && typeof outcome.then === 'function') {
      void outcome.then(settled).catch(() => settled(false));
    } else {
      settled(true);
    }
  };

  return (
    <section className="pm-delivery__backlog" aria-label="Backlog">
      <div className="pm-delivery__backlog-head">
        <span>Backlog</span>
        <span className="pm-delivery__panel-meta">{openCount} open</span>
      </div>
      <label className="pm-delivery__search">
        <span className="pm-delivery__sr-only">Search the Backlog</span>
        <input
          type="search"
          value={query}
          placeholder={`Search ${levelLabel.toLowerCase()}...`}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="pm-delivery__backlog-list">
        {filtered.length === 0 && (
          <p className="pm-delivery__note">
            {query.trim() === '' ? 'Every item at this level is already in the plan.' : 'No matching work.'}
          </p>
        )}
        {filtered.map((item) => {
          const reason = blockedReason(item);
          const canDrag = Boolean(onDragItemStart) && !item.inPlan && !reason;
          return (
            <div
              key={item.id}
              className={`pm-delivery__backlog-card${item.inPlan ? ' is-in-plan' : ''}${canDrag ? ' is-draggable' : ''}`}
            >
              <div
                className="pm-delivery__backlog-main"
                {...(canDrag
                  ? {
                      draggable: true,
                      title: 'Drag onto a sprint to add it there',
                      onDragStart: (event: React.DragEvent<HTMLDivElement>) => {
                        event.dataTransfer.effectAllowed = 'copyMove';
                        event.dataTransfer.setData('text/plain', item.title || item.id);
                        onDragItemStart?.(item.id);
                      },
                      onDragEnd: () => onDragItemEnd?.(),
                    }
                  : {})}
              >
                <span className="pm-delivery__backlog-title">{item.title || 'Untitled work'}</span>
                <span className="pm-delivery__backlog-meta">
                  {item.inPlan ? 'In plan' : reason ?? 'Unplanned'}
                </span>
              </div>
              {onSetPoints && !item.inPlan ? (
                <input
                  type="number"
                  className="pm-delivery__effort pm-delivery__effort--small"
                  aria-label={`Points for ${item.title || 'Untitled work'}`}
                  min={0}
                  step={1}
                  value={drafts[item.id] ?? item.points ?? ''}
                  placeholder="-"
                  onChange={(event) => {
                    if (event.target.validity.badInput) return;
                    setDraft(item.id, event.target.value);
                  }}
                  onBlur={() => commitPoints(item)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitPoints(item);
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      clearDraft(item.id);
                    }
                  }}
                />
              ) : (
                <span className="pm-delivery__backlog-points">{item.points ?? '-'}</span>
              )}
              <button
                type="button"
                className="pm-delivery__backlog-add"
                aria-label={addLabel(item)}
                disabled={item.inPlan || Boolean(reason)}
                onClick={() => add(item)}
              >
                {item.inPlan ? 'In plan' : '+'}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
