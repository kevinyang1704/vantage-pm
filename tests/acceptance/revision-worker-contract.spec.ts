import { expect, test } from '@playwright/test';

const initialSnapshot = {
  type: 'FullSnapshot',
  protocolVersion: '1.0.0',
  requestId: '01992f5c-7a10-7cb0-8b11-89ea06c8f9e0',
  projectId: '01992f5c-7a10-7ca1-8b11-89ea06c8f9d1',
  revision: 41,
  safeStateHash: 'c51ce410c124a10e0db5e4b97fc2af39fc2c090e0a8ba27d3e5fc20c1d0e3ec0',
};

function delta(baseRevision: number, targetRevision: number) {
  return {
    type: 'RevisionDelta',
    protocolVersion: '1.0.0',
    requestId: `01992f5c-7a10-7cb${targetRevision % 10}-8b11-89ea06c8f9e${targetRevision % 10}`,
    projectId: initialSnapshot.projectId,
    baseRevision,
    targetRevision,
    safeResultHash: 'aab3238922bcc25a6f606eb525ffdc56e2a87025af50ef2c6b76b5176cf92a21',
  };
}

test.describe('Story 1.1 revision worker contract', () => {
  test('[P0] AC4 rejects a lower base revision with typed ResyncRequired', async () => {
    const { createRevisionProtocolTestPort } = await import(
      '../../spikes/phase-0-durability/src/revision-protocol'
    );
    const port = createRevisionProtocolTestPort();
    expect(await port.replaceWithSnapshot(structuredClone(initialSnapshot))).toMatchObject({
      type: 'SnapshotAccepted',
      revision: 41,
    });

    const result = await port.acceptDelta(delta(40, 41));

    expect(result).toEqual({
      type: 'ResyncRequired',
      protocolVersion: '1.0.0',
      code: 'REVISION_BASE_MISMATCH',
      expectedBaseRevision: 41,
      receivedBaseRevision: 40,
      receivedTargetRevision: 41,
      staleDerivedResultDiscarded: true,
    });
    expect(port.currentRevision()).toBe(41);
  });

  test('[P0] AC4 rejects a skipped base revision and enters resync-only mode', async () => {
    const { createRevisionProtocolTestPort } = await import(
      '../../spikes/phase-0-durability/src/revision-protocol'
    );
    const port = createRevisionProtocolTestPort();
    await port.replaceWithSnapshot(initialSnapshot);

    const result = await port.acceptDelta(delta(43, 44));

    expect(result).toMatchObject({
      type: 'ResyncRequired',
      code: 'REVISION_BASE_MISMATCH',
      expectedBaseRevision: 41,
      receivedBaseRevision: 43,
      receivedTargetRevision: 44,
      staleDerivedResultDiscarded: true,
    });
    expect(port.mode()).toBe('awaiting-full-snapshot');
  });

  test('[P0] AC4 rejects a non-unit target revision and discards the stale derived result', async () => {
    const { createRevisionProtocolTestPort } = await import(
      '../../spikes/phase-0-durability/src/revision-protocol'
    );
    const port = createRevisionProtocolTestPort();
    await port.replaceWithSnapshot(initialSnapshot);

    const result = await port.acceptDelta(delta(41, 43));

    expect(result).toEqual({
      type: 'ResyncRequired',
      protocolVersion: '1.0.0',
      code: 'REVISION_TARGET_NOT_CONTIGUOUS',
      expectedBaseRevision: 41,
      receivedBaseRevision: 41,
      receivedTargetRevision: 43,
      staleDerivedResultDiscarded: true,
    });
    expect(port.lastDerivedResult()).toBeNull();
    expect(port.currentRevision()).toBe(41);
  });

  test('[P0] AC4 blocks every delta after a gap until snapshot replacement, then resumes contiguously', async () => {
    const { createRevisionProtocolTestPort } = await import(
      '../../spikes/phase-0-durability/src/revision-protocol'
    );
    const port = createRevisionProtocolTestPort();
    await port.replaceWithSnapshot(initialSnapshot);
    await port.acceptDelta(delta(41, 43));

    expect(await port.acceptDelta(delta(41, 42))).toMatchObject({
      type: 'ResyncRequired',
      code: 'FULL_SNAPSHOT_REQUIRED',
      expectedBaseRevision: 41,
    });

    const replacement = {
      ...initialSnapshot,
      requestId: '01992f5c-7a10-7cb8-8b11-89ea06c8f9e8',
      revision: 50,
      safeStateHash: '9bf31c7ff062936a96d3c8bd1f8f2ff3b6c47e76529f18d3262b994b50c1f4e5',
    };
    expect(await port.replaceWithSnapshot(replacement)).toMatchObject({
      type: 'SnapshotAccepted',
      revision: 50,
    });
    expect(await port.acceptDelta(delta(50, 51))).toMatchObject({
      type: 'DeltaAccepted',
      inputRevision: 50,
      revision: 51,
    });
    expect(port.mode()).toBe('accepting-deltas');
    expect(port.currentRevision()).toBe(51);
  });
});
