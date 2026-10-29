import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ViewStateCoalescer } from './view-state-coalescer';
import type { InteractionStatePort, PutViewStateResult } from './interaction-state.port';
import { createViewStateSnapshot, type ViewId, type ViewStatePatch } from '../../contracts/view-state';

const PROJ_ID = '019ffe00-0000-7000-8000-000000000001';

describe('ViewStateCoalescer (Story 2.5)', () => {
  let mockPort: InteractionStatePort;
  let putViewStateMock: (
    projectId: string,
    viewId: ViewId,
    baseRevision: number,
    patch: ViewStatePatch,
  ) => Promise<PutViewStateResult>;

  beforeEach(() => {
    vi.useFakeTimers();
    putViewStateMock = vi.fn(
      async (
        projectId: string,
        viewId: ViewId,
        baseRevision: number,
        patch: ViewStatePatch,
      ): Promise<PutViewStateResult> => {
        return {
          kind: 'Applied',
          snapshot: createViewStateSnapshot({
            projectId,
            viewId,
            viewStateRevision: baseRevision + 1,
            fields: {
              collapsedNodeIds: patch.collapsedNodeIds ?? [],
              zoomRootId: patch.zoomRootId ?? null,
              panX: patch.panX ?? 0,
              panY: patch.panY ?? 0,
              scale: patch.scale ?? 1,
            },
          }),
        };
      },
    );

    mockPort = {
      getViewState: vi.fn(async (pId, vId) =>
        createViewStateSnapshot({ projectId: pId, viewId: vId, viewStateRevision: 1 }),
      ),
      putViewState: (p, v, b, pa) => putViewStateMock(p, v, b, pa),
    };
  });

  it('coalesces rapid patches after idle delay', async () => {
    const coalescer = new ViewStateCoalescer(mockPort, 250);
    coalescer.setSnapshot(
      createViewStateSnapshot({ projectId: PROJ_ID, viewId: 'outline', viewStateRevision: 1 }),
    );

    coalescer.submitPatch(PROJ_ID, 'outline', { zoomRootId: '019ffe00-0001-7000-8000-000000000001' });
    coalescer.submitPatch(PROJ_ID, 'outline', { collapsedNodeIds: ['019ffe00-0002-7000-8000-000000000002'] });

    await vi.advanceTimersByTimeAsync(250);
    expect(putViewStateMock).toHaveBeenCalledTimes(1);
  });

  it('returns optimistically merged fields via getSnapshot while patches are pending', () => {
    const coalescer = new ViewStateCoalescer(mockPort, 250);
    coalescer.setSnapshot(
      createViewStateSnapshot({
        projectId: PROJ_ID,
        viewId: 'gantt',
        viewStateRevision: 1,
        fields: {
          granularity: 'month',
          dateWindowStart: '2026-01-01',
          dateWindowEnd: '2026-12-31',
        },
      }),
    );

    expect(coalescer.getSnapshot(PROJ_ID, 'gantt')?.fields.granularity).toBe('month');

    coalescer.submitPatch(PROJ_ID, 'gantt', { granularity: 'quarter' });

    const snapshot = coalescer.getSnapshot(PROJ_ID, 'gantt');
    expect(snapshot?.fields.granularity).toBe('quarter');
    expect(snapshot?.fields.dateWindowStart).toBe('2026-01-01');
    expect(snapshot?.fields.dateWindowEnd).toBe('2026-12-31');
  });

  it('coalesces visual viewport pan/zoom patches and reads them back optimistically (Epic 10, E10-AR9)', async () => {
    vi.useFakeTimers();
    const coalescer = new ViewStateCoalescer(mockPort, 250);
    coalescer.setSnapshot(
      createViewStateSnapshot({ projectId: PROJ_ID, viewId: 'visual', viewStateRevision: 1 }),
    );

    coalescer.submitPatch(PROJ_ID, 'visual', { panX: 40, panY: -20, scale: 1.25 });
    coalescer.submitPatch(PROJ_ID, 'visual', { panX: 90, panY: -40, scale: 1.5 });
    await vi.advanceTimersByTimeAsync(250);

    expect(putViewStateMock).toHaveBeenCalledTimes(1);
    const patch = (putViewStateMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][3] as ViewStatePatch;
    expect(patch.panX).toBe(90);
    expect(patch.panY).toBe(-40);
    expect(patch.scale).toBe(1.5);

    coalescer.submitPatch(PROJ_ID, 'visual', { panX: 120, panY: -60, scale: 1.75 });
    const snapshot = coalescer.getSnapshot(PROJ_ID, 'visual');
    expect(snapshot?.fields.panX).toBe(120);
    expect(snapshot?.fields.panY).toBe(-60);
    expect(snapshot?.fields.scale).toBe(1.75);
  });
});

const failed = (code: string): PutViewStateResult =>
  Object.freeze({ kind: 'Failed' as const, code, cause: 'transient', snapshot: null });

