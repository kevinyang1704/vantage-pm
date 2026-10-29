/**
 * Collaboration session composition (Story 27.6/27.7, H08).
 *
 * The one place the app turns a local project into a shared one and opens a
 * live, authenticated sync session for a shared project. Everything is
 * injected (fetch, socket, credential store, registry, repository), so this
 * module stays testable without a network and is never composed while the
 * collaboration flag is off.
 *
 * First share is not one transaction (R7). It records a durable local intent
 * (registry `provisioning` + idempotent operation id + stored credential)
 * BEFORE any network call, claims the project for this device, uploads the
 * portable snapshot under that operation id, and only then records `shared`.
 * A retry reuses the same device, credential and operation id, so it can never
 * create a second server project or a second owner.
 */

import type { ProductCommand, ProductCommandResult } from '../../contracts/repository-commands';
import type { SyncState } from '../../domain/collaboration/sync-state';
import { createAuthenticator, sha256Hex, type CredentialPort, type DeviceCredential } from './credential.port';
import { createCollaborationService, type CollaborationService, type SyncRepository, type CollaborationTerminal } from './collaboration-service';
import type { OutboxEntry, OutboxState } from './sync-client';
import { retryCommand } from './rejected-work';
import type { SharedProjectRecord, SharedProjectRegistry } from './shared-project-registry';
import type { CollaborationTransport, AuthHeaders } from '../../adapters/platform/collaboration-transport';

export interface CollaborationSessionPorts {
  readonly origin: string;
  readonly fetch: typeof fetch;
  readonly transport: CollaborationTransport;
  readonly credentials: CredentialPort;
  readonly registry: SharedProjectRegistry;
  /** Desktop: random keychain bearer. Browser: non-exportable P-256 key. */
  readonly createCredential: () => Promise<DeviceCredential>;
  /** The project's portable snapshot (the server's PortableImportSnapshot shape). */
  readonly readPortableSnapshot: (projectId: string) => Promise<unknown>;
  readonly syncRepository: SyncRepository;
  readonly newId: () => string;
  readonly nowISO: () => string;
  readonly newRecoveryCode: () => string;
  /** Confirmed history in the current epoch, newest first (27.8 activity). */
  readonly readHistory?: (projectId: string, before: number | null, limit: number) => Promise<readonly Readonly<{ serverRevision: number; entry: unknown }>[]>;
  /** Drop the project's sync state once it is local again (owner stopped sharing). */
  readonly forgetCollaboration?: (projectId: string) => Promise<void>;
  /** Injectable for tests; defaults to the global timers. */
  readonly timers?: Readonly<{ setInterval: (fn: () => void, ms: number) => unknown; clearInterval: (handle: unknown) => void }>;
}

/** D9: heartbeat every 10 s; the service forgets a member after 30 s. */
export const PRESENCE_HEARTBEAT_MS = 10_000;

export interface PresentMember {
  readonly actorId: string;
  readonly displayName: string;
}

export class CollaborationError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'CollaborationError'; }
}

export interface ShareOutcome {
  readonly record: SharedProjectRecord;
  /** Shown to the owner exactly once; null when this attempt did not issue it. */
  readonly recoveryCode: string | null;
  /** The recovery link (project + code + service) a new device can redeem. */
  readonly recoveryLink: string | null;
}

/** HTTP headers the server's principal check reads (mirror principal.rs). */
export function authHeaderEntries(auth: AuthHeaders): Record<string, string> {
  const headers: Record<string, string> = { 'x-pmapp-device': auth.deviceId };
  if (auth.bearer !== null) headers['x-pmapp-bearer'] = auth.bearer;
  if (auth.proof !== null) {
    headers['x-pmapp-nonce'] = auth.proof.nonce;
    headers['x-pmapp-timestamp'] = auth.proof.timestamp;
    headers['x-pmapp-signature'] = auth.proof.signature;
  }
  return headers;
}

