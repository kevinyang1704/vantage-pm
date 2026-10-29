/**
 * Local actor identity (Story 27.3, AC 27.3-1).
 *
 * A fresh install gets one stable local actor ID (UUIDv7), stored in
 * `app_settings` so it is reused on every later run. For a LOCAL project it is
 * the actor on every command envelope and receipt and is never transmitted (it
 * becomes authored-fact metadata, not part of the portable export). For a
 * shared project the device's guest identity (D5) is the actor instead.
 *
 * Storage is the app-level `app_settings` key/value table, the same pattern the
 * active workspace pointer uses; it is not a ProductCommand and produces no
 * ChangeSet.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import { createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export const LOCAL_ACTOR_SETTING_KEY = 'local_actor_id';

function readSetting(db: Database, key: string): string | null {
  const rows = db.exec({
    sql: 'SELECT value FROM app_settings WHERE key = ?',
    bind: [key],
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as unknown as { value: unknown }[];
  return rows && rows.length > 0 ? String(rows[0].value) : null;
}

function writeSetting(db: Database, key: string, value: string): void {
  db.exec({
    sql: `INSERT INTO app_settings(key, value) VALUES(?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    bind: [key, value],
  });
}

/**
 * Return the local actor ID, creating and persisting one on first use. Also
 * backfills any receipts that predate the v17 migration so their `actor_id`
 * matches the local actor (AC 27.3-2).
 */
export function ensureLocalActor(db: Database): string {
  let actorId = readSetting(db, LOCAL_ACTOR_SETTING_KEY);
  if (!actorId) {
    actorId = createUuidV7();
    writeSetting(db, LOCAL_ACTOR_SETTING_KEY, actorId);
  }
  // Existing receipts (pre-v17) migrate to the local actor.
  db.exec({
    sql: 'UPDATE product_command_receipt SET actor_id = ? WHERE actor_id IS NULL',
    bind: [actorId],
  });
  return actorId;
}

/** Read the local actor without creating one (null before first use). */
export function readLocalActor(db: Database): string | null {
  return readSetting(db, LOCAL_ACTOR_SETTING_KEY);
}
