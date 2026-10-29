/**
 * Pure placement math and Backlog filtering helpers (Story 21.1, AC 21.1-1..7,
 * AR-4, AR-7, FR-6, FR-9, FR-11, NFR-1, NFR-2, UX-DR5).
 *
 * 100% logic coverage of `moveBlockToIndex`, `clampDropIndexForBuckets`,
 * `calculateDropIndexFromMidpoints`, `toElementIndex`, and
 * `filterBacklogItems` — no DOM, no mocking, Node environment only.
 */

import { describe, it, expect } from 'vitest';
import {
  moveBlockToIndex,
  moveGroupMember,
  clampDropIndexForBuckets,
  calculateDropIndexFromMidpoints,
  calculateDropIndexFromIndexedMidpoints,
  toElementIndex,
  filterBacklogItems,
  backlogParentIds,
  visibleBacklogItems,
  sortByTreeOrder,
  countPrioritySlots,
  slotPositionOfBlock,
  computeGrabMoveTarget,
  formatRowPositionAnnouncement,
  formatBucketPositionAnnouncement,
  formatGrabCancelledAnnouncement,
  bucketLetterForIndex,
  GROUP_SPLIT_ERROR_MESSAGE,
} from './forecast-placement';
import type { ForecastParallelGroup } from '../../../domain/forecast/forecast-plan.entity';
import type { IndexedRowRect } from './forecast-placement';

// Deterministic UUIDv7-shaped IDs (the entity imports assertUuidV7 at plan
// construction, but these helpers are ID-agnostic; the ids below stay
// v7-shaped so a future assertion never trips).
const A = '019ffe00-0000-7000-8000-00000000000a';
const B = '019ffe00-0000-7000-8000-00000000000b';
const C = '019ffe00-0000-7000-8000-00000000000c';
const D = '019ffe00-0000-7000-8000-00000000000d';
const E = '019ffe00-0000-7000-8000-00000000000e';
const X = '019ffe00-0000-7000-8000-00000000000f';

function group(ids: readonly string[]): ForecastParallelGroup {
  return Object.freeze({ featureIds: Object.freeze([...ids]) });
}

function expectFrozen(result: { readonly ids: readonly string[]; readonly groups: readonly ForecastParallelGroup[] }) {
  expect(Object.isFrozen(result.ids)).toBe(true);
  expect(Object.isFrozen(result.groups)).toBe(true);
  expect(Object.isFrozen(result)).toBe(true);
}

describe('moveBlockToIndex — AC 21.1-1: free placement of a single item or contiguous block', () => {
  it('moves a single item forward', () => {
    const r = moveBlockToIndex([A, B, C, D, E], [C], 4, []);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.ids).toEqual([A, B, D, C, E]);
    expectFrozen(r);
  });

  it('moves a single item backward, adjusting for the block itself', () => {
    const r = moveBlockToIndex([A, B, C, D, E], [C], 1, []);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.ids).toEqual([A, C, B, D, E]);
  });

  it('keeps an item in place when the target is its own slot', () => {
    const r = moveBlockToIndex([A, B, C, D, E], [C], 2, []);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.ids).toEqual([A, B, C, D, E]);
  });

  it('moves a single item to the front boundary (index 0)', () => {
    const r = moveBlockToIndex([A, B, C, D, E], [C], 0, []);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.ids).toEqual([C, A, B, D, E]);
  });

  it('moves a single item to the end boundary (index = length)', () => {
    const r = moveBlockToIndex([A, B, C, D, E], [A], 5, []);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.ids).toEqual([B, C, D, E, A]);
  });

  it('translates the target by the members removed before it', () => {
    const r = moveBlockToIndex([A, B, C, D, E], [B], 4, []);
    expect(r.success).toBe(true);
    if (!r.success) return;
    // B leaves (its slot is index 1 < 4, so the insertion point shifts one);
    // target 4 is the gap before E.
    expect(r.ids).toEqual([A, C, D, B, E]);
  });

  it('clamps out-of-range targets instead of throwing', () => {
    expect(moveBlockToIndex([A, B, C, D, E], [E], -5, [])).toEqual({
      success: true,
      ids: Object.freeze([E, A, B, C, D]),
      groups: Object.freeze([]),
    });
    expect(moveBlockToIndex([A, B, C, D, E], [A], 99, [])).toEqual({
      success: true,
      ids: Object.freeze([B, C, D, E, A]),
      groups: Object.freeze([]),
    });
  });

  it('moves a contiguous block (multi-item bucket) forward as a unit', () => {
    const groups = [group([B, C])];
    const r = moveBlockToIndex([A, B, C, D, E], [B, C], 4, groups);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.ids).toEqual([A, D, B, C, E]);
    expect(r.groups).toEqual([group([B, C])]);
  });

  it('moves a contiguous block backward as a unit', () => {
    const groups = [group([B, C])];
    const r = moveBlockToIndex([A, B, C, D, E], [B, C], 0, groups);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.ids).toEqual([B, C, A, D, E]);
    expect(r.groups).toEqual([group([B, C])]);
  });

  it('moves an entire bucket past a second bucket without splitting either', () => {
    const groups = [group([A, B]), group([D, E])];
    const r = moveBlockToIndex([A, B, C, D, E], [A, B], 5, groups);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.ids).toEqual([C, D, E, A, B]);
    // Bucket letter derivation is by group ARRAY index (UX-DR6); the array
    // order is preserved so letters stay stable while the block travels.
    expect(r.groups).toEqual([group([A, B]), group([D, E])]);
  });

  it('reorders members inside a group (tie-display) preserving contiguity and the group', () => {
    const groups = [group([A, B])];
    const r = moveBlockToIndex([A, B, C], [B], 0, groups);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.ids).toEqual([B, A, C]);
    expect(r.groups).toEqual([group([B, A])]);
  });

  it('returns the input unchanged for empty or single-element orders', () => {
    const groups = [group([A, B])];
    expect(moveBlockToIndex([A], [A], 0, [])).toEqual({ success: true, ids: Object.freeze([A]), groups: Object.freeze([]) });
    expect(moveBlockToIndex([], [], 0, [])).toEqual({ success: true, ids: Object.freeze([]), groups: Object.freeze([]) });
    expect(moveBlockToIndex([A, B, C], [], 5, groups)).toEqual({ success: true, ids: Object.freeze([A, B, C]), groups: Object.freeze(groups) });
  });

  it('ignores block ids that are not in the current order', () => {
    const r = moveBlockToIndex([A, B, C, D, E], [X], 2, []);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.ids).toEqual([A, B, C, D, E]);
  });

  it('tolerates a group referencing an id outside the order (defensive)', () => {
    // X is not in scope: the group's span check is skipped for the missing
    // member and the group cannot survive (only B remains) — it dissolves
    // rather than throwing.
    const groups = [group([B, X])];
    const r = moveBlockToIndex([A, B, C], [C], 0, groups);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.ids).toEqual([C, A, B]);
    expect(r.groups).toEqual([]);
  });
});

