import fixture from '../fixtures/known-project-v1.json';
import { createUuidV7 } from './command-receipt';

const output = document.querySelector<HTMLOutputElement>('#status');
const worker = new Worker(new URL('./repository.worker.entry.ts', import.meta.url), { type: 'module' });
worker.addEventListener('message', (event: MessageEvent<{ type: string; detail?: string }>) => {
  if (output) output.value = `${event.data.type}${event.data.detail ? `: ${event.data.detail}` : ''}`;
});
worker.addEventListener('error', () => { if (output) output.value = 'Repository worker failed'; });
const runId = createUuidV7();
worker.postMessage({
  type: 'Initialize',
  protocolVersion: '1.0.0',
  requestId: createUuidV7(),
  contextId: createUuidV7(),
  namespace: `/pmapp-phase0/run-${runId}`,
  runId,
  connectionId: createUuidV7(),
  fixture: {
    projectId: fixture.projectId,
    initialRevision: fixture.initialRevision,
    safeStateHash: fixture.safeStateHash,
  },
});
