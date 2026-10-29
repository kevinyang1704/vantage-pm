import { validateDeletionBundle, type DeletionBundle } from '../../contracts/deletion-bundle';
/**
 * RestoreSubtree command (Story 2.6, AD-4).
 * Single typed command to atomically restore a deleted subtree (the exact inverse of DeleteSubtree).
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import type { NodeSnapshot } from '../../contracts/change-set';

export interface RestoreSubtreeCommand {
  readonly type: 'RestoreSubtree';
  readonly commandId: string;
  readonly projectId: string;
  readonly rootNodeId: string;
  readonly nodes: readonly NodeSnapshot[];
  readonly deletionBundle?: DeletionBundle;
}

export function createRestoreSubtreeCommand(input: {
  commandId: string;
  projectId: string;
  rootNodeId: string;
  nodes: readonly NodeSnapshot[];
  deletionBundle?: DeletionBundle;
}): RestoreSubtreeCommand {
  assertUuidV7(input.commandId, 'RestoreSubtreeCommand.commandId');
  assertUuidV7(input.projectId, 'RestoreSubtreeCommand.projectId');
  assertUuidV7(input.rootNodeId, 'RestoreSubtreeCommand.rootNodeId');

  for (const n of input.nodes) {
    assertUuidV7(n.nodeId, 'RestoreSubtreeCommand.nodeId');
  }

  return Object.freeze({
    type: 'RestoreSubtree',
    commandId: input.commandId,
    projectId: input.projectId,
    rootNodeId: input.rootNodeId,
    nodes: Object.freeze(input.nodes.map(node => Object.freeze({...node}))),
    ...(input.deletionBundle === undefined ? {} : { deletionBundle: validateDeletionBundle(input.deletionBundle, input.projectId, input.rootNodeId, input.nodes) }),
  });
}
