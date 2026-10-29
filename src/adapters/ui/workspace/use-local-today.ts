/**
 * Local calendar date boundary (Story 24.2, AC 24.2-4).
 *
 * The timeline's "Today" reference is the local calendar date, not an instant.
 * The UI reads it through this boundary so tests can inject a fixed date and
 * the real shell only reads the clock here. Recomputes on local day rollover
 * (next-midnight timer) and on tab resume/visibility change.
 */

import { Temporal } from 'temporal-polyfill';
import { useCallback, useEffect, useState } from 'react';
import { readInjectedTodayIso } from './overview-clock';

export function localTodayIso(): string {
  return readInjectedTodayIso() ?? Temporal.Now.plainDateISO().toString();
}

/** Milliseconds from `nowMs` until the next local midnight. */
export function msUntilNextLocalMidnight(now: Date = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1, 0);
  return Math.max(1, next.getTime() - now.getTime());
}

export interface UseLocalTodayOptions {
  /** Injected fixed date for deterministic runs (tests); omit in production. */
  readonly fixedTodayIso?: string | null;
}

export function useLocalToday(options: UseLocalTodayOptions = {}): string {
  const { fixedTodayIso = null } = options;
  const [today, setToday] = useState(() => fixedTodayIso ?? localTodayIso());

  const recompute = useCallback(() => {
    if (fixedTodayIso) return;
    setToday(localTodayIso());
  }, [fixedTodayIso]);

  useEffect(() => {
    if (fixedTodayIso) {
      setToday(fixedTodayIso);
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleMidnight = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setToday(localTodayIso());
        scheduleMidnight();
      }, msUntilNextLocalMidnight());
    };

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') recompute();
    };

    scheduleMidnight();
    window.addEventListener('focus', recompute);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('focus', recompute);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fixedTodayIso, recompute]);

  return today;
}
