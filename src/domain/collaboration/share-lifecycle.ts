/**
 * Share lifecycle (Story 27.6, R7, TC-FR2).
 *
 * Sharing spans a local project and the server and is not one transaction. It
 * uses an idempotent share-operation ID and a durable local intent; after a
 * failure it reconciles server status rather than falsely claiming local or
 * shared. This module is the pure decision layer; the adapter performs the I/O.
 */

export type ShareOperationStatus =
  | 'local'
  | 'provisioning'
  /** Server succeeded but the acknowledgement was lost; must reconcile. */
  | 'provisioning-unconfirmed'
  | 'shared'
  | 'stopping'
  | 'stop-unconfirmed';

export type ShareEvent =
  | Readonly<{ type: 'BEGIN_SHARE'; operationId: string }>
  | Readonly<{ type: 'SERVER_ACTIVATED'; projectRevision: number }>
  | Readonly<{ type: 'SERVER_CONFIRMED_SHARED' }>
  | Readonly<{ type: 'BEGIN_STOP' }>
  | Readonly<{ type: 'STOP_CONFIRMED_LOCAL' }>
  /** Reconciliation after a timeout/crash: the server says it never activated. */
  | Readonly<{ type: 'RECONCILE_NOT_ACTIVATED' }>
  /** Reconciliation: the server says it IS active. */
  | Readonly<{ type: 'RECONCILE_ACTIVATED' }>;

export type ShareState = Readonly<{
  status: ShareOperationStatus;
  /** The idempotent operation id; reused on retry, never a second project. */
  operationId: string | null;
  /** Whether a verified local backup exists before upload. */
  backupVerified: boolean;
}>;

export function initialShareState(): ShareState {
  return Object.freeze({ status: 'local', operationId: null, backupVerified: false });
}

/**
 * Advance the share lifecycle. A retry reuses the same operation id (R7): never
 * create a second project. An unconfirmed provisioning reconciles to either
 * `shared` (activated) or `local` (not activated), never a false claim.
 */
export function reduceShare(state: ShareState, event: ShareEvent): ShareState {
  switch (event.type) {
    case 'BEGIN_SHARE':
      // Idempotent: an existing in-flight operation keeps its id.
      if (state.status !== 'local') return state;
      return Object.freeze({ ...state, status: 'provisioning', operationId: event.operationId });
    case 'SERVER_ACTIVATED':
      if (state.status === 'provisioning' || state.status === 'provisioning-unconfirmed') {
        // Activation succeeded; awaiting the durable shared marker.
        return Object.freeze({ ...state, status: 'provisioning-unconfirmed' });
      }
      return state;
    case 'SERVER_CONFIRMED_SHARED':
      if (state.status === 'provisioning' || state.status === 'provisioning-unconfirmed') {
        return Object.freeze({ ...state, status: 'shared', backupVerified: true });
      }
      return state;
    case 'RECONCILE_NOT_ACTIVATED':
      // Safe: return to local, never a false "shared". Only valid while a share
      // is in flight — a stale reconcile must not unshare a live project.
      if (state.status !== 'provisioning' && state.status !== 'provisioning-unconfirmed') return state;
      return Object.freeze({ ...state, status: 'local', operationId: null });
    case 'RECONCILE_ACTIVATED':
      if (state.status !== 'provisioning' && state.status !== 'provisioning-unconfirmed') return state;
      return Object.freeze({ ...state, status: 'shared', backupVerified: true });
    case 'BEGIN_STOP':
      if (state.status === 'shared') return Object.freeze({ ...state, status: 'stopping' });
      return state;
    case 'STOP_CONFIRMED_LOCAL':
      if (state.status === 'stopping') return Object.freeze({ ...state, status: 'local', operationId: null });
      return state;
  }
}

/** A viewer sees only read-only controls (TC-FR8, AC 27.6-4). */
export type ProjectRole = 'owner' | 'editor' | 'viewer';

export interface RoleCapabilities {
  readonly canEdit: boolean;
  readonly canShare: boolean;
  readonly canStopSharing: boolean;
  readonly canManageMembers: boolean;
  readonly readOnlyExplanation: string | null;
}

export function capabilitiesFor(role: ProjectRole): RoleCapabilities {
  switch (role) {
    case 'owner':
      return Object.freeze({
        canEdit: true, canShare: true, canStopSharing: true, canManageMembers: true, readOnlyExplanation: null,
      });
    case 'editor':
      return Object.freeze({
        canEdit: true, canShare: false, canStopSharing: false, canManageMembers: false, readOnlyExplanation: null,
      });
    case 'viewer':
      return Object.freeze({
        canEdit: false, canShare: false, canStopSharing: false, canManageMembers: false,
        readOnlyExplanation: 'View only — ask an owner for edit access',
      });
  }
}

/** The explicit, durable cut an owner keeps when they stop sharing (R7). */
export function ownerLocalCopyRevision(lastConfirmedServerRevision: number): number {
  return lastConfirmedServerRevision;
}
