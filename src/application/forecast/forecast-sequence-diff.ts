/**
 * Forecast sequence diff (Story 27.2, D8(c), R3).
 *
 * The forecast workspace computes a gesture's *result* (the new priority order
 * and parallel groups). This pure helper turns that result into the minimal set
 * of `MoveForecastFeature` intents that reproduce it, so a producer names only
 * what changed and a concurrent edit keeps its meaning.
 *
 * Order: a greedy sequence of single moves, each to its final index with the
 * final neighbours as anchors. Group: at most one membership change per affected
 * member, emitted as a no-op reorder (anchors = its current neighbours) carrying
 * the join/leave. Applying the intents left-to-right with the R3 resolver
 * reproduces `nextIds`; the handler rebuilds groups to `nextGroups`.
 *
 * This is the canonical single-move form of the six whole-list commands; the
 * replay oracle (`single-move-replay.oracle.spec.ts`) and this module's spec
 * pin it against the real repository handlers.
 */

import type { ForecastParallelGroup } from '../../domain/forecast/forecast-plan.entity';
import type { ForecastGroupChange } from '../../domain/forecast/forecast.commands';

export type ForecastMoveIntent = Readonly<{
  featureId: string;
  afterId: string | null;
  beforeId: string | null;
  intendedIndex: number;
  groupChange: ForecastGroupChange;
}>;

function groupContaining(
  groups: readonly ForecastParallelGroup[],
  id: string,
): ForecastParallelGroup | undefined {
  return groups.find((g) => g.featureIds.includes(id));
}

/**
 * Anchors for placing `movingId` at its final index, applied left to right.
 *
 * Only the *after* anchor is used: when we place items left to right, the
 * preceding item is already in its final place, so "after it" resolves to the
 * exact target index. Using the before anchor from the final order would be
 * wrong mid-sequence, because that neighbour may not be placed yet.
 */
function anchorsAt(target: readonly string[], movingId: string): {
  afterId: string | null;
  beforeId: string | null;
  intendedIndex: number;
} {
  const idx = target.indexOf(movingId);
  return {
    afterId: idx > 0 ? target[idx - 1] : null,
    beforeId: null,
    intendedIndex: idx,
  };
}

/**
 * The single-move intents that turn `(currentIds, currentGroups)` into
 * `(nextIds, nextGroups)`. Returns an empty array when the scope itself
 * changed (not a pure reorder/group edit) — the caller must not use the
 * single-move path then.
 */
export function diffForecastSequence(
  currentIds: readonly string[],
  currentGroups: readonly ForecastParallelGroup[],
  nextIds: readonly string[],
  nextGroups: readonly ForecastParallelGroup[],
): readonly ForecastMoveIntent[] {
  // `nextIds` may add items (a preceding membership command already put them in
  // scope) or omit items removed the same way. Seed the working order with the
  // still-present prior items; place every target item left to right, so an
  // added item is inserted at its intended slot.
  const nextSet = new Set(nextIds);
  const working = currentIds.filter((id) => nextSet.has(id));

  const intents: ForecastMoveIntent[] = [];

  // Order: move each item into its final slot, left to right.
  for (let i = 0; i < nextIds.length; i += 1) {
    const id = nextIds[i];
    if (working[i] === id) continue;
    const from = working.indexOf(id);
    if (from === -1) working.splice(i, 0, id);
    else {
      working.splice(from, 1);
      working.splice(i, 0, id);
    }
    intents.push(
      Object.freeze({
        featureId: id,
        ...anchorsAt(nextIds, id),
        groupChange: Object.freeze({ kind: 'unchanged' }),
      }),
    );
  }

  // Groups: emit one membership move per item that ENTERS or LEAVES a group.
  // Items that stay grouped (the group merely shrinks/grows around them) emit
  // nothing. A no-op reorder (anchors from the final order) carries the change.
  const beforeGrouped = new Set(currentGroups.flatMap((g) => [...g.featureIds]));
  const afterGrouped = new Set(nextGroups.flatMap((g) => [...g.featureIds]));

  for (const id of nextIds) {
    const wasGrouped = beforeGrouped.has(id);
    const isGrouped = afterGrouped.has(id);
    if (wasGrouped === isGrouped) continue;
    let groupChange: ForecastGroupChange;
    if (isGrouped) {
      const after = groupContaining(nextGroups, id)!;
      const partner = after.featureIds.find((m: string) => m !== id);
      if (partner === undefined) continue;
      groupChange = Object.freeze({ kind: 'join', partnerId: partner });
    } else {
      groupChange = Object.freeze({ kind: 'leave' });
    }
    intents.push(
      Object.freeze({
        featureId: id,
        ...anchorsAt(nextIds, id),
        groupChange,
      }),
    );
  }

  return Object.freeze(intents);
}
