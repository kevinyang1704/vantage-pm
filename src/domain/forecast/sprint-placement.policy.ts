/**
 * Sprint placement policy (Delivery Board sprint plan).
 *
 * Pure: given the ranked scope, each item's remaining points, the team's
 * points per sprint, any per-sprint capacity override, the items the user
 * placed by hand, and the dependencies between items, decide which sprint(s)
 * every item lands in.
 *
 * Rules:
 * - Hand-placed items go first, in sprint order then rank. Each starts in the
 *   sprint it was dropped into and fills that sprint's free capacity; any
 *   points left carry into the next sprint, and the next, which must each
 *   have room. A sprint with no free capacity cannot take a new item.
 * - An item cannot be placed while it is blocked, has no estimate, or depends
 *   on an item that is not delivered and does not finish in an earlier
 *   sprint. A dependency outside the plan that is not delivered holds it too.
 * - With `autoFill` on (the default), every other item is placed by the
 *   forecast in rank order, into the earliest sprint after its dependencies
 *   finish, using whatever capacity the hand-placed items left. It may pause
 *   across a full sprint. With `autoFill` off, only hand-placed items are in
 *   sprints; the rest stay unscheduled until someone drags them in.
 * - An item that cannot be placed is held, with the reason.
 *
 * The policy never mutates its input and performs no I/O.
 */

export type SprintPlacementItem = Readonly<{
  id: string;
  /** Remaining points; null when the item has no estimate. */
  points: number | null;
  delivered: boolean;
  blocked: boolean;
}>;

export type SprintDependency = Readonly<{
  /** The item that must be done first. */
  sourceId: string;
  /** The item that waits for it. */
  targetId: string;
}>;

export type SprintPlacementInput = Readonly<{
  /** Scope in priority order. */
  items: readonly SprintPlacementItem[];
  /** Items at the planning level that are not in the plan (dependency sources only). */
  outsideItems?: ReadonlyMap<string, Readonly<{ delivered: boolean }>>;
  dependencies: readonly SprintDependency[];
  /** Team points per sprint; the capacity of a sprint with no override. */
  teamCapacity: number;
  /** Per-sprint capacity overrides keyed by sprint ordinal (decimal string). */
  capacities: Readonly<Record<string, number>>;
  /** Hand placements in the order they were made: each item starts in its sprint. */
  placements: readonly Readonly<{ itemId: string; sprint: number }>[];
  /** The first sprint work can go into (the current sprint). */
  firstSprint: number;
  /** How many sprints past `firstSprint` the forecast may look. */
  horizonSprints?: number;
  /** Fill the room hand placements leave with the rest, in rank order. Default true. */
  autoFill?: boolean;
}>;

export type SprintSlice = Readonly<{ sprint: number; points: number }>;

export type SprintAllocation = Readonly<{
  id: string;
  source: 'placed' | 'forecast';
  startSprint: number;
  finishSprint: number;
  slices: readonly SprintSlice[];
}>;

export type HoldReason =
  | Readonly<{ kind: 'blocked' }>
  | Readonly<{ kind: 'unestimated' }>
  | Readonly<{ kind: 'waiting'; on: readonly string[] }>
  | Readonly<{ kind: 'outside'; on: readonly string[] }>
  | Readonly<{ kind: 'cycle'; on: readonly string[] }>
  | Readonly<{ kind: 'full'; sprint: number }>
  | Readonly<{ kind: 'overflow'; sprint: number }>
  | Readonly<{ kind: 'no-room' }>;

export type SprintLoad = Readonly<{
  sprint: number;
  capacity: number;
  /** Points used by hand-placed items. */
  placedPoints: number;
  /** Points used by forecast-placed items. */
  forecastPoints: number;
  overridden: boolean;
}>;

export type SprintPlacement = Readonly<{
  allocations: ReadonlyMap<string, SprintAllocation>;
  held: ReadonlyMap<string, HoldReason>;
  /** Hand placements that no longer hold (the item is held instead). */
  brokenPlacements: readonly string[];
  /** Load per sprint from `firstSprint` through the last sprint with work. */
  sprints: readonly SprintLoad[];
  lastSprint: number;
}>;

