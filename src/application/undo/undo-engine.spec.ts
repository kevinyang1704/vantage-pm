import { describe, expect, it, vi } from 'vitest';
import { UndoEngine } from './undo-engine';
import { CommandQueueOrchestrator } from '../command-queue/command-queue-orchestrator';
import { createUuidV7, PROTOCOL_VERSION } from '../../../spikes/phase-0-durability/src/command-receipt';
import type { ProductCommand, ProductCommandApplied } from '../../contracts/repository-commands';
import { createChangeSet, type ChangeSet, type NodeChange } from '../../contracts/change-set';

const PROJECT_A = '019ffe00-0000-7000-8000-000000000001';
const PROJECT_B = '019ffe00-0000-7000-8000-000000000002';
const NODE_A1 = '019ffe00-0000-7000-8000-000000000011';
const NODE_B1 = '019ffe00-0000-7000-8000-000000000021';

function createNodeCommand(projectId: string, nodeId: string): ProductCommand {
  return Object.freeze({
    type: 'CreateNode',
    protocolVersion: PROTOCOL_VERSION,
    commandId: createUuidV7(),
    projectId,
    baseRevision: 0,
    expectedRevision: 1,
    nodeId,
    parentId: null,
    position: '4294967296',
    title: 'Node',
  }) as ProductCommand;
}

function createNodeChangeSet(projectId: string, nodeId: string): ChangeSet {
  const change: NodeChange = Object.freeze({
    type: 'NodeCreated',
    nodeId,
    parentId: null,
    position: '4294967296',
    title: 'Node',
  });
  return createChangeSet({
    projectId,
    baseRevision: 0,
    targetRevision: 1,
    changes: [change],
  });
}

function applied(command: ProductCommand): ProductCommandApplied {
  return Object.freeze({
    type: 'ProductCommandApplied',
    protocolVersion: PROTOCOL_VERSION,
    commandId: command.commandId,
    projectId: command.projectId,
    baseRevision: command.baseRevision,
    targetRevision: command.expectedRevision,
    outcome: 'VfsCommitAccepted',
    disposition: 'NewCommit',
  });
}

function makeEngine(): { engine: UndoEngine; orchestrator: CommandQueueOrchestrator } {
  const orchestrator = new CommandQueueOrchestrator(async (cmd) => applied(cmd));
  return { engine: new UndoEngine(orchestrator), orchestrator };
}

describe('UndoEngine project scoping (Story 5.9)', () => {
  it('is null to undo in a project with no recorded commands', async () => {
    const { engine } = makeEngine();
    engine.recordAppliedCommand(createNodeCommand(PROJECT_A, NODE_A1), createNodeChangeSet(PROJECT_A, NODE_A1));

    expect(engine.canUndo(PROJECT_A)).toBe(true);
    expect(engine.canUndo(PROJECT_B)).toBe(false);

    const result = await engine.undo(PROJECT_B, 1);
    expect(result).toBeNull();
  });

  it('does not pop project A entries while project B is active', async () => {
    const { engine, orchestrator } = makeEngine();
    const aCommand = createNodeCommand(PROJECT_A, NODE_A1);
    engine.recordAppliedCommand(aCommand, createNodeChangeSet(PROJECT_A, NODE_A1));

    const aStateAfterRecord = engine.getState(PROJECT_A);
    expect(aStateAfterRecord.undoEntries).toHaveLength(1);

    const result = await engine.undo(PROJECT_B, 1);
    expect(result).toBeNull();

    // A's history is untouched by B's undo attempt
    expect(engine.getState(PROJECT_A).undoEntries).toHaveLength(1);
    expect(orchestrator.isQueueSettled(PROJECT_B)).toBe(true);
  });

  it('still undoes project A after an interleaved switch to B and back', async () => {
    const { engine, orchestrator } = makeEngine();
    const aCommand = createNodeCommand(PROJECT_A, NODE_A1);
    engine.recordAppliedCommand(aCommand, createNodeChangeSet(PROJECT_A, NODE_A1));

    // Simulate switching: record a B command, then switch back to A.
    const bCommand = createNodeCommand(PROJECT_B, NODE_B1);
    engine.recordAppliedCommand(bCommand, createNodeChangeSet(PROJECT_B, NODE_B1));

    expect(engine.canUndo(PROJECT_A)).toBe(true);
    expect(engine.canUndo(PROJECT_B)).toBe(true);

    const result = await engine.undo(PROJECT_A, 1);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('ProductCommandApplied');

    // A's entry is consumed; nothing happened to B's stack
    expect(engine.canUndo(PROJECT_A)).toBe(false);
    expect(engine.canUndo(PROJECT_B)).toBe(true);
    expect(engine.canRedo(PROJECT_A)).toBe(true);
  });

  it('keeps stacks independent across interleaved edits', async () => {
    const { engine } = makeEngine();

    engine.recordAppliedCommand(createNodeCommand(PROJECT_A, NODE_A1), createNodeChangeSet(PROJECT_A, NODE_A1));
    engine.recordAppliedCommand(createNodeCommand(PROJECT_B, NODE_B1), createNodeChangeSet(PROJECT_B, NODE_B1));
    engine.recordAppliedCommand(createNodeCommand(PROJECT_A, NODE_A1), createNodeChangeSet(PROJECT_A, NODE_A1));

    expect(engine.getState(PROJECT_A).undoEntries).toHaveLength(2);
    expect(engine.getState(PROJECT_B).undoEntries).toHaveLength(1);

    // Undo B: only B's single entry is consumed
    await engine.undo(PROJECT_B, 1);
    expect(engine.getState(PROJECT_B).undoEntries).toHaveLength(0);
    expect(engine.getState(PROJECT_A).undoEntries).toHaveLength(2);
  });

  it('redo operates on the per-project redo stack', async () => {
    const { engine } = makeEngine();
    engine.recordAppliedCommand(createNodeCommand(PROJECT_A, NODE_A1), createNodeChangeSet(PROJECT_A, NODE_A1));

    await engine.undo(PROJECT_A, 1);
    expect(engine.canRedo(PROJECT_A)).toBe(true);
    expect(engine.canRedo(PROJECT_B)).toBe(false);

    const redoResult = await engine.redo(PROJECT_A, 2);
    expect(redoResult).not.toBeNull();
    expect(engine.canRedo(PROJECT_A)).toBe(false);
    expect(engine.canUndo(PROJECT_A)).toBe(true);
  });
});

