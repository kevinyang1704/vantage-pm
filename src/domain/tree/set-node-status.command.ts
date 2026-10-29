/**
 * SetNodeStatus domain command (outline status badging, AD-4).
 *
 * Sets a node's user-authored delivery status. Mirrors SetNodeEffort.
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import { DELIVERY_STATUSES, type DeliveryStatus } from './node.entity';

export type SetNodeStatusCommand = Readonly<{
  type: 'SetNodeStatus';
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  deliveryStatus: DeliveryStatus;
}>;

export function createSetNodeStatusCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  deliveryStatus: DeliveryStatus;
}): SetNodeStatusCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  assertUuidV7(params.nodeId, 'nodeId must be a valid UUIDv7');

  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('baseRevision must be a non-negative integer');
  }

  if (!DELIVERY_STATUSES.includes(params.deliveryStatus)) {
    throw new Error(
      `deliveryStatus must be one of ${DELIVERY_STATUSES.join(', ')}`,
    );
  }

  return Object.freeze({
    type: 'SetNodeStatus',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    nodeId: params.nodeId,
    deliveryStatus: params.deliveryStatus,
  });
}