const DEFAULT_HORIZON_SPRINTS = 520;

function capacityOf(input: SprintPlacementInput, sprint: number): number {
  const override = input.capacities[String(sprint)];
  return typeof override === 'number' ? override : Math.max(input.teamCapacity, 0);
}

export function calculateSprintPlacement(input: SprintPlacementInput): SprintPlacement {
  const horizon = Math.max(input.horizonSprints ?? DEFAULT_HORIZON_SPRINTS, 1);
  const lastAllowed = input.firstSprint + horizon - 1;
  const rank = new Map(input.items.map((item, index) => [item.id, index] as const));
  const byId = new Map(input.items.map((item) => [item.id, item] as const));

  const predecessors = new Map<string, string[]>();
  for (const edge of input.dependencies) {
    if (!byId.has(edge.targetId) || edge.sourceId === edge.targetId) continue;
    if (!byId.has(edge.sourceId) && !input.outsideItems?.has(edge.sourceId)) continue;
    const list = predecessors.get(edge.targetId) ?? [];
    if (!list.includes(edge.sourceId)) list.push(edge.sourceId);
    predecessors.set(edge.targetId, list);
  }

  const used = new Map<number, { placed: number; forecast: number }>();
  const usedAt = (sprint: number) => {
    let entry = used.get(sprint);
    if (!entry) {
      entry = { placed: 0, forecast: 0 };
      used.set(sprint, entry);
    }
    return entry;
  };
  const freeAt = (sprint: number): number => {
    const entry = used.get(sprint);
    return capacityOf(input, sprint) - (entry ? entry.placed + entry.forecast : 0);
  };

  const allocations = new Map<string, SprintAllocation>();
  const held = new Map<string, HoldReason>();

  const isDone = (id: string): boolean => {
    const item = byId.get(id);
    if (item) return item.delivered;
    return input.outsideItems?.get(id)?.delivered ?? false;
  };

  /** Reason an item cannot start in `sprint`, from its own state and dependencies. */
  const dependencyHold = (id: string, sprint: number | null): HoldReason | null => {
    const outside: string[] = [];
    const waiting: string[] = [];
    for (const sourceId of predecessors.get(id) ?? []) {
      if (isDone(sourceId)) continue;
      if (!byId.has(sourceId)) {
        outside.push(sourceId);
        continue;
      }
      const allocation = allocations.get(sourceId);
      if (!allocation || (sprint !== null && allocation.finishSprint >= sprint)) waiting.push(sourceId);
    }
    if (outside.length > 0) return Object.freeze({ kind: 'outside', on: Object.freeze(outside) });
    if (waiting.length > 0) return Object.freeze({ kind: 'waiting', on: Object.freeze(waiting) });
    return null;
  };

  const ownHold = (item: SprintPlacementItem): HoldReason | null => {
    if (item.blocked) return Object.freeze({ kind: 'blocked' });
    if (item.points === null) return Object.freeze({ kind: 'unestimated' });
    return null;
  };

  // ── 1. Hand-placed items ─────────────────────────────────────────────────
  // By sprint, then in the order they were placed: work already in a sprint
  // keeps its room when more arrives.
  const placedSprint = new Map<string, number>();
  const placedOrder = new Map<string, number>();
  input.placements.forEach((placement, index) => {
    placedSprint.set(placement.itemId, placement.sprint);
    placedOrder.set(placement.itemId, index);
  });
  const placedIds = input.items
    .filter((item) => !item.delivered && placedSprint.has(item.id))
    .map((item) => item.id)
    .sort((a, b) => {
      const sa = Math.max(placedSprint.get(a)!, input.firstSprint);
      const sb = Math.max(placedSprint.get(b)!, input.firstSprint);
      return sa - sb || placedOrder.get(a)! - placedOrder.get(b)!;
    });
  const brokenPlacements: string[] = [];

  for (const id of placedIds) {
    const item = byId.get(id)!;
    const start = Math.max(placedSprint.get(id)!, input.firstSprint);
    const reason = ownHold(item) ?? dependencyHold(id, start);
    if (reason) {
      held.set(id, reason);
      brokenPlacements.push(id);
      continue;
    }
    const points = item.points ?? 0;
    if (points > 0 && freeAt(start) <= 0) {
      held.set(id, Object.freeze({ kind: 'full', sprint: start }));
      brokenPlacements.push(id);
      continue;
    }
    const slices: SprintSlice[] = [];
    let remaining = points;
    let sprint = start;
    let failedAt: number | null = null;
    while (remaining > 0) {
      if (sprint > lastAllowed) {
        failedAt = sprint;
        break;
      }
      const free = freeAt(sprint);
      if (free <= 0) {
        failedAt = sprint;
        break;
      }
      const take = Math.min(free, remaining);
      slices.push(Object.freeze({ sprint, points: take }));
      remaining -= take;
      sprint += 1;
    }
    if (failedAt !== null) {
      held.set(id, Object.freeze({ kind: 'overflow', sprint: failedAt }));
      brokenPlacements.push(id);
      continue;
    }
    if (slices.length === 0) slices.push(Object.freeze({ sprint: start, points: 0 }));
    for (const slice of slices) usedAt(slice.sprint).placed += slice.points;
    allocations.set(
      id,
      Object.freeze({
        id,
        source: 'placed',
        startSprint: slices[0].sprint,
        finishSprint: slices[slices.length - 1].sprint,
        slices: Object.freeze(slices),
      }),
    );
  }

  // ── 2. Forecast placement for everything else ───────────────────────────
  let pending = input.items.filter(
    (item) => !item.delivered && !allocations.has(item.id) && !held.has(item.id),
  );
  for (const item of pending) {
    const reason = ownHold(item);
    if (reason) held.set(item.id, reason);
  }
  pending = pending.filter((item) => !held.has(item.id));

  if (input.autoFill === false) {
    // Nothing is placed automatically. Say why an item could not be placed
    // yet, where that is already known; the rest simply wait to be dragged in.
    // Repeat until nothing changes, so a hold travels down a dependency chain
    // whatever the rank order.
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of pending) {
        if (held.has(item.id)) continue;
        const sources = predecessors.get(item.id) ?? [];
        const outside = sources.filter((sourceId) => !byId.has(sourceId) && !isDone(sourceId));
        const heldSources = sources.filter((sourceId) => held.has(sourceId));
        if (outside.length > 0) held.set(item.id, Object.freeze({ kind: 'outside', on: Object.freeze(outside) }));
        else if (heldSources.length > 0) held.set(item.id, Object.freeze({ kind: 'waiting', on: Object.freeze(heldSources) }));
        else continue;
        changed = true;
      }
    }
    pending = [];
  }

  let progressed = true;
  while (pending.length > 0 && progressed) {
    progressed = false;
    const deferred: SprintPlacementItem[] = [];
    for (const item of pending) {
      const sources = predecessors.get(item.id) ?? [];
      const outside = sources.filter((sourceId) => !byId.has(sourceId) && !isDone(sourceId));
      if (outside.length > 0) {
        held.set(item.id, Object.freeze({ kind: 'outside', on: Object.freeze(outside) }));
        progressed = true;
        continue;
      }
      const heldSources = sources.filter((sourceId) => held.has(sourceId));
      if (heldSources.length > 0) {
        held.set(item.id, Object.freeze({ kind: 'waiting', on: Object.freeze(heldSources) }));
        progressed = true;
        continue;
      }
      const open = sources.filter(
        (sourceId) => byId.has(sourceId) && !isDone(sourceId) && !allocations.has(sourceId),
      );
      if (open.length > 0) {
        deferred.push(item);
        continue;
      }
      let earliest = input.firstSprint;
      for (const sourceId of sources) {
        const allocation = allocations.get(sourceId);
        if (allocation) earliest = Math.max(earliest, allocation.finishSprint + 1);
      }
      const points = item.points ?? 0;
      const slices: SprintSlice[] = [];
      let remaining = points;
      let sprint = earliest;
      while (remaining > 0 && sprint <= lastAllowed) {
        const free = freeAt(sprint);
        if (free > 0) {
          const take = Math.min(free, remaining);
          slices.push(Object.freeze({ sprint, points: take }));
          remaining -= take;
        }
        sprint += 1;
      }
      progressed = true;
      if (remaining > 0) {
        held.set(item.id, Object.freeze({ kind: 'no-room' }));
        continue;
      }
      if (slices.length === 0) slices.push(Object.freeze({ sprint: earliest, points: 0 }));
      for (const slice of slices) usedAt(slice.sprint).forecast += slice.points;
      allocations.set(
        item.id,
        Object.freeze({
          id: item.id,
          source: 'forecast',
          startSprint: slices[0].sprint,
          finishSprint: slices[slices.length - 1].sprint,
          slices: Object.freeze(slices),
        }),
      );
    }
    pending = deferred;
  }
  for (const item of pending) {
    const on = (predecessors.get(item.id) ?? []).filter((sourceId) => !allocations.has(sourceId) && !isDone(sourceId));
    held.set(item.id, Object.freeze({ kind: 'cycle', on: Object.freeze(on) }));
  }

  let lastSprint = input.firstSprint;
  for (const allocation of allocations.values()) lastSprint = Math.max(lastSprint, allocation.finishSprint);
  for (const sprint of used.keys()) lastSprint = Math.max(lastSprint, sprint);

  const sprints: SprintLoad[] = [];
  for (let sprint = input.firstSprint; sprint <= lastSprint; sprint += 1) {
    const entry = used.get(sprint);
    sprints.push(
      Object.freeze({
        sprint,
        capacity: capacityOf(input, sprint),
        placedPoints: entry?.placed ?? 0,
        forecastPoints: entry?.forecast ?? 0,
        overridden: typeof input.capacities[String(sprint)] === 'number',
      }),
    );
  }

  return Object.freeze({
    allocations,
    held,
    brokenPlacements: Object.freeze(brokenPlacements),
    sprints: Object.freeze(sprints),
    lastSprint,
  });
}

