import { describe, expect, it } from 'vitest';
import { decideExportEligibility } from './decide-export-eligibility';

describe('decideExportEligibility (Story 8.1 Task 6)', () => {
  it('returns Proceed when the queue is settled', () => {
    expect(decideExportEligibility({ isQueueSettled: true, blockingCause: null })).toEqual({
      kind: 'Proceed',
    });
  });

  it('returns Blocked with the exact blocking cause when the queue is unsettled', () => {
    expect(
      decideExportEligibility({ isQueueSettled: false, blockingCause: '2 commands in flight' }),
    ).toEqual({ kind: 'Blocked', cause: '2 commands in flight' });
  });

  it('falls back to a default cause when unsettled with no cause provided', () => {
    expect(decideExportEligibility({ isQueueSettled: false, blockingCause: null })).toEqual({
      kind: 'Blocked',
      cause: 'Command queue is not settled.',
    });
  });
});
