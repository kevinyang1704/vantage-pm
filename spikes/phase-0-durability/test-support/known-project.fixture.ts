import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createKnownFixtureCommand } from '../src/command-receipt';

export async function loadKnownProjectFixture() {
  const raw = await readFile(new URL('../fixtures/known-project-v1.json', import.meta.url));
  const fixture = JSON.parse(raw.toString('utf8')) as {
    schemaVersion: string; name: string; projectId: string; initialRevision: number; safeStateHash: string;
  };
  const manifest = JSON.parse(await readFile(
    new URL('../fixtures/compatibility-manifest.json', import.meta.url), 'utf8',
  )) as { fixture: { actualFileSha256: string; semanticStateSha256: string } };
  const actualFileSha256 = createHash('sha256').update(raw).digest('hex');
  if (actualFileSha256 !== manifest.fixture.actualFileSha256) throw new Error('FIXTURE_FILE_HASH_MISMATCH');
  if (fixture.safeStateHash !== manifest.fixture.semanticStateSha256) throw new Error('FIXTURE_SEMANTIC_HASH_MISMATCH');
  const base = {
    ...fixture,
    actualFileSha256,
    semanticStateSha256: fixture.safeStateHash,
    authoredFactCount: 0,
    workflowFactCount: 0,
    command: createKnownFixtureCommand({ baseRevision: fixture.initialRevision, safeValueHash: fixture.safeStateHash }),
  };
  return Object.assign(base, {
    withAuthoredBody(authoredBody: string) { return { ...base, authoredBody }; },
  });
}
