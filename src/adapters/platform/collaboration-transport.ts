/**
 * Collaboration transport (Story 27.7, D1/R4/R6, H01/H03).
 *
 * The one adapter that talks to the sync service: it submits commands over HTTP
 * and consumes the ordered stream over WebSocket. Everything else in the sync
 * client is pure; this is the I/O seam. Composed only when the `collaboration`
 * flag is on (AD-20) and only ever contacts the configured service origin.
 *
 * Authentication is delegated to the injected credential: `auth` produces the
 * exact headers the server verifies (desktop: `x-pmapp-bearer`; browser:
 * `x-pmapp-nonce`/`timestamp`/`signature` over method+path+bodyDigest+nonce+time)
 * — the transport never invents proof material.
 */

import { PROTOCOL_VERSION } from '../../domain/collaboration/version-handshake';
import { PRODUCT_SCHEMA_VERSION } from '../persistence/schema';
import { validateProductCommand } from '../../contracts/repository-commands';
import { validateConfirmedHistoryEntry, recoveryPayloadDigest } from '../../contracts/collaboration-recovery.validation';
import type { ProductCommand } from '../../contracts/repository-commands';
import type { StreamFrame } from '../../application/collaboration/sync-client';

export interface SubmitOutcome {
  readonly revision: number;
  readonly streamEpoch?: number;
  readonly resyncRequired?: boolean;
  readonly recoveryReason?: string;
  readonly accepted: boolean;
  /** True only when the server APPLIED the command (not a domain rejection). */
  readonly applied: boolean;
  /** The server's result payload, so the caller can surface a rejection. */
  readonly result?: unknown;
}

/** Headers required to authenticate one request (R6/H01). */
export interface AuthHeaders {
  readonly deviceId: string;
  /** Desktop bearer credential, or null for the browser signature path. */
  readonly bearer: string | null;
  /** Browser proof-of-possession fields, or null for the desktop path. */
  readonly proof: Readonly<{ nonce: string; timestamp: string; signature: string }> | null;
}

export interface TransportPorts {
  fetch: typeof fetch;
  /** Constructs a WebSocket to the given URL. */
  openSocket: (url: string) => WebSocketLike;
}

