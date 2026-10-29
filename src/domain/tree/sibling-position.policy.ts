/**
 * Sibling gap-position policy (Story 2.3 Task 3, AD-7).
 *
 * Provides pure signed 64-bit integer gap-position calculation, midpoint insertion,
 * and rebalance detection.
 */

export const SIBLING_POSITION_GAP = 4294967296n; // 2^32 = 4,294,967,296n
export const MIN_POSITION = -(2n ** 63n);
export const MAX_POSITION = 2n ** 63n - 1n;

export type PositionResult =
  | Readonly<{ kind: 'Position'; position: bigint }>
  | Readonly<{ kind: 'RebalanceRequired' }>;

export function positionForAppend(lastSiblingPosition: bigint | null): bigint {
  if (lastSiblingPosition === null) {
    return SIBLING_POSITION_GAP;
  }
  const next = lastSiblingPosition + SIBLING_POSITION_GAP;
  if (next > MAX_POSITION) {
    return MAX_POSITION;
  }
  return next;
}

export function positionBetween(before: bigint | null, after: bigint | null): PositionResult {
  if (before === null && after === null) {
    return Object.freeze({ kind: 'Position', position: SIBLING_POSITION_GAP });
  }

  if (before === null && after !== null) {
    const prev = after - SIBLING_POSITION_GAP;
    if (prev < MIN_POSITION) {
      return Object.freeze({ kind: 'RebalanceRequired' });
    }
    return Object.freeze({ kind: 'Position', position: prev });
  }

  if (before !== null && after === null) {
    const next = before + SIBLING_POSITION_GAP;
    if (next > MAX_POSITION) {
      return Object.freeze({ kind: 'RebalanceRequired' });
    }
    return Object.freeze({ kind: 'Position', position: next });
  }

  if (before !== null && after !== null) {
    if (after <= before || after - before <= 1n) {
      return Object.freeze({ kind: 'RebalanceRequired' });
    }
    const midpoint = before + (after - before) / 2n;
    if (midpoint === before || midpoint === after) {
      return Object.freeze({ kind: 'RebalanceRequired' });
    }
    return Object.freeze({ kind: 'Position', position: midpoint });
  }

  return Object.freeze({ kind: 'RebalanceRequired' });
}

export function rebalanceSiblingPositions(
  orderedNodeIds: readonly string[],
): readonly Readonly<{ nodeId: string; position: bigint }>[] {
  return Object.freeze(
    orderedNodeIds.map((nodeId, idx) =>
      Object.freeze({
        nodeId,
        position: BigInt(idx + 1) * SIBLING_POSITION_GAP,
      }),
    ),
  );
}

export function parsePosition(text: string): bigint {
  return BigInt(text.trim());
}

export function formatPosition(value: bigint): string {
  return value.toString();
}
