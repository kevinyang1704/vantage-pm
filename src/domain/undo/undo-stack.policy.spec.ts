import { describe, it, expect } from 'vitest';
import { computeInverseDescriptor } from './inverse-command.policy';
import {
  createInitialUndoStackState,
  pushAppliedCommand,
  popUndoEntry,
  popRedoEntry,
} from './undo-stack.policy';
import { createChangeSet } from '../../contracts/change-set';
import { PROTOCOL_VERSION } from '../../../spikes/phase-0-durability/src/command-receipt';
import type { ProductCommand } from '../../contracts/repository-commands';

const PROJ_ID = '019ffe00-0000-7000-8000-000000000001';
const NODE_1 = '019ffe00-0001-7000-8000-000000000001';

describe('Undo / Redo pure policies (Story 2.6)', () => {
  it('computes exact inverse descriptor for SetNodeTitle', () => {
    const cs = createChangeSet({
      projectId: PROJ_ID,
      baseRevision: 1,
      targetRevision: 2,
      changes: [
        {
          type: 'NodeTitleSet',
          nodeId: NODE_1,
          title: 'New Title',
          priorTitle: 'Old Title',
        },
      ],
    });

    const inv = computeInverseDescriptor(cs);
    expect(inv).toEqual({
      type: 'SetNodeTitle',
      nodeId: NODE_1,
      title: 'Old Title',
    });
  });

  it('computes exact inverse descriptor for SubtreeDeleted (RestoreSubtree)', () => {
    const snapshots = [
      {
        nodeId: NODE_1,
        parentId: null,
        title: 'Theme',
        bodyText: null,
        position: '1000',
        depth: 0,
      },
    ];

    const cs = createChangeSet({
      projectId: PROJ_ID,
      baseRevision: 2,
      targetRevision: 3,
      changes: [
        {
          type: 'SubtreeDeleted',
          rootNodeId: NODE_1,
          nodes: snapshots,
        },
      ],
    });

    const inv = computeInverseDescriptor(cs);
    expect(inv).toEqual({
      type: 'RestoreSubtree',
      rootNodeId: NODE_1,
      nodes: snapshots,
    });
  });

  it('manages stack transitions across push, undo, and redo', () => {
    let state = createInitialUndoStackState();
    expect(state.undoEntries.length).toBe(0);

    const cmd: ProductCommand = {
      type: 'SetNodeTitle',
      protocolVersion: PROTOCOL_VERSION,
      commandId: '019ffe00-0000-7000-8000-000000000010',
      projectId: PROJ_ID,
      baseRevision: 0,
      expectedRevision: 1,
      nodeId: NODE_1,
      title: 'Theme 1',
    };

    const cs = createChangeSet({
      projectId: PROJ_ID,
      baseRevision: 0,
      targetRevision: 1,
      changes: [{ type: 'NodeTitleSet', nodeId: NODE_1, title: 'Theme 1', priorTitle: '' }],
    });

    state = pushAppliedCommand(state, cmd, cs);
    expect(state.undoEntries.length).toBe(1);
    expect(state.redoEntries.length).toBe(0);

    // Pop undo
    const pop1 = popUndoEntry(state);
    state = pop1.nextState;
    expect(pop1.entry?.forwardCommand.type).toBe('SetNodeTitle');
    expect(state.undoEntries.length).toBe(0);
    expect(state.redoEntries.length).toBe(1);

    // Pop redo
    const pop2 = popRedoEntry(state);
    state = pop2.nextState;
    expect(pop2.entry?.forwardCommand.type).toBe('SetNodeTitle');
    expect(state.undoEntries.length).toBe(1);
    expect(state.redoEntries.length).toBe(0);
  });
});
