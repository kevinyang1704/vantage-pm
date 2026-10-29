/**
 * Collaboration composition root (H08). Loaded ONLY through a dynamic import
 * guarded by the literal `__PMAPP_COLLABORATION__` build constant, so a
 * flag-off production build contains none of this code (AD-20, 27.10-3).
 *
 * Builds the runtime ports the session layer needs: the configured service
 * origin, fetch and WebSocket, the desktop keychain or browser non-exportable
 * key credential, the nonportable shared-project registry, and the
 * runtime-neutral sync repository (browser worker or native actor).
 */

import { CollaborationTransport, type WebSocketLike } from '../adapters/platform/collaboration-transport';
import { createBrowserCredentialPort, generateBrowserCredential } from '../adapters/platform/browser-credential.adapter';
import { createBrowserSharedProjectRegistry } from '../adapters/platform/browser-shared-project-registry';
import { createBrowserSyncRepository } from '../adapters/persistence/browser-sync-repository';
import { forgetCollaborationState, isNativeBridge, queryPortableSnapshot, readCollaborationHistory } from '../adapters/persistence/repository-worker.client';
import { createUuidV7 } from '../../spikes/phase-0-durability/src/command-receipt';
import type { MergeState } from '../domain/collaboration/rebase';
import type { CollaborationSessionPorts } from '../application/collaboration/collaboration-session';

export {
  shareProject, openSharedSession, stopSharing, CollaborationError, type SharedSession,
  createInvite, listMembership, decideJoin, removeMember, joinWithInvite, refreshJoinStatus, parseInviteLink,
  recoverOwner, parseRecoveryLink, setApprovalRequired, changeRole, leaveProject,
} from '../application/collaboration/collaboration-session';
export { JoinDialog, type JoinStatus } from '../adapters/ui/collaboration/join-dialog';
export { MemberDialog } from '../adapters/ui/collaboration/member-dialog';
export { mergeStateFromSnapshot } from '../application/collaboration/merge-state';
export { describeRejectedWork } from '../application/collaboration/rejected-work';
export { activityFeed, lastChangedBy, relativeTime } from '../domain/collaboration/attribution';
export { FirstShareDialog, type FirstShareStatus } from '../adapters/ui/collaboration/first-share-dialog';

/** Adapt a DOM WebSocket to the transport's minimal interface. */
export function domSocket(url: string): WebSocketLike {
  const socket = new WebSocket(url);
  const like: WebSocketLike = {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  socket.onopen = () => like.onopen?.();
  socket.onmessage = (event) => like.onmessage?.({ data: event.data });
  socket.onclose = () => like.onclose?.();
  socket.onerror = (event) => like.onerror?.(event);
  return like;
}

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A 100-bit owner recovery code in five groups of four (no ambiguous glyphs). */
export function newRecoveryCode(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]);
  return [0, 4, 8, 12, 16].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

export async function createCollaborationPorts(
  origin: string,
  mergeStateFor: (projectId: string) => MergeState,
): Promise<CollaborationSessionPorts> {
  const fetchPort: typeof fetch = (input, init) => globalThis.fetch(input, init);
  const native = isNativeBridge();
  const desktop = native ? await import('../adapters/persistence/tauri-credential.adapter') : null;
  return {
    origin,
    fetch: fetchPort,
    transport: new CollaborationTransport(origin, { fetch: fetchPort, openSocket: domSocket }),
    credentials: desktop ? desktop.createDesktopCredentialPort() : createBrowserCredentialPort(),
    createCredential: desktop
      ? async () => Object.freeze({ kind: 'bearer-hash' as const, bearer: desktop.generateBearerCredential() })
      : generateBrowserCredential,
    registry: createBrowserSharedProjectRegistry(),
    readPortableSnapshot: queryPortableSnapshot,
    readHistory: readCollaborationHistory,
    forgetCollaboration: forgetCollaborationState,
    syncRepository: createBrowserSyncRepository({ mergeState: mergeStateFor }),
    newId: createUuidV7,
    nowISO: () => new Date().toISOString(),
    newRecoveryCode,
  };
}
