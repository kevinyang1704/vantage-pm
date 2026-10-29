/**
 * Anchored placement policy (Story 27.2, R3, D8(c)).
 *
 * A shared move carries its destination, an intended index, and both intended
 * neighbours — "after Y, before Z" — where either neighbour may be absent at a
 * list end. This module is the one pure resolver every runtime uses to turn
 * those anchors into a concrete insertion index, so the desktop handler, the
 * browser repository worker and the service cannot drift.
 *
 * Resolution order (D8(c), R3): after `after`; else before `before`; else the
 * intended index, clamped into range. A missing anchor is never by itself a
 * rejection — the next rule applies. The index is resolved among the list the
 * moving item is *absent* from, because the item is removed before it is
 * re-inserted; anchors name surviving siblings, never the item itself.
 *
 * Only *placement* is decided here. Collection membership of the anchors,
 * cycle freedom and the moving item's existence in the destination are the
 * caller's checks (there is no graph here, only an ordered id list).
 */

export type AnchoredPlacement = Readonly<{
  /** Sibling the item should follow, or null at the front. */
  afterId: string | null;
  /** Sibling the item should precede, or null at the end. */
  beforeId: string | null;
  /** Fallback position when neither anchor survives. */
  intendedIndex: number;
}>;

export type PlacementResolution =
  | Readonly<{ kind: 'Index'; index: number; resolvedBy: 'after' | 'before' | 'intended' }>
  | Readonly<{ kind: 'SelfAnchor' }>;

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Resolve the insertion index of `movingId` among `orderedIds` (which must
 * include `movingId`; it is removed before resolution). Returns `SelfAnchor`
 * when an anchor names the moving item itself — the caller turns that into a
 * named rejection.
 */
export function resolveAnchoredIndex(
  orderedIds: readonly string[],
  movingId: string,
  placement: AnchoredPlacement,
): PlacementResolution {
  if (placement.afterId === movingId || placement.beforeId === movingId) {
    return Object.freeze({ kind: 'SelfAnchor' });
  }

  const remaining = orderedIds.filter((id) => id !== movingId);

  if (placement.afterId !== null) {
    const at = remaining.indexOf(placement.afterId);
    if (at !== -1) {
      return Object.freeze({ kind: 'Index', index: at + 1, resolvedBy: 'after' });
    }
  }

  if (placement.beforeId !== null) {
    const at = remaining.indexOf(placement.beforeId);
    if (at !== -1) {
      return Object.freeze({ kind: 'Index', index: at, resolvedBy: 'before' });
    }
  }

  const intended = Number.isSafeInteger(placement.intendedIndex)
    ? placement.intendedIndex
    : remaining.length;
  return Object.freeze({
    kind: 'Index',
    index: clamp(intended, 0, remaining.length),
    resolvedBy: 'intended',
  });
}

/**
 * The neighbours (in the resulting order) that bracket an insertion of
 * `movingId` at `index` among the remaining ids — the anchors a producer must
 * send so a later replay reproduces exactly this position. `afterId` is the id
 * before the insertion (null at the front), `beforeId` the id after it (null
 * at the end).
 */
export function anchorsForIndex(
  orderedIds: readonly string[],
  movingId: string,
  index: number,
): AnchoredPlacement {
  const remaining = orderedIds.filter((id) => id !== movingId);
  const at = clamp(index, 0, remaining.length);
  return Object.freeze({
    afterId: at > 0 ? remaining[at - 1] : null,
    beforeId: at < remaining.length ? remaining[at] : null,
    intendedIndex: at,
  });
}

/** Apply a resolved placement to produce the next ordered id list. */
export function applyAnchoredMove(
  orderedIds: readonly string[],
  movingId: string,
  placement: AnchoredPlacement,
): PlacementResolution & { readonly ids?: readonly string[] } {
  const resolution = resolveAnchoredIndex(orderedIds, movingId, placement);
  if (resolution.kind === 'SelfAnchor') return resolution;
  const remaining = orderedIds.filter((id) => id !== movingId);
  const next = Object.freeze([
    ...remaining.slice(0, resolution.index),
    movingId,
    ...remaining.slice(resolution.index),
  ]);
  return Object.freeze({ ...resolution, ids: next });
}
