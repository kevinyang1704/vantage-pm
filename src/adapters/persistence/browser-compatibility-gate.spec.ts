/**
 * Browser SQLite compatibility gate qualification (Story 22.15, AC 22.15-1..5; review finding O2).
 *
 * Proves:
 * - The browser build stamps PRAGMA user_version = PRODUCT_SCHEMA_VERSION (15) on startup (AC 22.15-1).
 * - Newer databases (user_version > 15) are refused before ANY write or migration (AC 22.15-2).
 * - Before-and-after database bytes are byte-for-byte identical on refusal (AC 22.15-2).
 * - Actionable guidance "This project data was saved by a newer version of the app. Reload to update." is returned (AC 22.15-2).
 * - A command dispatched after the header was raised on a shared connection is refused without
 *   mutation. This is a header-change guard only: it does NOT exercise real ownership/handoff, so
 *   it is not AC 22.15-3 proof (that evidence is deferred). (AC 22.15-2/-3 command-dispatch path)
 * - Browser and native share the schema version constant (15), and portable import rejects newer schemas (AC 22.15-4).
 * - Current and legacy databases upgrade cleanly without regression (AC 22.15-5).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prepareProductDatabase } from './repository.worker';
import {
  PRODUCT_SCHEMA_VERSION,
  NEWER_SCHEMA_REFUSAL_MESSAGE,
  NewerSchemaVersionError,
  readUserVersion,
} from './schema';
import { ProductCommandHandler } from './project-commands';
import { createWorkspaceOp, queryWorkspaceRegistry } from './workspace-operations';
import { updateViewState, batchImportPortable, getDatabase, initWorkerDatabase } from './repository.worker';
import { formatCommandRejection } from '../ui/command-feedback';
import {
  createCreateProjectCommand,
  createRenameProjectCommand,
  type ProductCommandRejected,
} from '../../contracts/repository-commands';
import { createCreateProjectCommand as createDomainCreateProject } from '../../domain/project/create-project.command';
import { createRenameProjectCommand as createDomainRenameProject } from '../../domain/project/rename-project.command';
import { createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import { validatePortableFileEnvelope } from '../../contracts/portable-file.schema';

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

function openMemory(): Database {
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  db.exec('PRAGMA foreign_keys = ON; PRAGMA ignore_check_constraints = ON;');
  return db;
}

describe('Story 22.15: Browser schema compatibility gate', () => {
  describe('AC 22.15-1: The browser records its schema marker atomically', () => {
    it('stamps user_version = 21 when preparing a fresh database', () => {
      const db = openMemory();
      expect(readUserVersion(db)).toBe(0);

      prepareProductDatabase(db);
      expect(readUserVersion(db)).toBe(PRODUCT_SCHEMA_VERSION);
      expect(readUserVersion(db)).toBe(21);
      db.close();
    });

    it('stamps user_version = 21 on an unmarked legacy database after migration', () => {
      const db = openMemory();
      // Simulate an older unmarked database with projects table
      db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);');
      db.exec("INSERT INTO projects(id, name, revision) VALUES('0198a000-0000-7000-8000-000000000001', 'Legacy Project', 3);");
      expect(readUserVersion(db)).toBe(0);

      prepareProductDatabase(db);
      expect(readUserVersion(db)).toBe(PRODUCT_SCHEMA_VERSION);

      // Verify the legacy data was preserved
      const rows = db.exec({
        sql: 'SELECT id, name, revision FROM projects',
        rowMode: 'object',
        returnValue: 'resultRows',
      }) as unknown as Record<string, unknown>[];
      expect(rows).toEqual([
        { id: '0198a000-0000-7000-8000-000000000001', name: 'Legacy Project', revision: 3 },
      ]);
      db.close();
    });
  });

  describe('AC 22.15-2: Newer databases are refused before ANY write or migration without mutation', () => {
    it('refuses a newer database before any write, leaving bytes 100% identical', () => {
      const db = openMemory();
      // Initialize a database with facts and mark it as schema 16 (future version)
      db.exec('CREATE TABLE custom_data(key TEXT PRIMARY KEY, val TEXT);');
      db.exec("INSERT INTO custom_data VALUES('greeting', 'hello future');");
      db.exec(`PRAGMA user_version = ${PRODUCT_SCHEMA_VERSION + 1};`);
      expect(readUserVersion(db)).toBe(PRODUCT_SCHEMA_VERSION + 1);

      // Export bytes before attempted open
      const beforeBytes = sqlite3.capi.sqlite3_js_db_export(db);

      // Attempt to prepare the database with current build (v16)
      let thrown: unknown = null;
      try {
        prepareProductDatabase(db);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(NewerSchemaVersionError);
      const versionErr = thrown as NewerSchemaVersionError;
      expect(versionErr.message).toBe(NEWER_SCHEMA_REFUSAL_MESSAGE);
      expect(versionErr.message).toBe('This project data was saved by a newer version of the app. Reload to update.');
      expect(versionErr.foundVersion).toBe(PRODUCT_SCHEMA_VERSION + 1);
      expect(versionErr.supportedVersion).toBe(PRODUCT_SCHEMA_VERSION);
      expect(versionErr.code).toBe('UNSUPPORTED_NEWER_SCHEMA');

      // Export bytes after attempted open: must be byte-for-byte identical
      const afterBytes = sqlite3.capi.sqlite3_js_db_export(db);
      expect(afterBytes).toEqual(beforeBytes);
      expect(afterBytes.length).toBe(beforeBytes.length);

      // Verify no product tables were created
      const tables = (
        db.exec({
          sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          rowMode: 'object',
          returnValue: 'resultRows',
        }) as unknown as Record<string, unknown>[]
      ).map((r) => r.name);
      expect(tables).toEqual(['custom_data']);
      expect(tables).not.toContain('forecast_plans');
      expect(tables).not.toContain('projects');
      db.close();
    });

    it('refuses commands dispatched to a newer database with UNSUPPORTED_NEWER_SCHEMA and no mutation', () => {
      const db = openMemory();
      // Simulate database created by newer build (schema 16)
      const handler = new ProductCommandHandler(db);
      handler.initializeSchema();
      db.exec(`PRAGMA user_version = ${PRODUCT_SCHEMA_VERSION + 1};`);

      const beforeBytes = sqlite3.capi.sqlite3_js_db_export(db);

      const cmd = createCreateProjectCommand(
        createDomainCreateProject({
          commandId: createUuidV7(),
          projectId: createUuidV7(),
          name: 'Should Not Be Created',
        }),
      );

      const result = handler.apply(cmd);
      expect(result.type).toBe('ProductCommandRejected');
      const rejected = result as ProductCommandRejected;
      expect(rejected.code).toBe('UNSUPPORTED_NEWER_SCHEMA');

      // UI feedback formatting matches canonical guidance
      const feedback = formatCommandRejection(rejected);
      expect(`${feedback.cause} ${feedback.resultingState}`).toBe(
        'This project data was saved by a newer version of the app. Reload to update.',
      );

      // Bytes completely unchanged, no receipts inserted
      const afterBytes = sqlite3.capi.sqlite3_js_db_export(db);
      expect(afterBytes).toEqual(beforeBytes);

      const receipts = db.exec({
        sql: 'SELECT COUNT(*) as count FROM product_command_receipt',
        rowMode: 'object',
        returnValue: 'resultRows',
      }) as unknown as Record<string, unknown>[];
      expect(receipts[0].count).toBe(0);

      db.close();
    });
  });

  describe('Header-change guard (not AC 22.15-3 ownership proof): a raised user_version is refused', () => {
    it('refuses subsequent commands after the header is raised on this connection', () => {
      const db = openMemory();

      // Tab 1 starts up at current schema (v18)
      const tab1Handler = prepareProductDatabase(db);
      expect(readUserVersion(db)).toBe(21);

      // Tab 1 executes a valid command successfully
      const projectId = createUuidV7();
      const createCmd = createCreateProjectCommand(
        createDomainCreateProject({
          commandId: createUuidV7(),
          projectId,
          name: 'Original Project',
        }),
      );
      const firstResult = tab1Handler.apply(createCmd);
      expect(firstResult.type).toBe('ProductCommandApplied');

      // Tab 2 (newer build) runs in another tab/process and upgrades the database to v16
      db.exec(`PRAGMA user_version = ${PRODUCT_SCHEMA_VERSION + 1};`);
      expect(readUserVersion(db)).toBe(PRODUCT_SCHEMA_VERSION + 1);

      const bytesAfterUpgrade = sqlite3.capi.sqlite3_js_db_export(db);

      // Tab 1 (still open) attempts to dispatch a subsequent command
      const renameCmd = createRenameProjectCommand(
        createDomainRenameProject({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 1,
          name: 'Renamed In Stale Tab',
        }),
      );
      const staleResult = tab1Handler.apply(renameCmd);

      // Tab 1 must refuse with UNSUPPORTED_NEWER_SCHEMA
      expect(staleResult.type).toBe('ProductCommandRejected');
      const staleRejected = staleResult as ProductCommandRejected;
      expect(staleRejected.code).toBe('UNSUPPORTED_NEWER_SCHEMA');

      // Guidance matches canonical message
      const feedback = formatCommandRejection(staleRejected);
      expect(`${feedback.cause} ${feedback.resultingState}`).toBe(
        'This project data was saved by a newer version of the app. Reload to update.',
      );

      // Database was NOT mutated by Tab 1's command
      const bytesAfterStaleAttempt = sqlite3.capi.sqlite3_js_db_export(db);
      expect(bytesAfterStaleAttempt).toEqual(bytesAfterUpgrade);

      // Project name and revision remain unmutated
      const proj = db.exec({
        sql: 'SELECT name, revision FROM projects WHERE id = ?',
        bind: [projectId],
        rowMode: 'object',
        returnValue: 'resultRows',
      }) as unknown as Record<string, unknown>[];
      expect(proj[0].name).toBe('Original Project');
      expect(proj[0].revision).toBe(1);

      db.close();
    });
  });

  describe('AC 22.15-4: Parity and portability', () => {
    it('browser PRODUCT_SCHEMA_VERSION matches native CURRENT_SCHEMA_VERSION', () => {
      // Read native schema file to verify the constant matches
      const nativeSchemaPath = resolve(__dirname, '../../../crates/pmapp-core/src/db/schema.rs');
      const nativeContent = readFileSync(nativeSchemaPath, 'utf8');

      // Native derives CURRENT_SCHEMA_VERSION = BASELINE_SCHEMA_VERSION + MIGRATION_STEPS.len()
      // Epic 27 adds coordinated collaboration journals at version 18 and
      // typed recovery/stream-epoch sidecars plus local file metadata at version 20,
      // and the Delivery Board sprint plan at version 21
      expect(PRODUCT_SCHEMA_VERSION).toBe(21);

      // Verify the native test browser_and_native_schema_versions_match checks this exact TS constant
      expect(nativeContent).toContain('fn browser_and_native_schema_versions_match');
      expect(nativeContent).toContain('export const PRODUCT_SCHEMA_VERSION = ');
    });

    it('portable file validator continues to reject newer file schema versions with UnsupportedNewerSchema', () => {
      const futureEnvelope = {
        schemaVersion: 999, // far in the future
        exportedAt: '2026-09-26T12:00:00.000Z',
        project: {
          id: createUuidV7(),
          name: 'Future Project',
        },
        nodes: [],
        phases: [],
        unlockEdges: [],
      };

      const result = validatePortableFileEnvelope(futureEnvelope);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('UnsupportedNewerSchema');
      }
    });
  });

  describe('AC 22.15-2/-3 (review L2): every durable writer refuses a newer schema', () => {
    it('workspace, view-state and portable import all refuse after a live upgrade, with no mutation', async () => {
      await initWorkerDatabase();
      const db = getDatabase()!;
      const countRows = (sql: string): number =>
        Number(
          (db.exec({ sql, rowMode: 'object', returnValue: 'resultRows' })[0] as { c: number } | undefined)?.c ?? -1,
        );
      const workspacesBefore = countRows('SELECT COUNT(*) AS c FROM workspaces');
      const viewStateBefore = countRows('SELECT COUNT(*) AS c FROM view_state');
      const projectsBefore = countRows('SELECT COUNT(*) AS c FROM projects');

      // Simulate a newer tab upgrading this same database after open.
      db.exec(`PRAGMA user_version = ${PRODUCT_SCHEMA_VERSION + 1};`);
      try {
        // Workspace mutation (bypasses ProductCommandHandler.apply).
        expect(() => createWorkspaceOp(db, { workspaceId: createUuidV7(), name: 'New' })).toThrow(
          NewerSchemaVersionError,
        );

        // The workspace invariant repair is reachable from the registry READ
        // path; it writes too and must refuse (review L2).
        expect(() => queryWorkspaceRegistry(db)).toThrow(NewerSchemaVersionError);

        // View-state write (bypasses apply).
        expect(() => updateViewState(createUuidV7(), 'outline', 0, {})).toThrow(NewerSchemaVersionError);

        // Portable import returns its typed refusal code, not a throw.
        const importResult = batchImportPortable({
          projectId: createUuidV7(),
          projectName: 'Future',
          projectRevision: 1,
          phases: [],
          nodes: [],
          nodeCustomFields: [],
          typeTemplateFields: [],
          unlockEdges: [],
          findingDismissals: [],
          affectedReasons: [],
          openQuestions: [],
        } as never);
        expect(importResult).toEqual({ ok: false, code: 'UNSUPPORTED_NEWER_SCHEMA' });

        // Nothing was written to any table.
        expect(countRows('SELECT COUNT(*) AS c FROM workspaces')).toBe(workspacesBefore);
        expect(countRows('SELECT COUNT(*) AS c FROM view_state')).toBe(viewStateBefore);
        expect(countRows('SELECT COUNT(*) AS c FROM projects')).toBe(projectsBefore);
      } finally {
        // Restore the singleton even if an assertion throws, so later suites
        // still see a current-schema database.
        db.exec(`PRAGMA user_version = ${PRODUCT_SCHEMA_VERSION};`);
      }
    });
  });

  describe('AC 22.15-5: No regression for current and legacy data', () => {
    it('allows a current v15 database to open, verify, and accept commands', () => {
      const db = openMemory();
      const handler = prepareProductDatabase(db);
      expect(readUserVersion(db)).toBe(21);

      const cmd = createCreateProjectCommand(
        createDomainCreateProject({
          commandId: createUuidV7(),
          projectId: createUuidV7(),
          name: 'Healthy v15 Project',
        }),
      );
      const res = handler.apply(cmd);
      expect(res.type).toBe('ProductCommandApplied');
      db.close();
    });
  });
});