describe('moveBlockToIndex — AC 21.1-2: refusing a group-splitting placement', () => {
  it('refuses to drop an external item between bucket members', () => {
    const groups = [group([B, C])];
    const r = moveBlockToIndex([A, B, C, D, E], [D], 2, groups);
    expect(r).toEqual({ success: false, error: GROUP_SPLIT_ERROR_MESSAGE });
  });

  it('preserves the original order and groups on refusal (no mutation)', () => {
    const groups = [group([B, C])];
    const r = moveBlockToIndex([A, B, C, D, E], [D], 2, groups);
    expect(r.success).toBe(false);
    expect(groups).toEqual([group([B, C])]);
  });

  it('refuses to pull one member out of a bucket past its anchor', () => {
    // Pulling B (head of [B, C]) above A leaves C isolated — genuine split.
    const groups = [group([B, C])];
    const r = moveBlockToIndex([A, B, C], [B], 0, groups);
    expect(r).toEqual({ success: false, error: GROUP_SPLIT_ERROR_MESSAGE });
  });

  it('allows dropping an external item immediately before the bucket header', () => {
    const groups = [group([B, C])];
    const r = moveBlockToIndex([A, B, C, D, E], [D], 1, groups);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.ids).toEqual([A, D, B, C, E]);
  });

  it('allows dropping an external item immediately after the bucket members', () => {
    const groups = [group([B, C])];
    const r = moveBlockToIndex([A, B, C, D, E], [D], 3, groups);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.ids).toEqual([A, B, C, D, E]);
  });

  it('allows moving an entire bucket block across another bucket (exempt)', () => {
    const groups = [group([B, C]), group([D]) as unknown as ForecastParallelGroup];
    const r = moveBlockToIndex([A, B, C, D, E], [B, C], 5, groups);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.ids).toEqual([A, D, E, B, C]);
  });
});

describe('moveBlockToIndex — bucket member extraction boundary (Story 21.3 AC 9/10)', () => {
  it('refuses raw extraction: a member leaving a group splits it (AC 21.1-2)', () => {
    const groups = [group([B, C]), group([D, E])];
    const r = moveBlockToIndex([A, B, C, D, E], [B], 4, groups);
    expect(r).toEqual({ success: false, error: GROUP_SPLIT_ERROR_MESSAGE });
  });

  it('refuses extraction to the front boundary while the group span breaks', () => {
    const groups = [group([B, C])];
    const r = moveBlockToIndex([A, B, C, D, E], [B], 0, groups);
    expect(r).toEqual({ success: false, error: GROUP_SPLIT_ERROR_MESSAGE });
  });

  it('supports the drag-out recipe: caller dissolves/adjusts groups first, then places the row', () => {
    // 21.3 Task 4b: the component removes the member from the group (or
    // dissolves the singleton) and emits ONE SetForecastSequence. The pure
    // helper then places the freed row with the adjusted group set.
    const adjustedGroups: ForecastParallelGroup[] = []; // [B, C] dissolved by caller
    const r = moveBlockToIndex([A, B, C, D, E], [B], 4, adjustedGroups);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.ids).toEqual([A, C, D, B, E]);
    expect(r.groups).toEqual([]);
  });

  it('keeps a two-member bucket intact when only one member moves within it', () => {
    const groups = [group([B, C])];
    // Target 3 = the gap after C (B's own slot is target 1 -> identity).
    const r = moveBlockToIndex([A, B, C, D, E], [B], 3, groups);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.ids).toEqual([A, C, B, D, E]);
    expect(r.groups).toEqual([group([C, B])]);
  });

  it('dropping a member on its own slot is a no-op that preserves groups', () => {
    const groups = [group([B, C])];
    const r = moveBlockToIndex([A, B, C, D, E], [B], 1, groups);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.ids).toEqual([A, B, C, D, E]);
    expect(r.groups).toEqual([group([B, C])]);
  });
});