describe('ViewStateCoalescer transient failure retention (Story 25.3 AC 25.3-1/-3)', () => {
  it('retains a transiently-failed patch and retries it to convergence', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const port: InteractionStatePort = {
      getViewState: vi.fn(async (pId, vId) =>
        createViewStateSnapshot({ projectId: pId, viewId: vId, viewStateRevision: 1 }),
      ),
      putViewState: vi.fn(async (projectId, viewId, baseRevision) => {
        attempts += 1;
        if (attempts === 1) return failed('FAILED');
        return {
          kind: 'Applied' as const,
          snapshot: createViewStateSnapshot({
            projectId,
            viewId,
            viewStateRevision: baseRevision + 1,
            fields: { zoomRootId: '019ffe00-0001-7000-8000-0000000000aa' },
          }),
        };
      }),
    };
    const coalescer = new ViewStateCoalescer(port, 250);
    coalescer.setSnapshot(
      createViewStateSnapshot({ projectId: PROJ_ID, viewId: 'outline', viewStateRevision: 1 }),
    );

    coalescer.submitPatch(PROJ_ID, 'outline', { zoomRootId: '019ffe00-0001-7000-8000-0000000000aa' });
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(250);
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(coalescer.getSnapshot(PROJ_ID, 'outline')?.fields.zoomRootId).toBe(
      '019ffe00-0001-7000-8000-0000000000aa',
    );
    vi.useRealTimers();
  });

  it('does not retain a terminal newer-schema refusal', async () => {
    vi.useFakeTimers();
    const port: InteractionStatePort = {
      getViewState: vi.fn(async (pId, vId) =>
        createViewStateSnapshot({ projectId: pId, viewId: vId, viewStateRevision: 1 }),
      ),
      putViewState: vi.fn(async () => failed('UNSUPPORTED_NEWER_SCHEMA')),
    };
    const coalescer = new ViewStateCoalescer(port, 250);
    coalescer.setSnapshot(
      createViewStateSnapshot({ projectId: PROJ_ID, viewId: 'outline', viewStateRevision: 1 }),
    );

    coalescer.submitPatch(PROJ_ID, 'outline', { zoomRootId: '019ffe00-0001-7000-8000-0000000000bb' });
    await vi.advanceTimersByTimeAsync(250);
    expect((port.putViewState as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect((port.putViewState as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    vi.useRealTimers();
  });

  it('retains a second StaleBase instead of dropping the edit', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const port: InteractionStatePort = {
      getViewState: vi.fn(async (pId, vId) =>
        createViewStateSnapshot({ projectId: pId, viewId: vId, viewStateRevision: 5 }),
      ),
      putViewState: vi.fn(async (projectId, viewId) => {
        attempts += 1;
        if (attempts <= 2) {
          return {
            kind: 'StaleBase' as const,
            snapshot: createViewStateSnapshot({ projectId, viewId, viewStateRevision: 5 + attempts }),
          };
        }
        return {
          kind: 'Applied' as const,
          snapshot: createViewStateSnapshot({
            projectId,
            viewId,
            viewStateRevision: 9,
            fields: { zoomRootId: '019ffe00-0001-7000-8000-0000000000cc' },
          }),
        };
      }),
    };
    const coalescer = new ViewStateCoalescer(port, 250);
    coalescer.setSnapshot(
      createViewStateSnapshot({ projectId: PROJ_ID, viewId: 'outline', viewStateRevision: 4 }),
    );

    coalescer.submitPatch(PROJ_ID, 'outline', { zoomRootId: '019ffe00-0001-7000-8000-0000000000cc' });
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(250);
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(coalescer.getSnapshot(PROJ_ID, 'outline')?.fields.zoomRootId).toBe(
      '019ffe00-0001-7000-8000-0000000000cc',
    );
    vi.useRealTimers();
  });

  it('retains the patch when the port rejects (not just returns Failed)', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const port: InteractionStatePort = {
      getViewState: vi.fn(async (pId, vId) =>
        createViewStateSnapshot({ projectId: pId, viewId: vId, viewStateRevision: 1 }),
      ),
      putViewState: vi.fn(async () => {
        calls += 1;
        throw new Error('boom');
      }),
    };
    const coalescer = new ViewStateCoalescer(port, 100, 1);
    coalescer.setSnapshot(
      createViewStateSnapshot({ projectId: PROJ_ID, viewId: 'visual', viewStateRevision: 1 }),
    );

    coalescer.submitPatch(PROJ_ID, 'visual', { panX: 5 });
    // Must not reject out of flush: the throwing port is modelled as a transient
    // failure and retained for a bounded retry.
    await expect(coalescer.flush(PROJ_ID, 'visual')).resolves.toBeTruthy();
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(coalescer.getSnapshot(PROJ_ID, 'visual')?.fields.panX).toBe(5);
    vi.useRealTimers();
  });

  it('does not reset the retry budget for a submit that lands while a flush is in flight', async () => {
    vi.useFakeTimers();
    let resolvePut: ((r: PutViewStateResult) => void) | null = null;
    let calls = 0;
    const port: InteractionStatePort = {
      getViewState: vi.fn(async (pId, vId) =>
        createViewStateSnapshot({ projectId: pId, viewId: vId, viewStateRevision: 1 }),
      ),
      putViewState: vi.fn(
        () =>
          new Promise<PutViewStateResult>((resolve) => {
            calls += 1;
            resolvePut = resolve;
          }),
      ),
    };
    const coalescer = new ViewStateCoalescer(port, 100, 1);
    coalescer.setSnapshot(
      createViewStateSnapshot({ projectId: PROJ_ID, viewId: 'visual', viewStateRevision: 1 }),
    );

    // Attempt 1 fails → budget consumed (maxRetries=1); one retry armed.
    coalescer.submitPatch(PROJ_ID, 'visual', { panX: 1 });
    await vi.advanceTimersByTimeAsync(100);
    resolvePut!(failed('FAILED'));
    await vi.advanceTimersByTimeAsync(0);

    // Attempt 2 starts and stays in flight; a submit lands mid-flight.
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(2);
    coalescer.submitPatch(PROJ_ID, 'visual', { panX: 2 });

    // Fail attempt 2, then settle all timers. The mid-flight submit must not
    // have reset the budget, so exactly one further attempt is allowed (the
    // submit's own debounce), never an unbounded chain.
    resolvePut!(failed('FAILED'));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBeLessThanOrEqual(3);
    vi.useRealTimers();
  });
});
