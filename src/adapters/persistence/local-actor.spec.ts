/**
 * Story 27.3 — actor identity on receipts (AC 27.3-1/-2).
 *
 * A local actor is created once, persisted, and stamped on every applied
 * command's receipt. A supplied actorId (a shared project's guest device) is
 * preserved instead of the local actor.
 */

import { describe, expect, it } from 'vitest';
import { initWorkerDatabase, getDatabase } from './repository.worker';
import { ensureLocalActor, readLocalActor, LOCAL_ACTOR_SETTING_KEY } from './local-actor';
import { createUuidV7, PROTOCOL_VERSION } from '../../../spikes/phase-0-durability/src/command-receipt';

const P = '019ff800-0000-7000-8000-000000000001';

function rows(sql: string, bind?: readonly unknown[]): Record<string, unknown>[] {
  return getDatabase()!.exec({
    sql,
    ...(bind ? { bind: bind as never } : {}),
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as unknown as Record<string, unknown>[];
}

describe('Story 27.3 local actor and receipts', () => {
  it('creates one stable local actor and stamps applied receipts (AC 27.3-1/-2)', async () => {
    const handler = await initWorkerDatabase();
    const db = getDatabase()!;

    const actorA = ensureLocalActor(db);
    const actorB = ensureLocalActor(db);
    expect(actorB).toBe(actorA);
    expect(readLocalActor(db)).toBe(actorA);

    handler.apply({
      type: 'CreateProject', protocolVersion: PROTOCOL_VERSION, commandId: createUuidV7(),
      projectId: P, baseRevision: 0, expectedRevision: 1, name: 'Actor',
    });
    const receipt = rows('SELECT actor_id FROM product_command_receipt WHERE project_id = ?', [P]);
    expect(receipt).toHaveLength(1);
    expect(receipt[0].actor_id).toBe(actorA);

    // The setting is persisted in app_settings.
    expect(rows('SELECT value FROM app_settings WHERE key = ?', [LOCAL_ACTOR_SETTING_KEY])[0].value).toBe(actorA);
  });

  it('preserves a supplied actorId (shared-project guest device)', async () => {
    const handler = await initWorkerDatabase();
    const db = getDatabase()!;
    const localActor = ensureLocalActor(db);
    const guestActor = createUuidV7();
    const projectId = '019ff800-0000-7000-8000-0000000000aa';

    handler.apply({
      type: 'CreateProject', protocolVersion: PROTOCOL_VERSION, commandId: createUuidV7(),
      projectId, baseRevision: 0, expectedRevision: 1, name: 'Shared', actorId: guestActor,
    });
    const receipt = rows('SELECT actor_id FROM product_command_receipt WHERE project_id = ?', [projectId]);
    expect(receipt[0].actor_id).toBe(guestActor);
    expect(receipt[0].actor_id).not.toBe(localActor);
  });
});
