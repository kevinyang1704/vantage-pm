import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { createBrowserSyncRepository } from './browser-sync-repository';
import { createSetNodeTitleWireCommand } from '../../contracts/repository-commands';
import { createSetNodeTitleCommand } from '../../domain/tree/set-node-title.command';
import { boundHistoryFixture, envelopeFixture } from '../../application/collaboration/recovery-fixtures.test-only';
import { applyProductCommandBatch } from './repository-worker.client';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('./repository.worker', () => { throw new Error('Native collaboration must not load browser SQLite'); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('native collaboration through runtime-neutral repository', () => {
  it('routes an atomic batch to one native invoke and refuses malformed prefix acknowledgements', async () => {
    vi.stubGlobal('__TAURI_NATIVE_BRIDGE__', true);
    const projectId = '019ffe00-0000-7000-8000-000000000001';
    const first = createSetNodeTitleWireCommand(createSetNodeTitleCommand({ commandId: '019ffe00-0000-7000-8000-000000000003', projectId, nodeId: '019ffe00-0000-7000-8000-000000000002', baseRevision: 1, title: 'Synthetic' }));
    const second = { ...first, commandId: '019ffe00-0000-7000-8000-000000000004', baseRevision: 2, expectedRevision: 3 };
    const applied = { type: 'ProductCommandApplied', protocolVersion: '1.0.0', projectId, commandId: first.commandId, baseRevision: 1, targetRevision: 2, outcome: 'VfsCommitAccepted', disposition: 'NewCommit' };
    vi.mocked(invoke).mockResolvedValueOnce([applied]);
    await expect(applyProductCommandBatch([first, second])).rejects.toThrow('INVALID_PRODUCT_BATCH_RESULT');
    expect(invoke).toHaveBeenLastCalledWith('repository_apply_product_command_batch', { commands: [first, second] });
    vi.mocked(invoke).mockResolvedValueOnce([applied, { ...applied, commandId: second.commandId, baseRevision: 2, targetRevision: 3 }]);
    expect(await applyProductCommandBatch([first, second])).toHaveLength(2);
    const calls = vi.mocked(invoke).mock.calls.length;
    await expect(applyProductCommandBatch([first, { ...second, commandId: first.commandId }])).rejects.toThrow('INVALID_PRODUCT_COMMAND_BATCH');
    expect(invoke).toHaveBeenCalledTimes(calls);
  });
  it('routes commit, read, rebase and discard to typed native invokes without browser SQLite', async () => {
    vi.stubGlobal('__TAURI_NATIVE_BRIDGE__', true);
    const projectId = '019ffe00-0000-7000-8000-000000000001';
    const command = createSetNodeTitleWireCommand(createSetNodeTitleCommand({ commandId: '019ffe00-0000-7000-8000-000000000003', projectId, nodeId: '019ffe00-0000-7000-8000-000000000002', baseRevision: 1, title: 'Synthetic' }));
    const entry = { commandId: command.commandId, command, commitAttemptId: 1, queuedAtISO: '2026-10-05T00:00:00Z' };
    const repository = createBrowserSyncRepository({ mergeState: vi.fn() });
    vi.mocked(invoke).mockResolvedValue({ type: 'ProductCommandApplied' });
    expect(await repository.commitWithOutbox(projectId, command, entry)).toEqual({ applied: true, result: { type: 'ProductCommandApplied' } });
    expect(invoke).toHaveBeenLastCalledWith('repository_commit_with_outbox', { projectId, command, entry });

    const state = { entries: [], rejected: [], corrupt: [], cursor: 2, resyncRequired: false, streamEpoch: 1, recoveryRequired: false, recoveryReason: null };
    vi.mocked(invoke).mockResolvedValue(state);
    expect(await repository.readOutbox(projectId)).toEqual(state);
    expect(invoke).toHaveBeenLastCalledWith('repository_read_outbox', { projectId });
    vi.mocked(invoke).mockResolvedValueOnce(null).mockResolvedValueOnce(state);
    const remote = { command, ownEcho: true, serverRevision: 2, streamEpoch: 1, historyEntry: await boundHistoryFixture(command, 2) };
    expect(await repository.applyRebase(projectId, remote, [], [])).toEqual({ resyncRequired: false, state });
    expect(invoke).toHaveBeenNthCalledWith(3, 'repository_rebase', { projectId, remote, survivors: [], rejected: [] });
    await repository.discardOutboxEntry(projectId, command.commandId);
    expect(invoke).toHaveBeenLastCalledWith('repository_discard_outbox', { projectId, commandId: command.commandId });
    vi.mocked(invoke).mockResolvedValueOnce({ revision: 2, recoveryRequired: false }).mockResolvedValueOnce(state);
    const envelope = envelopeFixture(projectId, 2);
    expect(await repository.installSnapshot(projectId, envelope)).toEqual(state);
    expect(invoke).toHaveBeenCalledWith('repository_install_collaboration_snapshot', { projectId, envelope, archivedAtIso: expect.any(String) });
  });

  it('preserves typed native domain rejection and storage failure without split acknowledgement', async () => {
    vi.stubGlobal('__TAURI_NATIVE_BRIDGE__', true);
    const projectId = '019ffe00-0000-7000-8000-000000000001';
    const command = createSetNodeTitleWireCommand(createSetNodeTitleCommand({ commandId: '019ffe00-0000-7000-8000-000000000003', projectId, nodeId: '019ffe00-0000-7000-8000-000000000002', baseRevision: 1, title: 'Synthetic' }));
    const entry = { commandId: command.commandId, command, commitAttemptId: 1, queuedAtISO: '2026-10-05T00:00:00Z' };
    const repository = createBrowserSyncRepository({ mergeState: vi.fn() });
    vi.mocked(invoke).mockResolvedValueOnce({ type: 'ProductCommandRejected', code: 'NODE_NOT_FOUND' });
    expect(await repository.commitWithOutbox(projectId, command, entry)).toEqual({ applied: false, rejectedReason: 'NODE_NOT_FOUND', result: { type: 'ProductCommandRejected', code: 'NODE_NOT_FOUND' } });
    vi.mocked(invoke).mockRejectedValueOnce({ code: 'STORAGE_FULL' });
    await expect(repository.commitWithOutbox(projectId, command, entry)).rejects.toEqual({ code: 'STORAGE_FULL' });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
