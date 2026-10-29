/**
 * Sync-state label and precedence (Story 27.6/27.7, TC-UX1, R8).
 *
 * The title-bar indicator shows one label. R8 defines precedence and the
 * accompanying accessible notices; "Synced" must not hide unresolved work, and
 * "Offline" must not promise future sync after a known revocation. Local
 * projects show today's title bar unchanged (no collaboration indicator).
 *
 * Pure: state in, label out. The UI renders it and announces changes politely.
 */

export type SyncLabel =
  | 'saved-on-device'
  | 'synced'
  | 'n-changes-waiting'
  | 'offline'
  | 'update-to-keep-syncing';

export type SyncState =
  | Readonly<{ kind: 'local' }>
  | Readonly<{ kind: 'saved-on-device' }>
  | Readonly<{ kind: 'synced' }>
  | Readonly<{ kind: 'pending'; count: number }>
  | Readonly<{ kind: 'offline'; pendingCount: number; revoked: boolean }>
  | Readonly<{ kind: 'update-required' }>
  | Readonly<{ kind: 'rejected'; unresolvedCount: number; connected: boolean; pendingCount: number }>
  | Readonly<{ kind: 'revoked' }>;

export interface SyncIndicator {
  readonly label: SyncLabel;
  /** The label text (exact TC-UX1 strings), or null for a local project. */
  readonly text: string | null;
  /** An accompanying accessible notice, or null. */
  readonly notice: string | null;
}

export function pendingCountLabel(count: number): string {
  return count === 1 ? '1 change waiting' : `${count} changes waiting`;
}

/**
 * Resolve the indicator. Precedence (R8), highest first:
 * 1. revoked (access removed) — never promise sync;
 * 2. update-required;
 * 3. rejected (unresolved work) — Synced must not hide it;
 * 4. offline;
 * 5. pending;
 * 6. synced;
 * 7. saved-on-device.
 * A local project has no indicator.
 */
export function resolveSyncIndicator(state: SyncState): SyncIndicator {
  switch (state.kind) {
    case 'local':
      return Object.freeze({ label: 'saved-on-device', text: null, notice: null });
    case 'revoked':
      return Object.freeze({
        label: 'saved-on-device',
        text: 'Saved on this device',
        notice: 'Your access to this project was removed. This copy is read-only; your unsent changes will not sync, but you can copy or export them.',
      });
    case 'update-required':
      return Object.freeze({
        label: 'update-to-keep-syncing',
        text: 'Update to keep syncing',
        notice: 'Your version can no longer sync. Local changes are kept and will sync after you update.',
      });
    case 'rejected': {
      // R8: "Synced" requires no pending commands AND no unresolved rejection.
      // Unresolved rejections count as work needing attention, so the primary
      // label is a waiting/offline state, never "Synced".
      const waiting = state.pendingCount + state.unresolvedCount;
      const notice =
        state.unresolvedCount === 1
          ? '1 change could not be applied. Open “Changes that couldn’t be applied” to retry, copy or discard it.'
          : `${state.unresolvedCount} changes could not be applied. Open “Changes that couldn’t be applied” to retry, copy or discard them.`;
      if (!state.connected) {
        return Object.freeze({ label: 'offline', text: 'Offline — changes will sync', notice });
      }
      return Object.freeze({
        label: 'n-changes-waiting',
        text: pendingCountLabel(waiting),
        notice,
      });
    }
    case 'offline':
      return Object.freeze({
        label: 'offline',
        text: 'Offline — changes will sync',
        notice: state.revoked
          ? 'You are offline and your access was removed. Your unsent changes will not sync; you can copy or export them.'
          : state.pendingCount > 0
            ? `${pendingCountLabel(state.pendingCount)} will sync when you reconnect.`
            : 'You are offline. Changes will sync when you reconnect.',
      });
    case 'pending':
      return Object.freeze({
        label: 'n-changes-waiting',
        text: pendingCountLabel(state.count),
        notice: `${pendingCountLabel(state.count)} will sync shortly.`,
      });
    case 'synced':
      return Object.freeze({ label: 'synced', text: 'Synced', notice: null });
    case 'saved-on-device':
      return Object.freeze({ label: 'saved-on-device', text: 'Saved on this device', notice: null });
  }
}

/** Whether a label promises future sync (R8: Offline must not after revocation). */
export function promisesFutureSync(label: SyncLabel): boolean {
  return label === 'n-changes-waiting' || label === 'offline';
}
