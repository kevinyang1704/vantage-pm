/**
 * ViewStateCoalescer (Story 2.5 Task 2, AD-5).
 *
 * Coalesces high-frequency view-state patches after 250ms idle, merges
 * disjoint fields, applies last-write-wins per field, and retries on stale base.
 */

import {
  applyViewStatePatch,
  type ViewId,
  type ViewStatePatch,
  type ViewStateSnapshot,
} from '../../contracts/view-state';
import type {
  InteractionStatePort,
  PutViewStateResult,
} from './interaction-state.port';

export class ViewStateCoalescer {
  private readonly pendingPatches = new Map<string, ViewStatePatch>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly snapshots = new Map<string, ViewStateSnapshot>();
  /** Consecutive transient-failure retries per key (bounded; Story 25.3 AC 25.3-1). */
  private readonly retryCounts = new Map<string, number>();
  /** Keys with a flush currently awaiting the port, so a concurrent submit does not reset the budget. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly port: InteractionStatePort,
    private readonly idleDelayMs: number = 250,
    private readonly maxRetries: number = 3,
  ) {}

  private key(projectId: string, viewId: ViewId): string {
    return `${projectId}:${viewId}`;
  }

  setSnapshot(snapshot: ViewStateSnapshot): void {
    this.snapshots.set(this.key(snapshot.projectId, snapshot.viewId), snapshot);
  }

  getSnapshot(projectId: string, viewId: ViewId): ViewStateSnapshot | undefined {
    const k = this.key(projectId, viewId);
    const snap = this.snapshots.get(k);
    if (!snap) return undefined;
    const pending = this.pendingPatches.get(k);
    if (!pending) return snap;
    return Object.freeze({
      ...snap,
      fields: applyViewStatePatch(snap.fields, pending),
    });
  }

  submitPatch(
    projectId: string,
    viewId: ViewId,
    patch: ViewStatePatch,
  ): void {
    const k = this.key(projectId, viewId);
    const existing = this.pendingPatches.get(k) ?? {};
    const merged: ViewStatePatch = Object.freeze({
      ...existing,
      ...patch,
    });
    this.pendingPatches.set(k, merged);
    // A fresh user-initiated edit re-arms the retry budget, so a past burst of
    // failures cannot permanently reduce a later distinct edit to one attempt.
    // Only when no flush is in flight for the key: a submit during a flush is
    // the same in-progress edit and must not defeat the retry bound.
    if (!this.inFlight.has(k)) this.retryCounts.delete(k);

    const existingTimer = this.timers.get(k);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      void this.flush(projectId, viewId);
    }, this.idleDelayMs);

    this.timers.set(k, timer);
  }

  async flush(projectId: string, viewId: ViewId): Promise<PutViewStateResult | null> {
    const k = this.key(projectId, viewId);
    const timer = this.timers.get(k);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(k);
    }

    const patch = this.pendingPatches.get(k);
    if (!patch) return null;
    this.pendingPatches.delete(k);

    const currentSnapshot = this.snapshots.get(k);
    const baseRevision = currentSnapshot?.viewStateRevision ?? 0;

    this.inFlight.add(k);
    let res: PutViewStateResult;
    try {
      res = await this.port.putViewState(projectId, viewId, baseRevision, patch);

      if (res.kind === 'StaleBase') {
        // Reapply the pending patch once onto the latest snapshot.
        this.snapshots.set(k, res.snapshot);
        res = await this.port.putViewState(
          projectId,
          viewId,
          res.snapshot.viewStateRevision,
          patch,
        );
      }
    } catch (err) {
      // A rejecting port (the contract permits it) must not silently discard
      // the edit: model it as a transient failure so the retention/retry path
      // below runs (AC 25.3-1).
      res = Object.freeze({
        kind: 'Failed' as const,
        code: 'FAILED',
        cause: err instanceof Error ? err.message : 'View state write failed.',
        snapshot: null,
      });
    } finally {
      this.inFlight.delete(k);
    }

    // Story 25.3 AC 25.3-1/-3: a failure or a second stale base must not silently
    // discard the user's latest edit. Re-merge the patch back into the pending
    // set so a later submit/flush retries it; last-write-wins preserves any
    // newer fields written while the flush was in flight. A terminal
    // newer-schema refusal (`UNSUPPORTED_NEWER_SCHEMA`) is NOT retained — that
    // path is already surfaced by the caller and retrying would be futile.
    if (res.kind === 'Applied') {
      this.snapshots.set(k, res.snapshot);
      this.retryCounts.delete(k);
      return res;
    }

    const retryable = res.kind === 'StaleBase' || (res.kind === 'Failed' && res.code !== 'UNSUPPORTED_NEWER_SCHEMA');
    if (retryable) {
      // Adopt the newest snapshot a second StaleBase returned, so the retry
      // starts from the current revision rather than the first rebased one.
      if (res.kind === 'StaleBase') this.snapshots.set(k, res.snapshot);
      const newer = this.pendingPatches.get(k) ?? {};
      this.pendingPatches.set(k, Object.freeze({ ...patch, ...newer }));
      // Retry automatically, but bound the attempts so a persistent failure
      // does not spin forever. Once the budget is spent the patch stays
      // pending (still reflected by getSnapshot) and the next user edit
      // re-arms the budget (submitPatch clears retryCounts).
      const retries = (this.retryCounts.get(k) ?? 0) + 1;
      if (retries <= this.maxRetries) {
        this.retryCounts.set(k, retries);
        // Replace any timer a concurrent submit armed, so only one retry is
        // scheduled for this key.
        const existingTimer = this.timers.get(k);
        if (existingTimer) clearTimeout(existingTimer);
        const retryTimer = setTimeout(() => {
          void this.flush(projectId, viewId);
        }, this.idleDelayMs);
        this.timers.set(k, retryTimer);
      }
    }

    return res;
  }
}
