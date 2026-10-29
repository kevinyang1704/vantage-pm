import { describe, expect, it } from 'vitest';
import {
  anchorsForIndex,
  applyAnchoredMove,
  resolveAnchoredIndex,
} from './anchor-placement.policy';

describe('anchor-placement.policy (Story 27.2, D8(c), R3)', () => {
  describe('resolveAnchoredIndex', () => {
    it('resolves after the after-anchor when it survives', () => {
      const result = resolveAnchoredIndex(['a', 'b', 'c', 'd'], 'd', {
        afterId: 'b',
        beforeId: 'c',
        intendedIndex: 0,
      });
      // Remaining is [a,b,c]; d goes after b -> index 2.
      expect(result).toEqual({ kind: 'Index', index: 2, resolvedBy: 'after' });
    });

    it('falls back to the before-anchor when the after-anchor is gone', () => {
      const result = resolveAnchoredIndex(['a', 'b', 'c'], 'c', {
        afterId: 'missing',
        beforeId: 'b',
        intendedIndex: 99,
      });
      expect(result).toEqual({ kind: 'Index', index: 1, resolvedBy: 'before' });
    });

    it('falls back to the intended index, clamped, when both anchors are gone', () => {
      const high = resolveAnchoredIndex(['a', 'b', 'c'], 'c', {
        afterId: 'x',
        beforeId: 'y',
        intendedIndex: 99,
      });
      expect(high).toEqual({ kind: 'Index', index: 2, resolvedBy: 'intended' });

      const low = resolveAnchoredIndex(['a', 'b', 'c'], 'a', {
        afterId: 'x',
        beforeId: 'y',
        intendedIndex: -5,
      });
      expect(low).toEqual({ kind: 'Index', index: 0, resolvedBy: 'intended' });
    });

    it('never silently falls to the end — a surviving after-anchor wins over intended', () => {
      const result = resolveAnchoredIndex(['a', 'b', 'c'], 'a', {
        afterId: 'b',
        beforeId: null,
        intendedIndex: 0,
      });
      expect(result).toEqual({ kind: 'Index', index: 1, resolvedBy: 'after' });
    });

    it('treats empty-end anchors as valid (front/back moves)', () => {
      const front = resolveAnchoredIndex(['a', 'b', 'c'], 'c', {
        afterId: null,
        beforeId: 'a',
        intendedIndex: 5,
      });
      expect(front).toEqual({ kind: 'Index', index: 0, resolvedBy: 'before' });

      const back = resolveAnchoredIndex(['a', 'b', 'c'], 'a', {
        afterId: 'c',
        beforeId: null,
        intendedIndex: 0,
      });
      expect(back).toEqual({ kind: 'Index', index: 2, resolvedBy: 'after' });
    });

    it('rejects an anchor that names the moving item itself', () => {
      expect(
        resolveAnchoredIndex(['a', 'b', 'c'], 'b', {
          afterId: 'b',
          beforeId: null,
          intendedIndex: 0,
        }),
      ).toEqual({ kind: 'SelfAnchor' });
      expect(
        resolveAnchoredIndex(['a', 'b', 'c'], 'b', {
          afterId: null,
          beforeId: 'b',
          intendedIndex: 0,
        }),
      ).toEqual({ kind: 'SelfAnchor' });
    });
  });

  describe('anchorsForIndex', () => {
    it('produces the bracketing neighbours for an insertion', () => {
      expect(anchorsForIndex(['a', 'b', 'c', 'd'], 'c', 1)).toEqual({
        afterId: 'a',
        beforeId: 'b',
        intendedIndex: 1,
      });
      expect(anchorsForIndex(['a', 'b', 'c', 'd'], 'c', 0)).toEqual({
        afterId: null,
        beforeId: 'a',
        intendedIndex: 0,
      });
      expect(anchorsForIndex(['a', 'b', 'c', 'd'], 'a', 3)).toEqual({
        afterId: 'd',
        beforeId: null,
        intendedIndex: 3,
      });
    });

    it('round-trips through resolveAnchoredIndex', () => {
      const ordered = ['a', 'b', 'c', 'd'];
      for (const movingId of ordered) {
        for (let index = 0; index <= ordered.length - 1; index += 1) {
          const placement = anchorsForIndex(ordered, movingId, index);
          const resolved = resolveAnchoredIndex(ordered, movingId, placement);
          expect(resolved).toEqual({ kind: 'Index', index, resolvedBy: expect.any(String) });
        }
      }
    });
  });

  describe('applyAnchoredMove', () => {
    it('moves the item and returns the next order', () => {
      const result = applyAnchoredMove(['a', 'b', 'c', 'd'], 'c', {
        afterId: null,
        beforeId: 'a',
        intendedIndex: 9,
      });
      expect(result).toEqual({ kind: 'Index', index: 0, resolvedBy: 'before', ids: ['c', 'a', 'b', 'd'] });
    });

    it('is a no-op when the item is already at the resolved position', () => {
      const result = applyAnchoredMove(['a', 'b', 'c'], 'b', {
        afterId: 'a',
        beforeId: 'c',
        intendedIndex: 1,
      });
      expect(result.ids).toEqual(['a', 'b', 'c']);
    });

    it('propagates SelfAnchor without ids', () => {
      const result = applyAnchoredMove(['a', 'b', 'c'], 'b', {
        afterId: 'b',
        beforeId: null,
        intendedIndex: 0,
      });
      expect(result).toEqual({ kind: 'SelfAnchor' });
    });
  });
});
