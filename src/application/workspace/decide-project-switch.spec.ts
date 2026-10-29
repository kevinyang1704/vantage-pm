import { describe, expect, it } from 'vitest';
import { decideProjectSwitch } from './decide-project-switch';
import {
  createDefaultSessionViewContext,
  sessionViewContextKey,
} from './session-view-context';

const P1 = '019ffe00-0000-7000-8000-000000000001';
const P2 = '019ffe00-0000-7000-8000-000000000002';

describe('decide-project-switch', () => {
  it('returns NoOp for the same project', () => {
    expect(
      decideProjectSwitch({
        targetProjectId: P1,
        currentProjectId: P1,
        isQueueSettled: true,
        blockingCause: null,
      }),
    ).toEqual({ kind: 'NoOp' });
  });

  it('returns Proceed for a settled queue and different project', () => {
    expect(
      decideProjectSwitch({
        targetProjectId: P2,
        currentProjectId: P1,
        isQueueSettled: true,
        blockingCause: null,
      }),
    ).toEqual({ kind: 'Proceed' });
  });

  it('returns Blocked with the cause passed through verbatim when queue unsettled', () => {
    for (const cause of [
      'A command is still in flight.',
      '2 commands are pending.',
      'A command failed and is waiting for retry or discard.',
    ]) {
      expect(
        decideProjectSwitch({
          targetProjectId: P2,
          currentProjectId: P1,
          isQueueSettled: false,
          blockingCause: cause,
        }),
      ).toEqual({ kind: 'Blocked', cause });
    }
  });

  it('returns Blocked with a default cause when unsettled and no cause supplied', () => {
    const decision = decideProjectSwitch({
      targetProjectId: P2,
      currentProjectId: P1,
      isQueueSettled: false,
      blockingCause: null,
    });

    expect(decision.kind).toBe('Blocked');
    if (decision.kind === 'Blocked') {
      expect(decision.cause.length).toBeGreaterThan(0);
    }
  });

  it('treats a null current project as a plain switch target', () => {
    expect(
      decideProjectSwitch({
        targetProjectId: P1,
        currentProjectId: null,
        isQueueSettled: true,
        blockingCause: null,
      }),
    ).toEqual({ kind: 'Proceed' });
  });
});

describe('session-view-context', () => {
  it('keys by projectId:viewId', () => {
    expect(sessionViewContextKey(P1, 'outline')).toBe(`${P1}:outline`);
    expect(sessionViewContextKey(P2, 'gantt')).toBe(`${P2}:gantt`);
  });

  it('produces a frozen default with null focus fields', () => {
    const ctx = createDefaultSessionViewContext();
    expect(ctx).toEqual({ focusedNodeId: null, focusReturnNodeId: null });
    expect(Object.isFrozen(ctx)).toBe(true);
  });
});
