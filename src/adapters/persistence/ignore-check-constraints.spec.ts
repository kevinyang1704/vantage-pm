/**
 * The node_type vocabulary evolves (a new `Component` type was added between
 * Theme and Feature), but the CHECK constraint baked into a pre-existing
 * `nodes` table cannot be ALTERed. The browser + native compositions open
 * every connection with `PRAGMA ignore_check_constraints = ON` so a legacy
 * table's stale CHECK never rejects a value the domain layer accepts.
 *
 * This spec proves the pragma actually defeats a stale CHECK.
 */

import { describe, expect, it } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

const LEGACY_NODES_DDL = `CREATE TABLE nodes(
  id        TEXT NOT NULL PRIMARY KEY,
  node_type TEXT CHECK(node_type IN ('Vision', 'Theme', 'Feature', 'AcceptanceCriterion') OR node_type IS NULL)
)`;

describe('PRAGMA ignore_check_constraints (node_type vocabulary evolution)', () => {
  it('lets a value outside a legacy CHECK list be written when the pragma is on', async () => {
    const sqlite3 = await sqlite3InitModule();
    const db = new sqlite3.oo1.DB(':memory:', 'c');
    try {
      db.exec('PRAGMA foreign_keys = ON; PRAGMA ignore_check_constraints = ON;');
      db.exec(LEGACY_NODES_DDL);

      expect(() =>
        db.exec({ sql: 'INSERT INTO nodes(id, node_type) VALUES (?, ?)', bind: ['n1', 'Component'] }),
      ).not.toThrow();
      expect(() =>
        db.exec({ sql: 'UPDATE nodes SET node_type = ? WHERE id = ?', bind: ['Component', 'n1'] }),
      ).not.toThrow();

      const rows = db.exec({
        sql: 'SELECT node_type FROM nodes WHERE id = ?',
        bind: ['n1'],
        rowMode: 'object',
        returnValue: 'resultRows',
      }) as Record<string, unknown>[];
      expect(rows[0]?.node_type).toBe('Component');
    } finally {
      db.close();
    }
  });

  it('still rejects the same value when the pragma is off (guards against a silent default flip)', async () => {
    const sqlite3 = await sqlite3InitModule();
    const db = new sqlite3.oo1.DB(':memory:', 'c');
    try {
      db.exec('PRAGMA ignore_check_constraints = OFF;');
      db.exec(LEGACY_NODES_DDL);
      expect(() =>
        db.exec({ sql: 'INSERT INTO nodes(id, node_type) VALUES (?, ?)', bind: ['n1', 'Component'] }),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
