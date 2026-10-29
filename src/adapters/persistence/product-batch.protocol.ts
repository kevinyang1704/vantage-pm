import { validateProductCommand, type ProductCommand, type ProductCommandResult } from '../../contracts/repository-commands';

/** An application composite is one local transaction, never an acknowledged prefix. */
export function validateProductCommandBatch(value: unknown): readonly ProductCommand[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('INVALID_PRODUCT_COMMAND_BATCH');
  const commands = value.map(validateProductCommand);
  const ids = new Set<string>();
  for (let index = 0; index < commands.length; index++) {
    const command = commands[index];
    if (command.projectId !== commands[0].projectId || ids.has(command.commandId) || !Number.isSafeInteger(command.baseRevision) || !Number.isSafeInteger(command.expectedRevision) || command.baseRevision < 0 || command.expectedRevision !== command.baseRevision + 1 || (index > 0 && command.baseRevision !== commands[index - 1].expectedRevision)) throw new Error('INVALID_PRODUCT_COMMAND_BATCH');
    ids.add(command.commandId);
  }
  return Object.freeze(commands);
}

export function validateProductCommandBatchResults(commands: readonly ProductCommand[], value: unknown): readonly ProductCommandResult[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('INVALID_PRODUCT_BATCH_RESULT');
  const results = value as ProductCommandResult[];
  if (results.length === 1 && results[0]?.type === 'ProductCommandRejected') {
    const result = results[0];
    if (!commands.some(command => command.commandId === result.commandId && command.protocolVersion === result.protocolVersion) || (result.projectId !== undefined && result.projectId !== commands[0].projectId) || typeof result.code !== 'string' || result.code.length === 0) throw new Error('INVALID_PRODUCT_BATCH_RESULT');
    return Object.freeze(results);
  }
  if (results.length !== commands.length) throw new Error('INVALID_PRODUCT_BATCH_RESULT');
  for (let index = 0; index < results.length; index++) {
    const result = results[index]; const command = commands[index];
    if (!result || result.type !== 'ProductCommandApplied' || result.commandId !== command.commandId || result.projectId !== command.projectId || result.protocolVersion !== command.protocolVersion || result.baseRevision !== command.baseRevision || result.targetRevision !== command.expectedRevision || result.outcome !== 'VfsCommitAccepted' || !['NewCommit', 'StoredResultReturned'].includes(result.disposition)) throw new Error('INVALID_PRODUCT_BATCH_RESULT');
    if (result.changeSet && (result.changeSet.projectId !== command.projectId || result.changeSet.protocolVersion !== command.protocolVersion || result.changeSet.baseRevision !== result.baseRevision || result.changeSet.targetRevision !== result.targetRevision || !Array.isArray(result.changeSet.changes))) throw new Error('INVALID_PRODUCT_BATCH_RESULT');
  }
  return Object.freeze(results);
}
