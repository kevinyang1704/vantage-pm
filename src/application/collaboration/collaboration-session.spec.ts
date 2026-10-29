import { describe, expect, it, vi } from 'vitest';
import { CollaborationError, createInvite, decideJoin, formatInviteLink, formatRecoveryLink, parseRecoveryLink, recoverOwner, setApprovalRequired, joinWithInvite, listMembership, openSharedSession, parseInviteLink, refreshJoinStatus, shareProject, stopSharing, syncStateFor, type CollaborationSessionPorts } from './collaboration-session';
import type { SharedProjectRecord, SharedProjectRegistry } from './shared-project-registry';
import { sha256Hex, type CredentialPort, type DeviceCredential } from './credential.port';
import { CollaborationTransport } from '../../adapters/platform/collaboration-transport';
import { emptyOutbox } from './sync-client';
import type { SyncRepository } from './collaboration-service';
import { generateBrowserCredential } from '../../adapters/platform/browser-credential.adapter';

const PROJECT = '019ffa00-0000-7000-8000-000000000001';
const ORIGIN = 'https://svc.example';

function memoryRegistry(): SharedProjectRegistry & { rows: Map<string, SharedProjectRecord> } {
  const rows = new Map<string, SharedProjectRecord>();
  return { rows, get: async (id) => rows.get(id) ?? null, put: async (r) => { rows.set(r.projectId, r); }, remove: async (id) => { rows.delete(id); } };
}

function memoryCredentials(): CredentialPort & { rows: Map<string, DeviceCredential> } {
  const rows = new Map<string, DeviceCredential>();
  return { rows, load: async (id) => rows.get(id) ?? null, store: async (id, c) => { rows.set(id, c); }, remove: async (id) => { rows.delete(id); } };
}

type Call = { path: string; headers: Record<string, string>; body: Record<string, unknown> };

function ports(responses: Record<string, Response[]>, credential: () => Promise<DeviceCredential>) {
  const registry = memoryRegistry();
  const credentials = memoryCredentials();
  const calls: Call[] = [];
  const registryAtCall: (SharedProjectRecord | undefined)[] = [];
  let id = 0;
  const fetchPort = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input).slice(ORIGIN.length);
    calls.push({ path, headers: init?.headers as Record<string, string>, body: init?.body === undefined ? {} : JSON.parse(String(init.body)) });
    registryAtCall.push(registry.rows.get(PROJECT));
    const queue = responses[path.replace(PROJECT, ':id')] ?? responses[path] ?? [];
    return queue.shift() ?? new Response('UNEXPECTED', { status: 500 });
  });
  const value: CollaborationSessionPorts = {
    origin: ORIGIN,
    fetch: fetchPort,
    transport: new CollaborationTransport(ORIGIN, { fetch: fetchPort, openSocket: vi.fn() }),
    credentials,
    registry,
    createCredential: credential,
    readPortableSnapshot: async (projectId) => ({ projectId, projectName: 'Synthetic', projectRevision: 1 }),
    syncRepository: {} as SyncRepository,
    newId: () => `019ffa00-0000-7000-8000-${String(++id).padStart(12, '0')}`,
    nowISO: () => new Date().toISOString(),
    newRecoveryCode: () => 'WXYZ-2345-6789-ABCD-EFGH',
  };
  return { value, registry, credentials, calls, registryAtCall, fetchPort };
}

const ok = () => new Response(JSON.stringify({ status: 'shared' }), { status: 200 });
const bearer = async (): Promise<DeviceCredential> => ({ kind: 'bearer-hash', bearer: 'synthetic-bearer-0123456789abcdefghijklmnop' });