describe('moveGroupMember — Story 21.3 AC 6/9/10: bucket member drag resolution', () => {
  const groups = [group([B, C]), group([D, E])];

  it('reorders a member within its own bucket (tie-display, AC 21.3-6)', () => {
    // B is at 1. The swap landings are the seams of its own span: target 2
    // is B's own slot (identity), target 3 (last + 1) is the gap below C —
    // both stay inside the bucket span 1..3, so the bucket survives.
    const gap = moveGroupMember([A, B, C, D, E], B, 3, groups);
    expect(gap.success).toBe(true);
    if (!gap.success) return;
    expect(gap.ids).toEqual([A, C, B, D, E]);
    expect(gap.groups).toEqual([group([C, B]), group([D, E])]);
  });

  it('preserves the group when a member lands on its own slot or the bucket seam', () => {
    const own = moveGroupMember([A, B, C, D, E], B, 1, groups);
    expect(own.success).toBe(true);
    if (!own.success) return;
    expect(own.ids).toEqual([A, B, C, D, E]);
    expect(own.groups).toEqual(groups);
    // The seam below the bucket (last + 1) keeps the member in-group: the
    // external drop-line clamp never produces a between-buckets landing.
    const seam = moveGroupMember([A, B, C, D, E], B, 3, groups);
    expect(seam.success).toBe(true);
    if (!seam.success) return;
    expect(seam.ids).toEqual([A, C, B, D, E]);
    expect(seam.groups).toEqual([group([C, B]), group([D, E])]);
  });

  it('extracts a member to the exterior front in one operation (AC 21.3-9)', () => {
    const r = moveGroupMember([A, B, C, D, E], B, 0, groups);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.ids).toEqual([B, A, C, D, E]);
    expect(r.groups).toEqual([group([D, E])]);
  });

  it('extracts a member below its own bucket into the tail (AC 21.3-9)', () => {
    // Target 4 lies beyond the bucket's final gap (3) -> drag-out.
    const r = moveGroupMember([A, B, C, D, E], B, 4, [group([B, C])]);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.ids).toEqual([A, C, D, B, E]);
    expect(r.groups).toEqual([]); // C alone -> dissolved
  });

  it('refuses an unclamped raw landing that would split another bucket', () => {
    // Raw index 4 drops B between D and E — the domain refusal, which is why
    // the UI clamps before it ever reaches here.
    const r = moveGroupMember([A, B, C, D, E], B, 4, groups);
    expect(r).toEqual({ success: false, error: GROUP_SPLIT_ERROR_MESSAGE });
  });

  it('dissolves a bucket left with a single member (AC 21.3-10)', () => {
    const two = [group([B, C])];
    const r = moveGroupMember([A, B, C, D, E], B, 0, two);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.ids).toEqual([B, A, C, D, E]);
    expect(r.groups).toEqual([]);
  });

  it('falls through to plain move for a non-member row', () => {
    // X is not a bucket member but IS in scope; moving it into gap 4 places.
    const r = moveGroupMember([A, B, C, D, X], X, 4, [group([B, C])]);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.ids).toEqual([A, B, C, D, X]);
    expect(r.groups).toEqual([group([B, C])]);
  });
});