/** The subset of the WebSocket API the client uses. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen?: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface ServerFrame {
  readonly type: string;
  readonly [key: string]: unknown;
}

export class CollaborationTransport {
  constructor(
    private readonly origin: string,
    private readonly ports: TransportPorts,
  ) {}

  /**
   * Submit one command, authenticated by `auth`. The server re-checks
   * membership/role (R6) and applies it with the shared core; the response
   * carries the assigned server revision.
   */
  async submit(projectId: string, command: ProductCommand, auth: AuthHeaders, streamEpoch: number): Promise<SubmitOutcome> {
    const posted = await this.#post(`/projects/${projectId}/commands`, JSON.stringify({ recoveryVersion: 1, streamEpoch, command }), auth);
    if ('failure' in posted) return posted.failure;
    const bodyJson = posted.body as { revision?: number; streamEpoch?: number; result?: { type?: string } };
    // The server returns 200 even for a domain rejection; only an *applied*
    // result may be confirmed and dropped from the outbox (R8).
    const applied = bodyJson.result?.type === 'ProductCommandApplied';
    return Object.freeze({ revision: Number(bodyJson.revision ?? -1), streamEpoch: bodyJson.streamEpoch, accepted: true, applied, result: bodyJson.result });
  }

  /**
   * Submit a composite gesture's commands as ONE all-or-nothing group (Story
   * 27.2). `applied` is true only when every member applied; otherwise
   * `result` carries the refused member's result. The body bytes are exactly
   * `{"recoveryVersion":1,"streamEpoch":…,"commands":[…]}`, which is what the
   * caller authenticates.
   */
  async submitGroup(projectId: string, commands: readonly ProductCommand[], auth: AuthHeaders, streamEpoch: number): Promise<SubmitOutcome> {
    const posted = await this.#post(`/projects/${projectId}/command-group`, JSON.stringify({ recoveryVersion: 1, streamEpoch, commands }), auth);
    if ('failure' in posted) return posted.failure;
    const bodyJson = posted.body as { revision?: number; streamEpoch?: number; results?: { type?: string }[] };
    const results = Array.isArray(bodyJson.results) ? bodyJson.results : [];
    const applied = results.length === commands.length && results.every((result) => result?.type === 'ProductCommandApplied');
    const refused = results.find((result) => result?.type !== 'ProductCommandApplied');
    return Object.freeze({ revision: Number(bodyJson.revision ?? -1), streamEpoch: bodyJson.streamEpoch, accepted: results.length === commands.length, applied, result: refused ?? results[results.length - 1] });
  }

  async #post(path: string, body: string, auth: AuthHeaders): Promise<{ body: unknown } | { failure: SubmitOutcome }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-pmapp-protocol-version': PROTOCOL_VERSION,
      'x-pmapp-schema-version': String(PRODUCT_SCHEMA_VERSION),
      'x-pmapp-device': auth.deviceId,
    };
    if (auth.bearer !== null) headers['x-pmapp-bearer'] = auth.bearer;
    if (auth.proof !== null) {
      headers['x-pmapp-nonce'] = auth.proof.nonce;
      headers['x-pmapp-timestamp'] = auth.proof.timestamp;
      headers['x-pmapp-signature'] = auth.proof.signature;
    }
    const response = await this.ports.fetch(`${this.origin}${path}`, { method: 'POST', headers, body });
    if (!response.ok) {
      let resyncRequired = response.status === 409 || response.status === 426;
      let recoveryReason: string | undefined;
      try {
        const failure: unknown = await response.json();
        if (typeof failure === 'object' && failure !== null && 'kind' in failure) {
          resyncRequired ||= failure.kind === 'ResyncRequired' || failure.kind === 'UpdateRequired';
          if (failure.kind === 'RecoveryRequired' && 'reason' in failure && typeof failure.reason === 'string') recoveryReason = failure.reason;
        }
      } catch { /* Status still gates recovery when the error body is unavailable. */ }
      return { failure: Object.freeze({ revision: -1, accepted: false, applied: false, resyncRequired, ...(recoveryReason ? { recoveryReason } : {}) }) };
    }
    return { body: await response.json() };
  }

  /**
   * Open the ordered stream. Browsers cannot set WebSocket headers, so the
   * credential travels as query params (H01): desktop sends the device+bearer
   * pair; the browser sends the device + its signed proof (nonce/timestamp/
   * signature) over the canonical `GET path bodyDigest nonce timestamp` payload
   * — the server verifies the proof against the stored public key. The `since`
   * revision lets the server resume the suffix (AC 27.5-4). A drop closes; the
   * caller reconnects.
   */
  openStream(
    projectId: string,
    since: number,
    auth: AuthHeaders,
    onFrame: (frame: StreamFrame) => void,
    onClose: () => void,
    onResync?: (snapshot: unknown) => void,
    onRevoked?: () => void,
    onOpen?: () => void,
    streamEpoch: number | null = null,
    onReady?: (cut: Readonly<{ streamEpoch: number; serverRevision: number }>) => void,
    onUpdateRequired?: () => void,
    onRecoveryRequired?: (reason: string) => void,
  ): WebSocketLike {
    const query = new URLSearchParams({ since: String(since), device_id: auth.deviceId, protocol_version: PROTOCOL_VERSION, schema_version: String(PRODUCT_SCHEMA_VERSION), recovery_version: '1' });
    if (streamEpoch !== null) query.set('stream_epoch', String(streamEpoch));
    if (auth.bearer !== null) query.set('bearer', auth.bearer);
    if (auth.proof !== null) {
      query.set('nonce', auth.proof.nonce);
      query.set('timestamp', auth.proof.timestamp);
      query.set('signature', auth.proof.signature);
    }
    const url = `${this.origin.replace(/^http/, 'ws')}/projects/${projectId}/stream?${query.toString()}`;
    const socket = this.ports.openSocket(url);
    let messages: Promise<void> = Promise.resolve();
    socket.onmessage = (event) => {
      messages = messages.then(async () => {
        const frame = parseServerFrame(event.data);
        if (!frame) throw new Error('RECOVERY_FRAME_INVALID');
        if (frame.type === 'AccessRevoked') { onRevoked?.(); return; }
        if (frame.type === 'Snapshot') { onResync?.(frame.envelope); return; }
        if (frame.type === 'UpdateRequired') { onUpdateRequired?.(); return; }
        if (frame.type === 'ResyncRequired') {
          if (frame.reason === 'RECOVERY_PAYLOAD_TOO_LARGE') onRecoveryRequired?.(frame.reason);
          else onResync?.(null);
          return;
        }
        if (frame.type === 'CatchUpReady') {
          if (!Number.isSafeInteger(frame.streamEpoch) || Number(frame.streamEpoch) <= 0
            || !Number.isSafeInteger(frame.serverRevision) || Number(frame.serverRevision) < 0) throw new Error('RECOVERY_READY_INVALID');
          onReady?.(Object.freeze({ streamEpoch: Number(frame.streamEpoch), serverRevision: Number(frame.serverRevision) }));
          return;
        }
        if (frame.type !== 'Command') throw new Error('RECOVERY_FRAME_UNKNOWN');
        const command = validateProductCommand(frame.command);
        const historyEntry = await validateConfirmedHistoryEntry(frame.historyEntry, projectId);
        if (command.projectId !== projectId || historyEntry.serverRevision !== frame.serverRevision
          || historyEntry.command.commandId !== command.commandId
          || await recoveryPayloadDigest(historyEntry.command) !== await recoveryPayloadDigest(command)
          || !Number.isSafeInteger(frame.streamEpoch) || Number(frame.streamEpoch) <= 0
          || !Array.isArray(frame.appliedCommandIds) || frame.appliedCommandIds.length !== 1
          || frame.appliedCommandIds[0] !== command.commandId) throw new Error('RECOVERY_FRAME_BINDING_INVALID');
        onFrame(Object.freeze({
          streamEpoch: Number(frame.streamEpoch), serverRevision: Number(frame.serverRevision), command, historyEntry,
          appliedCommandIds: Object.freeze([command.commandId]),
        }));
      }).catch(() => { onResync?.(null); });
    };
    socket.onclose = () => onClose();
    socket.onopen = () => onOpen?.();
    return socket;
  }
}

function parseServerFrame(data: unknown): ServerFrame | null {
  if (typeof data !== 'string') return null;
  try {
    const parsed = JSON.parse(data) as ServerFrame;
    return typeof parsed === 'object' && parsed !== null && typeof parsed.type === 'string' ? parsed : null;
  } catch {
    return null;
  }
}
