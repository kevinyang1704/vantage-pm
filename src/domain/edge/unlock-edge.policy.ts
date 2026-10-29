/**
 * Unlock edge validation & query policy (Story 3.8, Story 3.9, AD-7).
 */

export interface EdgeValidationResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly code?: 'SELF_REFERENTIAL' | 'SOURCE_NOT_FOUND' | 'TARGET_NOT_FOUND' | 'DUPLICATE_EDGE';
}

export function validateUnlockEdge(
  sourceNodeId: string,
  targetNodeId: string,
  existingEdges: readonly { sourceNodeId: string; targetNodeId: string }[],
  existingNodeIds: ReadonlySet<string>,
): EdgeValidationResult {
  if (sourceNodeId === targetNodeId) {
    return Object.freeze({
      ok: false,
      error: 'Cannot create an unlock relationship to the same node.',
      code: 'SELF_REFERENTIAL',
    });
  }

  if (!existingNodeIds.has(sourceNodeId)) {
    return Object.freeze({
      ok: false,
      error: `Source node ${sourceNodeId} not found in project.`,
      code: 'SOURCE_NOT_FOUND',
    });
  }

  if (!existingNodeIds.has(targetNodeId)) {
    return Object.freeze({
      ok: false,
      error: `Target node ${targetNodeId} not found in project.`,
      code: 'TARGET_NOT_FOUND',
    });
  }

  const isDuplicate = existingEdges.some(
    (e) => e.sourceNodeId === sourceNodeId && e.targetNodeId === targetNodeId,
  );

  if (isDuplicate) {
    return Object.freeze({
      ok: false,
      error: 'An unlock relationship already exists between these nodes.',
      code: 'DUPLICATE_EDGE',
    });
  }

  return Object.freeze({ ok: true });
}

export interface NodeEdgeCounts {
  readonly unlocksCount: number; // outbound (this node unlocks others)
  readonly unlockedByCount: number; // inbound (others unlock this node)
}

export function computeNodeEdgeCounts(
  nodeId: string,
  allEdges: readonly { sourceNodeId: string; targetNodeId: string }[],
): NodeEdgeCounts {
  let unlocksCount = 0;
  let unlockedByCount = 0;

  for (const e of allEdges) {
    if (e.sourceNodeId === nodeId) {
      unlocksCount++;
    }
    if (e.targetNodeId === nodeId) {
      unlockedByCount++;
    }
  }

  return Object.freeze({
    unlocksCount,
    unlockedByCount,
  });
}
