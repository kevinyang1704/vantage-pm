import { selectMigrationRecovery as selectFromProtocol, type MigrationState } from './migration-protocol';

export type RecoverySelectorState = Readonly<{
  successMarker: boolean;
  targetSchema: boolean;
  compatibility: boolean;
  semanticHash: boolean;
  quickCheck: 'ok';
  backupVerified: boolean;
}>;

export type RecoverySelection =
  | Readonly<{ type: 'CandidateV2'; mode: 'read-write' }>
  | Readonly<{ type: 'VerifiedBackupV1'; mode: 'read-only' }>
  | Readonly<{ type: 'RecoveryBlocked'; code: string; mode: 'closed' }>;

export function selectMigrationRecovery(state: RecoverySelectorState): RecoverySelection {
  if (!state.backupVerified || state.quickCheck !== 'ok') {
    return { type: 'RecoveryBlocked', code: 'VERIFIED_BACKUP_UNAVAILABLE', mode: 'closed' };
  }
  if (state.successMarker && state.targetSchema && state.compatibility && state.semanticHash) {
    return { type: 'CandidateV2', mode: 'read-write' };
  }
  return { type: 'VerifiedBackupV1', mode: 'read-only' };
}

export { selectFromProtocol, type MigrationState };