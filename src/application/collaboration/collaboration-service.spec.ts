import { boundHistoryFixture, envelopeFixture } from './recovery-fixtures.test-only';
import { describe, expect, it, vi } from 'vitest';
import { createCollaborationService, remoteTargets, type SyncRepository } from './collaboration-service';
import { CollaborationTransport, type WebSocketLike } from '../../adapters/platform/collaboration-transport';
import { emptyOutbox, type OutboxState } from './sync-client';
import type { ProductCommand, ProductCommandResult } from '../../contracts/repository-commands';
import { PROTOCOL_VERSION } from '../../../spikes/phase-0-durability/src/command-receipt';

const projectId = '019ff100-0000-7000-8000-000000000001';
const nodeId = '019ff100-0000-7000-8000-0000000000a0';
const commandId = '019ff100-0000-7000-8000-0000000000b0';
const command: ProductCommand = { type: 'SetNodeTitle', protocolVersion: PROTOCOL_VERSION,
  commandId, projectId, baseRevision: 0, expectedRevision: 1, nodeId, title: 'Synthetic' };

async function setup(initial: OutboxState = Object.freeze({ ...emptyOutbox(), streamEpoch: 1, resyncRequired: false }), extra: Partial<Pick<Parameters<typeof createCollaborationService>[0], 'setTimer' | 'clearTimer'>> = {}) {
  const socket: WebSocketLike = { send: vi.fn(), close: vi.fn(), onmessage: null, onclose: null, onerror: null };
  const fetchPort = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    streamEpoch: 1, revision: 1, result: { type: 'ProductCommandApplied' },
  }), { status: 200 }));
  const repository: SyncRepository = {
    readOutbox: vi.fn().mockResolvedValue(initial),
    installSnapshot: vi.fn().mockRejectedValue(new Error('Synthetic unavailable atomic installation')),
    discardOutboxEntry: vi.fn().mockResolvedValue(undefined),
    commitWithOutbox: vi.fn().mockResolvedValue({ applied: true, result: { type: 'ProductCommandApplied', protocolVersion: PROTOCOL_VERSION, commandId, projectId, baseRevision: 0, targetRevision: 1, outcome: 'VfsCommitAccepted', disposition: 'NewCommit' } }),
    commitGroupWithOutbox: vi.fn(async (_project: string, commands: readonly ProductCommand[]) => ({ applied: true, results: commands.map((c, i) => ({ type: 'ProductCommandApplied', protocolVersion: PROTOCOL_VERSION, commandId: c.commandId, projectId, baseRevision: i, targetRevision: i + 1, outcome: 'VfsCommitAccepted', disposition: 'NewCommit' })) as unknown as readonly ProductCommandResult[] })),
    applyRebase: vi.fn().mockResolvedValue({ resyncRequired: false }),
    mergeState: () => ({ projectId, nodes: new Map([[nodeId, { parentId: null }]]),
      order: new Map([['', [nodeId]]]), forecastOrder: [], forecastGroups: [], assignments: {},
      rosterIds: new Set(), points: new Map(), pointsDone: new Map() }),
  };
  const openSocket = vi.fn((_url: string) => socket);
  const authenticate = vi.fn(async () => ({ deviceId: 'synthetic-device', bearer: null, proof: null }));
  const service = await createCollaborationService({ projectId, deviceId: 'synthetic-device', repository,
    transport: new CollaborationTransport('https://synthetic.invalid', { fetch: fetchPort, openSocket }),
    authenticate,
    nowISO: () => '2026-10-05T00:00:00Z',
    ...extra,
  });
  await service.connect();
  return { service, socket, repository, fetchPort, openSocket, authenticate };
}

async function frame(socket: WebSocketLike, revision = 1) {
  socket.onmessage?.({ data: JSON.stringify({ type: 'Command', streamEpoch: 1, serverRevision: revision, historyEntry: await boundHistoryFixture(command, revision),
    command, appliedCommandIds: [commandId] }) });
}

