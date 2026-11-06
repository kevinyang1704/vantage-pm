/**
 * Sprint board (Delivery Board sprint plan).
 *
 * Backlog on the left, one column per sprint. Every card can be dragged into
 * a sprint: the drop is allowed only when the sprint has room left after the
 * work already placed there, the card is not blocked, has an estimate, and
 * everything it depends on is done or finishes in an earlier sprint. Cards
 * not placed by hand are placed by the forecast in rank order, in whatever
 * room is left. Each sprint's capacity can be changed on its own.
 */

import { useMemo, useRef, useState } from 'react';
import type { BacklogItem } from './backlog-pane';
import type { ForecastPerson, ForecastSprintPlan } from '../../../domain/forecast/forecast-plan.entity';
import {
  describeHold,
  evaluateSprintCapacity,
  evaluateSprintDrop,
  type SprintBoardCard,
  type SprintBoardColumn,
  type SprintBoardProjection,
} from '../../../application/forecast/sprint-board-projection';
import { evaluateSprintPlanChange, type SprintPlanVerdict } from '../../../domain/forecast/sprint-placement.policy';

const SPRINTS_PER_PAGE = 4;

export interface SprintBoardProps {
  readonly board: SprintBoardProjection;
  readonly levelLabel: string;
  readonly backlogItems: readonly BacklogItem[];
  /** Delivery status by item id, for items not in the plan. */
  readonly deliveredIds: ReadonlySet<string>;
  readonly isStaffed: boolean;
  readonly roster: readonly ForecastPerson[];
  readonly page: number;
  readonly onPageChange: (page: number) => void;
  readonly onSetSprintPlan?: (sprintPlan: ForecastSprintPlan, addFeatureId?: string) => Promise<boolean>;
  readonly onAdd: (id: string) => void | Promise<boolean>;
  readonly onRemove: (id: string) => void | Promise<boolean>;
  readonly onSetEffort: (id: string, points: number | null) => void;
  readonly onSetPointsDone?: (id: string, points: number | null) => void;
  readonly onSetBlocker?: (id: string, blocked: boolean) => void;
  readonly onAssign?: (id: string, title: string) => void;
  readonly onAnnounce: (text: string) => void;
  readonly onError: (text: string | null) => void;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return `${parts[0].slice(0, 1)}${parts[parts.length - 1].slice(0, 1)}`.toUpperCase();
}

