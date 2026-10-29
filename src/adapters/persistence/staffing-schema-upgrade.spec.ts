/**
 * Browser staffing schema upgrade qualification (Story 22.13, AC 22.13-1/-2/-3;
 * review R13).
 *
 * Drives the real browser startup sequence, `prepareProductDatabase` (the
 * exact function `openDatabase` runs), over POPULATED predecessor databases
 * whose DDL is extracted verbatim from the builds that created them
 * (`tests/fixtures/staffing-migration/legacy-schemas.json`): v13 (immediate
 * pre-staffing), v12 and v9. The v15 test this replaces initialized a fresh
 * database and read the current version back.
 *
 * The browser path has no version ladder: it adds missing columns with
 * guarded, auto-committed statements. So the meaningful interruption points
 * are the boundaries BETWEEN those statements. The interruption test records
 * every statement the real sequence executes, replays only the first k (a
 * crash after statement k), restarts, and requires the uninterrupted result —
 * for every k.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import legacy from '../../../tests/fixtures/staffing-migration/legacy-schemas.json';
import { prepareProductDatabase } from './repository.worker';
import { readForecastPlan } from './forecast-operations';
import { PRODUCT_SCHEMA_VERSION, readUserVersion } from './schema';

type Source = (typeof legacy.sources)[number];
type Row = Record<string, unknown>;

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;
beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

function openMemory(): Database {
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  db.exec('PRAGMA foreign_keys = ON; PRAGMA ignore_check_constraints = ON;');
  return db;
}

/** A database exactly as the predecessor build left it, with synthetic facts. */
function legacyDatabase(source: Source): Database {
  const db = openMemory();
  for (const ddl of source.browserDdl) db.exec(ddl);
  for (const statement of source.data) db.exec(statement);
  return db;
}

function select(db: Database, sql: string): Row[] {
  return db.exec({ sql, rowMode: 'object', returnValue: 'resultRows' }) as unknown as Row[];
}

function tables(db: Database): string[] {
  return select(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(
    (r) => String(r.name),
  );
}

/** Every row of every table, in storage order. */
function dump(db: Database): Record<string, Row[]> {
  return Object.fromEntries(tables(db).map((t) => [t, select(db, `SELECT * FROM "${t}" ORDER BY rowid`)]));
}

/** Column contract per table, keyed by name (ALTER appends, so order may differ). */
function columns(db: Database): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    tables(db).map((t) => [
      t,
      Object.fromEntries(
        select(db, `PRAGMA table_info("${t}")`).map((c) => [
          String(c.name),
          { type: c.type, notnull: c.notnull, dflt: c.dflt_value, pk: c.pk },
        ]),
      ),
    ]),
  );
}