describe('clampDropIndexForBuckets — AC 21.1-3: snapping to bucket exterior boundaries', () => {
  const ids = [A, B, C, D, E];
  const groupBC = [group([B, C])];

  it('returns the target unchanged when no group overlaps', () => {
    expect(clampDropIndexForBuckets(2, [], ids)).toBe(2);
  });

  it('snaps a mid-bucket target (B..C) to the nearer exterior boundary', () => {
    // BC occupies 1..2. Target 2 (below B) is 1 from first(1) and 1 from last+1(3): tie -> above.
    expect(clampDropIndexForBuckets(2, groupBC, ids)).toBe(1);
    // Target 3 is the after-boundary itself (3 > 1 && 3 <= 2 is false) -> unchanged.
    expect(clampDropIndexForBuckets(3, groupBC, ids)).toBe(3);
    // Target 4 is exterior -> unchanged.
    expect(clampDropIndexForBuckets(4, groupBC, ids)).toBe(4);
  });

  it('leaves boundary targets unchanged', () => {
    expect(clampDropIndexForBuckets(1, groupBC, ids)).toBe(1);
    expect(clampDropIndexForBuckets(3, groupBC, ids)).toBe(3);
  });

  it('handles a bucket at the start of the list', () => {
    const g = [group([A, B])];
    // AB occupies 0..1. Target 1 -> tie (1 vs 1): above header = first = 0.
    expect(clampDropIndexForBuckets(1, g, ids)).toBe(0);
    // Target 2 is the after-boundary itself -> unchanged.
    expect(clampDropIndexForBuckets(2, g, ids)).toBe(2);
  });

  it('handles a bucket at the end of the list', () => {
    const g = [group([D, E])];
    // DE occupies 3..4. Target 4 (below D) is 1 from first(3) and 1 from last+1(5): tie -> above = 3.
    expect(clampDropIndexForBuckets(4, g, ids)).toBe(3);
    // Target 5 is the after-boundary itself -> unchanged.
    expect(clampDropIndexForBuckets(5, g, ids)).toBe(5);
  });

  it('handles two adjacent buckets', () => {
    const g = [group([A, B]), group([C, D])];
    // Target 2 is the exterior gap between the two buckets -> unchanged.
    expect(clampDropIndexForBuckets(2, g, ids)).toBe(2);
    // Target 1 (between A and B, inside AB) -> tie (1 vs 1) -> above AB = 0.
    expect(clampDropIndexForBuckets(1, g, ids)).toBe(0);
    // Target 3 (below C, inside CD: 2..3) -> tie (1 vs 1) -> above CD = 2.
    expect(clampDropIndexForBuckets(3, g, ids)).toBe(2);
  });

  it('never clamps an index at a bucket exterior when other buckets exist', () => {
    const g = [group([B, C]), group([D, E])];
    // Target 1 is the before-head of BC -> unchanged.
    expect(clampDropIndexForBuckets(1, g, ids)).toBe(1);
  });

  it('ignores degenerate groups with fewer than two resolvable members', () => {
    // A singleton group and a group whose other member is out of order cannot
    // form a snap boundary — the target passes through.
    const g = [group([B]), group([C, X])];
    expect(clampDropIndexForBuckets(2, g, ids)).toBe(2);
  });

  it('snaps to the after-boundary when it is strictly nearer (3+ member bucket)', () => {
    // B,C,D occupy 1..3 with a third member (D). Target 3 (below C): beforeDelta
    // = 2, afterDelta = 1 -> snaps after the bucket (index 4).
    const g = [group([B, C, D])];
    expect(clampDropIndexForBuckets(3, g, ids)).toBe(4);
    // Target 2 (below B): beforeDelta 1 vs afterDelta 2 -> snaps above (1).
    expect(clampDropIndexForBuckets(2, g, ids)).toBe(1);
  });
});

describe('calculateDropIndexFromMidpoints — AC 21.1-4: item-space drop index from midpoints', () => {
  const rects = [
    { top: 0, height: 40 },
    { top: 40, height: 40 },
    { top: 80, height: 40 },
  ];

  it('returns 0 above the first midpoint', () => {
    expect(calculateDropIndexFromMidpoints(5, rects)).toBe(0);
  });

  it('returns the index of the first row whose midpoint is below clientY', () => {
    expect(calculateDropIndexFromMidpoints(20, rects)).toBe(1); // first midpoint is 20
    expect(calculateDropIndexFromMidpoints(21, rects)).toBe(1);
    expect(calculateDropIndexFromMidpoints(60, rects)).toBe(2);
  });

  it('returns row count below the final midpoint', () => {
    expect(calculateDropIndexFromMidpoints(200, rects)).toBe(3);
  });

  it('handles an empty rect list', () => {
    expect(calculateDropIndexFromMidpoints(100, [])).toBe(0);
  });

  it('handles exactly-on-midpoint Y as "below" (strict <)', () => {
    expect(calculateDropIndexFromMidpoints(20, rects)).toBe(1);
  });

  it('is per-item independent of bucket rendering (rects stay item-space)', () => {
    // A bucket [B, C] still contributes two rects; dropping in the middle of
    // them must return an item-space index inside the bucket — clamping is a
    // separate concern.
    const bucketRects = rects; // same 3 items
    expect(calculateDropIndexFromMidpoints(60, bucketRects)).toBe(2);
  });
});

describe('calculateDropIndexFromIndexedMidpoints — Story 23.11 AC 23.11-2: windowed drop index', () => {
  // A rendered window of items 100, 101 and a pinned item 250. The gap between
  // 101 and 250 must not shift the index by the skipped rows.
  const windowed: readonly IndexedRowRect[] = [
    { top: 0, height: 40, itemIndex: 100 },
    { top: 40, height: 40, itemIndex: 101 },
    { top: 80, height: 40, itemIndex: 250 },
  ];

  it('returns 0 for an empty window', () => {
    expect(calculateDropIndexFromIndexedMidpoints(50, [])).toBe(0);
  });

  it('returns the first rendered row item index above every midpoint', () => {
    expect(calculateDropIndexFromIndexedMidpoints(5, windowed)).toBe(100);
  });

  it('resolves a Y between rendered rows to the correct row item index', () => {
    expect(calculateDropIndexFromIndexedMidpoints(25, windowed)).toBe(101);
    expect(calculateDropIndexFromIndexedMidpoints(65, windowed)).toBe(250);
  });

  it('returns the last rendered item index + 1 below every midpoint', () => {
    expect(calculateDropIndexFromIndexedMidpoints(500, windowed)).toBe(251);
  });

  it('does not count skipped rows between the window and a pinned row', () => {
    // Contiguous-midpoint math over the same rects would return 1 or 2, which
    // is what a naive count would splice at a completely wrong slot.
    expect(calculateDropIndexFromIndexedMidpoints(25, windowed)).not.toBe(1);
    expect(calculateDropIndexFromIndexedMidpoints(65, windowed)).not.toBe(2);
  });

  it('handles exactly-on-midpoint Y as "below" (strict <)', () => {
    expect(calculateDropIndexFromIndexedMidpoints(20, windowed)).toBe(101);
  });
});