describe('collaboration service commit boundaries', () => {
  it('returns the local result before network submission and still submits in order', async () => {
    const { service, socket, fetchPort } = await setup();
    socket.onmessage?.({ data: JSON.stringify({ type: 'CatchUpReady', streamEpoch: 1, serverRevision: 0 }) });
    let release!: (response: Response) => void;
    fetchPort.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    await vi.waitFor(() => expect(service.getState().streamEpoch).toBe(1));
    const result = await service.applyLocalEdit(command);
    expect(result.type).toBe('ProductCommandApplied');
    expect(service.getState().entries.map((e) => e.commandId)).toEqual([commandId]);
    // The POST is in flight while the caller already has its result.
    await vi.waitFor(() => expect(fetchPort).toHaveBeenCalledTimes(1));
    release(new Response(JSON.stringify({ streamEpoch: 1, revision: 1, result: { type: 'ProductCommandApplied' } }), { status: 200 }));
    service.disconnect();
  });

  it('resyncs after a definitive server rejection so the snapshot can retain it', async () => {
    const { service, socket, fetchPort, openSocket } = await setup();
    socket.onmessage?.({ data: JSON.stringify({ type: 'CatchUpReady', streamEpoch: 1, serverRevision: 0 }) });
    await vi.waitFor(() => expect(service.isConnected()).toBe(true));
    fetchPort.mockResolvedValueOnce(new Response(JSON.stringify({ streamEpoch: 1, revision: 0, result: { type: 'ProductCommandRejected', code: 'REVISION_CONFLICT' } }), { status: 200 }));
    const opened = openSocket.mock.calls.length;
    await service.applyLocalEdit(command);
    await vi.waitFor(() => expect(openSocket.mock.calls.length).toBe(opened + 1));
    // The new stream asks for a full snapshot (no cursor resume) and nothing is dropped locally.
    expect(String(openSocket.mock.calls.at(-1)?.[0])).toContain('since=0');
    expect(service.isConnected()).toBe(false);
    expect(service.getState().entries.map((e) => e.commandId)).toEqual([commandId]);
    service.disconnect();
  });

  it('commits a composite gesture as one group and submits it as one all-or-nothing request', async () => {
    const { service, socket, fetchPort, repository } = await setup();
    socket.onmessage?.({ data: JSON.stringify({ type: 'CatchUpReady', streamEpoch: 1, serverRevision: 0 }) });
    await vi.waitFor(() => expect(service.isConnected()).toBe(true));
    const second = { ...command, commandId: '019ff500-0000-7000-8000-0000000000c2' } as ProductCommand;
    fetchPort.mockResolvedValueOnce(new Response(JSON.stringify({ streamEpoch: 1, revision: 2, results: [{ type: 'ProductCommandApplied' }, { type: 'ProductCommandApplied' }] }), { status: 200 }));
    const results = await service.applyLocalGroup([command, second]);
    expect(results.map((r) => r.type)).toEqual(['ProductCommandApplied', 'ProductCommandApplied']);
    const [, , entries] = vi.mocked(repository.commitGroupWithOutbox).mock.calls[0];
    expect(entries.map((e) => [e.commandId, e.groupId, e.groupIndex])).toEqual([[commandId, commandId, 0], [second.commandId, commandId, 1]]);
    expect(service.getState().entries.map((e) => e.groupId)).toEqual([commandId, commandId]);
    await vi.waitFor(() => expect(fetchPort).toHaveBeenCalledTimes(1));
    const [url, init] = fetchPort.mock.calls[0];
    expect(String(url)).toBe(`https://synthetic.invalid/projects/${projectId}/command-group`);
    expect(JSON.parse(String(init?.body)).commands.map((c: ProductCommand) => c.commandId)).toEqual([commandId, second.commandId]);
    service.disconnect();
  });

  it('resyncs when the service refuses a whole gesture', async () => {
    const { service, socket, fetchPort, openSocket } = await setup();
    socket.onmessage?.({ data: JSON.stringify({ type: 'CatchUpReady', streamEpoch: 1, serverRevision: 0 }) });
    await vi.waitFor(() => expect(service.isConnected()).toBe(true));
    const second = { ...command, commandId: '019ff500-0000-7000-8000-0000000000c2' } as ProductCommand;
    fetchPort.mockResolvedValueOnce(new Response(JSON.stringify({ streamEpoch: 1, revision: 0, results: [{ type: 'ProductCommandRejected', code: 'ATOMIC_GROUP_REJECTED' }, { type: 'ProductCommandRejected', code: 'NODE_NOT_FOUND' }] }), { status: 200 }));
    const opened = openSocket.mock.calls.length;
    await service.applyLocalGroup([command, second]);
    await vi.waitFor(() => expect(openSocket.mock.calls.length).toBe(opened + 1));
    expect(String(openSocket.mock.calls.at(-1)?.[0])).toContain('since=0');
    service.disconnect();
  });

  it('retries queued work after a failed send while the stream stays open', async () => {
    const timers: Array<() => void> = [];
    const { service, socket, fetchPort } = await setup(undefined, { setTimer: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimer: () => undefined });
    socket.onmessage?.({ data: JSON.stringify({ type: 'CatchUpReady', streamEpoch: 1, serverRevision: 0 }) });
    await vi.waitFor(() => expect(service.isConnected()).toBe(true));
    fetchPort.mockRejectedValueOnce(new TypeError('Synthetic network drop'));
    await service.applyLocalEdit(command);
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    expect(fetchPort).toHaveBeenCalledTimes(1);
    timers[0]();
    await vi.waitFor(() => expect(fetchPort).toHaveBeenCalledTimes(2));
    expect(service.getState().entries.map((e) => e.commandId)).toEqual([commandId]);
    service.disconnect();
  });

  it('discarding re-reads the durable journal', async () => {
    const { service, repository } = await setup();
    const after = Object.freeze({ ...emptyOutbox(), streamEpoch: 1, resyncRequired: false, cursor: 4 });
    vi.mocked(repository.readOutbox).mockResolvedValueOnce(after);
    await service.discardRejected(commandId);
    expect(repository.discardOutboxEntry).toHaveBeenCalledWith(projectId, commandId);
    expect(service.getState()).toBe(after);
    service.disconnect();
  });

  it('reports a teammate frame with its targets for shared undo, but not an own echo', async () => {
    const onRemoteCommand = vi.fn();
    const { service, socket } = await setup();
    // Rebuild with the callback: setup() has no hook, so drive a second service.
    service.disconnect();
    const socket2: WebSocketLike = { send: vi.fn(), close: vi.fn(), onmessage: null, onclose: null, onerror: null };
    const repository: SyncRepository = {
      readOutbox: vi.fn().mockResolvedValue(Object.freeze({ ...emptyOutbox(), streamEpoch: 1, resyncRequired: false })),
      installSnapshot: vi.fn(), discardOutboxEntry: vi.fn(), commitWithOutbox: vi.fn(), commitGroupWithOutbox: vi.fn(),
      applyRebase: vi.fn().mockResolvedValue({ resyncRequired: false, state: Object.freeze({ ...emptyOutbox(), streamEpoch: 1, resyncRequired: false, cursor: 1 }) }),
      mergeState: () => ({ projectId, nodes: new Map([[nodeId, { parentId: null }]]), order: new Map([['', [nodeId]]]), forecastOrder: [], forecastGroups: [], assignments: {}, rosterIds: new Set(), points: new Map(), pointsDone: new Map() }),
    };
    const live = await createCollaborationService({ projectId, deviceId: 'synthetic-device', repository,
      transport: new CollaborationTransport('https://synthetic.invalid', { fetch: vi.fn<typeof fetch>(), openSocket: () => socket2 }),
      authenticate: async () => ({ deviceId: 'synthetic-device', bearer: null, proof: null }), nowISO: () => '2026-10-07T00:00:00Z', onRemoteCommand });
    await live.connect();
    await frame(socket2, 1);
    await vi.waitFor(() => expect(onRemoteCommand).toHaveBeenCalledTimes(1));
    expect(onRemoteCommand.mock.calls[0][2]).toContain(nodeId);
    void socket;
    live.disconnect();
  });

  it('remoteTargets includes authoritative effect footprints only when complete', async () => {
    const history = await boundHistoryFixture(command, 1);
    expect(remoteTargets(command, history)).toEqual([nodeId]);
    const complete = { ...history, effectFootprint: { availability: 'complete' as const, reason: null,
      knownTargets: [{ kind: 'entity' as const, entityType: 'node', id: 'child-1' }, { kind: 'order' as const, collectionType: 'children', ownerId: 'parent-1' }] } };
    expect(remoteTargets(command, complete)).toEqual([nodeId, 'child-1', 'parent-1']);
  });

  it('returns a local rejection without queuing or submitting it', async () => {
    const { service, repository, fetchPort } = await setup();
    const rejected = { type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId, code: 'NODE_NOT_FOUND' } as const;
    vi.mocked(repository.commitWithOutbox).mockResolvedValueOnce({ applied: false, rejectedReason: 'NODE_NOT_FOUND', result: rejected });
    expect(await service.applyLocalEdit(command)).toEqual(rejected);
    expect(service.getState().entries).toHaveLength(0);
    expect(fetchPort).not.toHaveBeenCalled();
    service.disconnect();
  });

  it('clears readiness immediately on socket close before reconnect', async () => {
    vi.useFakeTimers();
    try {
      const { service, socket, fetchPort } = await setup();
      socket.onmessage?.({ data: JSON.stringify({ type: 'CatchUpReady', streamEpoch: 1, serverRevision: 0 }) });
      await vi.advanceTimersByTimeAsync(0);
      socket.onclose?.();
      await service.onLocalEdit(command);
      expect(fetchPort).not.toHaveBeenCalled();
      expect(service.getState().entries).toHaveLength(1);
      service.disconnect();
    } finally { vi.useRealTimers(); }
  });

  it('requests bootstrap after named resync instead of permanently stopping', async () => {
    const { service, socket, openSocket } = await setup();
    socket.onmessage?.({ data: JSON.stringify({ type: 'ResyncRequired', reason: 'STREAM_EPOCH_MISMATCH' }) });
    await vi.waitFor(() => expect(openSocket).toHaveBeenCalledTimes(2));
    const url = openSocket.mock.calls.length;
    expect(url).toBe(2);
    expect(service.getState().resyncRequired).toBe(true);
    service.disconnect();
  });

  it('blocks oversized recovery without reconnect or pending submission', async () => {
    const initial = { ...emptyOutbox(), streamEpoch: 1, resyncRequired: false,
      entries: [{ commandId, command, commitAttemptId: 1, queuedAtISO: '2026-10-01T00:00:00Z' }] };
    const { service, socket, openSocket, fetchPort } = await setup(initial);
    socket.onmessage?.({ data: JSON.stringify({ type: 'ResyncRequired', reason: 'RECOVERY_PAYLOAD_TOO_LARGE' }) });
    await vi.waitFor(() => expect(service.getState().recoveryReason).toBe('RECOVERY_PAYLOAD_TOO_LARGE'));
    expect(service.getState().recoveryRequired).toBe(true);
    expect(service.getState().entries).toHaveLength(1);
    expect(openSocket).toHaveBeenCalledTimes(1);
    expect(fetchPort).not.toHaveBeenCalled();
    await service.connect();
    socket.onmessage?.({ data: JSON.stringify({ type: 'CatchUpReady', streamEpoch: 1, serverRevision: 0 }) });
    await vi.waitFor(() => expect(openSocket).toHaveBeenCalledTimes(2));
    expect(fetchPort).not.toHaveBeenCalled();
    service.disconnect();
  });

  it('reconnects with a fresh authentication proof using default timers', async () => {
    vi.useFakeTimers();
    let service: Awaited<ReturnType<typeof createCollaborationService>> | undefined;
    try {
      const setupResult = await setup();
      service = setupResult.service;
      setupResult.socket.onclose?.();
      await vi.advanceTimersByTimeAsync(500);
      expect(setupResult.openSocket).toHaveBeenCalledTimes(2);
      expect(setupResult.authenticate).toHaveBeenCalledTimes(2);
    } finally {
      service?.disconnect();
      vi.useRealTimers();
    }
  });
  it('retains own-echo identity after POST acknowledgement until ordered replay commits', async () => {
    const { service, socket, repository } = await setup();
    await service.onLocalEdit(command);
    expect(service.getState().entries).toHaveLength(1);
    await frame(socket);
    await vi.waitFor(() => expect(service.getState().cursor).toBe(1));
    expect(repository.applyRebase).toHaveBeenCalledWith(projectId,
      { command, ownEcho: true, serverRevision: 1, streamEpoch: 1, historyEntry: await boundHistoryFixture(command) }, [], []);
    expect(service.getState().entries).toHaveLength(0);
  });

  it('keeps durable edits when the network submission fails', async () => {
    const { service, fetchPort } = await setup();
    fetchPort.mockRejectedValueOnce(new Error('Synthetic offline'));
    await service.onLocalEdit(command);
    expect(service.getState().entries[0]?.commandId).toBe(commandId);
    expect(service.getState().cursor).toBe(0);
  });

  it('does not acknowledge a failed repository rebase', async () => {
    const { service, socket, repository } = await setup();
    await service.onLocalEdit(command);
    vi.mocked(repository.applyRebase).mockRejectedValueOnce(new Error('Synthetic commit failure'));
    await frame(socket);
    await vi.waitFor(() => expect(service.getState().resyncRequired).toBe(true));
    expect(service.getState().cursor).toBe(0);
    expect(service.getState().entries).toHaveLength(1);
  });

  it('fails closed when snapshot installation has no atomic repository implementation', async () => {
    const { service, socket } = await setup();
    await service.onLocalEdit(command);
    socket.onmessage?.({ data: JSON.stringify({ type: 'Snapshot', envelope: envelopeFixture(projectId) }) });
    await vi.waitFor(() => expect(socket.close).toHaveBeenCalled());
    expect(service.getState().cursor).toBe(0);
    expect(service.getState().entries).toHaveLength(1);
    expect(service.getState().resyncRequired).toBe(true);
  });

  it('adopts snapshot state only after the repository installation commits', async () => {
    const { service, socket, repository } = await setup();
    let commit: ((state: OutboxState) => void) | undefined;
    repository.installSnapshot = () => new Promise((resolve) => { commit = resolve; });
    socket.onmessage?.({ data: JSON.stringify({ type: 'Snapshot', envelope: envelopeFixture(projectId) }) });
    await vi.waitFor(() => expect(commit).toBeDefined());
    expect(service.getState().cursor).toBe(0);
    commit?.({ ...emptyOutbox(), streamEpoch: 1, resyncRequired: false, cursor: 42 });
    await vi.waitFor(() => expect(service.getState().cursor).toBe(42));
  });

  it('replays a persisted offline queue only after the verified ready cut', async () => {
    const initial = { ...emptyOutbox(), streamEpoch: 1, resyncRequired: false, entries: [{ commandId, command, commitAttemptId: 2, queuedAtISO: '2026-10-01T00:00:00Z' }] };
    const { service, socket, fetchPort } = await setup(initial);
    socket.onopen?.();
    expect(fetchPort).not.toHaveBeenCalled();
    socket.onmessage?.({ data: JSON.stringify({ type: 'CatchUpReady', streamEpoch: 1, serverRevision: 0 }) });
    await vi.waitFor(() => expect(fetchPort).toHaveBeenCalledTimes(1));
    expect(service.getState().entries).toHaveLength(1);
  });
});