describe('UndoEngine composite grouping (Story 27.2, AC 27.2-3)', () => {
  const NODE_A2 = '019ffe00-0000-7000-8000-000000000012';

  it('records every command inside a group as one undoable entry', () => {
    const { engine } = makeEngine();
    engine.beginGroup(PROJECT_A);
    engine.recordAppliedCommand(createNodeCommand(PROJECT_A, NODE_A1), createNodeChangeSet(PROJECT_A, NODE_A1));
    engine.recordAppliedCommand(createNodeCommand(PROJECT_A, NODE_A2), createNodeChangeSet(PROJECT_A, NODE_A2));
    engine.endGroup();

    const state = engine.getState(PROJECT_A);
    expect(state.undoEntries).toHaveLength(1);
    expect(state.undoEntries[0].steps).toHaveLength(2);
    // Single-step compatibility fields mirror the LAST step.
    expect(state.undoEntries[0].forwardCommand.type).toBe('CreateNode');
  });

  it('undo reverses all steps of a group; redo re-applies all', async () => {
    const dispatched: string[] = [];
    let batchCount = 0;
    const orchestrator = new CommandQueueOrchestrator(async (cmd) => {
      dispatched.push(cmd.type);
      return applied(cmd);
    }, async (commands) => {
      batchCount += 1;
      dispatched.push(...commands.map(command => command.type));
      return commands.map(applied);
    });
    const engine = new UndoEngine(orchestrator);
    engine.beginGroup(PROJECT_A);
    engine.recordAppliedCommand(createNodeCommand(PROJECT_A, NODE_A1), createNodeChangeSet(PROJECT_A, NODE_A1));
    engine.recordAppliedCommand(createNodeCommand(PROJECT_A, NODE_A2), createNodeChangeSet(PROJECT_A, NODE_A2));
    engine.endGroup();

    await engine.undo(PROJECT_A, 2);
    // CreateNode's inverse is DeleteSubtree (see inverse-command.policy).
    expect(dispatched).toEqual(['DeleteSubtree', 'DeleteSubtree']);
    expect(batchCount).toBe(1);
    expect(engine.canUndo(PROJECT_A)).toBe(false);
    expect(engine.canRedo(PROJECT_A)).toBe(true);

    dispatched.length = 0;
    await engine.redo(PROJECT_A, 3);
    expect(dispatched).toEqual(['CreateNode', 'CreateNode']);
    expect(batchCount).toBe(2);
  });

  it('failed grouped undo keeps both stacks unchanged and sends no compensating commands', async () => {
    const single = vi.fn(async (cmd: ProductCommand) => applied(cmd));
    const batch = vi.fn(async (commands: readonly ProductCommand[]) => [{
      type: 'ProductCommandRejected' as const, protocolVersion: PROTOCOL_VERSION,
      commandId: commands[1].commandId, code: 'NODE_NOT_FOUND' as const,
    }]);
    const engine = new UndoEngine(new CommandQueueOrchestrator(single, batch));
    engine.beginGroup(PROJECT_A);
    engine.recordAppliedCommand(createNodeCommand(PROJECT_A, NODE_A1), createNodeChangeSet(PROJECT_A, NODE_A1));
    engine.recordAppliedCommand(createNodeCommand(PROJECT_A, NODE_A2), createNodeChangeSet(PROJECT_A, NODE_A2));
    engine.endGroup();
    const before = engine.getState(PROJECT_A);
    expect((await engine.undo(PROJECT_A, 2))?.type).toBe('ProductCommandRejected');
    expect(engine.getState(PROJECT_A)).toBe(before);
    expect(batch).toHaveBeenCalledOnce();
    expect(single).not.toHaveBeenCalled();
    expect(batch.mock.calls[0][0].map(command => command.type === 'DeleteSubtree' ? command.nodeId : null)).toEqual([NODE_A2, NODE_A1]);
  });

  it('a group with no steps is ignored; commands outside a group stay single', () => {
    const { engine } = makeEngine();
    engine.beginGroup(PROJECT_A);
    engine.endGroup();
    expect(engine.getState(PROJECT_A).undoEntries).toHaveLength(0);

    engine.recordAppliedCommand(createNodeCommand(PROJECT_A, NODE_A1), createNodeChangeSet(PROJECT_A, NODE_A1));
    expect(engine.getState(PROJECT_A).undoEntries).toHaveLength(1);
    expect(engine.getState(PROJECT_A).undoEntries[0].steps).toHaveLength(1);
  });
});