async function post(ports: CollaborationSessionPorts, path: string, body: unknown, auth: AuthHeaders | null): Promise<Response> {
  const text = JSON.stringify(body);
  return ports.fetch(`${ports.origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? authHeaderEntries(auth) : {}) },
    body: text,
  });
}

async function signed(ports: CollaborationSessionPorts, record: SharedProjectRecord, credential: DeviceCredential, path: string, body: unknown): Promise<Response> {
  const authenticate = createAuthenticator(record.deviceId, credential, ports.nowISO);
  const auth = await authenticate({ method: 'POST', path, bodyBytes: new TextEncoder().encode(JSON.stringify(body)) });
  return post(ports, path, body, auth);
}

async function failureCode(response: Response, fallback: string): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return /^[A-Z0-9_]{3,64}$/.test(text) ? text : fallback;
  } catch {
    return fallback;
  }
}

/** Turn a local project into a shared one (owner first-share, R7). */
export async function shareProject(
  ports: CollaborationSessionPorts,
  input: Readonly<{ projectId: string; displayName: string }>,
): Promise<ShareOutcome> {
  let record = await ports.registry.get(input.projectId);
  if (record?.status === 'shared') return { record, recoveryCode: null, recoveryLink: null };
  if (record?.status === 'stopped') throw new CollaborationError('RESHARE_REQUIRES_NEW_EPOCH');

  let credential: DeviceCredential | null;
  const firstAttempt = record === null;
  if (record === null) {
    const created: SharedProjectRecord = Object.freeze({
      projectId: input.projectId, origin: ports.origin, deviceId: ports.newId(), actorId: ports.newId(),
      displayName: input.displayName.trim(), role: 'owner', status: 'provisioning',
      shareOperationId: ports.newId(), createdAtISO: ports.nowISO(),
    });
    credential = await ports.createCredential();
    // Durable intent before any network call: credential, then mapping.
    await ports.credentials.store(created.actorId, credential);
    await ports.registry.put(created);
    record = created;
  } else {
    credential = await ports.credentials.load(record.actorId);
    if (!credential) throw new CollaborationError('CREDENTIAL_MISSING');
  }
  if (record.origin !== ports.origin) throw new CollaborationError('SERVICE_ORIGIN_CHANGED');

  // Claim: the server stores only the bearer hash or the proven public key.
  const claimPath = `/projects/${record.projectId}/owner`;
  const claimBody = {
    deviceId: record.deviceId, actorId: record.actorId, displayName: record.displayName,
    credential: credential.kind === 'bearer-hash'
      ? { kind: 'bearer', bearer: credential.bearer }
      : { kind: 'publicKey', publicKeyB64: credential.publicKeyB64 },
  };
  const claimed = credential.kind === 'bearer-hash'
    ? await post(ports, claimPath, claimBody, null)
    : await signed(ports, record, credential, claimPath, claimBody);
  if (claimed.status === 409) throw new CollaborationError('PROJECT_ALREADY_CLAIMED');
  if (!claimed.ok) throw new CollaborationError(await failureCode(claimed, 'OWNER_CLAIM_FAILED'));

  // Recovery material is issued only on the first attempt: a retry cannot know
  // whether the server already stored an earlier verifier, and must never show
  // a code the server would not accept.
  const recoveryCode = firstAttempt ? ports.newRecoveryCode() : null;
  const sharePath = `/projects/${record.projectId}/share`;
  const shareBody = {
    operationId: record.shareOperationId,
    snapshot: await ports.readPortableSnapshot(record.projectId),
    ...(recoveryCode ? { recoveryVerifier: await sha256Hex(new TextEncoder().encode(recoveryCode)) } : {}),
  };
  const shared = await signed(ports, record, credential, sharePath, shareBody);
  if (!shared.ok) throw new CollaborationError(await failureCode(shared, 'SHARE_FAILED'));
  const activated: SharedProjectRecord = Object.freeze({ ...record, status: 'shared' });
  await ports.registry.put(activated);
  return {
    record: activated,
    recoveryCode,
    recoveryLink: recoveryCode ? formatRecoveryLink({ projectId: record.projectId, code: recoveryCode, service: ports.origin }) : null,
  };
}

/** Owner stops sharing: members lose access; this copy stays a local project. */
export async function stopSharing(ports: CollaborationSessionPorts, record: SharedProjectRecord): Promise<void> {
  const credential = await ports.credentials.load(record.actorId);
  if (!credential) throw new CollaborationError('CREDENTIAL_MISSING');
  const response = await signed(ports, record, credential, `/projects/${record.projectId}/share/stop`, {});
  if (!response.ok) throw new CollaborationError(await failureCode(response, 'STOP_FAILED'));
  await ports.registry.put(Object.freeze({ ...record, status: 'stopped' }));
  // The owner keeps a normal local project: local-only behaviour returns.
  await ports.forgetCollaboration?.(record.projectId);
}

/** Pure: the title-bar sync state for a live session (R8 precedence inputs). */
export function syncStateFor(outbox: OutboxState, connected: boolean, terminal: CollaborationTerminal): SyncState {
  if (terminal === 'revoked') return { kind: 'revoked' };
  if (terminal === 'update-required') return { kind: 'update-required' };
  const pendingCount = outbox.entries.length;
  const unresolved = (outbox.rejected?.length ?? 0) + (outbox.corrupt?.length ?? 0) + (outbox.recoveryRequired ? 1 : 0);
  if (unresolved > 0) return { kind: 'rejected', unresolvedCount: unresolved, connected, pendingCount };
  if (!connected) return { kind: 'offline', pendingCount, revoked: false };
  if (pendingCount > 0) return { kind: 'pending', count: pendingCount };
  return { kind: 'synced' };
}

export interface SharedSession {
  readonly record: SharedProjectRecord;
  readonly service: CollaborationService;
  applyLocalEdit(command: ProductCommand): Promise<ProductCommandResult>;
  /** A composite gesture, committed and synced all-or-nothing (Story 27.2). */
  applyLocalGroup(commands: readonly ProductCommand[]): Promise<readonly ProductCommandResult[]>;
  syncState(): SyncState;
  /** Durably retained rejected work, with its complete original command. */
  rejectedWork(): readonly Readonly<OutboxEntry & { reason: string }>[];
  /** Ids of queue rows that could not be read (quarantined, never dropped). */
  unreadableWork(): readonly string[];
  /** Durable dismissal of retained rejected or unreadable work. */
  discardRejected(commandId: string): Promise<void>;
  /**
   * Retry under a NEW command id at the current revision. The rejected entry
   * is dismissed only after the retry applied locally, so its content is never
   * lost in between.
   */
  retryRejected(commandId: string, currentRevision: number, newCommandId: string): Promise<ProductCommandResult>;
  /** Attributed confirmed changes (newest first) and the people to filter by. */
  activity(limit: number): Promise<ActivityPage>;
  close(): void;
}

export interface ActivityPage {
  readonly changes: readonly import('../../domain/collaboration/attribution').ConfirmedChange[];
  readonly people: readonly Readonly<{ actorId: string; actorName: string }>[];
  readonly hasMore: boolean;
}

export interface SharedSessionCallbacks {
  /** Teammates present right now (this person excluded); [] when unknown. */
  onPresence?: (present: readonly PresentMember[]) => void;
  onChange?: (state: SyncState) => void;
  onRejected?: (commandId: string, reason: string) => void;
  /** Authoritative state replaced local rows; refresh read models. */
  onRemoteChange?: () => void;
  /** A teammate's confirmed command with the ids it touched (shared undo, R9). */
  onRemoteCommand?: (command: ProductCommand, actorId: string | null, targetIds: readonly string[]) => void;
  /** An authoritative snapshot replaced local state. */
  onAuthoritativeReplace?: () => void;
  /** An owner changed this member's role; the session record now carries it. */
  onRoleChange?: (role: SharedProjectRecord['role']) => void;
}

/** Open an authenticated live session for a mapped shared project. */
export async function openSharedSession(
  ports: CollaborationSessionPorts,
  record: SharedProjectRecord,
  callbacks: SharedSessionCallbacks = {},
): Promise<SharedSession> {
  if (record.status !== 'shared') throw new CollaborationError('PROJECT_NOT_SHARED');
  if (record.origin !== ports.origin) throw new CollaborationError('SERVICE_ORIGIN_CHANGED');
  const credential = await ports.credentials.load(record.actorId);
  if (!credential) throw new CollaborationError('CREDENTIAL_MISSING');
  let service: CollaborationService | null = null;
  const view = (): SyncState => (service ? syncStateFor(service.getState(), service.isConnected(), service.terminal()) : { kind: 'saved-on-device' });
  let lastCursor = -1;
  service = await createCollaborationService({
    projectId: record.projectId,
    deviceId: record.deviceId,
    transport: ports.transport,
    repository: ports.syncRepository,
    authenticate: createAuthenticator(record.deviceId, credential, ports.nowISO),
    nowISO: ports.nowISO,
    onRejected: callbacks.onRejected,
    onResync: () => callbacks.onRemoteChange?.(),
    onRemoteCommand: callbacks.onRemoteCommand,
    onAuthoritativeReplace: callbacks.onAuthoritativeReplace,
    onStateChange: () => {
      if (!service) return;
      const cursor = service.getState().cursor;
      if (cursor !== lastCursor) { lastCursor = cursor; callbacks.onRemoteChange?.(); }
      callbacks.onChange?.(view());
    },
  });
  lastCursor = service.getState().cursor;
  const live = service;
  await live.connect();

  // Presence (27.8): one authenticated heartbeat both records this device and
  // returns who is here. Ephemeral; a failed beat clears the list instead of
  // showing stale people.
  const timers = ports.timers ?? {
    setInterval: (fn: () => void, ms: number) => globalThis.setInterval(fn, ms),
    clearInterval: (handle: unknown) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
  };
  let closed = false;
  let current: SharedProjectRecord = record;
  const beat = async (): Promise<void> => {
    try {
      const response = await signedRequest(ports, record, 'POST', `/projects/${record.projectId}/presence`, {});
      if (closed) return;
      if (!response.ok) { callbacks.onPresence?.([]); return; }
      // The service reports this member's current role on every beat.
      const role = response.headers.get('x-pmapp-role');
      if ((role === 'owner' || role === 'editor' || role === 'viewer') && role !== current.role) {
        current = Object.freeze({ ...current, role });
        await ports.registry.put(current);
        callbacks.onRoleChange?.(role);
      }
      const present = (await response.json()) as unknown;
      const members = Array.isArray(present)
        ? present.filter((m): m is PresentMember => typeof m === 'object' && m !== null && typeof (m as PresentMember).actorId === 'string' && typeof (m as PresentMember).displayName === 'string')
        : [];
      callbacks.onPresence?.(members.filter((m) => m.actorId !== record.actorId).map((m) => Object.freeze({ actorId: m.actorId, displayName: m.displayName })));
    } catch {
      if (!closed) callbacks.onPresence?.([]);
    }
  };
  const heartbeat = callbacks.onPresence ? timers.setInterval(() => { void beat(); }, PRESENCE_HEARTBEAT_MS) : null;

  // Display names for attribution, from the members-only people directory.
  const people = new Map<string, string>();
  const refreshPeople = async (): Promise<void> => {
    try {
      const response = await signedRequest(ports, record, 'GET', `/projects/${record.projectId}/people`);
      if (!response.ok) return;
      const list = (await response.json()) as unknown;
      if (!Array.isArray(list)) return;
      for (const p of list as Array<{ actorId?: unknown; displayName?: unknown }>) {
        if (typeof p.actorId === 'string' && typeof p.displayName === 'string') people.set(p.actorId, p.displayName);
      }
    } catch { /* Names fall back to "A teammate" while offline. */ }
  };
  if (callbacks.onPresence) void beat();

  return {
    get record() { return current; },
    service: live,
    applyLocalEdit: (command) => live.applyLocalEdit(command),
    applyLocalGroup: (commands) => live.applyLocalGroup(commands),
    syncState: view,
    rejectedWork: () => live.getState().rejected ?? [],
    unreadableWork: () => live.getState().corrupt ?? [],
    discardRejected: (commandId) => live.discardRejected(commandId),
    retryRejected: async (commandId, currentRevision, newCommandId) => {
      const entry = (live.getState().rejected ?? []).find((e) => e.commandId === commandId);
      if (!entry) throw new CollaborationError('REJECTED_WORK_NOT_FOUND');
      const result = await live.applyLocalEdit(retryCommand(entry.command, newCommandId, currentRevision));
      if (result.type === 'ProductCommandApplied') await live.discardRejected(commandId);
      return result;
    },
    activity: async (limit) => {
      if (!ports.readHistory) return { changes: [], people: [], hasMore: false };
      const rows = await ports.readHistory(record.projectId, null, Math.min(200, Math.max(1, limit)));
      const parsed = rows.flatMap((row) => {
        const entry = row.entry as { actorId?: unknown; recordedAtIso?: unknown; command?: unknown } | null;
        const command = entry?.command as ProductCommand | undefined;
        if (!entry || !command || typeof command !== 'object' || typeof (command as { type?: unknown }).type !== 'string') return [];
        return [{ serverRevision: row.serverRevision, actorId: typeof entry.actorId === 'string' ? entry.actorId : null,
          confirmedAtISO: typeof entry.recordedAtIso === 'string' ? entry.recordedAtIso : '', command }];
      });
      if (parsed.some((p) => p.actorId && !people.has(p.actorId))) await refreshPeople();
      const name = (actorId: string | null) => (actorId ? people.get(actorId) ?? (actorId === record.actorId ? record.displayName : 'A teammate') : 'A teammate');
      return {
        changes: parsed.map((p) => Object.freeze({ serverRevision: p.serverRevision, confirmedAtISO: p.confirmedAtISO, actorId: p.actorId ?? 'unknown', actorName: name(p.actorId), command: p.command })),
        people: [...people.entries()].map(([actorId, actorName]) => Object.freeze({ actorId, actorName })),
        hasMore: rows.length >= limit,
      };
    },
    close: () => {
      closed = true;
      if (heartbeat !== null) timers.clearInterval(heartbeat);
      live.disconnect();
    },
  };
}

// ── Invites, membership and joining (Story 27.4) ───────────────────────────

export interface InviteLink {
  readonly projectId: string;
  readonly token: string;
  readonly service: string;
}

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const LINK_PREFIX = 'vantage://join?';

/** `vantage://join?...` — pasteable, and the desktop deep-link form. */
export function formatInviteLink(link: InviteLink): string {
  const query = new URLSearchParams({ project: link.projectId, token: link.token, service: link.service });
  return `${LINK_PREFIX}${query.toString()}`;
}

/** Parse a pasted invite link; anything malformed is null (never a guess). */
export function parseInviteLink(text: string): InviteLink | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(LINK_PREFIX)) return null;
  const query = new URLSearchParams(trimmed.slice(LINK_PREFIX.length));
  const projectId = query.get('project') ?? '';
  const token = query.get('token') ?? '';
  const service = query.get('service') ?? '';
  if (!PROJECT_ID.test(projectId) || !TOKEN.test(token)) return null;
  try {
    if (new URL(service).origin !== service) return null;
  } catch {
    return null;
  }
  return Object.freeze({ projectId, token, service });
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signedRequest(ports: CollaborationSessionPorts, record: SharedProjectRecord, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<Response> {
  const credential = await ports.credentials.load(record.actorId);
  if (!credential) throw new CollaborationError('CREDENTIAL_MISSING');
  const text = body === undefined ? '' : JSON.stringify(body);
  const auth = await createAuthenticator(record.deviceId, credential, ports.nowISO)({ method, path, bodyBytes: new TextEncoder().encode(text) });
  return ports.fetch(`${ports.origin}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...authHeaderEntries(auth) },
    ...(body === undefined ? {} : { body: text }),
  });
}

export interface CreatedInvite {
  readonly inviteId: string;
  readonly link: string;
  readonly role: 'editor' | 'viewer';
  readonly expiresAtISO: string;
}

/** Owner creates a single-use invite link that expires (AC 27.4-3). */
export async function createInvite(ports: CollaborationSessionPorts, record: SharedProjectRecord, role: 'editor' | 'viewer', options: Readonly<{ validForDays?: number; replacesInviteId?: string }> = {}): Promise<CreatedInvite> {
  const token = randomToken();
  const inviteId = ports.newId();
  const expiresAtISO = new Date(Date.parse(ports.nowISO()) + (options.validForDays ?? 7) * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const response = await signedRequest(ports, record, 'POST', `/projects/${record.projectId}/invites`, {
    role, single_use: true, expires_at_iso: expiresAtISO, token, invite_id: inviteId,
    ...(options.replacesInviteId ? { replaces_invite_id: options.replacesInviteId } : {}),
  });
  if (!response.ok) throw new CollaborationError(await failureCode(response, 'INVITE_FAILED'));
  return Object.freeze({ inviteId, link: formatInviteLink({ projectId: record.projectId, token, service: ports.origin }), role, expiresAtISO });
}

export interface MembershipView {
  readonly members: readonly Readonly<{ deviceId: string; displayName: string; role: 'owner' | 'editor' | 'viewer' }>[];
  readonly requests: readonly Readonly<{ requestId: string; displayName: string; role: 'owner' | 'editor' | 'viewer' }>[];
  /** Owner approval for new joiners (AC 27.4-4); true unless an owner turned it off. */
  readonly approvalRequired: boolean;
}

/** Owner turns per-project join approval on or off (AC 27.4-4). */
export async function setApprovalRequired(ports: CollaborationSessionPorts, record: SharedProjectRecord, required: boolean): Promise<void> {
  const response = await signedRequest(ports, record, 'POST', `/projects/${record.projectId}/approval`, { required });
  if (!response.ok) throw new CollaborationError(await failureCode(response, 'APPROVAL_SETTING_FAILED'));
}

export async function listMembership(ports: CollaborationSessionPorts, record: SharedProjectRecord): Promise<MembershipView> {
  const response = await signedRequest(ports, record, 'GET', `/projects/${record.projectId}/members`);
  if (!response.ok) throw new CollaborationError(await failureCode(response, 'MEMBERS_UNAVAILABLE'));
  const view = (await response.json()) as MembershipView;
  if (!Array.isArray(view.members) || !Array.isArray(view.requests)) throw new CollaborationError('MEMBERS_UNAVAILABLE');
  // Fail safe: anything but an explicit false means approval is required.
  return { ...view, approvalRequired: view.approvalRequired !== false };
}

export async function decideJoin(ports: CollaborationSessionPorts, record: SharedProjectRecord, requestId: string, approve: boolean): Promise<void> {
  const response = await signedRequest(ports, record, 'POST', `/projects/${record.projectId}/join-requests/${encodeURIComponent(requestId)}/${approve ? 'approve' : 'deny'}`, {});
  if (!response.ok) throw new CollaborationError(await failureCode(response, approve ? 'APPROVE_FAILED' : 'DENY_FAILED'));
}

export async function removeMember(ports: CollaborationSessionPorts, record: SharedProjectRecord, deviceId: string): Promise<void> {
  const response = await signedRequest(ports, record, 'DELETE', `/projects/${record.projectId}/members/${encodeURIComponent(deviceId)}`);
  if (!response.ok) throw new CollaborationError(await failureCode(response, 'REMOVE_FAILED'));
}

/**
 * Redeem an invite as a new member. The device's own credential is bound to
 * the request (browser keys prove possession), stored locally first, and the
 * mapping waits in `joining` until an owner approves (or is `shared` at once
 * when the owner turned approval off).
 */
export async function joinWithInvite(
  ports: CollaborationSessionPorts,
  input: Readonly<{ link: string; displayName: string }>,
): Promise<SharedProjectRecord> {
  const link = parseInviteLink(input.link);
  if (!link) throw new CollaborationError('INVITE_LINK_INVALID');
  if (link.service !== ports.origin) throw new CollaborationError('INVITE_FOR_OTHER_SERVICE');
  const existing = await ports.registry.get(link.projectId);
  if (existing) throw new CollaborationError(existing.status === 'joining' ? 'JOIN_ALREADY_PENDING' : 'ALREADY_A_MEMBER');
  const displayName = input.displayName.trim();
  if (!displayName) throw new CollaborationError('NAME_REQUIRED');
  const credential = await ports.createCredential();
  const record: SharedProjectRecord = Object.freeze({
    projectId: link.projectId, origin: ports.origin, deviceId: ports.newId(), actorId: ports.newId(), displayName,
    role: 'viewer', status: 'joining', shareOperationId: null, joinRequestId: ports.newId(), createdAtISO: ports.nowISO(),
  });
  await ports.credentials.store(record.actorId, credential);
  await ports.registry.put(record);
  const body = {
    token: link.token, request_id: record.joinRequestId, actor_id: record.actorId, display_name: displayName, device_id: record.deviceId,
    verifier_kind: credential.kind === 'bearer-hash' ? 'bearerHash' : 'publicKey',
    verifier: credential.kind === 'bearer-hash' ? await sha256Hex(new TextEncoder().encode(credential.bearer)) : credential.publicKeyB64,
  };
  const response = credential.kind === 'bearer-hash'
    ? await post(ports, '/invites/redeem', body, null)
    : await signed(ports, record, credential, '/invites/redeem', body);
  if (!response.ok) {
    // A definite refusal leaves nothing behind; the link can be retried.
    await ports.registry.remove(record.projectId);
    await ports.credentials.remove(record.actorId);
    throw new CollaborationError(await failureCode(response, 'JOIN_FAILED'));
  }
  const redeemed = (await response.json()) as { role?: string; approved?: boolean };
  const role = redeemed.role === 'editor' || redeemed.role === 'viewer' ? redeemed.role : 'viewer';
  const joined: SharedProjectRecord = Object.freeze({ ...record, role, status: redeemed.approved ? 'shared' : 'joining' });
  await ports.registry.put(joined);
  return joined;
}

/** A joiner asks whether an owner decided; approved moves the mapping to shared. */
export async function refreshJoinStatus(ports: CollaborationSessionPorts, record: SharedProjectRecord): Promise<SharedProjectRecord | null> {
  if (record.status !== 'joining' || !record.joinRequestId) return record;
  const response = await signedRequest(ports, record, 'GET', `/join-requests/${encodeURIComponent(record.joinRequestId)}`);
  if (response.status === 401) throw new CollaborationError('JOIN_REQUEST_UNKNOWN');
  if (!response.ok) throw new CollaborationError(await failureCode(response, 'JOIN_STATUS_UNAVAILABLE'));
  const status = (await response.json()) as { status?: string; role?: string };
  if (status.status === 'denied') {
    await ports.registry.remove(record.projectId);
    await ports.credentials.remove(record.actorId);
    return null;
  }
  if (status.status !== 'approved') return record;
  const role = status.role === 'editor' || status.role === 'viewer' || status.role === 'owner' ? status.role : record.role;
  const approved: SharedProjectRecord = Object.freeze({ ...record, role, status: 'shared' });
  await ports.registry.put(approved);
  return approved;
}


// ── Owner recovery (Story 27.4, R6) ────────────────────────────────────────

export interface RecoveryLink {
  readonly projectId: string;
  readonly code: string;
  readonly service: string;
}

const RECOVER_PREFIX = 'vantage://recover?';
const RECOVERY_CODE = /^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/;

export function formatRecoveryLink(link: RecoveryLink): string {
  return `${RECOVER_PREFIX}${new URLSearchParams({ project: link.projectId, code: link.code, service: link.service }).toString()}`;
}

export function parseRecoveryLink(text: string): RecoveryLink | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(RECOVER_PREFIX)) return null;
  const query = new URLSearchParams(trimmed.slice(RECOVER_PREFIX.length));
  const projectId = query.get('project') ?? '';
  const code = query.get('code') ?? '';
  const service = query.get('service') ?? '';
  if (!PROJECT_ID.test(projectId) || !RECOVERY_CODE.test(code)) return null;
  try {
    if (new URL(service).origin !== service) return null;
  } catch {
    return null;
  }
  return Object.freeze({ projectId, code, service });
}

/**
 * Regain owner access on a new device with the once-shown recovery link. The
 * code is single-use; this device's own credential is bound (browser keys
 * prove possession) and the project bootstraps from the authoritative
 * snapshot like any member's.
 */
export async function recoverOwner(
  ports: CollaborationSessionPorts,
  input: Readonly<{ link: string; displayName: string }>,
): Promise<SharedProjectRecord> {
  const link = parseRecoveryLink(input.link);
  if (!link) throw new CollaborationError('RECOVERY_LINK_INVALID');
  if (link.service !== ports.origin) throw new CollaborationError('INVITE_FOR_OTHER_SERVICE');
  if (await ports.registry.get(link.projectId)) throw new CollaborationError('ALREADY_A_MEMBER');
  const displayName = input.displayName.trim();
  if (!displayName) throw new CollaborationError('NAME_REQUIRED');
  const credential = await ports.createCredential();
  const record: SharedProjectRecord = Object.freeze({
    projectId: link.projectId, origin: ports.origin, deviceId: ports.newId(), actorId: ports.newId(), displayName,
    role: 'owner', status: 'shared', shareOperationId: null, joinRequestId: null, createdAtISO: ports.nowISO(),
  });
  await ports.credentials.store(record.actorId, credential);
  const path = `/projects/${link.projectId}/recovery`;
  const body = {
    code: link.code, device_id: record.deviceId, actor_id: record.actorId, display_name: displayName,
    verifier_kind: credential.kind === 'bearer-hash' ? 'bearerHash' : 'publicKey',
    verifier: credential.kind === 'bearer-hash' ? await sha256Hex(new TextEncoder().encode(credential.bearer)) : credential.publicKeyB64,
  };
  const response = credential.kind === 'bearer-hash' ? await post(ports, path, body, null) : await signed(ports, record, credential, path, body);
  if (!response.ok) {
    await ports.credentials.remove(record.actorId);
    throw new CollaborationError(await failureCode(response, 'RECOVERY_FAILED'));
  }
  await ports.registry.put(record);
  return record;
}


// ── Roles and leaving (Story 27.4-5 / 27.6-5) ──────────────────────────────

export async function changeRole(ports: CollaborationSessionPorts, record: SharedProjectRecord, deviceId: string, role: 'owner' | 'editor' | 'viewer'): Promise<void> {
  const response = await signedRequest(ports, record, 'POST', `/projects/${record.projectId}/members/${encodeURIComponent(deviceId)}/role`, { role });
  if (!response.ok) throw new CollaborationError(await failureCode(response, 'ROLE_CHANGE_FAILED'));
}

/**
 * A member leaves: the service removes this device, and the local mapping is
 * kept as `stopped` so the copy stays read-only (and can be deleted).
 */
export async function leaveProject(ports: CollaborationSessionPorts, record: SharedProjectRecord): Promise<SharedProjectRecord> {
  const response = await signedRequest(ports, record, 'DELETE', `/projects/${record.projectId}/members/${encodeURIComponent(record.deviceId)}`);
  if (!response.ok) throw new CollaborationError(await failureCode(response, 'LEAVE_FAILED'));
  const left: SharedProjectRecord = Object.freeze({ ...record, status: 'stopped' });
  await ports.registry.put(left);
  await ports.credentials.remove(record.actorId);
  return left;
}