export type SprintPlanChange = Readonly<{
  placements: readonly Readonly<{ itemId: string; sprint: number }>[];
  capacities: Readonly<Record<string, number>>;
}>;

export type SprintPlanVerdict =
  | Readonly<{
      ok: true;
      placement: SprintPlacement;
      /** The placements to store: the change plus any dependencies kept in place. */
      placements: readonly Readonly<{ itemId: string; sprint: number }>[];
      addedPlacements: readonly string[];
    }>
  | Readonly<{
      ok: false;
      /** The item the change was about, when one was. */
      itemId: string | null;
      reason: HoldReason | Readonly<{ kind: 'delivered' }> | Readonly<{ kind: 'past'; sprint: number }>;
      /** Hand-placed items the change would knock out of their sprint. */
      displaced: readonly string[];
    }>;

/**
 * Check a proposed sprint plan change against the rules above.
 *
 * `itemId`/`sprint` names a drop: the item is to start in `sprint`. Any of its
 * dependencies in the plan that are only placed by the forecast are kept in
 * the sprint the forecast shows them in (they become hand placements too), so
 * dropping an item never lets its dependencies slide after it. The change is
 * refused when the dropped item would not hold in that sprint, or when an
 * existing hand placement would stop holding.
 */
export function evaluateSprintPlanChange(
  input: SprintPlacementInput,
  change: SprintPlanChange,
  drop?: Readonly<{ itemId: string; sprint: number }>,
): SprintPlanVerdict {
  const before = calculateSprintPlacement(input);
  let placements: Readonly<{ itemId: string; sprint: number }>[] = [...change.placements];
  const addedPlacements: string[] = [];
  const refuse = (
    reason: Extract<SprintPlanVerdict, { ok: false }>['reason'],
    displaced: readonly string[] = [],
  ): SprintPlanVerdict =>
    Object.freeze({ ok: false, itemId: drop?.itemId ?? null, reason, displaced: Object.freeze([...displaced]) });

  if (drop) {
    const item = input.items.find((candidate) => candidate.id === drop.itemId);
    if (item?.delivered) return refuse(Object.freeze({ kind: 'delivered' }));
    if (drop.sprint < input.firstSprint) return refuse(Object.freeze({ kind: 'past', sprint: drop.sprint }));
    if (item?.blocked) return refuse(Object.freeze({ kind: 'blocked' }));
    if (item && item.points === null) return refuse(Object.freeze({ kind: 'unestimated' }));
    // A sprint whose capacity is used up by hand-placed work is full, and a
    // full sprint takes no new card, even one with no points.
    const alreadyThere = before.allocations.get(drop.itemId);
    const sameSprint = alreadyThere?.source === 'placed' && alreadyThere.startSprint === drop.sprint;
    if (!sameSprint) {
      let committed = 0;
      for (const allocation of before.allocations.values()) {
        if (allocation.source !== 'placed' || allocation.id === drop.itemId) continue;
        for (const slice of allocation.slices) if (slice.sprint === drop.sprint) committed += slice.points;
      }
      if (capacityOf(input, drop.sprint) - committed <= 0) {
        return refuse(Object.freeze({ kind: 'full', sprint: drop.sprint }));
      }
    }
    placements = placements.filter((placement) => placement.itemId !== drop.itemId);
    // Keep forecast-placed dependencies where they are shown, transitively.
    const placedIds = new Set(placements.map((placement) => placement.itemId));
    const sourcesOf = (id: string) =>
      input.dependencies.filter((edge) => edge.targetId === id).map((edge) => edge.sourceId);
    const queue = [...sourcesOf(drop.itemId)];
    const seen = new Set<string>([drop.itemId]);
    const kept: { itemId: string; sprint: number }[] = [];
    while (queue.length > 0) {
      const sourceId = queue.shift()!;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);
      if (placedIds.has(sourceId)) continue;
      const allocation = before.allocations.get(sourceId);
      if (allocation && allocation.source === 'forecast') {
        kept.push({ itemId: sourceId, sprint: allocation.startSprint });
        addedPlacements.push(sourceId);
        queue.push(...sourcesOf(sourceId));
      }
    }
    kept.sort((a, b) => a.sprint - b.sprint);
    placements = [...placements, ...kept, { itemId: drop.itemId, sprint: drop.sprint }];
  }

  const after = calculateSprintPlacement({ ...input, placements, capacities: change.capacities });
  if (drop) {
    const reason = after.held.get(drop.itemId);
    if (reason) return refuse(reason);
  }
  // An existing hand placement may not be knocked out or pushed later, and a
  // dependency kept in place must still hold.
  const knockedOut = placements
    .map((placement) => placement.itemId)
    .filter((id) => {
      if (id === drop?.itemId) return false;
      if (addedPlacements.includes(id)) return after.held.has(id);
      const prior = before.allocations.get(id);
      if (prior?.source !== 'placed') return false;
      const next = after.allocations.get(id);
      return !next || next.finishSprint > prior.finishSprint;
    });
  if (knockedOut.length > 0) {
    const first = knockedOut[0];
    const firstReason: HoldReason =
      after.held.get(first) ??
      Object.freeze({ kind: 'overflow', sprint: (before.allocations.get(first)?.finishSprint ?? 0) + 1 });
    return refuse(firstReason, knockedOut);
  }
  return Object.freeze({
    ok: true,
    placement: after,
    placements: Object.freeze(placements.map((placement) => Object.freeze({ ...placement }))),
    addedPlacements: Object.freeze(addedPlacements),
  });
}
