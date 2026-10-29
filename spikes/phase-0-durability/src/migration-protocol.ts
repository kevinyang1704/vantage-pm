export type MigrationState = Readonly<{ backupVerified: boolean; candidateTransactionCommitted: boolean; successMarkerCommitted: boolean; candidateQuickCheck: 'ok' | 'failed'; backupQuickCheck: 'ok' | 'failed' }>;
export type RecoverySelection = { type: 'CandidateV2'; mode: 'read-write' } | { type: 'VerifiedBackupV1'; mode: 'read-only' } | { type: 'RecoveryBlocked'; code: string; mode: 'closed' };

export function selectMigrationRecovery(state: MigrationState): RecoverySelection {
  if (!state.backupVerified || state.backupQuickCheck !== 'ok') return { type: 'RecoveryBlocked', code: 'VERIFIED_BACKUP_UNAVAILABLE', mode: 'closed' };
  if (state.candidateTransactionCommitted && state.successMarkerCommitted && state.candidateQuickCheck === 'ok') return { type: 'CandidateV2', mode: 'read-write' };
  return { type: 'VerifiedBackupV1', mode: 'read-only' };
}