describe('toElementIndex — AC 21.1-5: item→element space mapping (forecast-workspace.tsx:1151 defect class)', () => {
  const ids = [A, B, C, D, E];

  it('is the identity when no buckets exist', () => {
    expect(toElementIndex(0, [], ids)).toBe(0);
    expect(toElementIndex(2, [], ids)).toBe(2);
    expect(toElementIndex(5, [], ids)).toBe(5);
  });

  it('collapses each bucket to one rendered slot before the index', () => {
    const g = [group([B, C])];
    // B(1) and C(2) render as one element. Element order: [A, bucketBC, D, E].
    expect(toElementIndex(0, g, ids)).toBe(0); // before A
    expect(toElementIndex(1, g, ids)).toBe(1); // in bucketBC header
    expect(toElementIndex(3, g, ids)).toBe(2); // after bucketBC (before D)
    expect(toElementIndex(5, g, ids)).toBe(4); // end
  });

  it('handles an index inside a bucket (before its final member)', () => {
    const g = [group([B, C])];
    expect(toElementIndex(2, g, ids)).toBe(1); // between B and C still lands before the bucket wrapper
  });

  it('handles two adjacent buckets', () => {
    const g = [group([A, B]), group([C, D])];
    // Elements: [bucketAB, bucketCD, E].
    expect(toElementIndex(1, g, ids)).toBe(0); // inside AB
    expect(toElementIndex(3, g, ids)).toBe(1); // inside CD
    expect(toElementIndex(4, g, ids)).toBe(2); // after CD, before E
    expect(toElementIndex(5, g, ids)).toBe(3);
  });

  it('clamps out-of-range item indices', () => {
    expect(toElementIndex(-3, [], ids)).toBe(0);
    expect(toElementIndex(99, [], ids)).toBe(5);
    const g = [group([B, C])];
    expect(toElementIndex(99, g, ids)).toBe(4);
  });

  it('ignores groups whose members are entirely absent from the order', () => {
    // A stale group with no resolvable members contributes no collapse.
    const g = [group([X, '019ffe00-0000-7000-8000-00000000000g'])];
    expect(toElementIndex(3, g, ids)).toBe(3);
  });
});

describe('filterBacklogItems — AC 21.1-6: case-insensitive title search', () => {
  const items = [
    { id: '1', title: 'Alpha Theme Landing' },
    { id: '2', title: 'Beta Billing Flow' },
    { id: '3', title: 'Alpha Payments' },
    { id: '4', title: 'Untitled' },
  ];

  it('returns all items for an empty query', () => {
    expect(filterBacklogItems(items, '')).toEqual(items);
    expect(filterBacklogItems(items, '   ')).toEqual(items);
  });

  it('filters case-insensitively and preserves original order', () => {
    expect(filterBacklogItems(items, 'alpha')).toEqual([items[0], items[2]]);
    expect(filterBacklogItems(items, 'ALPHA')).toEqual([items[0], items[2]]);
    expect(filterBacklogItems(items, 'Alpha Payments')).toEqual([items[2]]);
  });

  it('matches partial titles', () => {
    expect(filterBacklogItems(items, 'beta')).toEqual([items[1]]);
  });

  it('returns an empty list for no matches', () => {
    expect(filterBacklogItems(items, 'zzz')).toEqual([]);
  });

  it('treats special characters literally (no regex interpretation)', () => {
    // Literal `includes` matching: a `.` is not a regex wildcard, so 'a.'
    // matches nothing (no title contains a literal period) — proving the
    // helper never interprets the query as a pattern.
    expect(filterBacklogItems(items, '(pay)')).toEqual([]);
    expect(filterBacklogItems(items, 'a.')).toEqual([]);
    expect(filterBacklogItems(items, '(Alpha)')).toEqual([]);
  });

  it('ignores surrounding whitespace in the query', () => {
    expect(filterBacklogItems(items, '  beta ')).toEqual([items[1]]);
  });

  it('is generic over any title-carrying row shape', () => {
    const rows = [Object.freeze({ id: 'x', title: 'Theme One', points: 5 })];
    expect(filterBacklogItems(rows, 'theme')).toEqual(rows);
  });
});

describe('countPrioritySlots — AC 21.4-11: a bucket is one slot for announcements', () => {
  const ids = [A, B, C, D, E];

  it('counts every row when no buckets exist', () => {
    expect(countPrioritySlots(ids, [])).toBe(5);
  });

  it('collapses each bucket to exactly one slot', () => {
    expect(countPrioritySlots(ids, [group([B, C])])).toBe(4);
    expect(countPrioritySlots(ids, [group([B, C]), group([D, E])])).toBe(3);
  });

  it('treats an adjacent two-member bucket as one slot', () => {
    expect(countPrioritySlots(ids, [group([D, E])])).toBe(4);
  });
});

describe('position announcement builders — AC 21.4-2/5/11', () => {
  it('formats a row position announcement', () => {
    expect(formatRowPositionAnnouncement('Reporting', 2, 4)).toBe('Reporting, position 2 of 4');
  });

  it('formats a bucket position announcement on the same slot basis', () => {
    expect(formatBucketPositionAnnouncement('A', 2, 1, 3)).toBe('Bucket A (2 items), position 1 of 3');
    expect(formatBucketPositionAnnouncement('B', 3, 2, 3)).toBe('Bucket B (3 items), position 2 of 3');
  });

  it('formats grab cancellation for a row and a bucket', () => {
    expect(formatGrabCancelledAnnouncement(false, 'Reporting')).toBe('Reorder cancelled; Reporting ungrabbed');
    expect(formatGrabCancelledAnnouncement(true, 'A')).toBe('Reorder cancelled; bucket A ungrabbed');
  });
});

