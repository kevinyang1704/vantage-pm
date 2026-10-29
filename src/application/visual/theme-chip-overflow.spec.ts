import { describe, it, expect } from 'vitest';
import { computeVisibleChipCount } from './theme-chip-overflow';

describe('theme-chip-overflow', () => {
  it('returns all chips when container is wide enough', () => {
    const count = computeVisibleChipCount({
      chipWidths: [100, 100, 100],
      containerWidth: 500,
      overflowChipWidth: 60,
      gap: 10,
    });
    expect(count).toBe(3);
  });

  it('calculates fitting chips plus overflow badge when container is constrained', () => {
    // 100 + 10 + 100 = 210. 210 + 10 + 60 = 280 <= 300.
    // Next: 210 + 10 + 100 = 320 + 10 + 60 = 390 > 300.
    const count = computeVisibleChipCount({
      chipWidths: [100, 100, 100, 100],
      containerWidth: 300,
      overflowChipWidth: 60,
      gap: 10,
    });
    expect(count).toBe(2);
  });

  it('returns 0 if not even one chip fits with the overflow badge', () => {
    const count = computeVisibleChipCount({
      chipWidths: [200, 200],
      containerWidth: 100,
      overflowChipWidth: 60,
      gap: 10,
    });
    expect(count).toBe(0);
  });

  it('handles empty chip list', () => {
    const count = computeVisibleChipCount({
      chipWidths: [],
      containerWidth: 500,
      overflowChipWidth: 60,
    });
    expect(count).toBe(0);
  });
});
