/**
 * Pure placement math and Backlog filtering helpers (Story 21.1, AR-4).
 *
 * This module is the epic's only genuinely unit-testable surface (AR-7): all
 * free-placement reordering, bucket boundary clamping, drop-line midpoint
 * calculation, item→element index mapping, and Backlog filtering live here as
 * pure functions — never in the component. The component (`ForecastWorkspace`)
 * consumes these helpers; the UI only renders and dispatches.
 *
 * All functions are side-effect free: no DOM access, no mutations of their
 * inputs, and every returned array/object is readonly.
 *
 * Index spaces:
 * - **Item space** — an index into the flat `selectedFeatureIds` order. Each
 *   bucket member occupies its own index.
 * - **Element space** — an index into the rendered Priority list, where each
 *   bucket collapses its N members into a single wrapper. Drop-line rendering
 *   must use element space; splicing an item-space index into an element-space
 *   array is the defect this module exists to prevent (forecast-workspace.tsx
 *   dropIndex splice, 2026-09-07).
 */

import type { ForecastParallelGroup } from '../../../domain/forecast/forecast-plan.entity';

/** A successful reorder: the new priority order and rebuilt groups. */
export interface MoveBlockSuccess {
  readonly success: true;
  readonly ids: readonly string[];
  readonly groups: readonly ForecastParallelGroup[];
}

/** A refused reorder: the request would split an existing parallel group. */
export interface MoveBlockFailure {
  readonly success: false;
  readonly error: string;
}

export type MoveBlockResult = MoveBlockSuccess | MoveBlockFailure;

/** Minimal bounding-box shape used for drop-line midpoint math. */
export interface RectLike {
  readonly top: number;
  readonly height: number;
}

/** Minimal Backlog row shape consumed by `filterBacklogItems`. */
export interface BacklogItemFilterable {
  readonly title: string;
}

/** The explanatory message for a refused group-splitting drop. */
export const GROUP_SPLIT_ERROR_MESSAGE =
  'That position splits a parallel group. Place it before or after the group, or ungroup first.';

/**
 * Deterministic bucket letter from the group's array index (UX-DR6): A..Z,
 * then AA, AB, … so groups past the 26th stay distinguishable
 * (Story 21.11 AC 22).
 */