describe('slotPositionOfBlock — AC 21.4-2/6: N in "position N of M"', () => {
  it('uses the same slot for every member, including the final bucket in the list', () => {
    const ids = [A, B, C];
    const groups = [group([B, C])];
    expect(slotPositionOfBlock(ids, [C], groups)).toBe(2);
    expect(slotPositionOfBlock(ids, [B], groups)).toBe(2);
    expect(countPrioritySlots(ids, groups)).toBe(2);
  });
  const ids = [A, B, C, D, E];

  it('is 1-based and counts slots before the block (bucket = one slot)', () => {
    expect(slotPositionOfBlock(ids, [A], [])).toBe(1);
    expect(slotPositionOfBlock(ids, [C], [])).toBe(3);
    expect(slotPositionOfBlock(ids, [B, C], [group([B, C])])).toBe(2); // slot after the (A) row
    expect(slotPositionOfBlock(ids, [D, E], [group([B, C]), group([D, E])])).toBe(3);
  });

  it('falls back to 1 for a block outside the order', () => {
    expect(slotPositionOfBlock(ids, [X], [])).toBe(1);
  });

  it('ignores degenerate groups with fewer than two resolvable members', () => {
    // B resolves but X does not -> no bucket slot before C.
    expect(slotPositionOfBlock(ids, [C], [group([B, X])])).toBe(3);
  });
});

describe('computeGrabMoveTarget — AC 21.4-2/4/6: ±1-slot keyboard moves', () => {
  const ids = [A, B, C, D, E];

  it('moves a single row up and down past a plain row', () => {
    expect(computeGrabMoveTarget(ids, [C], [], -1)).toBe(1);
    expect(computeGrabMoveTarget(ids, [C], [], 1)).toBe(4); // C lands after D
  });

  it('returns null at the list edges', () => {
    expect(computeGrabMoveTarget(ids, [A], [], -1)).toBeNull();
    expect(computeGrabMoveTarget(ids, [E], [], 1)).toBeNull();
  });

  it('moves a whole bucket as a contiguous block', () => {
    const g = [group([B, C])];
    // BC occupies 1..2; moving it up one slot lands above A.
    expect(computeGrabMoveTarget(ids, [B, C], g, -1)).toBe(0);
    // Moving it down one slot lands below D (index 4 is the gap after D).
    expect(computeGrabMoveTarget(ids, [B, C], g, 1)).toBe(4);
  });

  it('steps a grabbed bucket past an adjacent bucket (up and down)', () => {
    const g = [group([B, C]), group([D, E])];
    // The BC block steps down past the DE bucket: land below E (gap 5).
    const down = computeGrabMoveTarget(ids, [B, C], g, 1);
    expect(down).toBe(5);
    // ...and applying it moves the block exactly one slot, not past F as well.
    expect(moveBlockToIndex(ids, [B, C], down as number, g)).toMatchObject({
      success: true,
      ids: [A, D, E, B, C],
    });
    // The DE block steps up past the BC bucket: land above the BC header (gap 1).
    const up = computeGrabMoveTarget(ids, [D, E], g, -1);
    expect(up).toBe(1);
    expect(moveBlockToIndex(ids, [D, E], up as number, g)).toMatchObject({
      success: true,
      ids: [A, D, E, B, C],
    });
  });

  it('skips the whole adjacent bucket when a single row steps up into a bucket anchored at 0', () => {
    // BC anchors at the very top: a row below stepping up lands at position 0
    // (the after-header case where the bucket's first member is index 0).
    const g = [group([B, C])];
    expect(computeGrabMoveTarget([B, C, D], [D], g, -1)).toBe(0);
  });

  it('handles an empty grabbed block and a single-item order as unresolvable', () => {
    expect(computeGrabMoveTarget([A], [], [], 1)).toBeNull();
    expect(computeGrabMoveTarget([A], [A], [], -1)).toBeNull();
  });

  it('skips a whole adjacent bucket atomically when a single row steps into it', () => {
    const g = [group([B, C])];
    // A at 0 steps down into the BC bucket -> skip to below the bucket (gap 3).
    expect(computeGrabMoveTarget(ids, [A], g, 1)).toBe(3);
    // D at 3 steps up into the BC bucket -> skip to above the bucket header (1).
    expect(computeGrabMoveTarget(ids, [D], g, -1)).toBe(1);
    // E at 4 steps up over plain D -> lands in the gap before D.
    expect(computeGrabMoveTarget(ids, [E], [], -1)).toBe(3);
  });

  it('returns null for an unresolvable block', () => {
    expect(computeGrabMoveTarget(ids, [X], [], 1)).toBeNull();
  });

  it('keeps a bucket member inside its own bucket on keyboard steps', () => {
    const g = [group([B, C])];
    // B (head) at 1: stepping up would leave the bucket -> null.
    expect(computeGrabMoveTarget(ids, [B], g, -1)).toBeNull();
    // B (head) stepping down swaps with C (tie-display inside the bucket).
    // `moveBlockToIndex` removes B first, so the gap after C is 3, not 2 — and
    // the applied order is asserted so a no-op target cannot pass this test.
    const bDown = computeGrabMoveTarget(ids, [B], g, 1);
    expect(bDown).toBe(3);
    expect(moveBlockToIndex(ids, [B], bDown as number, g)).toMatchObject({
      success: true,
      ids: [A, C, B, D, E],
    });
    // C (tail) at 2: stepping down would leave the bucket -> null.
    expect(computeGrabMoveTarget(ids, [C], g, 1)).toBeNull();
    // C stepping up swaps with B.
    const cUp = computeGrabMoveTarget(ids, [C], g, -1);
    expect(cUp).toBe(1);
    expect(moveBlockToIndex(ids, [C], cUp as number, g)).toMatchObject({
      success: true,
      ids: [A, C, B, D, E],
    });
  });

  it('ignores degenerate groups with fewer than two resolvable members', () => {
    // B resolves but X does not -> no bucket to skip, plain adjacency applies:
    // A steps one slot down to the gap after B (index 2).
    const g = [group([B, X])];
    expect(computeGrabMoveTarget(ids, [A], g, 1)).toBe(2);
  });
});

