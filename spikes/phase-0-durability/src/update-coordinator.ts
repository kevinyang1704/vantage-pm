export type ActivationBlockedCode =
  | 'DIRTY_STATE'
  | 'UNRESOLVED_COMMANDS'
  | 'OWNERSHIP_UNRESOLVED'
  | 'VERIFIED_BACKUP_UNAVAILABLE'
  | 'INCOMPATIBLE_ASSET_SCHEMA'
  | 'APPROVAL_REQUIRED';

export type PrepareUpdateState = Readonly<{
  clean: boolean;
  unresolvedCommands: number;
  ownershipResolved?: boolean;
  backupVerified?: boolean;
  compatible?: boolean;
  approved?: boolean;
}>;

export type PrepareUpdateResult = Readonly<
  | { type: 'ActivationAllowed'; controllerChanged: false; databaseMutated: false; currentAssetsRemainActive: false }
  | { type: 'ActivationBlocked'; code: ActivationBlockedCode; controllerChanged: false; databaseMutated: false; currentAssetsRemainActive: true }
>;

export function prepareUpdate(state: PrepareUpdateState): PrepareUpdateResult {
  if (!state.clean) return { type: 'ActivationBlocked', code: 'DIRTY_STATE', controllerChanged: false, databaseMutated: false, currentAssetsRemainActive: true };
  if (state.unresolvedCommands) return { type: 'ActivationBlocked', code: 'UNRESOLVED_COMMANDS', controllerChanged: false, databaseMutated: false, currentAssetsRemainActive: true };
  if (!state.ownershipResolved) return { type: 'ActivationBlocked', code: 'OWNERSHIP_UNRESOLVED', controllerChanged: false, databaseMutated: false, currentAssetsRemainActive: true };
  if (!state.backupVerified) return { type: 'ActivationBlocked', code: 'VERIFIED_BACKUP_UNAVAILABLE', controllerChanged: false, databaseMutated: false, currentAssetsRemainActive: true };
  if (!state.compatible) return { type: 'ActivationBlocked', code: 'INCOMPATIBLE_ASSET_SCHEMA', controllerChanged: false, databaseMutated: false, currentAssetsRemainActive: true };
  if (!state.approved) return { type: 'ActivationBlocked', code: 'APPROVAL_REQUIRED', controllerChanged: false, databaseMutated: false, currentAssetsRemainActive: true };
  return { type: 'ActivationAllowed', controllerChanged: false, databaseMutated: false, currentAssetsRemainActive: false };
}

export type AssetSchemaRange = Readonly<{ readSchemas: readonly string[]; writeSchemas: readonly string[] }>;

export type CompatibilityInput = Readonly<{
  old: AssetSchemaRange;
  next: AssetSchemaRange;
  fromSchema: string;
  targetSchema: string;
}>;

export type CompatibilityResult = Readonly<
  | { status: 'PASS' }
  | { status: 'FAIL'; code: 'INCOMPATIBLE_ASSET_SCHEMA' }
>;

export function validateAssetSchemaCompatibility(input: CompatibilityInput): CompatibilityResult {
  const bothCanReadBoth = input.old.readSchemas.includes(input.fromSchema)
    && input.old.readSchemas.includes(input.targetSchema)
    && input.next.readSchemas.includes(input.fromSchema)
    && input.next.readSchemas.includes(input.targetSchema);
  const bothCanWriteBoth = input.old.writeSchemas.includes(input.fromSchema)
    && input.old.writeSchemas.includes(input.targetSchema)
    && input.next.writeSchemas.includes(input.fromSchema)
    && input.next.writeSchemas.includes(input.targetSchema);
  if (bothCanReadBoth && bothCanWriteBoth) return { status: 'PASS' };
  return { status: 'FAIL', code: 'INCOMPATIBLE_ASSET_SCHEMA' };
}

const LEGAL_UPDATE_SEQUENCE = [
  'Idle', 'Prepared', 'SQLiteClosed', 'VfsPaused', 'WebLockReleased',
  'ControllerChanged', 'Reloaded', 'WebLockAcquired', 'SAHAcquired',
  'ReceiptsReconciled', 'RevisionReconciled', 'Migrating',
  'MigrationSuccessCommitted', 'Active',
] as const;

export type UpdateTraceResult = Readonly<
  | { status: 'PASS'; terminalState: Readonly<{ type: 'Active'; root: string; targetSchema: string }> }
  | { status: 'FAIL'; code: 'ILLEGAL_UPDATE_TRANSITION' }
>;

export function adjudicateUpdateTrace(sequence: readonly string[]): UpdateTraceResult {
  if (sequence.length !== LEGAL_UPDATE_SEQUENCE.length) return { status: 'FAIL', code: 'ILLEGAL_UPDATE_TRANSITION' };
  for (let i = 0; i < sequence.length; i++) {
    if (sequence[i] !== LEGAL_UPDATE_SEQUENCE[i]) return { status: 'FAIL', code: 'ILLEGAL_UPDATE_TRANSITION' };
  }
  return Object.freeze({ status: 'PASS', terminalState: { type: 'Active' as const, root: 'phase0-v2-candidate', targetSchema: '2.0.0' } });
}

export type FailureModeInput = Readonly<{ controllerChanged: boolean }>;

export type FailureModeResult = Readonly<
  | { mode: 'old-assets-active'; writable: true }
  | { mode: 'Recovery'; writable: false; mixedAssetsAllowed: false }
>;

export function selectUpdateFailureMode(input: FailureModeInput): FailureModeResult {
  if (input.controllerChanged) return { mode: 'Recovery', writable: false, mixedAssetsAllowed: false };
  return { mode: 'old-assets-active', writable: true };
}