describe('first share (H08, R7)', () => {
  it('records a durable intent before the network, claims, uploads and activates', async () => {
    const p = ports({ '/projects/:id/owner': [ok()], '/projects/:id/share': [ok()] }, bearer);
    const outcome = await shareProject(p.value, { projectId: PROJECT, displayName: '  Hera ' });
    expect(outcome.recoveryCode).toBe('WXYZ-2345-6789-ABCD-EFGH');
    expect(outcome.record).toMatchObject({ status: 'shared', role: 'owner', displayName: 'Hera', origin: ORIGIN });
    // The intent and credential existed before the first request left.
    expect(p.registryAtCall[0]?.status).toBe('provisioning');
    expect(p.credentials.rows.get(outcome.record.actorId)).toBeDefined();
    const [claim, share] = p.calls;
    expect(claim.path).toBe(`/projects/${PROJECT}/owner`);
    expect(claim.body).toEqual({ deviceId: outcome.record.deviceId, actorId: outcome.record.actorId, displayName: 'Hera',
      credential: { kind: 'bearer', bearer: 'synthetic-bearer-0123456789abcdefghijklmnop' } });
    expect(share.headers['x-pmapp-bearer']).toBe('synthetic-bearer-0123456789abcdefghijklmnop');
    expect(share.body.operationId).toBe(outcome.record.shareOperationId);
    expect(share.body.recoveryVerifier).toBe(await sha256Hex(new TextEncoder().encode('WXYZ-2345-6789-ABCD-EFGH')));
    expect((share.body.snapshot as { projectId: string }).projectId).toBe(PROJECT);
    expect(p.registry.rows.get(PROJECT)?.status).toBe('shared');
  });

  it('retries with the same device, credential and operation id and never reissues recovery', async () => {
    const p = ports({ '/projects/:id/owner': [ok(), ok()], '/projects/:id/share': [new Response('<html>Bad gateway</html>', { status: 503 }), ok()] }, bearer);
    await expect(shareProject(p.value, { projectId: PROJECT, displayName: 'Hera' })).rejects.toThrow('SHARE_FAILED');
    const intent = p.registry.rows.get(PROJECT)!;
    expect(intent.status).toBe('provisioning');
    const createCredential = vi.fn(bearer);
    const retry = await shareProject({ ...p.value, createCredential }, { projectId: PROJECT, displayName: 'Hera' });
    expect(createCredential).not.toHaveBeenCalled();
    expect(retry.recoveryCode).toBeNull();
    expect(retry.record).toMatchObject({ deviceId: intent.deviceId, actorId: intent.actorId, shareOperationId: intent.shareOperationId, status: 'shared' });
    expect(p.calls[3].body.operationId).toBe(intent.shareOperationId);
    expect('recoveryVerifier' in p.calls[3].body).toBe(false);
    // Already shared: no further requests.
    await shareProject(p.value, { projectId: PROJECT, displayName: 'Hera' });
    expect(p.calls).toHaveLength(4);
  });

  it('refuses a project another device claimed and keeps the local intent', async () => {
    const p = ports({ '/projects/:id/owner': [new Response('PROJECT_ALREADY_CLAIMED', { status: 409 })] }, bearer);
    await expect(shareProject(p.value, { projectId: PROJECT, displayName: 'Hera' })).rejects.toEqual(new CollaborationError('PROJECT_ALREADY_CLAIMED'));
    expect(p.registry.rows.get(PROJECT)?.status).toBe('provisioning');
    expect(p.calls).toHaveLength(1);
  });

  it('browser claim registers the public key and proves possession on every request', async () => {
    const p = ports({ '/projects/:id/owner': [ok()], '/projects/:id/share': [ok()] }, generateBrowserCredential);
    const outcome = await shareProject(p.value, { projectId: PROJECT, displayName: 'Ada' });
    const [claim, share] = p.calls;
    const stored = p.credentials.rows.get(outcome.record.actorId)!;
    expect(stored.kind).toBe('public-key');
    expect(claim.body.credential).toEqual({ kind: 'publicKey', publicKeyB64: (stored as { publicKeyB64: string }).publicKeyB64 });
    for (const call of [claim, share]) {
      expect(call.headers['x-pmapp-signature']).toBeTruthy();
      expect(call.headers['x-pmapp-bearer']).toBeUndefined();
    }
    expect(claim.headers['x-pmapp-nonce']).not.toBe(share.headers['x-pmapp-nonce']);
  });

  it('stop sharing is owner-authenticated and records the stopped state; reshare is refused locally', async () => {
    const p = ports({ '/projects/:id/owner': [ok()], '/projects/:id/share': [ok()], '/projects/:id/share/stop': [new Response(null, { status: 204 })] }, bearer);
    const { record } = await shareProject(p.value, { projectId: PROJECT, displayName: 'Hera' });
    await stopSharing(p.value, record);
    expect(p.calls[2].path).toBe(`/projects/${PROJECT}/share/stop`);
    expect(p.calls[2].headers['x-pmapp-device']).toBe(record.deviceId);
    expect(p.registry.rows.get(PROJECT)?.status).toBe('stopped');
    await expect(shareProject(p.value, { projectId: PROJECT, displayName: 'Hera' })).rejects.toThrow('RESHARE_REQUIRES_NEW_EPOCH');
  });
});