function indexes(db: Database): string[] {
  return select(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(
    (r) => String(r.name),
  );
}

function integrity(db: Database): { integrity: unknown; foreignKeys: Row[] } {
  return {
    integrity: select(db, 'PRAGMA integrity_check')[0]?.integrity_check,
    foreignKeys: select(db, 'PRAGMA foreign_key_check'),
  };
}

/**
 * Model process death mid-transaction: a real crash leaves the journal to roll
 * back the open transaction on reopen, but a replay harness that keeps using
 * the same connection must roll back explicitly, or the next `BEGIN IMMEDIATE`
 * fails with "cannot start a transaction within a transaction".
 */
function rollbackIfTransactionOpen(db: Database, executed: readonly unknown[]): void {
  let openCount = 0;
  for (const statement of executed) {
    if (typeof statement !== 'string') continue;
    const trimmed = statement.trim();
    if (/^BEGIN\b/i.test(trimmed)) openCount += 1;
    else if (/^COMMIT\b/i.test(trimmed)) openCount = Math.max(0, openCount - 1);
  }
  if (openCount > 0) db.exec('ROLLBACK');
}

/**
 * The same startup sequence, recording every statement it executes. The
 * recording database is discarded afterwards: the patched `exec` must never
 * touch a database whose state is measured.
 */
function recordStartupStatements(source: Source): unknown[] {
  const db = legacyDatabase(source);
  const recorded: unknown[] = [];
  const exec = db.exec.bind(db);
  (db as unknown as { exec: (...args: unknown[]) => unknown }).exec = (...args: unknown[]) => {
    recorded.push(args[0]);
    return (exec as (...a: unknown[]) => unknown)(...args);
  };
  prepareProductDatabase(db);
  db.close();
  return recorded;
}

let freshBaseline: { columns: ReturnType<typeof columns>; indexes: string[] };
beforeAll(() => {
  const fresh = openMemory();
  prepareProductDatabase(fresh);
  freshBaseline = { columns: columns(fresh), indexes: indexes(fresh) };
});

describe.each(legacy.sources.map((s) => [`v${s.version} (${s.commit})`, s] as const))(
  'browser startup upgrade from populated %s',
  (_label, source) => {
    it('preserves every prior fact, adds staffing defaults, and passes integrity (AC 22.13-1)', () => {
      const db = legacyDatabase(source);
      const before = dump(db);

      prepareProductDatabase(db);
      const after = dump(db);

      // Every legacy row survives unchanged, column for column.
      for (const [table, rows] of Object.entries(before)) {
        const legacyColumns = rows.length > 0 ? Object.keys(rows[0]) : [];
        const projected = after[table].map((row) => Object.fromEntries(legacyColumns.map((c) => [c, row[c]])));
        expect(projected, `table ${table}`).toEqual(rows);
      }
      // Revision and command receipts are among those facts; assert them explicitly too.
      expect(after.projects.map((p) => p.revision)).toEqual([7]);
      expect(after.product_command_receipt.map((r) => r.command_id)).toEqual([legacy.ids.receipt1, legacy.ids.receipt2]);

      // A migrated schema is the fresh baseline: same columns, types, defaults, indexes, and user_version.
      expect(columns(db)).toEqual(freshBaseline.columns);
      expect(indexes(db)).toEqual(freshBaseline.indexes);
      expect(integrity(db)).toEqual({ integrity: 'ok', foreignKeys: [] });
      expect(readUserVersion(db)).toBe(PRODUCT_SCHEMA_VERSION);

      // A legacy plan reads as a shared plan with empty staffing (never fabricated).
      const plan = readForecastPlan(db, legacy.ids.project);
      if (source.version >= 12) {
        expect(after.forecast_plans[0]).toMatchObject({ roster: '[]', assignments: '{}', policy_version: 'shared-capacity-v1' });
        expect(plan?.policyVersion).toBe('shared-capacity-v1');
        expect(plan?.roster).toEqual([]);
        expect(plan?.assignments).toEqual({});
        expect(plan?.selectedFeatureIds).toEqual([legacy.ids.featureA, legacy.ids.featureB]);
        expect(plan?.blockedFeatureIds).toEqual([legacy.ids.featureB]);
        expect(plan?.planningLevel).toBe('Feature');
      } else {
        expect(plan).toBeNull();
      }
    });

    it('is idempotent: repeating startup on the migrated database changes nothing (AC 22.13-2)', () => {
      const db = legacyDatabase(source);
      prepareProductDatabase(db);
      const once = { rows: dump(db), columns: columns(db), indexes: indexes(db), userVersion: readUserVersion(db) };

      prepareProductDatabase(db);
      prepareProductDatabase(db);
      expect({ rows: dump(db), columns: columns(db), indexes: indexes(db), userVersion: readUserVersion(db) }).toEqual(once);
      expect(readUserVersion(db)).toBe(PRODUCT_SCHEMA_VERSION);
    });

    it('recovers to the completed state from a crash after ANY startup statement (AC 22.13-3)', () => {
      const statements = recordStartupStatements(source);
      const reference = legacyDatabase(source);
      prepareProductDatabase(reference);
      const expected = { rows: dump(reference), columns: columns(reference), indexes: indexes(reference) };
      const staffingSteps = statements.filter((s) => typeof s === 'string' && /ADD COLUMN (roster|assignments)/.test(s));
      // An existing plans table gains both staffing columns by ALTER; a v9
      // database has no plans table, so startup creates it whole (already
      // staffed) and needs no ALTER at all.
      expect(staffingSteps).toHaveLength(source.version >= 12 ? 2 : 0);
      for (let k = 0; k <= statements.length; k += 1) {
        const db = legacyDatabase(source);
        // The crashed run: statements 0..k-1 executed, nothing after. The
        // whole sequence runs in one transaction (22.15-1), so a crash inside
        // it leaves an uncommitted transaction that the journal rolls back on
        // reopen — model that with an explicit ROLLBACK, since a real process
        // death never runs one itself.
        for (const statement of statements.slice(0, k)) db.exec(statement as string);
        rollbackIfTransactionOpen(db, statements.slice(0, k));
        // Restart runs the whole sequence again.
        prepareProductDatabase(db);
        expect({ rows: dump(db), columns: columns(db), indexes: indexes(db) }, `crash after statement ${k}`).toEqual(expected);
        expect(integrity(db)).toEqual({ integrity: 'ok', foreignKeys: [] });
        expect(readUserVersion(db), `user_version after crash at statement ${k}`).toBe(PRODUCT_SCHEMA_VERSION);
      }
    });

    it('commits the schema marker atomically with the last migration step (AC 22.15-1)', () => {
      // Crash AFTER every migration statement AND the marker have executed but
      // BEFORE the transaction commits. The journal rolls the whole change
      // back, so the database must show BOTH the predecessor marker AND the
      // predecessor schema/data — never changed schema under an old marker.
      // This is the property the old auto-commit sequence could not provide,
      // and it cannot pass for it: the old sequence ran no `BEGIN` at all, so
      // `beginIndex` below would be -1.
      const statements = recordStartupStatements(source);
      const beginIndex = statements.findIndex(
        (s) => typeof s === 'string' && /^BEGIN\b/i.test(s.trim()),
      );
      expect(beginIndex, 'the startup sequence opens one transaction').toBeGreaterThanOrEqual(0);
      const markerIndex = statements.findIndex(
        (s) => typeof s === 'string' && /^PRAGMA\s+user_version\s*=/i.test(s.trim()),
      );
      expect(markerIndex, 'the startup sequence sets the marker inside the transaction').toBeGreaterThan(beginIndex);
      const commitIndex = statements.findIndex(
        (s) => typeof s === 'string' && /^COMMIT\b/i.test(s.trim()),
      );
      expect(commitIndex, 'the marker is set before the commit').toBeGreaterThan(markerIndex);

      const crashed = legacyDatabase(source);
      // Replay through the marker inclusive, but NOT the COMMIT.
      for (const statement of statements.slice(0, commitIndex)) crashed.exec(statement as string);
      // Prove the migration and marker really did run (else the assertion
      // below would pass vacuously): the marker was advanced inside the tx.
      expect(readUserVersion(crashed)).toBe(PRODUCT_SCHEMA_VERSION);
      rollbackIfTransactionOpen(crashed, statements.slice(0, commitIndex));

      const before = legacyDatabase(source);
      expect({ rows: dump(crashed), columns: columns(crashed), indexes: indexes(crashed) }).toEqual({
        rows: dump(before),
        columns: columns(before),
        indexes: indexes(before),
      });
      expect(readUserVersion(crashed), 'marker reverted with the uncommitted migration').toBe(readUserVersion(before));
      expect(readUserVersion(crashed)).not.toBe(PRODUCT_SCHEMA_VERSION);
    });
  },
);
