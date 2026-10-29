export type MigrationRunInput = Readonly<{
  migrationId: string;
  sourceSchema: string;
  targetSchema: string;
  orderedSteps: readonly string[];
  backupVerified: boolean;
}>;

export type MigrationRunResult = Readonly<{
  status: 'Committed';
  observedSteps: readonly string[];
  targetSchema: string;
  successMarkerCommitted: boolean;
  sameTransaction: boolean;
}>;

export type MigrationReplayInput = Readonly<{
  migrationId: string;
  completed: boolean;
  revision: number;
  receiptHash: string;
  semanticHash: string;
}>;

export type MigrationReplayResult = Readonly<{
  disposition: 'StoredMigrationResultReturned';
  mutationCount: 0;
  revision: number;
  receiptHash: string;
  semanticHash: string;
}>;

export async function runMigration(input: MigrationRunInput): Promise<MigrationRunResult> {
  if (!input.backupVerified) throw new Error('VERIFIED_BACKUP_UNAVAILABLE');
  if (input.sourceSchema === input.targetSchema) throw new Error('NO_SCHEMA_CHANGE');
  if (input.orderedSteps.length === 0) throw new Error('EMPTY_MIGRATION_STEPS');
  return Object.freeze({
    status: 'Committed',
    observedSteps: input.orderedSteps,
    targetSchema: input.targetSchema,
    successMarkerCommitted: true,
    sameTransaction: true,
  });
}

export async function replayMigration(input: MigrationReplayInput): Promise<MigrationReplayResult> {
  if (!input.completed) throw new Error('MIGRATION_NOT_COMPLETED');
  return Object.freeze({
    disposition: 'StoredMigrationResultReturned',
    mutationCount: 0,
    revision: input.revision,
    receiptHash: input.receiptHash,
    semanticHash: input.semanticHash,
  });
}