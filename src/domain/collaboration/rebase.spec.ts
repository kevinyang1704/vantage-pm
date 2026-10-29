import { describe, expect, it } from 'vitest';
import { rebase, type MergeState } from './rebase';
import type { ProductCommand } from '../../contracts/repository-commands';
import { PROTOCOL_VERSION } from '../../../spikes/phase-0-durability/src/command-receipt';

const P = '019ff900-0000-7000-8000-000000000001';
const A = '019ff900-0000-7000-8000-0000000000a0';
const B = '019ff900-0000-7000-8000-0000000000b0';
const C = '019ff900-0000-7000-8000-0000000000c0';

function cmd<T extends ProductCommand['type']>(type: T, fields: Record<string, unknown>): ProductCommand {
  return { type, protocolVersion: PROTOCOL_VERSION, commandId: '019ff900-0000-7000-8000-0000000000ff', projectId: P, baseRevision: 0, expectedRevision: 1, ...fields } as ProductCommand;
}

function state(overrides: Partial<MergeState> = {}): MergeState {
  return {
    projectId: P,
    nodes: new Map([[A, { parentId: null }], [B, { parentId: null }], [C, { parentId: A }]]),
    order: new Map([['', [A, B]]]),
    forecastOrder: [A, B],
    forecastGroups: [],
    assignments: {},
    rosterIds: new Set<string>(),
    points: new Map([[A, 10]]),
    pointsDone: new Map([[A, 0]]),
    ...overrides,
  };
}

describe('rebase (Story 27.3, AC 27.3-4)', () => {
  it('re-applies a pending rename whose target survives', () => {
    const pending = [cmd('SetNodeTitle', { nodeId: A, title: 'X' })];
    const decision = rebase(pending, [], state());
    expect(decision.toReapply).toHaveLength(1);
    expect(decision.rejected).toHaveLength(0);
  });

  it('rejects a pending rename when a confirmed delete removed the target (rename racing delete)', () => {
    const pending = [cmd('SetNodeTitle', { nodeId: B, title: 'X' })];
    const confirmed = [cmd('DeleteSubtree', { nodeId: B })];
    const decision = rebase(pending, confirmed, state());
    expect(decision.toReapply).toHaveLength(0);
    expect(decision.rejected).toEqual([
      expect.objectContaining({ reason: 'TargetDeleted' }),
    ]);
    // The rejected command keeps its full content.
    expect(decision.rejected[0].command).toMatchObject({ type: 'SetNodeTitle', nodeId: B, title: 'X' });
  });

  it('rejects a pending move into a deleted destination', () => {
    const pending = [cmd('MoveNode', { nodeId: A, newParentId: B, newPosition: '1' })];
    const confirmed = [cmd('DeleteSubtree', { nodeId: B })];
    const decision = rebase(pending, confirmed, state());
    expect(decision.rejected[0].reason).toBe('DestinationMissing');
  });

  it('rejects a pending move that would create a cycle after a confirmed move', () => {
    // Confirmed moves A under C (which is under A) is already a cycle at source;
    // instead confirm C under B, then pending move C under its own descendant.
    const s = state({
      nodes: new Map([[A, { parentId: null }], [B, { parentId: null }], [C, { parentId: A }]]),
    });
    const pending = [cmd('MoveNode', { nodeId: A, newParentId: C, newPosition: '1' })];
    const decision = rebase(pending, [], s);
    // A is an ancestor of C, so moving A under C would create a cycle.
    expect(decision.rejected[0].reason).toBe('WouldCreateCycle');
  });

  it('rejects points done above the lowered estimate (points done racing a lowering)', () => {
    const pending = [cmd('SetNodePointsDone', { nodeId: A, effortPointsDone: 8 })];
    const confirmed = [cmd('SetNodeEffort', { nodeId: A, effortPoints: 5 })];
    const decision = rebase(pending, confirmed, state());
    expect(decision.rejected[0].reason).toBe('PointsDoneExceedsPoints');
  });

  it('accepts points done at or below the estimate', () => {
    const pending = [cmd('SetNodePointsDone', { nodeId: A, effortPointsDone: 3 })];
    const confirmed = [cmd('SetNodeEffort', { nodeId: A, effortPoints: 5 })];
    const decision = rebase(pending, confirmed, state());
    expect(decision.toReapply).toHaveLength(1);
  });

  it('rejects a group join whose partner is gone (concurrent group membership)', () => {
    const pending = [cmd('MoveForecastFeature', { featureId: A, afterId: null, beforeId: null, intendedIndex: 0, groupChange: { kind: 'join', partnerId: B } })];
    const s = state({ forecastOrder: [A] });
    const decision = rebase(pending, [], s);
    expect(decision.rejected[0].reason).toBe('GroupPartnerMissing');
  });

  it('rejects an assignment to a person not on the roster (concurrent assignments)', () => {
    const pending = [cmd('SetForecastAssignment', { featureId: A, personId: B, assigned: true })];
    const decision = rebase(pending, [], state());
    expect(decision.rejected[0].reason).toBe('PersonMissing');
  });

  it('accepts an assignment when the person is on the roster', () => {
    const pending = [cmd('SetForecastAssignment', { featureId: A, personId: B, assigned: true })];
    const decision = rebase(pending, [], state({ rosterIds: new Set([B]) }));
    expect(decision.toReapply).toHaveLength(1);
  });

  it('is deterministic and has no side effects', () => {
    const pending = [cmd('SetNodeTitle', { nodeId: A, title: 'X' })];
    const before = JSON.stringify(pending);
    const first = rebase(pending, [], state());
    const second = rebase(pending, [], state());
    expect(first).toEqual(second);
    expect(JSON.stringify(pending)).toBe(before);
  });

  it('a move racing a move both re-apply (order is decided by the apply step, not here)', () => {
    const pending = [cmd('MoveNode', { nodeId: A, newParentId: B, newPosition: '1' })];
    const confirmed = [cmd('MoveNode', { nodeId: B, newParentId: null, newPosition: '2' })];
    const decision = rebase(pending, confirmed, state());
    expect(decision.toReapply).toHaveLength(1);
  });

  it('rejects a pending assignment when a confirmed change removed the feature from the forecast (H-review)', () => {
    // The pending assignment targets a feature that a CONFIRMED
    // SetForecastMembership(included:false) removed from scope.
    const pending = [cmd('SetForecastAssignment', { featureId: A, personId: B, assigned: true })];
    const confirmed = [cmd('SetForecastMembership', { featureId: A, included: false })];
    const decision = rebase(pending, confirmed, state({ forecastOrder: [A, B], rosterIds: new Set([B]) }));
    expect(decision.toReapply).toHaveLength(0);
    expect(decision.rejected[0].reason).toBe('ForecastScopeInvalid');
  });

  it('rejects a pending group join when a confirmed membership removed the partner', () => {
    const pending = [cmd('MoveForecastFeature', { featureId: A, afterId: null, beforeId: null, intendedIndex: 0, groupChange: { kind: 'join', partnerId: B } })];
    const confirmed = [cmd('SetForecastMembership', { featureId: B, included: false })];
    const decision = rebase(pending, confirmed, state({ forecastOrder: [A, B] }));
    expect(decision.rejected[0].reason).toBe('GroupPartnerMissing');
  });
});
