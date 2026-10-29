import { describe, expect, it } from 'vitest';
import {
  activityFeed,
  commandTouches,
  describeChange,
  initialsFor,
  lastChangedBy,
  presentMembers,
  relativeTime,
  type ConfirmedChange,
} from './attribution';
import type { ProductCommand } from '../../contracts/repository-commands';
import { PROTOCOL_VERSION } from '../../../spikes/phase-0-durability/src/command-receipt';

const A = '019ff200-0000-7000-8000-0000000000a0';
const B = '019ff200-0000-7000-8000-0000000000b0';

function change(revision: number, actorId: string, actorName: string, command: ProductCommand, at = '2026-09-30T10:00:00Z'): ConfirmedChange {
  return { serverRevision: revision, confirmedAtISO: at, actorId, actorName, command };
}

function titleCmd(nodeId: string): ProductCommand {
  return { type: 'SetNodeTitle', protocolVersion: PROTOCOL_VERSION, commandId: 'c', projectId: 'p', baseRevision: 0, expectedRevision: 1, nodeId, title: 'X' } as ProductCommand;
}

describe('attribution (Story 27.8)', () => {
  it('resolves the last confirmed actor for a target', () => {
    const changes = [
      change(1, A, 'Hera', titleCmd(A)),
      change(2, B, 'Milo', titleCmd(A)),
    ];
    expect(lastChangedBy(changes, A)).toMatchObject({ actorName: 'Milo' });
    expect(lastChangedBy(changes, B)).toBeNull();
  });

  it('touches the right target ids', () => {
    expect(commandTouches(titleCmd(A), A)).toBe(true);
    expect(commandTouches(titleCmd(A), B)).toBe(false);
  });

  it('describes a change in plain language', () => {
    const c = change(1, A, 'Hera', { type: 'MoveNode', protocolVersion: PROTOCOL_VERSION, commandId: 'c', projectId: 'p', baseRevision: 0, expectedRevision: 1, nodeId: A, newParentId: null, newPosition: '1' } as ProductCommand);
    expect(describeChange(c, (id) => (id === A ? 'Report builder' : id))).toBe('Hera moved Report builder');
  });

  it('activity feed is newest-first and filterable/paged', () => {
    const changes = [
      change(1, A, 'Hera', titleCmd(A)),
      change(2, B, 'Milo', titleCmd(B)),
      change(3, A, 'Hera', titleCmd(A)),
    ];
    const feed = activityFeed(changes, (id) => id);
    expect(feed.map((f) => f.serverRevision)).toEqual([3, 2, 1]);
    const onlyHera = activityFeed(changes, (id) => id, { actorId: A });
    expect(onlyHera).toHaveLength(2);
    const page = activityFeed(changes, (id) => id, { limit: 1, offset: 1 });
    expect(page.map((p) => p.serverRevision)).toEqual([2]);
  });

  it('presence drops expired entries after the 30s timeout', () => {
    const entries = [
      { actorId: A, actorName: 'Hera', lastSeenISO: '2026-09-30T10:00:00Z' },
      { actorId: B, actorName: 'Milo', lastSeenISO: '2026-09-30T09:59:00Z' },
    ];
    // 20s after Hera, 80s after Milo.
    const present = presentMembers(entries, '2026-09-30T10:00:20Z');
    expect(present.map((p) => p.actorId)).toEqual([A]);
  });

  it('initials use first and last name, never color', () => {
    expect(initialsFor('Hera Lindqvist')).toBe('HL');
    expect(initialsFor('Milo')).toBe('MI');
    expect(initialsFor('   ')).toBe('?');
  });

  it('relative time reads naturally', () => {
    expect(relativeTime('2026-09-30T10:00:00Z', '2026-09-30T10:02:00Z')).toBe('2 min ago');
    expect(relativeTime('2026-09-30T10:00:00Z', '2026-09-30T10:00:30Z')).toBe('just now');
    expect(relativeTime('2026-09-30T09:00:00Z', '2026-09-30T10:00:00Z')).toBe('1 hour ago');
  });
});
