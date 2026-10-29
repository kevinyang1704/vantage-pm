import { expect, test } from '@playwright/test';

test.describe('Story 1.1 repository structured-clone contract', () => {
  test('[P0] AC1 accepts only lowercase UUIDv7 identifiers and safe hashes', async () => {
    const { createKnownFixtureCommand, KNOWN_COMMAND_ID, KNOWN_PROJECT_ID } = await import(
      '../../spikes/phase-0-durability/src/command-receipt'
    );
    const { validateApplyCommandRequest } = await import(
      '../../spikes/phase-0-durability/src/repository-protocol'
    );
    const request = {
      type: 'ApplyCommand' as const,
      protocolVersion: '1.0.0' as const,
      requestId: '01992f5c-7a10-7ca4-8b11-89ea06c8f9d4',
      contextId: '01992f5c-7a10-7ca5-8b11-89ea06c8f9d5',
      ownerSessionId: '01992f5c-7a10-7ca6-8b11-89ea06c8f9d6',
      writerEpoch: 1,
      command: createKnownFixtureCommand({
        commandId: KNOWN_COMMAND_ID,
        projectId: KNOWN_PROJECT_ID,
        baseRevision: 41,
        safeValueHash: 'c20ad4d76fe97759aa27a0c99bff6710c7f4b66dcbf15a3512c3f5b2b60690b2',
      }),
    };
    expect(validateApplyCommandRequest(structuredClone(request))).toEqual(request);
    expect(() => validateApplyCommandRequest({
      ...request,
      command: { ...request.command, commandId: request.command.commandId.toUpperCase() },
    })).toThrow(/INVALID_UUID_V7/);
    expect(() => validateApplyCommandRequest({
      ...request,
      command: {
        ...request.command,
        baseRevision: Number.MAX_SAFE_INTEGER,
        expectedRevision: Number.MAX_SAFE_INTEGER + 1,
      },
    })).toThrow(/INVALID_COMMAND/);
  });

  test('[P0] AC3 canonical result persists commit outcome but never acknowledgement class', async () => {
    const { createKnownFixtureCommand, KNOWN_COMMAND_ID, KNOWN_PROJECT_ID } = await import(
      '../../spikes/phase-0-durability/src/command-receipt'
    );
    const { commandApplied } = await import('../../spikes/phase-0-durability/src/repository-protocol');
    const response = commandApplied({
      type: 'ApplyCommand', protocolVersion: '1.0.0',
      requestId: '01992f5c-7a10-7ca4-8b11-89ea06c8f9d4',
      contextId: '01992f5c-7a10-7ca5-8b11-89ea06c8f9d5',
      ownerSessionId: '01992f5c-7a10-7ca6-8b11-89ea06c8f9d6',
      writerEpoch: 1,
      command: createKnownFixtureCommand({
        commandId: KNOWN_COMMAND_ID, projectId: KNOWN_PROJECT_ID, baseRevision: 41,
        safeValueHash: 'c20ad4d76fe97759aa27a0c99bff6710c7f4b66dcbf15a3512c3f5b2b60690b2',
      }),
    });
    expect(response).toMatchObject({
      type: 'CommandApplied', outcome: 'VfsCommitAccepted', disposition: 'NewCommit',
      targetRevision: 42,
      receipt: { resultCode: 'VFS_COMMIT_ACCEPTED', appliedRevision: 42 },
    });
    expect(JSON.stringify(response)).not.toContain('DurableCommitAcknowledged');
  });

  test('[P0] validation failures return versioned request-correlated typed rejections where possible', async () => {
    const { KNOWN_COMMAND_ID, KNOWN_PROJECT_ID } = await import('../../spikes/phase-0-durability/src/command-receipt');
    const { typedValidationRejection, validateInspectLedgerRequest } = await import(
      '../../spikes/phase-0-durability/src/repository-protocol'
    );
    const requestId = '01992f5c-7a10-7ca4-8b11-89ea06c8f9d4';
    expect(typedValidationRejection({ requestId }, new Error('INVALID_COMMAND'))).toEqual({
      type: 'RepositoryRejected', protocolVersion: '1.0.0', requestId, code: 'INVALID_COMMAND',
    });
    expect(typedValidationRejection({ requestId }, new Error('PROTOCOL_VERSION_MISMATCH'))).toEqual({
      type: 'RepositoryRejected', protocolVersion: '1.0.0', requestId, code: 'PROTOCOL_VERSION_MISMATCH',
    });
    expect(typedValidationRejection({ requestId: 'uncorrelatable' }, new Error('INVALID_COMMAND'))).toBeNull();
    expect(() => validateInspectLedgerRequest({
      type: 'InspectCommandLedger', protocolVersion: 'wrong', requestId, projectId: KNOWN_PROJECT_ID,
      commandId: KNOWN_COMMAND_ID,
    })).toThrow('PROTOCOL_VERSION_MISMATCH');
  });

  test('[P0] AC7 production contract exposes no test controls or durable acknowledgement', async () => {
    const { listProductionCompositionModules, listProductionMessageTypes } = await import(
      '../../spikes/phase-0-durability/src/harness'
    );
    expect(await listProductionCompositionModules()).toEqual([
      'src/repository.worker.entry.ts', 'src/repository.worker.ts', 'src/repository-ledger.ts',
      'src/sqlite-opfs.adapter.ts', 'src/recovery-safe-vfs.ts', 'src/restart-inspector.ts',
      'src/repository-protocol.ts', 'src/command-receipt.ts',
      'src/ownership-protocol.ts', 'src/repository-ownership.ts', 'src/cooperative-handoff.ts',
      'src/backup.ts', 'src/migration-runner.ts', 'src/recovery-selector.ts', 'src/update-coordinator.ts',
    ]);
    expect(await listProductionMessageTypes()).toEqual([
      'ApplyCommand', 'InspectCommandLedger', 'VfsCommitAccepted',
    ]);
  });
});