describe('session composition guards', () => {
  it('opens only shared, same-origin projects with a stored credential', async () => {
    const p = ports({}, bearer);
    const record: SharedProjectRecord = { projectId: PROJECT, origin: ORIGIN, deviceId: 'd', actorId: 'a', displayName: 'Hera', role: 'owner', status: 'shared', shareOperationId: null, createdAtISO: '2026-10-06T00:00:00Z' };
    await expect(openSharedSession(p.value, record)).rejects.toThrow('CREDENTIAL_MISSING');
    await expect(openSharedSession(p.value, { ...record, status: 'provisioning' })).rejects.toThrow('PROJECT_NOT_SHARED');
    await expect(openSharedSession(p.value, { ...record, origin: 'https://other.example' })).rejects.toThrow('SERVICE_ORIGIN_CHANGED');
  });

  it('maps queue, connection and terminal status to the R8 indicator inputs', () => {
    const base = { ...emptyOutbox(), streamEpoch: 1, resyncRequired: false };
    const entry = { commandId: 'c', command: {} as never, commitAttemptId: 1, queuedAtISO: '2026-10-06T00:00:00Z' };
    expect(syncStateFor(base, true, null)).toEqual({ kind: 'synced' });
    expect(syncStateFor({ ...base, entries: [entry] }, true, null)).toEqual({ kind: 'pending', count: 1 });
    expect(syncStateFor({ ...base, entries: [entry] }, false, null)).toEqual({ kind: 'offline', pendingCount: 1, revoked: false });
    expect(syncStateFor({ ...base, rejected: [{ ...entry, reason: 'x' }] }, true, null)).toEqual({ kind: 'rejected', unresolvedCount: 1, connected: true, pendingCount: 0 });
    expect(syncStateFor({ ...base, recoveryRequired: true, recoveryReason: 'CONFIRMED_AHEAD' }, true, null).kind).toBe('rejected');
    expect(syncStateFor(base, true, 'revoked')).toEqual({ kind: 'revoked' });
    expect(syncStateFor(base, false, 'update-required')).toEqual({ kind: 'update-required' });
  });
});

