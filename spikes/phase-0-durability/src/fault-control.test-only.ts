import type { BoundaryCorrelation, BoundaryEvent, FaultBoundary } from './boundary-trace.test-only';

export const FAULT_CONTROL_WORDS = 4;

export type FaultControl = Readonly<{
  armedBoundary: FaultBoundary | null;
  sharedBuffer: SharedArrayBuffer;
  timeoutMs: number;
  publish: (event: BoundaryEvent) => never | void;
  stickyFailure: () => string | null;
}>;

export function createFaultControl(input: {
  armedBoundary: FaultBoundary | null;
  sharedBuffer: SharedArrayBuffer;
  timeoutMs?: number;
  postBoundary: (event: BoundaryEvent) => void;
}) : FaultControl {
  if (input.sharedBuffer.byteLength < Int32Array.BYTES_PER_ELEMENT * FAULT_CONTROL_WORDS) {
    throw new Error('FAULT_CONTROL_BUFFER_TOO_SMALL');
  }
  const words = new Int32Array(input.sharedBuffer);
  let failure: string | null = null;
  return {
    armedBoundary: input.armedBoundary,
    sharedBuffer: input.sharedBuffer,
    timeoutMs: input.timeoutMs ?? 30_000,
    publish(event) {
      if (input.armedBoundary !== event.boundaryId) return;
      if (Atomics.compareExchange(words, 0, 0, 1) !== 0) {
        failure = 'FAULT_BOUNDARY_REENTERED';
        throw new Error(failure);
      }
      Atomics.store(words, 1, event.sequence);
      input.postBoundary(event);
      Atomics.notify(words, 0);
      const outcome = Atomics.wait(words, 0, 1, input.timeoutMs ?? 30_000);
      failure = outcome === 'timed-out' ? 'EXTERNAL_TERMINATION_TIMEOUT' : 'WORKER_RESUMED_BEFORE_TERMINATION';
      Atomics.store(words, 2, 1);
      throw new Error(failure);
    },
    stickyFailure: () => failure,
  };
}

export function correlatedBoundary(
  boundaryId: FaultBoundary,
  sequence: number,
  correlation: BoundaryCorrelation,
  details: Partial<BoundaryEvent> = {},
): BoundaryEvent {
  return {
    type: 'BoundaryObserved',
    boundaryId,
    sequence,
    ...correlation,
    forwardedBeforeTermination: false,
    physicalDirectorySync: 'Unobservable',
    ...details,
  };
}