// ── Story 21.11 Group A — residual placement-math defects (AC 21.11-1..5) ──

describe('Story 21.11 AC 1 — filterBacklogItems tolerates null/empty titles', () => {
  const items = [
    { id: '1', title: 'Alpha Theme' },
    { id: '2', title: '' },
    { id: '3', title: null as unknown as string },
    { id: '4', title: undefined as unknown as string },
  ];

  it('does not throw and matches "untitled" against the render contract', () => {
    expect(() => filterBacklogItems(items, 'untitled')).not.toThrow();
    expect(filterBacklogItems(items, 'untitled')).toEqual([items[1], items[2], items[3]]);
  });

  it('still filters real titles case-insensitively', () => {
    expect(filterBacklogItems(items, 'alpha')).toEqual([items[0]]);
  });
});

describe('Story 21.11 AC 2 — countPrioritySlots ignores phantom groups', () => {
  it('a group with no resolvable members contributes no slot', () => {
    expect(countPrioritySlots([A, B, C], [group([X, '019ffe00-0000-7000-8000-00000000000g'])])).toBe(3);
  });

  it('agrees with slotPositionOfBlock on the same phantom group', () => {
    const phantom = [group([X, '019ffe00-0000-7000-8000-00000000000g'])];
    expect(countPrioritySlots([A, B, C], phantom)).toBe(3);
    expect(slotPositionOfBlock([A, B, C], [C], phantom)).toBe(3);
  });
});

describe('Story 21.11 AC 3 — moveBlockToIndex contiguity guard with a missing member', () => {
  it('refuses a placement that splits 2+ surviving members of a 3-member group', () => {
    // B,C,D are grouped; D is absent from the order (deleted node). Moving A
    // between B and C would leave B and C non-contiguous — refused.
    const g = [group([B, C, D])];
    const r = moveBlockToIndex([A, B, C, E], [A], 2, g);
    expect(r).toEqual({ success: false, error: GROUP_SPLIT_ERROR_MESSAGE });
  });

  it('allows a placement that keeps the surviving members contiguous', () => {
    const g = [group([B, C, D])];
    const r = moveBlockToIndex([A, B, C, E], [A], 1, g);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.ids).toEqual([A, B, C, E]);
    expect(r.groups).toEqual([group([B, C])]);
  });
});

describe('Story 21.11 AC 4 — moveBlockToIndex early return copies, never freezes inputs', () => {
  it('returns a defensive copy of the caller groups array', () => {
    const inputGroups = [group([A, B])];
    const r = moveBlockToIndex([A], [A], 0, inputGroups);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.groups).toEqual(inputGroups);
    expect(r.groups).not.toBe(inputGroups);
    expect(Object.isFrozen(r.groups)).toBe(true);
    // The caller's array is untouched (not frozen by reference).
    expect(Object.isFrozen(inputGroups)).toBe(false);
  });
});

describe('Story 21.11 AC 5 — moveGroupMember with an unresolvable owning group', () => {
  it('falls back to a plain move instead of Infinity bounds', () => {
    // X is a member of the group but absent from the order (deleted node):
    // the span computation must not produce Infinity — it falls through to a
    // plain move, which is an identity for an out-of-order id.
    const g = [group([X, '019ffe00-0000-7000-8000-00000000000g'])];
    const r = moveGroupMember([A, B, C], X, 2, g);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.ids).toEqual([A, B, C]);
  });
});

describe('Story 21.11 AC 22 — bucket letters stay distinguishable past Z', () => {
  it('maps 0..25 to A..Z', () => {
    expect(bucketLetterForIndex(0)).toBe('A');
    expect(bucketLetterForIndex(25)).toBe('Z');
  });

  it('continues AA, AB after the 26th group', () => {
    expect(bucketLetterForIndex(26)).toBe('AA');
    expect(bucketLetterForIndex(27)).toBe('AB');
    expect(bucketLetterForIndex(51)).toBe('AZ');
    expect(bucketLetterForIndex(52)).toBe('BA');
  });

  it('clamps negative indices to A', () => {
    expect(bucketLetterForIndex(-3)).toBe('A');
  });
});

