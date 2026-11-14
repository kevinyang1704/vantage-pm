import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDemoProject } from '../../app/demo-project';
import {
  initWorkerDatabase,
  resetWorkerDatabase,
  getDatabase,
  ensureDemoProject,
  DEMO_INSTALLATION_KEY,
  queryProjects,
  queryPortableSnapshot,
  batchImportPortable,
} from './repository.worker';
import { PRODUCT_SCHEMA_VERSION } from './schema';

const raw = readFileSync('public/demos/lumen-trade.json', 'utf8');
const loadRaw = async () => raw;
const demo = () => createDemoProject('2027-01-04', loadRaw);

describe('atomic once-only Lumen demo installation', () => {
  beforeEach(async () => {
    await initWorkerDatabase();
    resetWorkerDatabase();
    getDatabase()!.exec({ sql: 'DELETE FROM app_settings WHERE key = ?', bind: [DEMO_INSTALLATION_KEY] });
  });

  it('adds once alongside existing projects and retains the edited or renamed copy', async () => {
    const existing = await demo();
    expect(batchImportPortable({ ...existing, projectName: 'Existing synthetic work' }).ok).toBe(true);
    const seed = await demo();
    expect(ensureDemoProject(seed)).toEqual({ kind: 'installed', projectId: seed.projectId });
    getDatabase()!.exec({ sql: 'UPDATE projects SET name = ? WHERE id = ?', bind: ['My edited demo', seed.projectId] });
    getDatabase()!.exec({ sql: 'UPDATE nodes SET title = ? WHERE id = ?', bind: ['Synthetic edited vision', seed.nodes[0].id] });
    expect(ensureDemoProject(seed)).toEqual({ kind: 'already-installed', projectId: seed.projectId });
    expect(ensureDemoProject(await demo())).toEqual({ kind: 'already-installed', projectId: seed.projectId });
    expect(queryProjects()).toHaveLength(2);
    expect(queryPortableSnapshot(seed.projectId).projectName).toBe('My edited demo');
    expect(queryPortableSnapshot(seed.projectId).nodes.find((n) => n.id === seed.nodes[0].id)?.title).toBe(
      'Synthetic edited vision',
    );
    expect(queryPortableSnapshot(existing.projectId).projectName).toBe('Existing synthetic work');
  });

  it('does not automatically recreate a deleted demo, but permits explicit fresh imports', async () => {
    const seed = await demo();
    expect(ensureDemoProject(seed).kind).toBe('installed');
    getDatabase()!.exec({ sql: 'DELETE FROM projects WHERE id = ?', bind: [seed.projectId] });
    expect(ensureDemoProject(await demo())).toEqual({ kind: 'already-installed', projectId: seed.projectId });
    expect(queryProjects()).toHaveLength(0);
    expect(batchImportPortable(await demo()).ok).toBe(true);
    expect(queryProjects()).toHaveLength(1);
  });

  it('rolls back the complete project when installation marker persistence fails and allows retry', async () => {
    const db = getDatabase()!;
    db.exec(
      `CREATE TEMP TRIGGER reject_demo_install BEFORE INSERT ON app_settings WHEN NEW.key = '${DEMO_INSTALLATION_KEY}' BEGIN SELECT RAISE(FAIL, 'synthetic marker failure'); END`,
    );
    const seed = await demo();
    try {
      expect(ensureDemoProject(seed)).toEqual({ kind: 'failed', code: 'IMPORT_FAILED' });
      expect(queryProjects()).toHaveLength(0);
      const rows = db.exec({
        sql: 'SELECT value FROM app_settings WHERE key = ?',
        bind: [DEMO_INSTALLATION_KEY],
        rowMode: 'object',
        returnValue: 'resultRows',
      }) as unknown[];
      expect(rows).toHaveLength(0);
    } finally {
      db.exec('DROP TRIGGER reject_demo_install');
    }
    expect(ensureDemoProject(seed)).toEqual({ kind: 'installed', projectId: seed.projectId });
    expect(queryPortableSnapshot(seed.projectId).nodes).toHaveLength(56);
  });

  it('refuses newer storage before writing any project or installation marker', async () => {
    const seed = await demo();
    const db = getDatabase()!;
    db.exec(`PRAGMA user_version = ${PRODUCT_SCHEMA_VERSION + 1}`);
    try {
      expect(ensureDemoProject(seed)).toEqual({ kind: 'failed', code: 'UNSUPPORTED_NEWER_SCHEMA' });
    } finally {
      db.exec(`PRAGMA user_version = ${PRODUCT_SCHEMA_VERSION}`);
    }
    expect(queryProjects()).toHaveLength(0);
    expect(ensureDemoProject(seed).kind).toBe('installed');
  });
});