describe('invites and joining (27.4)', () => {
  const TOKEN = 'A'.repeat(43);
  const link = `vantage://join?project=${PROJECT}&token=${TOKEN}&service=${encodeURIComponent(ORIGIN)}`;

  it('formats and strictly parses invite links', () => {
    expect(parseInviteLink(formatInviteLink({ projectId: PROJECT, token: TOKEN, service: ORIGIN }))).toEqual({ projectId: PROJECT, token: TOKEN, service: ORIGIN });
    expect(parseInviteLink(`  ${link}\n`)?.projectId).toBe(PROJECT);
    for (const bad of ['', 'https://svc.example/join', link.replace(PROJECT, 'nope'), link.replace(TOKEN, 'short'),
      link.replace(encodeURIComponent(ORIGIN), encodeURIComponent('https://svc.example/path'))]) {
      expect(parseInviteLink(bad), bad).toBeNull();
    }
  });

  it('owner creates a single-use expiring invite and decides join requests', async () => {
    const p = ports({ '/projects/:id/owner': [ok()], '/projects/:id/share': [ok()], '/projects/:id/invites': [ok()],
      '/projects/:id/members': [new Response(JSON.stringify({ members: [], requests: [{ requestId: 'r1', displayName: 'Milo', role: 'editor' }] }))],
      '/projects/:id/join-requests/r1/approve': [ok()] }, bearer);
    const { record } = await shareProject(p.value, { projectId: PROJECT, displayName: 'Hera' });
    const invite = await createInvite(p.value, record, 'editor');
    const parsed = parseInviteLink(invite.link)!;
    expect(parsed.service).toBe(ORIGIN);
    const call = p.calls[2];
    expect(call.body).toMatchObject({ role: 'editor', single_use: true, token: parsed.token });
    expect(Date.parse(call.body.expires_at_iso as string)).toBeGreaterThan(Date.now());
    expect((await listMembership(p.value, record)).requests[0].requestId).toBe('r1');
    expect(p.calls[3].headers['x-pmapp-bearer']).toBeDefined();
    await decideJoin(p.value, record, 'r1', true);
    expect(p.calls[4].path).toBe(`/projects/${PROJECT}/join-requests/r1/approve`);
  });

  it('joiner binds its own credential, waits, and becomes shared on approval', async () => {
    const p = ports({ '/invites/redeem': [new Response(JSON.stringify({ project_id: PROJECT, role: 'editor', approved: false }))] }, bearer);
    const joined = await joinWithInvite(p.value, { link, displayName: ' Milo ' });
    expect(joined).toMatchObject({ status: 'joining', role: 'editor', displayName: 'Milo' });
    const redeem = p.calls[0];
    expect(redeem.body).toMatchObject({ token: TOKEN, request_id: joined.joinRequestId, device_id: joined.deviceId, verifier_kind: 'bearerHash',
      verifier: await sha256Hex(new TextEncoder().encode('synthetic-bearer-0123456789abcdefghijklmnop')) });
    expect(JSON.stringify(redeem.body)).not.toContain('synthetic-bearer-0123456789');
    await expect(joinWithInvite(p.value, { link, displayName: 'Milo' })).rejects.toThrow('JOIN_ALREADY_PENDING');
    const statusPath = `/join-requests/${joined.joinRequestId}`;
    const responses: Record<string, Response[]> = {};
    responses[statusPath] = [new Response(JSON.stringify({ status: 'pending' })), new Response(JSON.stringify({ status: 'approved', role: 'editor' }))];
    const status = vi.fn<typeof fetch>(async (input) => responses[String(input).slice(ORIGIN.length)].shift()!);
    const pending = await refreshJoinStatus({ ...p.value, fetch: status }, joined);
    expect(pending?.status).toBe('joining');
    const approved = await refreshJoinStatus({ ...p.value, fetch: status }, joined);
    expect(approved?.status).toBe('shared');
    expect(p.registry.rows.get(PROJECT)?.status).toBe('shared');
  });

  it('a refused or denied join leaves no mapping or credential behind', async () => {
    const p = ports({ '/invites/redeem': [new Response('INVITEUSED', { status: 410 })] }, bearer);
    await expect(joinWithInvite(p.value, { link, displayName: 'Milo' })).rejects.toThrow('INVITEUSED');
    expect(p.registry.rows.size).toBe(0);
    expect(p.credentials.rows.size).toBe(0);
    await expect(joinWithInvite(p.value, { link: link.replace(encodeURIComponent(ORIGIN), encodeURIComponent('https://other.example')), displayName: 'Milo' }))
      .rejects.toThrow('INVITE_FOR_OTHER_SERVICE');
    const q = ports({ '/invites/redeem': [new Response(JSON.stringify({ project_id: PROJECT, role: 'viewer', approved: false }))] }, bearer);
    const joined = await joinWithInvite(q.value, { link, displayName: 'Milo' });
    const denied = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ status: 'denied' })));
    expect(await refreshJoinStatus({ ...q.value, fetch: denied }, joined)).toBeNull();
    expect(q.registry.rows.size).toBe(0);
    expect(q.credentials.rows.size).toBe(0);
  });
});


describe('presence heartbeat (27.8)', () => {
  it('beats immediately and every 10 s, reports teammates only, clears on failure and stops on close', async () => {
    let tick: (() => void) | null = null;
    const cleared = vi.fn();
    const timers = { setInterval: (fn: () => void) => { tick = fn; return 'h'; }, clearInterval: cleared };
    const presence = vi.fn();
    const responses = [
      new Response(JSON.stringify([{ actorId: 'me', displayName: 'Hera' }, { actorId: 'them', displayName: 'Milo' }])),
      new Response('UNAUTHENTICATED', { status: 401 }),
    ];
    const fetchPort = vi.fn<typeof fetch>(async () => responses.shift()!);
    const socket = { send: vi.fn(), close: vi.fn(), onmessage: null, onclose: null, onerror: null };
    const credentials = memoryCredentials();
    await credentials.store('me', { kind: 'bearer-hash', bearer: 'synthetic-bearer-0123456789abcdefghijklmnop' });
    const record: SharedProjectRecord = { projectId: PROJECT, origin: ORIGIN, deviceId: 'dev', actorId: 'me', displayName: 'Hera', role: 'owner', status: 'shared', shareOperationId: null, createdAtISO: '2026-10-06T00:00:00Z' };
    const repository = { readOutbox: vi.fn().mockResolvedValue({ ...emptyOutbox(), streamEpoch: 1, resyncRequired: false }) } as unknown as SyncRepository;
    const session = await openSharedSession({
      origin: ORIGIN, fetch: fetchPort, transport: new CollaborationTransport(ORIGIN, { fetch: fetchPort, openSocket: () => socket }),
      credentials, registry: memoryRegistry(), createCredential: bearer, readPortableSnapshot: async () => ({}), syncRepository: repository,
      newId: () => 'x', nowISO: () => new Date().toISOString(), newRecoveryCode: () => 'R', timers,
    }, record, { onPresence: presence });
    await vi.waitFor(() => expect(presence).toHaveBeenCalledWith([{ actorId: 'them', displayName: 'Milo' }]));
    const beat = fetchPort.mock.calls.find(([url]) => String(url).endsWith('/presence'));
    expect(beat?.[1]?.method).toBe('POST');
    expect((beat?.[1]?.headers as Record<string, string>)['x-pmapp-device']).toBe('dev');
    tick!();
    await vi.waitFor(() => expect(presence).toHaveBeenLastCalledWith([]));
    session.close();
    expect(cleared).toHaveBeenCalledWith('h');
  });
});

