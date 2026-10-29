/**
 * Export eligibility decision policy (Story 8.1 Task 6, AC4, AD-5).
 *
 * Pure function deciding whether an export may proceed, mirroring
 * `decideProjectSwitch`'s `Blocked`/`Proceed` shape (no `NoOp` case — export
 * has no "already there" state). Queue predicates are caller-supplied so this
 * stays unit-testable without a fake dispatcher.
 */

export type ExportEligibilityDecision =
  | Readonly<{ kind: 'Blocked'; cause: string }>
  | Readonly<{ kind: 'Proceed' }>;

export function decideExportEligibility(params: {
  isQueueSettled: boolean;
  blockingCause: string | null;
}): ExportEligibilityDecision {
  if (!params.isQueueSettled) {
    return Object.freeze({
      kind: 'Blocked',
      cause: params.blockingCause ?? 'Command queue is not settled.',
    });
  }
  return Object.freeze({ kind: 'Proceed' });
}
