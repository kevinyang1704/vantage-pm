/**
 * Forecast refresh chain (Story 21.13, D1).
 *
 * Defect: the per-project refresh serialization chained each new refresh off
 * the previous promise UNGUARDED, so a rejecting link (sendSnapshot /
 * requestForecastFromSnapshot throwing) was stored as the next call's
 * predecessor — and `rejected.then(fn)` skips `fn` and propagates the
 * rejection. Every later refresh for that project silently did nothing and
 * added another unhandled rejection for the session.
 *
 * These tests assert the fixed contract: a throwing link must be bypassed by
 * subsequent work, each link's own outcome is still surfaced to its caller,
 * and the retained chain never holds rejections.
 */

import { describe, expect, it } from 'vitest';
import { createForecastRefreshChain } from './forecast-refresh-chain';

describe('createForecastRefreshChain (Story 21.13 D1)', () => {
  it.each([false, true])('preserves pending work across eviction, including rejection=%s', async (reject) => {
    const chain = createForecastRefreshChain();
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const order: string[] = [];
    const first = chain.schedule('p1', async () => {
      started.resolve();
      await gate.promise;
      order.push('old');
      if (reject) throw new Error('old refresh failed');
    });
    const observedFirst = first.catch(() => undefined);
    await started.promise;
    chain.evict('p1');
    const second = chain.schedule('p1', async () => { order.push('new'); });
    // Flush queued promise continuations without a timing-dependent sleep.
    await chain.schedule('p2', async () => {});
    expect(order).toEqual([]);
    gate.resolve();
    await Promise.all([observedFirst, second]);
    expect(order).toEqual(['old', 'new']);
  });

  it('an evicted predecessor cannot remove a newer pending tail', async () => {
    const chain = createForecastRefreshChain();
    const firstGate = Promise.withResolvers<void>();
    const secondGate = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const order: string[] = [];
    const first = chain.schedule('p1', () => firstGate.promise);
    chain.evict('p1');
    const second = chain.schedule('p1', async () => {
      secondStarted.resolve();
      await secondGate.promise;
      order.push('second');
    });
    firstGate.resolve();
    await first;
    await secondStarted.promise;
    const third = chain.schedule('p1', async () => { order.push('third'); });
    await chain.schedule('p2', async () => {});
    expect(order).toEqual([]);
    secondGate.resolve();
    await Promise.all([second, third]);
    expect(order).toEqual(['second', 'third']);
  });

  it('runs links for the same project strictly in order', async () => {
    const chain = createForecastRefreshChain();
    const order: string[] = [];
    await chain.schedule('p1', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('first');
    });
    await chain.schedule('p1', async () => {
      order.push('second');
    });
    expect(order).toEqual(['first', 'second']);
  });

  it('serializes links across projects independently', async () => {
    const chain = createForecastRefreshChain();
    const events: string[] = [];
    const first = chain.schedule('p1', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push('p1-done');
    });
    const second = chain.schedule('p2', async () => {
      events.push('p2-done');
    });
    await Promise.all([first, second]);
    expect(events).toEqual(['p2-done', 'p1-done']);
  });

  it('a rejecting link does NOT poison later refreshes for that project (D1 core)', async () => {
    const chain = createForecastRefreshChain();
    const firstLink = chain.schedule('p1', async () => {
      throw new Error('sendSnapshot exploded');
    });
    // The first caller must still observe its own failure.
    await expect(firstLink).rejects.toThrow('sendSnapshot exploded');

    let secondRan = false;
    const secondLink = chain.schedule('p1', async () => {
      secondRan = true;
    });
    // The second link must RUN — and must NOT inherit the rejection. Under
    // the defect this awaited promise never resolved and the flag stayed
    // false: the test fails against the current implementation.
    await secondLink;
    expect(secondRan).toBe(true);
  });

  it('each link surfaces its own outcome; later links are unaffected by an earlier rejection', async () => {
    const chain = createForecastRefreshChain();
    const calls: string[] = [];
    await chain.schedule('p1', async () => {
      calls.push('a');
      throw new Error('a failed');
    }).catch(() => undefined); // caller handles its own failure
    await chain.schedule('p1', async () => {
      calls.push('b');
      throw new Error('b failed');
    }).catch(() => undefined);
    await chain.schedule('p1', async () => {
      calls.push('c');
    });
    expect(calls).toEqual(['a', 'b', 'c']);
  });

  it('a recovering link after a failure still runs (rejection is not sticky)', async () => {
    const chain = createForecastRefreshChain();
    await chain.schedule('p1', async () => {
      throw new Error('boom');
    }).catch(() => undefined);
    await chain.schedule('p1', async () => {
      // must execute — the chain recovered
    });
  });

  it('evict drops the retained promise so a later schedule starts fresh', async () => {
    const chain = createForecastRefreshChain();
    await chain.schedule('p1', async () => {
      throw new Error('boom');
    }).catch(() => undefined);
    chain.evict('p1');
    let ran = false;
    await chain.schedule('p1', async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
