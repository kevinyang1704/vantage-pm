import { PROTOCOL_VERSION } from './command-receipt';

type Snapshot = { projectId: string; revision: number; safeStateHash: string };
type Delta = { projectId: string; baseRevision: number; targetRevision: number; safeResultHash: string };
type Mode = 'accepting-deltas' | 'awaiting-full-snapshot';

export function createRevisionProtocolTestPort() {
  let revision: number | null = null;
  let currentMode: Mode = 'awaiting-full-snapshot';
  let derived: { inputRevision: number; revision: number; safeResultHash: string } | null = null;

  const resync = (code: 'REVISION_BASE_MISMATCH' | 'REVISION_TARGET_NOT_CONTIGUOUS' | 'FULL_SNAPSHOT_REQUIRED', delta: Delta) => {
    const expectedBaseRevision = revision ?? 0;
    currentMode = 'awaiting-full-snapshot';
    derived = null;
    return {
      type: 'ResyncRequired' as const,
      protocolVersion: PROTOCOL_VERSION,
      code,
      expectedBaseRevision,
      receivedBaseRevision: delta.baseRevision,
      receivedTargetRevision: delta.targetRevision,
      staleDerivedResultDiscarded: true,
    };
  };

  return {
    async replaceWithSnapshot(snapshot: Snapshot) {
      revision = snapshot.revision;
      currentMode = 'accepting-deltas';
      derived = null;
      return { type: 'SnapshotAccepted' as const, protocolVersion: PROTOCOL_VERSION, revision };
    },
    async acceptDelta(delta: Delta) {
      if (currentMode === 'awaiting-full-snapshot') return resync('FULL_SNAPSHOT_REQUIRED', delta);
      if (delta.baseRevision !== revision) return resync('REVISION_BASE_MISMATCH', delta);
      if (delta.targetRevision !== delta.baseRevision + 1) return resync('REVISION_TARGET_NOT_CONTIGUOUS', delta);
      derived = { inputRevision: delta.baseRevision, revision: delta.targetRevision, safeResultHash: delta.safeResultHash };
      revision = delta.targetRevision;
      return { type: 'DeltaAccepted' as const, protocolVersion: PROTOCOL_VERSION, ...derived };
    },
    currentRevision: () => revision,
    mode: () => currentMode,
    lastDerivedResult: () => derived,
  };
}
