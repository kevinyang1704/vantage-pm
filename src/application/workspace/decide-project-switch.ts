/**
 * Project switch decision policy (Story 5.4 Task 1, AD-4/AD-5).
 *
 * Pure function deciding whether a project switch may proceed.
 * Queue predicates are caller-supplied so this stays unit-testable
 * without a fake dispatcher.
 */

export type ProjectSwitchDecision =
  | Readonly<{ kind: 'NoOp' }>
  | Readonly<{ kind: 'Blocked'; cause: string }>
  | Readonly<{ kind: 'Proceed' }>;

export function decideProjectSwitch(params: {
  targetProjectId: string;
  currentProjectId: string | null;
  isQueueSettled: boolean;
  blockingCause: string | null;
}): ProjectSwitchDecision {
  if (params.targetProjectId === params.currentProjectId) {
    return Object.freeze({ kind: 'NoOp' });
  }

  if (!params.isQueueSettled) {
    return Object.freeze({
      kind: 'Blocked',
      cause: params.blockingCause ?? 'Command queue is not settled.',
    });
  }

  return Object.freeze({ kind: 'Proceed' });
}
