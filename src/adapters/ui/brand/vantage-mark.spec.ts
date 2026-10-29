import { describe, expect, it } from 'vitest';
import { colors } from '../theme/meridian.tokens';
import { VANTAGE_MARK_FACETS, VANTAGE_MARK_VIEWBOX } from './vantage-mark';

describe('Vantage mark', () => {
  it('colours every facet from a defined brand token', () => {
    for (const { tone } of VANTAGE_MARK_FACETS) {
      expect(colors[`brand-facet-${tone}`]).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it('keeps every facet inside the view box', () => {
    const [x, y, width, height] = VANTAGE_MARK_VIEWBOX.split(' ').map(Number);
    for (const { points } of VANTAGE_MARK_FACETS) {
      for (const pair of points.split(' ')) {
        const [px, py] = pair.split(',').map(Number);
        expect(px).toBeGreaterThanOrEqual(x);
        expect(px).toBeLessThanOrEqual(x + width);
        expect(py).toBeGreaterThanOrEqual(y);
        expect(py).toBeLessThanOrEqual(y + height);
      }
    }
  });

  it('is symmetric in outline: each wing mirrors the other', () => {
    const xs = VANTAGE_MARK_FACETS.flatMap(({ points }) =>
      points.split(' ').map((pair) => Number(pair.split(',')[0])),
    );
    expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(100, 5);
  });
});