export function bucketLetterForIndex(groupIndex: number): string {
  const n = Math.max(0, groupIndex);
  const letters: string[] = [];
  let value = n;
  do {
    letters.unshift(String.fromCharCode(65 + (value % 26)));
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return letters.join('');
}

/**
 * Move a block of item IDs (one row, a whole bucket's members, or a grabbed
 * keyboard selection) to `targetIndex` in the flat priority order.
 *
 * The target index is expressed in the *full* (pre-move) list and is
 * translated to account for the block's own members being removed first. Every
 * parallel group must remain strictly contiguous afterwards — a group whose
 * members are wholly inside the block is exempt (it moves as a unit), while a
 * group the block only partially leaves must keep its remaining members
 * contiguous.
 *
 * Returns `{ success: false, error }` (with the original order preserved) when
 * the placement would split a group, or a frozen `{ success: true, ids,
 * groups }` otherwise. Group member lists are rebuilt from the resulting order
 * (scope-priority canonical form); members that left a group are dropped, and
 * a group left with fewer than two members dissolves entirely (the sequence
 * wire contract rejects singleton groups — Story 21.3 AC 10).
 */
export function moveBlockToIndex(
  currentIds: readonly string[],
  blockIds: readonly string[],
  targetIndex: number,
  parallelGroups: readonly ForecastParallelGroup[],
): MoveBlockResult {
  if (currentIds.length <= 1 || blockIds.length === 0) {
    // Defensive copy — never freeze the caller's own array by reference
    // (Story 21.11 AC 4: the module documents "no mutations of inputs").
    return Object.freeze({
      success: true as const,
      ids: Object.freeze([...currentIds]),
      groups: Object.freeze(parallelGroups.map((g) => Object.freeze({ featureIds: Object.freeze([...g.featureIds]) }))),
    });
  }

  const blockSet = new Set(blockIds);
  const without = currentIds.filter((id) => !blockSet.has(id));
  const removedBefore = currentIds.slice(0, targetIndex).filter((id) => blockSet.has(id)).length;
  const upper = Math.max(0, Math.min(without.length, Math.max(0, targetIndex) - removedBefore));
  const ordered = blockIds.filter((id) => currentIds.includes(id));
  const nextIds = [...without.slice(0, upper), ...ordered, ...without.slice(upper)];

  for (const group of parallelGroups) {
    if (group.featureIds.every((id) => blockSet.has(id))) continue;
    const indices = group.featureIds.map((id) => nextIds.indexOf(id)).filter((i) => i !== -1);
    // A member absent from the order (deleted node) is not part of the
    // contiguity check, but 2+ surviving members must still stay contiguous —
    // skipping the check entirely would let a split bucket through
    // (Story 21.11 AC 3).
    if (indices.length < 2) continue;
    const min = Math.min(...indices);
    const max = Math.max(...indices);
    if (max - min + 1 !== indices.length) {
      return Object.freeze({ success: false as const, error: GROUP_SPLIT_ERROR_MESSAGE });
    }
  }

  const nextGroups: ForecastParallelGroup[] = [];
  for (const group of parallelGroups) {
    const kept = nextIds.filter((id) => group.featureIds.includes(id));
    if (kept.length >= 2) {
      nextGroups.push(Object.freeze({ featureIds: Object.freeze([...kept]) }));
    }
  }

  return Object.freeze({
    success: true as const,
    ids: Object.freeze([...nextIds]),
    groups: Object.freeze(nextGroups),
  });
}

/**
 * Resolve a bucket member drag (Story 21.3 AC 6/9/10). `targetIndex` is the
 * *raw* item-space drop position (pre-clamp, from `calculateDropIndexFromMidpoints`).
 *
 * - A target over the member's own bucket span — anywhere from its header gap
 *   to the gap after the last member (`first <= t <= last + 1`) — is an
 *   intra-bucket move: a no-op when the member cannot travel further, or a
 *   tie-display reorder; the group survives with its order updated.
 * - Any target above the header or below the final gap is a drag-out: the
 *   member leaves the group and lands at the target in the same operation
 *   (`onSetForecastSequence` emits once), the group is rebuilt, and a group
 *   left with a single member dissolves (the sequence wire contract rejects
 *   singleton groups).
 *
 * A non-member target falls through to plain `moveBlockToIndex`.
 */
export function moveGroupMember(
  currentIds: readonly string[],
  memberId: string,
  targetIndex: number,
  parallelGroups: readonly ForecastParallelGroup[],
): MoveBlockResult {
  const group = parallelGroups.find((g) => g.featureIds.includes(memberId));
  if (!group) {
    return moveBlockToIndex(currentIds, Object.freeze([memberId]), targetIndex, parallelGroups);
  }

  const indices = group.featureIds.map((id) => currentIds.indexOf(id)).filter((i) => i !== -1);
  // No resolvable members (all deleted): fall back to a plain move — never
  // `Math.min(...[])` → Infinity (Story 21.11 AC 5).
  if (indices.length === 0) {
    return moveBlockToIndex(currentIds, Object.freeze([memberId]), targetIndex, parallelGroups);
  }
  const first = Math.min(...indices);
  const last = Math.max(...indices);
  const insideBucketSpan = targetIndex >= first && targetIndex <= last + 1;

  if (insideBucketSpan) {
    // Intra-bucket move: the group is preserved (member stays inside).
    return moveBlockToIndex(currentIds, Object.freeze([memberId]), targetIndex, parallelGroups);
  }

  // Drag-out: rebuild the groups without the member first, so the span check
  // inside `moveBlockToIndex` sees a group the member is no longer part of.
  const adjusted: ForecastParallelGroup[] = [];
  for (const g of parallelGroups) {
    const kept = g.featureIds.filter((id) => id !== memberId);
    if (kept.length >= 2) {
      adjusted.push(Object.freeze({ featureIds: Object.freeze([...kept]) }));
    }
  }
  return moveBlockToIndex(
    currentIds,
    Object.freeze([memberId]),
    targetIndex,
    Object.freeze(adjusted),
  );
}

/**
 * Snap a drop index to a bucket's exterior boundaries when it would otherwise
 * land strictly between the bucket's members. `targetIndex` is in item space.
 * For each group occupying contiguous positions `[first..last]` in `itemIds`,
 * a target strictly inside (`first < target <= last` — the drop would land
 * between members) snaps to whichever exterior boundary is nearer: immediately
 * before the bucket header (index `first`) or immediately after the last
 * member (index `last + 1`); ties snap above the header. Targets at the
 * exterior boundaries themselves are returned unchanged.
 *
 * Groups are mutually disjoint by domain invariant (AR-5, AR-18), so the
 * target can sit strictly inside at most one group; the first hit wins.
 */
export function clampDropIndexForBuckets(
  targetIndex: number,
  parallelGroups: readonly ForecastParallelGroup[],
  itemIds: readonly string[],
): number {
  for (const group of parallelGroups) {
    const indices = group.featureIds.map((id) => itemIds.indexOf(id)).filter((i) => i !== -1);
    if (indices.length < 2) continue;
    const first = Math.min(...indices);
    const last = Math.max(...indices);
    if (targetIndex > first && targetIndex <= last) {
      const beforeDelta = targetIndex - first;
      const afterDelta = last + 1 - targetIndex;
      if (afterDelta < beforeDelta) return last + 1;
      return first;
    }
  }

  return targetIndex;
}

/**
 * Convert a client Y coordinate into an item-space drop index from the rows'
 * vertical midpoints: `0` above the first midpoint, `rowRects.length` below
 * the final midpoint, otherwise the index of the first row whose midpoint is
 * below `clientY`. Rects are per *item*, never per rendered element.
 */
export function calculateDropIndexFromMidpoints(
  clientY: number,
  rowRects: readonly RectLike[],
): number {
  for (let i = 0; i < rowRects.length; i += 1) {
    const rect = rowRects[i];
    if (clientY < rect.top + rect.height / 2) return i;
  }
  return rowRects.length;
}

/** A rendered row's rect plus its item-space index (virtualized lists). */
export interface IndexedRowRect extends RectLike {
  /** Index of this row in the flat priority (item) order. */
  readonly itemIndex: number;
}

/**
 * Item-space drop index from rendered rows only (Story 23.11 AC 23.11-2).
 *
 * The virtualized Priority list renders a bounded window, so rects are not
 * contiguous — a focused or edited row may be pinned far from the scrolled
 * window. `calculateDropIndexFromMidpoints` assumes a contiguous run in item
 * order; this variant uses each rect's `itemIndex`, so a gap between the
 * window and a pinned row can never shift the index by the gap size.
 *
 * Rows are expected in item order. A `clientY` above every rendered midpoint
 * resolves to the first rendered row's item index; below every midpoint to the
 * last rendered row's item index plus one. With no rendered rows the index is
 * `0` (the prior behaviour for an unregistered list).
 */
export function calculateDropIndexFromIndexedMidpoints(
  clientY: number,
  rows: readonly IndexedRowRect[],
): number {
  if (rows.length === 0) return 0;
  for (const row of rows) {
    if (clientY < row.top + row.height / 2) return row.itemIndex;
  }
  return rows[rows.length - 1].itemIndex + 1;
}

/**
 * Map an item-space drop index to render (element) space, where each bucket's
 * N members collapse to a single rendered wrapper. An element is counted as we
 * pass (a) any non-member item, or (b) a bucket's final member — so an index
 * inside a bucket collapses to the bucket's own element slot (the same
 * exterior-before position the clamp snaps to), never a gap after it. The
 * result is the element index at which the drop line must be spliced.
 */
export function toElementIndex(
  itemIndex: number,
  parallelGroups: readonly ForecastParallelGroup[],
  itemIds: readonly string[],
): number {
  const clamped = Math.max(0, Math.min(itemIndex, itemIds.length));
  const members = new Set<string>();
  const lastMembers = new Set<string>();
  parallelGroups.forEach((group) => {
    group.featureIds.forEach((id) => members.add(id));
    const positions = group.featureIds
      .map((id) => itemIds.indexOf(id))
      .filter((i) => i !== -1);
    if (positions.length === 0) return;
    lastMembers.add(itemIds[Math.max(...positions)]);
  });

  let elements = 0;
  for (let i = 0; i < clamped; i += 1) {
    const id = itemIds[i];
    if (!members.has(id) || lastMembers.has(id)) elements += 1;
  }
  return elements;
}

/**
 * Filter Backlog items by a case-insensitive title query, preserving original
 * order. An empty or whitespace-only query returns all items unchanged. A
 * null/undefined/empty title matches the query `"untitled"` — the same
 * `it.title || 'Untitled'` contract every render site uses (Story 21.11 AC 1).
 */
export function filterBacklogItems<T extends BacklogItemFilterable>(
  items: readonly T[],
  query: string,
): readonly T[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === '') return items;
  return items.filter((item) => (item.title || 'Untitled').toLowerCase().includes(normalized));
}

