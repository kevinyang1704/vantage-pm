/**
 * Rejected work (Story 27.7, TC-UX3, R8; gate 5).
 *
 * A rejected shared edit is retained durably with its complete original
 * command. This pure module turns it into what the panel shows — which item,
 * what the user wrote, why it was not applied — plus the full content Copy
 * puts on the clipboard, and the Retry command: the same authored intent under
 * a NEW command id at the current revision (never a replay of the rejected id).
 */

import { validateProductCommand, type ProductCommand } from '../../contracts/repository-commands';

export interface RejectedWorkView {
  readonly commandId: string;
  readonly label: string;
  readonly yourValue: string;
  readonly reason: string;
  /** Complete authored content for Copy (no ids or revisions). */
  readonly copyText: string;
}

const ACTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  SetNodeTitle: 'Title',
  SetNodeBodyText: 'Brief',
  SetNodeEffort: 'Points',
  SetNodePointsDone: 'Points done',
  SetNodeStatus: 'Delivery status',
  SetNodeSchedule: 'Schedule',
  SetNodeType: 'Type',
  ToggleNodeCompleted: 'Done',
  CreateNode: 'New item',
  DeleteSubtree: 'Delete',
  MoveNode: 'Move',
  DuplicateSubtree: 'Duplicate',
  RenameProject: 'Project name',
});

/** Fields that never describe what the user authored. */
const MECHANICAL = new Set(['type', 'protocolVersion', 'commandId', 'projectId', 'baseRevision', 'expectedRevision', 'actorId', 'commandName']);
/** The authored value, in preference order, when a command has one. */
const VALUE_KEYS = ['title', 'bodyText', 'effortPoints', 'pointsDone', 'deliveryStatus', 'status', 'completed', 'nodeType', 'name', 'questionText', 'startDate', 'endDate'];

function humanize(type: string): string {
  return type.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(empty)';
  if (typeof value === 'boolean') return value ? 'Done' : 'Not done';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
}

/** Plain-language reason for a retained rejection code. */
export function rejectionReasonText(code: string): string {
  switch (code) {
    case 'REVISION_CONFLICT':
    case 'RebasePreconditionFailed':
      return 'A teammate changed this first.';
    case 'NODE_NOT_FOUND':
    case 'TargetDeleted':
      return 'The item was deleted by a teammate.';
    case 'PARENT_NOT_FOUND':
      return 'The place it belonged to no longer exists.';
    case 'VIEWER_CANNOT_WRITE':
    case 'ViewerCannotWrite':
      return 'You can view this project but not change it.';
    case 'FORECAST_ASSIGNMENT_CONFLICT':
      return 'A teammate changed the same assignment at the same time.';
    default:
      return 'The team service did not accept this change.';
  }
}

export function describeRejectedWork(
  entry: Readonly<{ commandId: string; command: ProductCommand; reason: string }>,
  titleOf: (nodeId: string) => string | null,
): RejectedWorkView {
  const fields = entry.command as unknown as Record<string, unknown>;
  const nodeId = typeof fields.nodeId === 'string' ? fields.nodeId : null;
  const title = nodeId ? titleOf(nodeId) : null;
  const action = ACTION_LABELS[entry.command.type] ?? humanize(entry.command.type);
  const label = title ? `${action} of “${title || 'Untitled'}”` : action;
  const valueKey = VALUE_KEYS.find((key) => Object.hasOwn(fields, key));
  const authored = Object.fromEntries(Object.entries(fields).filter(([key]) => !MECHANICAL.has(key)));
  const copyText = [
    `${label}: ${valueKey ? display(fields[valueKey]) : ''}`.trim(),
    JSON.stringify(authored, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value), 2),
  ].join('\n');
  return Object.freeze({
    commandId: entry.commandId,
    label,
    yourValue: valueKey ? display(fields[valueKey]) : '',
    reason: rejectionReasonText(entry.reason),
    copyText,
  });
}

/** Retry: the same authored intent under a new id at the current revision. */
export function retryCommand(command: ProductCommand, newCommandId: string, currentRevision: number): ProductCommand {
  if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) throw new Error('RETRY_REVISION_INVALID');
  if (newCommandId === command.commandId) throw new Error('RETRY_REQUIRES_NEW_ID');
  return validateProductCommand(Object.freeze({
    ...command,
    commandId: newCommandId,
    baseRevision: currentRevision,
    expectedRevision: currentRevision + 1,
  }));
}