describe('owner recovery (27.4)', () => {
  const CODE = 'ABCD-EFGH-JKLM-NPQR-STUV';
  const link = `vantage://recover?project=${PROJECT}&code=${CODE}&service=${encodeURIComponent(ORIGIN)}`;

  it('formats and strictly parses recovery links', () => {
    expect(parseRecoveryLink(formatRecoveryLink({ projectId: PROJECT, code: CODE, service: ORIGIN }))).toEqual({ projectId: PROJECT, code: CODE, service: ORIGIN });
    for (const bad of [link.replace(CODE, 'abcd-efgh'), link.replace('recover', 'join'), link.replace(PROJECT, 'x')]) expect(parseRecoveryLink(bad), bad).toBeNull();
  });

  it('first share returns a recovery link carrying the project, code and service', async () => {
    const p = ports({ '/projects/:id/owner': [ok()], '/projects/:id/share': [ok()] }, bearer);
    const outcome = await shareProject(p.value, { projectId: PROJECT, displayName: 'Hera' });
    expect(parseRecoveryLink(outcome.recoveryLink!)).toEqual({ projectId: PROJECT, code: 'WXYZ-2345-6789-ABCD-EFGH', service: ORIGIN });
  });

  it('binds a new owner device, and a refused code leaves nothing behind', async () => {
    const p = ports({ '/projects/:id/recovery': [new Response(JSON.stringify({ role: 'owner' })), new Response('NOTAMEMBER', { status: 404 })] }, bearer);
    const record = await recoverOwner(p.value, { link, displayName: 'Hera laptop' });
    expect(record).toMatchObject({ role: 'owner', status: 'shared', projectId: PROJECT });
    expect(p.calls[0].body).toMatchObject({ code: CODE, device_id: record.deviceId, verifier_kind: 'bearerHash' });
    await expect(recoverOwner(p.value, { link, displayName: 'Again' })).rejects.toThrow('ALREADY_A_MEMBER');
    const q = ports({ '/projects/:id/recovery': [new Response('NOTAMEMBER', { status: 404 })] }, bearer);
    await expect(recoverOwner(q.value, { link, displayName: 'Hera' })).rejects.toThrow('NOTAMEMBER');
    expect(q.registry.rows.size).toBe(0);
    expect(q.credentials.rows.size).toBe(0);
  });
});

describe('approval setting (27.4-4)', () => {
  it('posts the owner choice and treats anything but an explicit false as required', async () => {
    const p = ports({ '/projects/:id/owner': [ok()], '/projects/:id/share': [ok()], '/projects/:id/approval': [new Response(null, { status: 204 })],
      '/projects/:id/members': [new Response(JSON.stringify({ members: [], requests: [] })), new Response(JSON.stringify({ members: [], requests: [], approvalRequired: false }))] }, bearer);
    const { record } = await shareProject(p.value, { projectId: PROJECT, displayName: 'Hera' });
    await setApprovalRequired(p.value, record, false);
    expect(p.calls[2].body).toEqual({ required: false });
    expect((await listMembership(p.value, record)).approvalRequired).toBe(true);
    expect((await listMembership(p.value, record)).approvalRequired).toBe(false);
  });
});
