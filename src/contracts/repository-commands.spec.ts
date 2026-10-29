import { describe, expect, it } from 'vitest';
import {
  createDeleteProjectWireCommand,
  createSetNodeStatusWireCommand,
  validateDeleteProjectWireCommand,
  validateProductCommand,
} from './repository-commands';
import { createDeleteProjectCommand } from '../domain/project/delete-project.command';
import { createSetNodeStatusCommand } from '../domain/tree/set-node-status.command';
import { PROTOCOL_VERSION } from '../../spikes/phase-0-durability/src/command-receipt';

const UUID1 = '019ffe00-0000-7000-8000-000000000001';
const UUID2 = '019ffe00-0000-7000-8000-000000000002';

describe('DeleteProject wire command (Story 1.10 wiring)', () => {
  it('wraps the domain command with the protocol envelope', () => {
    const domain = createDeleteProjectCommand({
      commandId: UUID1,
      projectId: UUID2,
      baseRevision: 3,
    });

    const wire = createDeleteProjectWireCommand(domain);

    expect(wire.type).toBe('DeleteProject');
    expect(wire.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(wire.commandId).toBe(UUID1);
    expect(wire.projectId).toBe(UUID2);
    expect(wire.baseRevision).toBe(3);
    expect(wire.expectedRevision).toBe(4);
    expect(Object.isFrozen(wire)).toBe(true);
  });

  it('rejects a negative base revision', () => {
    expect(() =>
      createDeleteProjectWireCommand(
        createDeleteProjectCommand({
          commandId: UUID1,
          projectId: UUID2,
          baseRevision: -1,
        }),
      ),
    ).toThrow('INVALID_BASE_REVISION');
  });

  it('validates a well-formed wire command', () => {
    const wire = createDeleteProjectWireCommand(
      createDeleteProjectCommand({
        commandId: UUID1,
        projectId: UUID2,
        baseRevision: 5,
      }),
    );

    expect(validateDeleteProjectWireCommand(wire)).toEqual(wire);
  });

  it('rejects a protocol version mismatch', () => {
    const wire = {
      ...createDeleteProjectWireCommand(
        createDeleteProjectCommand({
          commandId: UUID1,
          projectId: UUID2,
          baseRevision: 0,
        }),
      ),
      protocolVersion: '9.9.9',
    };

    expect(() => validateDeleteProjectWireCommand(wire)).toThrow('PROTOCOL_VERSION_MISMATCH');
  });

  it('rejects an expectedRevision that is not baseRevision + 1', () => {
    const wire = {
      ...createDeleteProjectWireCommand(
        createDeleteProjectCommand({
          commandId: UUID1,
          projectId: UUID2,
          baseRevision: 0,
        }),
      ),
      expectedRevision: 99,
    };

    expect(() => validateDeleteProjectWireCommand(wire)).toThrow('INVALID_COMMAND');
  });
});

describe('SetNodeStatus wire command (outline status badging)', () => {
  const NODE = '019ffe00-0000-7000-8000-000000000003';

  it('wraps the domain command with the protocol envelope', () => {
    const wire = createSetNodeStatusWireCommand(
      createSetNodeStatusCommand({
        commandId: UUID1,
        projectId: UUID2,
        baseRevision: 4,
        nodeId: NODE,
        deliveryStatus: 'in_progress',
      }),
    );

    expect(wire.type).toBe('SetNodeStatus');
    expect(wire.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(wire.baseRevision).toBe(4);
    expect(wire.expectedRevision).toBe(5);
    expect(wire.deliveryStatus).toBe('in_progress');
    expect(Object.isFrozen(wire)).toBe(true);
    expect(validateProductCommand(wire)).toEqual(wire);
  });

  it('rejects an unrecognised delivery status at the domain boundary', () => {
    expect(() =>
      createSetNodeStatusCommand({
        commandId: UUID1,
        projectId: UUID2,
        baseRevision: 0,
        nodeId: NODE,
        // @ts-expect-error — exercising the runtime guard with an invalid value
        deliveryStatus: 'shipped',
      }),
    ).toThrow('deliveryStatus');
  });
});
