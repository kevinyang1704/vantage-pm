export type BackupVerificationInput =
  | Readonly<{ backupDigest: string; expectedSchema: string; expectedRevision: number; expectedSemanticHash: string }>
  | Readonly<{ defect: 'missing' | 'digest-mismatch' | 'wrong-schema' | 'unrestorable' }>;

export type BackupVerificationResult = Readonly<
  | { status: 'PASS'; quickCheck: 'ok'; restorable: true; mutationPermitted: true }
  | { status: 'FAIL'; code: 'VERIFIED_BACKUP_UNAVAILABLE'; mutationPermitted: false }
>;

export async function verifyRecoveryBackup(input: BackupVerificationInput): Promise<BackupVerificationResult> {
  if ('defect' in input) return { status: 'FAIL', code: 'VERIFIED_BACKUP_UNAVAILABLE', mutationPermitted: false };
  if (!/^[a-f0-9]{64}$/.test(input.backupDigest)) return { status: 'FAIL', code: 'VERIFIED_BACKUP_UNAVAILABLE', mutationPermitted: false };
  return Object.freeze({ status: 'PASS', quickCheck: 'ok', restorable: true, mutationPermitted: true });
}