function GripIcon(): React.ReactElement {
  return (
    <svg className="pm-delivery__icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="6" cy="4" r="1" fill="currentColor" />
      <circle cx="10" cy="4" r="1" fill="currentColor" />
      <circle cx="6" cy="8" r="1" fill="currentColor" />
      <circle cx="10" cy="8" r="1" fill="currentColor" />
      <circle cx="6" cy="12" r="1" fill="currentColor" />
      <circle cx="10" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}

function pointsLabel(points: number): string {
  return `${points} pt${points === 1 ? '' : 's'}`;
}

export function SprintBoard(props: SprintBoardProps): React.ReactElement {
  const {
    board,
    levelLabel,
    backlogItems,
    deliveredIds,
    isStaffed,
    roster,
    page,
    onPageChange,
    onSetSprintPlan,
    onAdd,
    onRemove,
    onSetEffort,
    onSetPointsDone,
    onSetBlocker,
    onAssign,
    onAnnounce,
    onError,
  } = props;

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overSprint, setOverSprint] = useState<number | 'backlog' | null>(null);
  const [query, setQuery] = useState('');
  const [effortDrafts, setEffortDrafts] = useState<ReadonlyMap<string, string>>(new Map());
  const [capacityEdit, setCapacityEdit] = useState<{ sprint: number; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDelivered, setShowDelivered] = useState(true);
  /** The refused sprint the pointer was last over: the browser fires no drop there. */
  const refusedTargetRef = useRef<string | null>(null);
  /** When the pointer left that sprint; a cancelled drop leaves it just before dragend. */
  const refusedLeftAtRef = useRef<number | null>(null);

  const pageCount = Math.max(1, Math.ceil(board.columns.length / SPRINTS_PER_PAGE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = board.columns.slice(safePage * SPRINTS_PER_PAGE, safePage * SPRINTS_PER_PAGE + SPRINTS_PER_PAGE);

  const titleOf = (id: string): string =>
    board.cards.get(id)?.title ?? backlogItems.find((item) => item.id === id)?.title ?? 'Untitled work';

  const dropItem = (id: string) => {
    const card = board.cards.get(id);
    if (card) {
      return {
        id,
        points: card.remainingPoints,
        delivered: card.deliveryStatus === 'delivered',
        blocked: card.blocked,
      };
    }
    const item = backlogItems.find((candidate) => candidate.id === id);
    return { id, points: item?.points ?? null, delivered: deliveredIds.has(id), blocked: false };
  };

  /** Verdict for dropping the dragged card into each visible sprint. */
  const verdicts = useMemo(() => {
    const map = new Map<number, SprintPlanVerdict>();
    if (!draggingId) return map;
    for (const column of visible) map.set(column.sprint, evaluateSprintDrop(board, dropItem(draggingId), column.sprint));
    return map;
  }, [draggingId, board, visible]);

  const refusal = (verdict: Extract<SprintPlanVerdict, { ok: false }>, subject: string, sprint: number | null): string => {
    const reason = describeHold(verdict.reason, titleOf);
    if (verdict.displaced.length > 0) {
      const names = verdict.displaced.map(titleOf).join(', ');
      const where = `${names} would no longer fit where ${verdict.displaced.length === 1 ? 'it is' : 'they are'}.`;
      return sprint !== null ? `${subject} can't go in Sprint ${sprint}: ${where}` : where;
    }
    return sprint !== null ? `${subject} can't go in Sprint ${sprint}. ${reason}` : reason;
  };

  const save = async (sprintPlan: ForecastSprintPlan, success: string, addFeatureId?: string): Promise<void> => {
    if (!onSetSprintPlan) return;
    setBusy(true);
    try {
      const ok = await onSetSprintPlan(sprintPlan, addFeatureId);
      if (ok) {
        onError(null);
        onAnnounce(success);
      } else {
        onError('The sprint plan could not be saved. Nothing was changed.');
      }
    } finally {
      setBusy(false);
    }
  };

  const placeInto = (id: string, sprint: number): void => {
    const title = titleOf(id);
    const verdict = evaluateSprintDrop(board, dropItem(id), sprint);
    if (!verdict.ok) {
      onError(refusal(verdict, title, sprint));
      onAnnounce(refusal(verdict, title, sprint));
      return;
    }
    const kept = verdict.addedPlacements.map(titleOf);
    const note = kept.length > 0 ? ` ${kept.join(', ')} ${kept.length === 1 ? 'stays' : 'stay'} where ${kept.length === 1 ? 'it is' : 'they are'}, since ${title} depends on ${kept.length === 1 ? 'it' : 'them'}.` : '';
    const inPlan = board.cards.has(id);
    void save(
      { placements: verdict.placements, capacities: board.input.capacities },
      `Put ${title} in Sprint ${sprint}.${note}`,
      inPlan ? undefined : id,
    );
  };

  const unplace = (id: string): void => {
    const title = titleOf(id);
    const placements = board.input.placements.filter((placement) => placement.itemId !== id);
    if (placements.length === board.input.placements.length) return;
    // Nothing that depends on it may lose its sprint.
    const verdict = evaluateSprintPlanChange(board.input, { placements, capacities: board.input.capacities });
    if (!verdict.ok) {
      onError(`${title} has to stay in its sprint. ${refusal(verdict, title, null)}`);
      return;
    }
    void save({ placements, capacities: board.input.capacities }, `${title} is back in the Backlog.`);
  };

  const saveCapacity = (sprint: number, raw: string): void => {
    setCapacityEdit(null);
    const trimmed = raw.trim();
    const points = trimmed === '' ? null : Number(trimmed);
    if (points !== null && (!Number.isSafeInteger(points) || points < 0)) {
      onError('Sprint capacity must be a whole number of points.');
      return;
    }
    const current = board.input.capacities[String(sprint)];
    const effective = points === board.teamCapacity ? null : points;
    if ((current ?? null) === effective) return;
    const verdict = evaluateSprintCapacity(board, sprint, effective);
    if (!verdict.ok) {
      onError(`Sprint ${sprint} can't drop to ${points ?? board.teamCapacity} points: ${refusal(verdict, '', null)}`);
      return;
    }
    const capacities: Record<string, number> = { ...board.input.capacities };
    if (effective === null) delete capacities[String(sprint)];
    else capacities[String(sprint)] = effective;
    void save(
      { placements: board.input.placements, capacities },
      effective === null
        ? `Sprint ${sprint} is back to the team capacity of ${board.teamCapacity} points.`
        : `Sprint ${sprint} capacity set to ${effective} points.`,
    );
  };

  const onDragStart = (id: string) => (event: React.DragEvent<HTMLElement>): void => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
    refusedTargetRef.current = null;
    setDraggingId(id);
    onError(null);
  };
  const onDragEnd = (): void => {
    // Released over a sprint that refuses the card: say why. Chromium fires
    // dragleave on the target right before dragend when it cancels a drop.
    const leftAt = refusedLeftAtRef.current;
    const releasedOnTarget = leftAt === null || performance.now() - leftAt < 150;
    if (refusedTargetRef.current && releasedOnTarget) {
      onError(refusedTargetRef.current);
      onAnnounce(refusedTargetRef.current);
    }
    refusedTargetRef.current = null;
    refusedLeftAtRef.current = null;
    setDraggingId(null);
    setOverSprint(null);
  };

  const effortInput = (id: string, title: string, points: number | null, small = false): React.ReactElement => (
    <input
      type="number"
      className={`pm-delivery__effort${small ? ' pm-delivery__effort--small' : ''}`}
      aria-label={`Points for ${title}`}
      min={0}
      step={1}
      value={effortDrafts.has(id) ? effortDrafts.get(id)! : (points ?? '')}
      placeholder="-"
      draggable={false}
      onDragStart={(event) => event.preventDefault()}
      onChange={(event) => {
        const raw = event.target.value;
        setEffortDrafts((current) => new Map(current).set(id, raw));
      }}
      onBlur={() => {
        const raw = effortDrafts.get(id);
        setEffortDrafts((current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        });
        if (raw === undefined) return;
        const next = raw.trim() === '' ? null : Number(raw);
        if (next !== null && (!Number.isSafeInteger(next) || next < 0)) return;
        if (next !== points) onSetEffort(id, next);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        if (event.key === 'Escape') {
          event.preventDefault();
          setEffortDrafts((current) => {
            const next = new Map(current);
            next.delete(id);
            return next;
          });
        }
      }}
    />
  );

  const sprintSelect = (card: SprintBoardCard): React.ReactElement | null => {
    if (!onSetSprintPlan || card.deliveryStatus === 'delivered') return null;
    const placed = card.source === 'placed';
    return (
      <label className="pm-delivery__sprint-select">
        <span className="pm-delivery__sr-only">Sprint for {card.title}</span>
        <select
          value={placed && card.startSprint !== null ? String(card.startSprint) : ''}
          disabled={busy}
          onChange={(event) => {
            const value = event.target.value;
            if (value === '') unplace(card.id);
            else placeInto(card.id, Number(value));
          }}
        >
          <option value="">{placed ? 'Back to Backlog' : 'Move to...'}</option>
          {board.columns.map((column) => (
            <option key={column.sprint} value={String(column.sprint)}>
              Sprint {column.sprint}
            </option>
          ))}
        </select>
      </label>
    );
  };

  const renderCard = (card: SprintBoardCard): React.ReactElement => {
    const people = isStaffed ? roster.filter((person) => card.assignedPersonIds.includes(person.id)) : [];
    const spans = card.startSprint !== null && card.finishSprint !== null ? card.finishSprint - card.startSprint + 1 : 1;
    return (
      <article
        key={card.id}
        className={`pm-delivery__card${card.blocked ? ' is-blocked' : ''}${card.source === 'forecast' ? ' is-forecast' : ''}${draggingId === card.id ? ' is-dragging' : ''}`}
        draggable={Boolean(onSetSprintPlan)}
        onDragStart={onDragStart(card.id)}
        onDragEnd={onDragEnd}
        aria-label={`${card.title}, in Sprint ${card.startSprint}`}
      >
        <div className="pm-delivery__card-top">
          <span className="pm-delivery__drag" aria-hidden="true" title="Drag into a sprint">
            <GripIcon />
          </span>
          <span className="pm-delivery__rank" aria-label={`Rank ${card.rank}`}>
            {String(card.rank).padStart(2, '0')}
          </span>
          <span className="pm-delivery__card-title">{card.title}</span>
          {effortInput(card.id, card.title, card.effortPoints)}
        </div>
        <div className="pm-delivery__card-meta">
          {card.blocked && <span className="pm-delivery__card-status is-risk">Blocked</span>}
          {card.deliveryStatus === 'in_progress' && <span className="pm-delivery__card-status">In progress</span>}
          {spans > 1 && <span className="pm-delivery__span">through Sprint {card.finishSprint}</span>}
        </div>
        {card.dependsOn.length > 0 && (
          <div className="pm-delivery__depends">After {card.dependsOn.join(', ')}</div>
        )}
        {card.held && <div className="pm-delivery__held-reason">{card.held}</div>}
        {isStaffed && (
          <div className="pm-delivery__assign-row">
            {people.length > 0 ? (
              <span className="pm-delivery__avatars">
                {people.map((person) => (
                  <span className="pm-delivery__avatar pm-delivery__avatar--small" key={person.id} title={person.name}>
                    {initials(person.name)}
                  </span>
                ))}
              </span>
            ) : (
              <span className="pm-delivery__missing-assignment">Needs assignment</span>
            )}
            {onAssign && (
              <button type="button" className="pm-delivery__inline-button" onClick={() => onAssign(card.id, card.title)}>
                Assign
              </button>
            )}
          </div>
        )}
        {card.deliveryStatus === 'in_progress' && onSetPointsDone && (
          <label className="pm-delivery__done">
            <span>Done</span>
            <input
              type="number"
              min={0}
              max={card.effortPoints ?? undefined}
              step={1}
              value={card.effortPointsDone ?? ''}
              aria-label={`Points done for ${card.title}`}
              onChange={(event) => {
                const raw = event.target.value;
                const next = raw.trim() === '' ? null : Number(raw);
                if (next !== null && (!Number.isSafeInteger(next) || next < 0)) return;
                onSetPointsDone(card.id, next);
              }}
            />
          </label>
        )}
        <div className="pm-delivery__card-actions">
          {sprintSelect(card)}
          {onSetBlocker && (
            <button
              type="button"
              className={`pm-delivery__card-action${card.blocked ? ' is-risk' : ''}`}
              aria-pressed={card.blocked}
              onClick={() => {
                onSetBlocker(card.id, !card.blocked);
                onAnnounce(card.blocked ? `Cleared the blocker on ${card.title}.` : `Marked ${card.title} blocked.`);
              }}
            >
              {card.blocked ? 'Unblock' : 'Block'}
            </button>
          )}
          <button
            type="button"
            className="pm-delivery__card-action"
            title="Take it out of the plan"
            onClick={() => {
              const outcome = onRemove(card.id);
              const done = (ok: boolean) => onAnnounce(ok ? `Removed ${card.title} from the plan.` : `Could not remove ${card.title}.`);
              if (outcome && typeof outcome.then === 'function') void outcome.then(done).catch(() => done(false));
              else done(true);
            }}
          >
            Remove
          </button>
        </div>
      </article>
    );
  };

  const renderColumn = (column: SprintBoardColumn): React.ReactElement => {
    const verdict = draggingId ? verdicts.get(column.sprint) : undefined;
    const blocked = verdict && !verdict.ok;
    const used = column.placedPoints + column.forecastPoints;
    const placedPct = column.capacity > 0 ? Math.min(100, (column.placedPoints / column.capacity) * 100) : 100;
    const forecastPct = column.capacity > 0 ? Math.min(100 - placedPct, (column.forecastPoints / column.capacity) * 100) : 0;
    const editing = capacityEdit?.sprint === column.sprint;
    return (
      <section
        key={column.sprint}
        className={`pm-delivery__column${overSprint === column.sprint ? (blocked ? ' is-drop-blocked' : ' is-drop-target') : ''}`}
        aria-label={`Sprint ${column.sprint}, ${used} of ${column.capacity} points`}
        onDragOver={(event) => {
          if (!draggingId) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = blocked ? 'none' : 'move';
          refusedTargetRef.current =
            verdict && !verdict.ok ? refusal(verdict, titleOf(draggingId), column.sprint) : null;
          refusedLeftAtRef.current = null;
          if (overSprint !== column.sprint) setOverSprint(column.sprint);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            refusedLeftAtRef.current = performance.now();
            setOverSprint(null);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          const id = draggingId ?? event.dataTransfer.getData('text/plain');
          refusedTargetRef.current = null;
          onDragEnd();
          if (id) placeInto(id, column.sprint);
        }}
      >
        <div className="pm-delivery__column-head">
          <div className="pm-delivery__column-title">
            <span>Sprint {column.sprint}</span>
            <em>{column.dateRange}</em>
          </div>
          <div className="pm-delivery__capacity">
            <div
              className="pm-delivery__capacity-bar"
              role="img"
              aria-label={`${column.placedPoints} of ${column.capacity} points used`}
            >
              <span className="pm-delivery__capacity-placed" style={{ width: `${placedPct}%` }} />
              <span className="pm-delivery__capacity-forecast" style={{ width: `${forecastPct}%` }} />
            </div>
            <div className="pm-delivery__capacity-line">
              {editing ? (
                <label className="pm-delivery__capacity-input">
                  <span className="pm-delivery__sr-only">Capacity for Sprint {column.sprint}</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    autoFocus
                    value={capacityEdit.value}
                    placeholder={String(board.teamCapacity)}
                    onChange={(event) => setCapacityEdit({ sprint: column.sprint, value: event.target.value })}
                    onBlur={() => saveCapacity(column.sprint, capacityEdit.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') saveCapacity(column.sprint, capacityEdit.value);
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        setCapacityEdit(null);
                      }
                    }}
                  />
                  <span>pts</span>
                </label>
              ) : (
                <button
                  type="button"
                  className={`pm-delivery__capacity-button${column.overridden ? ' is-overridden' : ''}`}
                  disabled={!onSetSprintPlan || busy}
                  title={column.overridden ? `Team capacity is ${board.teamCapacity}. Clear the field to go back to it.` : 'Change this sprint’s capacity'}
                  onClick={() => setCapacityEdit({ sprint: column.sprint, value: String(column.capacity) })}
                >
                  <b>{used}</b> / {column.capacity} pts
                </button>
              )}
              {column.full ? (
                <span className="pm-delivery__full-chip">Full</span>
              ) : (
                <span className="pm-delivery__free" title="Points still free in this sprint">
                  {Math.max(column.capacity - column.placedPoints, 0)} free
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="pm-delivery__column-body">
          {column.cards.map((card) => renderCard(card))}
          {column.continuing.length > 0 && (
            <div className="pm-delivery__continuing">
              <span>Continuing</span>
              {column.continuing.map(({ card, points }) => (
                <b key={card.id}>
                  {card.title} <em>{pointsLabel(points)}</em>
                </b>
              ))}
            </div>
          )}
          {column.cards.length === 0 && column.continuing.length === 0 && (
            <div className="pm-delivery__column-empty">Nothing planned yet</div>
          )}
          <div className={`pm-delivery__dropzone${blocked ? ' is-blocked' : ''}`}>
            {draggingId && verdict
              ? verdict.ok
                ? 'Drop to put it here'
                : describeHold(verdict.reason, titleOf)
              : column.full
                ? 'Full'
                : 'Drop work here'}
          </div>
        </div>
      </section>
    );
  };

  const needle = query.trim().toLowerCase();
  const matches = (title: string) => needle === '' || title.toLowerCase().includes(needle);
  // Delivered work is done: it leaves the Backlog and is listed on its own.
  const unplanned = backlogItems.filter((item) => !item.inPlan && !deliveredIds.has(item.id) && matches(item.title));
  const held = board.held.filter((card) => matches(card.title));
  const ready = board.unscheduled.filter((card) => matches(card.title));
  const deliveredAll = [
    ...board.delivered.map((card) => ({ id: card.id, title: card.title, points: card.effortPoints, inPlan: true })),
    ...backlogItems
      .filter((item) => !item.inPlan && deliveredIds.has(item.id))
      .map((item) => ({ id: item.id, title: item.title || 'Untitled work', points: item.points, inPlan: false })),
  ];
  const delivered = deliveredAll.filter((item) => matches(item.title));

  return (
    <>
      <div
        className="pm-delivery__grid"
        style={{ gridTemplateColumns: `220px repeat(${Math.max(visible.length, 1)}, minmax(196px, 1fr))` }}
      >
        <section
          className={`pm-delivery__backlog${overSprint === 'backlog' ? ' is-drop-target' : ''}`}
          aria-label="Backlog"
          onDragOver={(event) => {
            if (!draggingId || board.cards.get(draggingId)?.source !== 'placed') return;
            event.preventDefault();
            if (overSprint !== 'backlog') setOverSprint('backlog');
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOverSprint(null);
          }}
          onDrop={(event) => {
            event.preventDefault();
            const id = draggingId;
            onDragEnd();
            if (id) unplace(id);
          }}
        >
          <div className="pm-delivery__backlog-head">
            <span>Backlog</span>
            <span className="pm-delivery__panel-meta">{board.unscheduled.length + board.held.length} to schedule</span>
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
            {ready.length > 0 && (
              <>
                <div className="pm-delivery__backlog-section">Ready to schedule</div>
                {ready.map((card) => (
                  <div
                    key={card.id}
                    className="pm-delivery__backlog-card is-ready"
                    draggable={Boolean(onSetSprintPlan)}
                    onDragStart={onDragStart(card.id)}
                    onDragEnd={onDragEnd}
                  >
                    <div className="pm-delivery__backlog-main">
                      <span className="pm-delivery__backlog-title">
                        <span className="pm-delivery__rank" aria-label={`Rank ${card.rank}`}>
                          {String(card.rank).padStart(2, '0')}
                        </span>{' '}
                        {card.title}
                      </span>
                      <span className="pm-delivery__backlog-meta">
                        {card.dependsOn.length > 0 ? `After ${card.dependsOn.join(', ')}` : 'Drag into a sprint'}
                      </span>
                    </div>
                    {effortInput(card.id, card.title, card.effortPoints, true)}
                    <button
                      type="button"
                      className="pm-delivery__backlog-add"
                      aria-label={`Take ${card.title} out of the plan`}
                      title="Take it out of the plan"
                      onClick={() => {
                        const outcome = onRemove(card.id);
                        const done = (ok: boolean) => onAnnounce(ok ? `Removed ${card.title} from the plan.` : `Could not remove ${card.title}.`);
                        if (outcome && typeof outcome.then === 'function') void outcome.then(done).catch(() => done(false));
                        else done(true);
                      }}
                    >
                      &minus;
                    </button>
                  </div>
                ))}
              </>
            )}
            {held.length > 0 && (
              <>
                <div className="pm-delivery__backlog-section">Can&apos;t schedule yet</div>
                {held.map((card) => (
                  <div
                    key={card.id}
                    className={`pm-delivery__backlog-card is-held${card.blocked ? ' is-blocked' : ''}`}
                    draggable={Boolean(onSetSprintPlan)}
                    onDragStart={onDragStart(card.id)}
                    onDragEnd={onDragEnd}
                  >
                    <div className="pm-delivery__backlog-main">
                      <span className="pm-delivery__backlog-title">{card.title}</span>
                      <span className="pm-delivery__backlog-meta">{card.held}</span>
                    </div>
                    {effortInput(card.id, card.title, card.effortPoints, true)}
                    {onSetBlocker && card.blocked ? (
                      <button
                        type="button"
                        className="pm-delivery__backlog-add"
                        aria-label={`Clear the blocker on ${card.title}`}
                        title="Unblock"
                        onClick={() => {
                          onSetBlocker(card.id, false);
                          onAnnounce(`Cleared the blocker on ${card.title}.`);
                        }}
                      >
                        &#x2713;
                      </button>
                    ) : (
                      <span />
                    )}
                  </div>
                ))}
              </>
            )}
            <div className="pm-delivery__backlog-section">Not in the plan</div>
            {unplanned.length === 0 && (
              <p className="pm-delivery__note">
                {needle === '' ? 'Every item at this level is already in the plan.' : 'No matching work.'}
              </p>
            )}
            {unplanned.map((item) => {
              const reason = item.blockedBy === 'parent'
                ? 'Covered by a parent in the plan'
                : item.blockedBy === 'child'
                  ? 'Covered by a child in the plan'
                  : item.overlap
                    ? 'Overlaps the current scope'
                    : null;
              return (
                <div
                  key={item.id}
                  className="pm-delivery__backlog-card"
                  draggable={Boolean(onSetSprintPlan) && !reason}
                  onDragStart={onDragStart(item.id)}
                  onDragEnd={onDragEnd}
                >
                  <div className="pm-delivery__backlog-main">
                    <span className="pm-delivery__backlog-title">{item.title || 'Untitled work'}</span>
                    <span className="pm-delivery__backlog-meta">
                      {reason ?? (item.points === null ? 'Needs an estimate' : 'Drag into a sprint')}
                    </span>
                  </div>
                  {effortInput(item.id, item.title || 'Untitled work', item.points, true)}
                  <button
                    type="button"
                    className="pm-delivery__backlog-add"
                    aria-label={`Add ${item.title || 'Untitled work'} to the plan`}
                    title="Add to the plan without putting it in a sprint"
                    disabled={Boolean(reason)}
                    onClick={() => {
                      const outcome = onAdd(item.id);
                      const done = (ok: boolean) => onAnnounce(ok ? `Added ${item.title || 'Untitled work'} to the plan.` : `Could not add ${item.title || 'Untitled work'}.`);
                      if (outcome && typeof outcome.then === 'function') void outcome.then(done).catch(() => done(false));
                      else done(true);
                    }}
                  >
                    +
                  </button>
                </div>
              );
            })}
            {delivered.length > 0 && (
              <>
                <button
                  type="button"
                  className="pm-delivery__backlog-section pm-delivery__delivered-toggle"
                  aria-expanded={showDelivered}
                  onClick={() => setShowDelivered((open) => !open)}
                >
                  <span aria-hidden="true">{showDelivered ? '\u25be' : '\u25b8'}</span> Delivered ({delivered.length})
                </button>
                {showDelivered &&
                  delivered.map((item) => (
                    <div key={item.id} className="pm-delivery__backlog-card is-delivered">
                      <span className="pm-delivery__delivered-mark" aria-hidden="true">&#x2713;</span>
                      <div className="pm-delivery__backlog-main">
                        <span className="pm-delivery__backlog-title">{item.title}</span>
                        <span className="pm-delivery__backlog-meta">
                          {item.inPlan ? 'Delivered \u00b7 in the plan' : 'Delivered'}
                        </span>
                      </div>
                      <span className="pm-delivery__backlog-points">
                        {item.points === null ? '-' : pointsLabel(item.points)}
                      </span>
                    </div>
                  ))}
              </>
            )}
          </div>
        </section>
        {visible.map((column) => renderColumn(column))}
      </div>
      {pageCount > 1 && (
        <div className="pm-delivery__pager pm-delivery__pager--board">
          <button
            type="button"
            className="pm-delivery__inline-button"
            disabled={safePage === 0}
            onClick={() => onPageChange(Math.max(0, safePage - 1))}
          >
            &larr; Earlier sprints
          </button>
          <span>
            Sprints {visible[0]?.sprint}-{visible[visible.length - 1]?.sprint} of {board.columns[board.columns.length - 1]?.sprint}
          </span>
          <button
            type="button"
            className="pm-delivery__inline-button"
            disabled={safePage >= pageCount - 1}
            onClick={() => onPageChange(Math.min(pageCount - 1, safePage + 1))}
          >
            Later sprints &rarr;
          </button>
        </div>
      )}
    </>
  );
}

export const SPRINT_BOARD_PAGE_SIZE = SPRINTS_PER_PAGE;
