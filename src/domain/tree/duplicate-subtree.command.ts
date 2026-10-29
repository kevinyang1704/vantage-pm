/**
 * DuplicateSubtree command (Story 2.6, FR-13, AD-7).
 * Single typed command to atomically duplicate a subtree with client-minted stable IDs.
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export interface DuplicateSubtreeCommand {
  readonly type: 'DuplicateSubtree';
  readonly commandId: string;
  readonly projectId: string;
  readonly sourceNodeId: string;
  readonly newRootId: string;
  readonly idMap: Readonly<Record<string, string>>;
  readonly newPosition: bigint;
}

export function createDuplicateSubtreeCommand(input: {
  commandId: string;
  projectId: string;
  sourceNodeId: string;
  newRootId: string;
  idMap: Readonly<Record<string, string>>;
  newPosition: bigint;
}): DuplicateSubtreeCommand {
  assertUuidV7(input.commandId, 'DuplicateSubtreeCommand.commandId');
  assertUuidV7(input.projectId, 'DuplicateSubtreeCommand.projectId');
  assertUuidV7(input.sourceNodeId, 'DuplicateSubtreeCommand.sourceNodeId');
  assertUuidV7(input.newRootId, 'DuplicateSubtreeCommand.newRootId');

  for (const [src, dst] of Object.entries(input.idMap)) {
    assertUuidV7(src, 'DuplicateSubtreeCommand.idMap source');
    assertUuidV7(dst, 'DuplicateSubtreeCommand.idMap target');
  }

  return Object.freeze({
    type: 'DuplicateSubtree',
    commandId: input.commandId,
    projectId: input.projectId,
    sourceNodeId: input.sourceNodeId,
    newRootId: input.newRootId,
    idMap: Object.freeze({ ...input.idMap }),
    newPosition: input.newPosition,
  });
}
