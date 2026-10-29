import path from 'node:path';
import { createUuidV7 } from '../src/command-receipt';

export type IsolatedRun = Readonly<{
  runId: string;
  profilePath: string;
  origin: string;
  opfsNamespace: string;
  seed: string;
}>;

const allocated = new Map<string, IsolatedRun>();

export function allocateRun(seed: string): IsolatedRun {
  const runId = createUuidV7();
  const run = Object.freeze({
    runId,
    profilePath: path.resolve('test-results', 'phase-0-profiles', runId),
    origin: `http://127.0.0.1:4173/run/${runId}`,
    opfsNamespace: `/pmapp-phase0/run-${runId}`,
    seed,
  });
  allocated.set(runId, run);
  return run;
}

export function writeRunSentinel(run: IsolatedRun): void {
  if (allocated.get(run.runId)?.opfsNamespace !== run.opfsNamespace) throw new Error('RUN_SENTINEL_IDENTITY_MISMATCH');
}

export function verifyResetTarget(input: { runId: string; expectedNamespace: string }) {
  const run = allocated.get(input.runId);
  if (!run || run.opfsNamespace !== input.expectedNamespace) {
    throw new Error('SAFE_RESET_TARGET_MISMATCH');
  }
  allocated.delete(input.runId);
  return run;
}
