import { describe, it, expect } from 'vitest';
import { createNode } from './node.entity';
import {
  validateNodeTitle,
  validateNodeBodyText,
  MAX_NODE_TITLE_LENGTH,
  MAX_NODE_BODY_LENGTH,
} from './node.policy';
import {
  positionForAppend,
  positionBetween,
  rebalanceSiblingPositions,
  parsePosition,
  formatPosition,
  SIBLING_POSITION_GAP,
} from './sibling-position.policy';
import { createCreateNodeCommand } from './create-node.command';
import { createSetNodeTitleCommand } from './set-node-title.command';
import { createSetNodeBodyTextCommand } from './set-node-body-text.command';

const VALID_UUID_1 = '019ffe00-0000-7000-8000-000000000001';
const VALID_UUID_2 = '019ffe00-0000-7000-8000-000000000002';
const VALID_UUID_3 = '019ffe00-0000-7000-8000-000000000003';

describe('Node domain entity', () => {
  it('creates a frozen node with valid UUIDv7 IDs', () => {
    const node = createNode({
      id: VALID_UUID_1,
      projectId: VALID_UUID_2,
      parentId: VALID_UUID_3,
      title: 'A node',
      bodyText: 'Some prose',
      position: 1000n,
    });

    expect(node.id).toBe(VALID_UUID_1);
    expect(node.projectId).toBe(VALID_UUID_2);
    expect(node.parentId).toBe(VALID_UUID_3);
    expect(node.title).toBe('A node');
    expect(node.bodyText).toBe('Some prose');
    expect(node.position).toBe(1000n);
    expect(Object.isFrozen(node)).toBe(true);
  });

  it('allows empty title and null parent', () => {
    const node = createNode({
      id: VALID_UUID_1,
      projectId: VALID_UUID_2,
      position: 100n,
    });

    expect(node.parentId).toBeNull();
    expect(node.title).toBe('');
    expect(node.bodyText).toBeNull();
  });
});

describe('Node policy', () => {
  it('allows empty title as valid', () => {
    const res = validateNodeTitle('');
    expect(res.valid).toBe(true);
    if (res.valid) expect(res.title).toBe('');
  });

  it('trims whitespace and validates within max length', () => {
    const res = validateNodeTitle('  Vision Node 🚀  ');
    expect(res.valid).toBe(true);
    if (res.valid) expect(res.title).toBe('Vision Node 🚀');
  });

  it('rejects title exceeding MAX_NODE_TITLE_LENGTH', () => {
    const longTitle = 'a'.repeat(MAX_NODE_TITLE_LENGTH + 1);
    const res = validateNodeTitle(longTitle);
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.cause).toBe('TITLE_TOO_LONG');
  });

  it('normalizes empty body text to null', () => {
    const res1 = validateNodeBodyText(null);
    expect(res1.valid).toBe(true);
    if (res1.valid) expect(res1.bodyText).toBeNull();

    const res2 = validateNodeBodyText('   ');
    expect(res2.valid).toBe(true);
    if (res2.valid) expect(res2.bodyText).toBeNull();
  });

  it('rejects body text exceeding MAX_NODE_BODY_LENGTH', () => {
    const longBody = 'x'.repeat(MAX_NODE_BODY_LENGTH + 1);
    const res = validateNodeBodyText(longBody);
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.cause).toBe('BODY_TOO_LONG');
  });
});

describe('Sibling position policy', () => {
  it('appends at SIBLING_POSITION_GAP when empty', () => {
    expect(positionForAppend(null)).toBe(SIBLING_POSITION_GAP);
  });

  it('appends after last sibling with SIBLING_POSITION_GAP step', () => {
    expect(positionForAppend(100n)).toBe(100n + SIBLING_POSITION_GAP);
  });

  it('inserts midpoint between siblings', () => {
    const res = positionBetween(0n, 100n);
    expect(res.kind).toBe('Position');
    if (res.kind === 'Position') {
      expect(res.position).toBe(50n);
    }
  });

  it('signals RebalanceRequired when gap is exhausted', () => {
    const res = positionBetween(10n, 11n);
    expect(res.kind).toBe('RebalanceRequired');
  });

  it('rebalances a single sibling set evenly', () => {
    const rebalanced = rebalanceSiblingPositions(['a', 'b', 'c']);
    expect(rebalanced).toEqual([
      { nodeId: 'a', position: SIBLING_POSITION_GAP },
      { nodeId: 'b', position: 2n * SIBLING_POSITION_GAP },
      { nodeId: 'c', position: 3n * SIBLING_POSITION_GAP },
    ]);
  });

  it('converts to/from decimal string losslessly', () => {
    const val = 9223372036854775807n;
    const str = formatPosition(val);
    expect(str).toBe('9223372036854775807');
    expect(parsePosition(str)).toBe(val);
  });
});

describe('Tree domain commands', () => {
  it('constructs CreateNodeCommand', () => {
    const cmd = createCreateNodeCommand({
      commandId: VALID_UUID_1,
      projectId: VALID_UUID_2,
      baseRevision: 3,
      nodeId: VALID_UUID_3,
      position: 100n,
      title: 'Title',
    });
    expect(cmd.type).toBe('CreateNode');
    expect(cmd.baseRevision).toBe(3);
    expect(cmd.title).toBe('Title');
    expect(Object.isFrozen(cmd)).toBe(true);
  });

  it('constructs SetNodeTitleCommand', () => {
    const cmd = createSetNodeTitleCommand({
      commandId: VALID_UUID_1,
      projectId: VALID_UUID_2,
      baseRevision: 4,
      nodeId: VALID_UUID_3,
      title: 'New Title',
    });
    expect(cmd.type).toBe('SetNodeTitle');
    expect(cmd.title).toBe('New Title');
  });

  it('constructs SetNodeBodyTextCommand', () => {
    const cmd = createSetNodeBodyTextCommand({
      commandId: VALID_UUID_1,
      projectId: VALID_UUID_2,
      baseRevision: 5,
      nodeId: VALID_UUID_3,
      bodyText: 'Prose',
    });
    expect(cmd.type).toBe('SetNodeBodyText');
    expect(cmd.bodyText).toBe('Prose');
  });
});
