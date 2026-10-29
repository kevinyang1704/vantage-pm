/**
 * Per-project serialized forecast refresh chain (Story 21.13, D1).
 *
 * Refreshes for the same project are serialized so two commands dispatched
 * back-to-back (e.g. a configuration save then a level change) cannot have
 * their snapshot reads resolve out of order — the last refresh wins.
 *
 * The chain must survive a throwing link: a rejection in one refresh must
 * never poison every later refresh for the rest of the session. Each new
 * link is chained off a NEUTRALIZED predecessor (`previous.catch(() => {})*`),
 * so a rejected link is skipped and never propagates into later work.
 *
 * The returned promise still resolves/rejects with THIS link's outcome — the
 * caller decides how to surface a failure (Story 21.13 AC 2). The chain only
 * takes responsibility for sequencing and resilience, never for swallowing
 * errors silently.
 */

export interface ForecastRefreshChain {
  /**
   * Queue `work` after any pending refresh for `projectId`. Resolves with
   * this link's outcome; rejects when THIS link's work rejects (after any
   * preceding rejection has been bypassed).
   */
  schedule(projectId: string, work: () => Promise<void>): Promise<void>;
  /** Release a closed project's chain after pending work settles (AC 4). */
  evict(projectId: string): void;
}
export function createForecastRefreshChain(): ForecastRefreshChain {
  const chains = new Map<string, Promise<void>>();
  const chain: ForecastRefreshChain = Object.freeze({
    schedule(projectId: string, work: () => Promise<void>) {
      const previous = chains.get(projectId) ?? Promise.resolve();
      // Neutralize the predecessor so a rejecting link cannot skip or poison
      // this one: `rejected.then(fn)` propagates the rejection and never
      // runs `fn`. The stored chain may hold a rejection from the previous
      // link; that rejection belongs to that link's caller and must not
      // wedge every later refresh for the session (Story 21.13, D1).
      const current = previous.catch(() => {}).then(work);
      chains.set(projectId, current);
      return current;
    },
    evict(projectId: string) {
      const pending = chains.get(projectId);
      if (!pending) return;
      // A project can be reopened before its refresh finishes. Keep that
      // predecessor so the next refresh cannot overtake it. An older cleanup
      // must never discard a newer tail queued while this one was settling.
      const release = (): void => {
        if (chains.get(projectId) === pending) chains.delete(projectId);
      };
      void pending.then(release, release);
    },
  });
  return chain;
}