// ── Backlog hierarchy: nesting among rows at the same planning level ──

/**
 * A Backlog row's place in the hierarchy. `parentId` is the nearest
 * ancestor that is *also* a row at the planning level — nodes at other
 * levels are skipped, so a Feature nested under a Feature reads as a child
 * even when a Component sits between them.
 */
export interface BacklogHierarchyItem {
  readonly id: string;
  readonly parentId: string | null;
}

/** The ids that have at least one child among these rows. */
export function backlogParentIds(items: readonly BacklogHierarchyItem[]): ReadonlySet<string> {
  const present = new Set(items.map((item) => item.id));
  const parents = new Set<string>();
  for (const item of items) {
    if (item.parentId !== null && present.has(item.parentId)) parents.add(item.parentId);
  }
  return parents;
}

/**
 * Drop every row that sits under a collapsed ancestor, at any depth. The
 * collapsed row itself stays visible (it holds the caret that reopens it).
 * A parent chain that cycles, or leaves the list, terminates the walk
 * instead of hanging.
 */
export function visibleBacklogItems<T extends BacklogHierarchyItem>(
  items: readonly T[],
  collapsedIds: ReadonlySet<string>,
): readonly T[] {
  if (collapsedIds.size === 0) return items;
  const parentOf = new Map(items.map((item) => [item.id, item.parentId] as const));
  return items.filter((item) => {
    const seen = new Set<string>([item.id]);
    let ancestor = item.parentId;
    while (ancestor !== null && !seen.has(ancestor) && parentOf.has(ancestor)) {
      if (collapsedIds.has(ancestor)) return false;
      seen.add(ancestor);
      ancestor = parentOf.get(ancestor) ?? null;
    }
    return true;
  });
}

