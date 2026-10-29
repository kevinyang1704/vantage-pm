/**
 * A portable import lands in the active workspace (the browser worker path).
 *
 * The project shelf and workspace overview list only the active workspace's
 * projects, so an import that left workspace_id NULL succeeded but stayed
 * invisible. It must be stamped like CreateProject does.
 */

import { describe, expect, it } from 'vitest';
import {
  initWorkerDatabase,
  queryPortableSnapshot,
  queryProjects,
  getDatabase,
  batchImportPortable,
} from './repository.worker';
import { createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import { createCreateProjectCommand } from '../../contracts/repository-commands';
import { createCreateProjectCommand as createDomainCreateProject } from '../../domain/project/create-project.command';
import { remapPortableSnapshot } from '../../application/portable-file/import-project';
import { readActiveWorkspaceId } from './workspace-operations';

describe('batchImportPortable workspace placement', () => {
  it('stamps the active workspace so the imported project is listed', async () => {
    const handler = await initWorkerDatabase();
    const sourceId = createUuidV7();
    handler.apply(
      createCreateProjectCommand(
        createDomainCreateProject({ commandId: createUuidV7(), projectId: sourceId, name: 'Exported elsewhere' }),
      ),
    );
    const copy = remapPortableSnapshot({ ...(await queryPortableSnapshot(sourceId)), projectName: 'Imported here' });

    const result = batchImportPortable(copy);
    expect(result.ok).toBe(true);

    const db = getDatabase();
    if (!db) throw new Error('database not open');
    const row = db.exec({
      sql: 'SELECT workspace_id AS workspaceId FROM projects WHERE id = ?',
      bind: [copy.projectId],
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as { workspaceId: string | null }[];
    expect(row[0]?.workspaceId).toBe(readActiveWorkspaceId(db));
    expect(row[0]?.workspaceId).not.toBeNull();
    expect(queryProjects().map((p) => p.id)).toContain(copy.projectId);
  });
});