// ── Backlog hierarchy: nesting, collapse, and parent lookup ─────────────

describe('backlogParentIds — nesting among same-level rows', () => {
  const rows = [
    { id: 'a', parentId: null },
    { id: 'a1', parentId: 'a' },
    { id: 'a1x', parentId: 'a1' },
    { id: 'b', parentId: null },
  ];

  it('reports which rows have at least one child', () => {
    expect(backlogParentIds(rows)).toEqual(new Set(['a', 'a1']));
  });

  it('is empty for a flat list', () => {
    expect(backlogParentIds([{ id: 'a', parentId: null }, { id: 'b', parentId: null }])).toEqual(new Set());
  });

  it('ignores a parent id that is not itself a row', () => {
    // The parent sits at another planning level, so this row reads as a root.
    expect(backlogParentIds([{ id: 'a', parentId: 'absent' }])).toEqual(new Set());
  });
});

describe('visibleBacklogItems — collapse hides descendants at any depth', () => {
  const rows = [
    { id: 'a', parentId: null },
    { id: 'a1', parentId: 'a' },
    { id: 'a1x', parentId: 'a1' },
    { id: 'b', parentId: null },
  ];

  it('returns every row when nothing is collapsed', () => {
    expect(visibleBacklogItems(rows, new Set()).map((r) => r.id)).toEqual(['a', 'a1', 'a1x', 'b']);
  });

  it('hides the whole subtree of a collapsed row, keeping the row itself', () => {
    expect(visibleBacklogItems(rows, new Set(['a'])).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('hides a grandchild when only the middle row is collapsed', () => {
    expect(visibleBacklogItems(rows, new Set(['a1'])).map((r) => r.id)).toEqual(['a', 'a1', 'b']);
  });

  it('survives a parent cycle without hanging', () => {
    const cyclic = [
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' },
    ];
    expect(visibleBacklogItems(cyclic, new Set(['x'])).map((r) => r.id)).toEqual(['x']);
  });

  it('keeps a row whose collapsed ancestor is not in the list', () => {
    expect(visibleBacklogItems(rows, new Set(['absent'])).map((r) => r.id)).toEqual(['a', 'a1', 'a1x', 'b']);
  });
});

describe('sortByTreeOrder — outline pre-order from a flat node list', () => {
  // The read model returns nodes ORDER BY position across the whole project,
  // and position only ranks siblings — so a child at position 0 sorts ahead
  // of a root at position 1. This is the shape that interleaved the Backlog.
  const flat = [
    { id: 'child-0', parentId: 'root-1', position: 0 },
    { id: 'root-0', parentId: null, position: 0 },
    { id: 'child-1', parentId: 'root-1', position: 1 },
    { id: 'root-1', parentId: null, position: 1 },
    { id: 'root-2', parentId: null, position: 2 },
    { id: 'child-2', parentId: 'root-1', position: 2 },
  ];

  it('puts every parent directly above its own subtree', () => {
    expect(sortByTreeOrder(flat).map((n) => n.id)).toEqual([
      'root-0', 'root-1', 'child-0', 'child-1', 'child-2', 'root-2',
    ]);
  });

  it('keeps a subtree contiguous when an intermediate level is filtered out', () => {
    const tree = [
      { id: 'f', parentId: null, position: 0 },
      { id: 'g', parentId: null, position: 1 },
      { id: 'c', parentId: 'f', position: 0 }, // a Component between Features
      { id: 'f-under-c', parentId: 'c', position: 0 },
    ];
    const features = sortByTreeOrder(tree).filter((n) => n.id !== 'c');
    expect(features.map((n) => n.id)).toEqual(['f', 'f-under-c', 'g']);
  });

  it('handles empty input', () => {
    expect(sortByTreeOrder([])).toEqual([]);
  });

  it('breaks a position tie by id so the order is deterministic', () => {
    const tied = [
      { id: 'b', parentId: null, position: 0 },
      { id: 'a', parentId: null, position: 0 },
      { id: 'a', parentId: null, position: 0 },
    ];
    expect(sortByTreeOrder(tied).map((n) => n.id)).toEqual(['a', 'b']);

    const asc = [
      { id: 'x', parentId: null, position: 0 },
      { id: 'y', parentId: null, position: 0 },
    ];
    expect(sortByTreeOrder(asc).map((n) => n.id)).toEqual(['x', 'y']);
  });

  it('orders bigint positions (the domain Node type) mixed with numbers', () => {
    const fromSqlite = [
      { id: 'late', parentId: null, position: 2n },
      { id: 'early', parentId: null, position: 1 },
    ];
    expect(sortByTreeOrder(fromSqlite).map((n) => n.id)).toEqual(['early', 'late']);
  });

  it('treats a node whose parent is absent as a root', () => {
    expect(sortByTreeOrder([{ id: 'x', parentId: 'gone', position: 0 }]).map((n) => n.id)).toEqual(['x']);
  });

  it('never drops a node caught in a parent cycle', () => {
    const cyclic = [
      { id: 'x', parentId: 'y', position: 0 },
      { id: 'y', parentId: 'x', position: 0 },
      { id: 'r', parentId: null, position: 0 },
    ];
    expect(sortByTreeOrder(cyclic).map((n) => n.id).sort()).toEqual(['r', 'x', 'y']);
  });
});

