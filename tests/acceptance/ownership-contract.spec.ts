import { expect, test } from '@playwright/test';

const ownershipProtocol = '../../spikes/phase-0-durability/src/ownership-protocol';

test.describe('Story 1.2 exclusive ownership and handoff contracts', () => {
  test('[P0] AC1 reaches OwnerReady only after lock SAH SQLite integrity and revision recovery', async () => {
    const { reduceOwnershipEvents } = await import(ownershipProtocol);
    const result = reduceOwnershipEvents([
      'WebLockAcquired', 'SAHAcquired', 'SQLiteOpened', 'IntegrityVerified', 'ReceiptsReconciled', 'RevisionReconciled',
    ], { contextId: '01992f5c-7a10-7cc4-8b11-89ea06c8f9f4', ownerSessionId: '01992f5c-7a10-7cc5-8b11-89ea06c8f9f5', writerEpoch: 1 });
    expect(result).toMatchObject({ state: 'OwnerReady', writable: true, ownerSessionId: '01992f5c-7a10-7cc5-8b11-89ea06c8f9f5' });
  });

  test('[P0] AC2 returns StorageBusy without any SAH or SQLite attempt', async () => {
    const modulePath = '../../spikes/phase-0-durability/src/repository-ownership';
    const { adjudicateContender } = await import(modulePath);
    expect(adjudicateContender({ webLock: null, events: [] })).toMatchObject({
      type: 'StorageBusy', code: 'REPOSITORY_WRITER_BUSY', mode: 'read-only-frozen', sahOpenAttempts: 0, sqliteOpenAttempts: 0,
    });
  });

  test('[P0] AC2 rejects timeout heartbeat steal lease and queued takeover policy', async () => {
    const modulePath = '../../spikes/phase-0-durability/src/repository-ownership';
    const { validateOwnershipPolicy } = await import(modulePath);
    for (const forbidden of ['timeout', 'heartbeat', 'steal', 'lease-expiry', 'queued-lock']) {
      expect(validateOwnershipPolicy({ ifAvailable: true, mechanisms: [forbidden] })).toMatchObject({ status: 'FAIL', code: 'FORCED_TAKEOVER_FORBIDDEN' });
    }
  });

  test('[P0] AC3 rejects stale non-owner and former-owner commands without mutation', async () => {
    const { authorizeOwnerCommand } = await import(ownershipProtocol);
    expect(authorizeOwnerCommand({ state: 'NonOwner', ownerSessionId: 'old', currentOwnerSessionId: 'new' })).toMatchObject({
      type: 'OwnershipRejected', code: 'NOT_CURRENT_REPOSITORY_OWNER', resultingState: 'read-only-frozen', mutated: false,
    });
  });

  test('[P0] AC4 accepts only the exact cooperative handoff sequence', async () => {
    const { verifyCooperativeHandoff } = await import(ownershipProtocol);
    const exact = ['IntakeStopped', 'QueueResolved', 'StatementsClosed', 'SQLiteClosed', 'VfsPaused', 'WebLockReleased', 'FormerOwnerFenced'];
    expect(verifyCooperativeHandoff(exact)).toMatchObject({ type: 'HandoffVerified', formerOwnerWritable: false });
    expect(() => verifyCooperativeHandoff([...exact, 'FormerOwnerFenced'])).toThrow(/HANDOFF_EVENT_REPEATED|HANDOFF_ORDER/);
  });

  test('[P0] AC4 blocks release when queue close or pause does not complete', async () => {
    const modulePath = '../../spikes/phase-0-durability/src/cooperative-handoff';
    const { planHandoff } = await import(modulePath);
    for (const state of [{ queueResolved: false, databaseClosed: false, vfsPaused: false }, { queueResolved: true, databaseClosed: false, vfsPaused: false }, { queueResolved: true, databaseClosed: true, vfsPaused: false }]) {
      expect(planHandoff(state)).toMatchObject({ type: 'HandoffBlocked', lockReleased: false, exactCause: expect.any(String) });
    }
  });

  test('[P0] AC6 folds an unsafe ownership case into a sticky Gate A attempt failure', async () => {
    const modulePath = '../../spikes/phase-0-durability/src/evidence-contract';
    const { foldEngineeringQualification } = await import(modulePath);
    expect(foldEngineeringQualification([{ caseId: 'O1_CONCURRENT_CONTENDER', status: 'FAIL', code: 'CONCURRENT_SQLITE_OPEN' }, { caseId: 'O3_COOPERATIVE_HANDOFF', status: 'PASS' }])).toMatchObject({ status: 'FAIL', retainedFailures: [{ caseId: 'O1_CONCURRENT_CONTENDER', code: 'CONCURRENT_SQLITE_OPEN' }] });
  });

  test('[P0] AC6 derives maximum owners from ordered acquisition and release facts', async () => {
    const modulePath = '../../spikes/phase-0-durability/src/evidence';
    const { deriveMaximumConcurrentResourceOwners } = await import(modulePath);
    const base = {
      actorId: 'page-a', contextId: '01992f5c-7a10-7cc4-8b11-89ea06c8f9f4',
      ownerSessionId: '01992f5c-7a10-7cc5-8b11-89ea06c8f9f5', writerEpoch: 1,
      resource: 'web-lock' as const, type: 'WebLockAcquired', outcome: 'acquired' as const, requestId: null,
    };
    expect(deriveMaximumConcurrentResourceOwners([
      { ...base, sequence: 1, outcome: 'acquired' },
      { ...base, sequence: 2, outcome: 'released', type: 'WebLockReleased' },
      { ...base, sequence: 3, contextId: '01992f5c-7a10-7cc6-8b11-89ea06c8f9f6', ownerSessionId: '01992f5c-7a10-7cc7-8b11-89ea06c8f9f7', outcome: 'acquired' },
    ])).toBe(1);
    expect(deriveMaximumConcurrentResourceOwners([
      { ...base, sequence: 1, outcome: 'acquired' },
      { ...base, sequence: 2, contextId: '01992f5c-7a10-7cc6-8b11-89ea06c8f9f6', ownerSessionId: '01992f5c-7a10-7cc7-8b11-89ea06c8f9f7', outcome: 'acquired' },
    ])).toBe(2);
  });
});