describe('UndoEngine per-user undo (Story 27.3, AC 27.3-6)', () => {
  function nodeCommand(projectId: string, nodeId: string, actorId: string): ProductCommand {
    return Object.freeze({ ...createNodeCommand(projectId, nodeId), actorId }) as ProductCommand;
  }

  it('refuses undo when another actor changed the same target (ChangedByOtherActor)', async () => {
    const { engine } = makeEngine();
    engine.recordAppliedCommand(nodeCommand(PROJECT_A, NODE_A1, 'actor-a'), createNodeChangeSet(PROJECT_A, NODE_A1));
    // A different actor touched NODE_A1 after this edit.
    engine.recordOtherActorChange(PROJECT_A, 'actor-b', [NODE_A1]);

    const result = await engine.undo(PROJECT_A, 1);
    expect(result).toMatchObject({ type: 'ProductCommandRejected', code: 'CHANGED_BY_OTHER_ACTOR' });
    // The stack is intact so the user can still see/retry.
    expect(engine.canUndo(PROJECT_A)).toBe(true);
  });

  it('a teammate change confirmed BEFORE the edit does not block undoing it (R9 "since")', async () => {
    const { engine } = makeEngine();
    engine.recordOtherActorChange(PROJECT_A, 'actor-b', [NODE_A1]);
    engine.recordAppliedCommand(nodeCommand(PROJECT_A, NODE_A1, 'actor-a'), createNodeChangeSet(PROJECT_A, NODE_A1));
    const result = await engine.undo(PROJECT_A, 1);
    expect(result).not.toMatchObject({ code: 'CHANGED_BY_OTHER_ACTOR' });
  });

  it('clearProject drops undo/redo history and recorded teammate changes after a replacement', () => {
    const { engine } = makeEngine();
    engine.recordAppliedCommand(nodeCommand(PROJECT_A, NODE_A1, 'actor-a'), createNodeChangeSet(PROJECT_A, NODE_A1));
    engine.recordAppliedCommand(nodeCommand(PROJECT_B, NODE_B1, 'actor-a'), createNodeChangeSet(PROJECT_B, NODE_B1));
    engine.clearProject(PROJECT_A);
    expect(engine.canUndo(PROJECT_A)).toBe(false);
    expect(engine.canUndo(PROJECT_B)).toBe(true);
  });

  it('allows undo when no other actor touched the target', async () => {
    const { engine } = makeEngine();
    engine.recordAppliedCommand(nodeCommand(PROJECT_A, NODE_A1, 'actor-a'), createNodeChangeSet(PROJECT_A, NODE_A1));
    engine.recordOtherActorChange(PROJECT_A, 'actor-b', [NODE_B1]); // unrelated target

    const result = await engine.undo(PROJECT_A, 1);
    expect(result).toMatchObject({ type: 'ProductCommandApplied' });
    expect(engine.canUndo(PROJECT_A)).toBe(false);
  });

  it('a local project with no other-actor changes undoes exactly as before', async () => {
    const { engine } = makeEngine();
    engine.recordAppliedCommand(createNodeCommand(PROJECT_A, NODE_A1), createNodeChangeSet(PROJECT_A, NODE_A1));
    const result = await engine.undo(PROJECT_A, 1);
    expect(result).toMatchObject({ type: 'ProductCommandApplied' });
  });
});