/** The fields `sortByTreeOrder` needs: a node's parent and its sibling rank. */
export interface TreeOrderable {
  readonly id: string;
  readonly parentId: string | null;
  /** Domain nodes carry a `bigint`; plain numbers are accepted too. */
  readonly position: number | bigint;
}

/**
 * Reorder a flat node list into outline pre-order: each node directly
 * followed by its whole subtree, siblings by `position` then `id`.
 *
 * The read model returns nodes sorted by `position` across the whole
 * project, and `position` only ranks siblings, so that order interleaves
 * unrelated subtrees. Sort the FULL tree before filtering to one planning
 * level: pre-order restricted to any subset still keeps every same-level
 * subtree contiguous under its ancestor, even across skipped levels.
 *
 * A node whose parent is absent is a root. Nodes caught in a parent cycle
 * (unreachable from any root) are appended rather than dropped.
 */
export function sortByTreeOrder<T extends TreeOrderable>(nodes: readonly T[]): readonly T[] {
  const ids = new Set(nodes.map((node) => node.id));
  const childrenOf = new Map<string | null, T[]>();
  for (const node of nodes) {
    const parent = node.parentId !== null && ids.has(node.parentId) ? node.parentId : null;
    const list = childrenOf.get(parent);
    if (list) list.push(node);
    else childrenOf.set(parent, [node]);
  }
  // Relational operators, never subtraction: `bigint - number` throws, and
  // they compare mixed bigint/number positions correctly.
  const bySiblingRank = (a: T, b: T): number => {
    if (a.position < b.position) return -1;
    if (a.position > b.position) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
  for (const list of childrenOf.values()) list.sort(bySiblingRank);

  const ordered: T[] = [];
  const emitted = new Set<string>();
  // Iterative, so a deep outline cannot overflow the stack.
  const stack = [...(childrenOf.get(null) ?? [])].reverse();
  while (stack.length > 0) {
    const node = stack.pop() as T;
    if (emitted.has(node.id)) continue;
    emitted.add(node.id);
    ordered.push(node);
    const children = childrenOf.get(node.id);
    if (children) for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
  }
  for (const node of nodes) if (!emitted.has(node.id)) ordered.push(node);
  return ordered;
}

// ── Story 21.4: keyboard grab-and-drop pure helpers (AC 21.4-2/5/11) ──

/** One `‹title›, position N of M` slot announcement for a grabbed row. */
export function formatRowPositionAnnouncement(
  title: string,
  position: number,
  totalSlots: number,
): string {
  return `${title}, position ${position} of ${totalSlots}`;
}

/** One `Bucket ‹letter› (N items), position P of M` announcement. */
export function formatBucketPositionAnnouncement(
  bucketLetter: string,
  itemCount: number,
  position: number,
  totalSlots: number,
): string {
  return `Bucket ${bucketLetter} (${itemCount} items), position ${position} of ${totalSlots}`;
}

/** Cancellation announcement (row or bucket) — AC 21.4-5. */
export function formatGrabCancelledAnnouncement(
  isBucket: boolean,
  label: string,
): string {
  return isBucket
    ? `Reorder cancelled; bucket ${label} ungrabbed`
    : `Reorder cancelled; ${label} ungrabbed`;
}

/**
 * Count the render (slot) positions in the priority list: a bucket occupies
 * exactly one slot regardless of member count; every other row is one slot
 * (AC 21.4-11 — row and bucket announcements share the same `M`). A group
 * whose members are all absent from `itemIds` contributes no slot
 * (Story 21.11 AC 2 — it must agree with `slotPositionOfBlock` and
 * `clampDropIndexForBuckets`, which both skip unresolvable groups).
 */
export function countPrioritySlots(itemIds: readonly string[], parallelGroups: readonly ForecastParallelGroup[]): number {
  const members = new Set<string>();
  let resolvableGroups = 0;
  parallelGroups.forEach((g) => {
    const present = g.featureIds.filter((id) => itemIds.includes(id)).length;
    if (present < 2) return;
    resolvableGroups += 1;
    g.featureIds.forEach((id) => members.add(id));
  });
  return itemIds.filter((id) => !members.has(id)).length + resolvableGroups;
}

/**
 * The slot-space position (1..M) of a grabbed block in the current order —
 * used by the `‹title›, position N of M` / `Bucket ‹letter› (N items),
 * position P of M` announcement builders (AC 21.4-2/6/11).
 */
export function slotPositionOfBlock(
  itemIds: readonly string[],
  blockIds: readonly string[],
  parallelGroups: readonly ForecastParallelGroup[],
): number {
  const positions = blockIds.map((id) => itemIds.indexOf(id)).filter((i) => i !== -1);
  if (positions.length === 0) return 1;
  const first = Math.min(...positions);

  const bucketBounds = new Map<string, { first: number; last: number }>();
  for (const g of parallelGroups) {
    const pos = g.featureIds.map((id) => itemIds.indexOf(id)).filter((i) => i !== -1);
    if (pos.length < 2) continue;
    const bounds = { first: Math.min(...pos), last: Math.max(...pos) };
    g.featureIds.forEach((id) => bucketBounds.set(id, bounds));
  }

  const firstSlotIndex = bucketBounds.get(itemIds[first])?.first ?? first;
  let slotsBefore = 0;
  for (let i = 0; i < firstSlotIndex; i += 1) {
    const bounds = bucketBounds.get(itemIds[i]);
    if (bounds) {
      // A bucket header is one slot; skip its remaining members.
      if (bounds.first === i) slotsBefore += 1;
      continue;
    }
    slotsBefore += 1;
  }
  return slotsBefore + 1;
}

function bucketBoundsFor(
  currentIds: readonly string[],
  parallelGroups: readonly ForecastParallelGroup[],
): ReadonlyMap<string, { first: number; last: number }> {
  const bounds = new Map<string, { first: number; last: number }>();
  for (const g of parallelGroups) {
    const pos = g.featureIds.map((id) => currentIds.indexOf(id)).filter((i) => i !== -1);
    if (pos.length < 2) continue;
    const b = { first: Math.min(...pos), last: Math.max(...pos) };
    g.featureIds.forEach((id) => bounds.set(id, b));
  }
  return bounds;
}

/**
 * The item-space insertion target for a ±1-slot keyboard move of a grabbed
 * block (AC 21.4-2/4/6).
 *
 * - A **plain row** steps one slot: up lands in the gap before its
 *   predecessor (`first - 1`), down in the gap after its successor
 *   (`last + 2`, which `moveBlockToIndex` translates to one position down).
 * - A grabbed **whole bucket** moves as one contiguous block, landing one
 *   slot past the adjacent slot — above a preceding bucket's header gap or
 *   below a following bucket's last-member gap.
 * - A single **member** of a bucket only reorders tie-display inside it
 *   (AC 21.3-6): step up swaps with the member above (`first - 1`, refused
 *   at the header), step down swaps with the member below (`first + 1`,
 *   refused at the last member).
 * - A row stepping toward an **adjacent bucket** skips the whole bucket
 *   atomically (Story 21.4 Task 2): up lands above its header (`group.first`),
 *   down lands below its final member (`group.last + 1`).
 *
 * Returns `null` at the list edges or for an unresolvable block. The result
 * is meant for `moveBlockToIndex` / `moveGroupMember` (which still refuse any
 * group-split landing defensively).
 */
export function computeGrabMoveTarget(
  currentIds: readonly string[],
  blockIds: readonly string[],
  parallelGroups: readonly ForecastParallelGroup[],
  direction: -1 | 1,
): number | null {
  if (blockIds.length === 0 || currentIds.length <= 1) return null;
  const positions = blockIds.map((id) => currentIds.indexOf(id));
  if (positions.some((i) => i === -1) || positions.length !== blockIds.length) return null;
  const first = Math.min(...positions);
  const last = Math.max(...positions);
  const bounds = bucketBoundsFor(currentIds, parallelGroups);

  const blockSet = new Set(blockIds);
  const isBucketBlock =
    blockIds.length >= 2 &&
    parallelGroups.some((g) => g.featureIds.every((id) => blockSet.has(id)));
  const ownerBucket =
    blockIds.length === 1
      ? parallelGroups.find((g) => g.featureIds.includes(blockIds[0]))
      : undefined;

  if (direction === -1) {
    if (first === 0) return null;
    if (ownerBucket) {
      // Member: tie-display only — refuse at the bucket header.
      const own = bounds.get(ownerBucket.featureIds[0]);
      if (own && first === own.first) return null;
      return first - 1;
    }
    const prev = currentIds[first - 1];
    const prevBounds = bounds.get(prev);
    if (isBucketBlock) {
      if (prevBounds) return prevBounds.first;
      return first - 1;
    }
    if (prevBounds) return prevBounds.first;
    return first - 1;
  }

  if (last >= currentIds.length - 1) return null;
  if (ownerBucket) {
    // Member: tie-display only — refuse at the last member.
    const own = bounds.get(ownerBucket.featureIds[0]);
    if (own && first === own.last) return null;
    // `moveBlockToIndex` removes the member before inserting, so the gap *after*
    // the next member is `first + 2` — `first + 1` resolves back to its own slot.
    return first + 2;
  }
  const next = currentIds[last + 1];
  const nextBounds = bounds.get(next);
  if (isBucketBlock) {
    if (nextBounds) return Math.min(currentIds.length, nextBounds.last + 1);
    return Math.min(currentIds.length, last + 2);
  }
  if (nextBounds) return Math.min(currentIds.length, nextBounds.last + 1);
  return Math.min(currentIds.length, last + 2);
}
