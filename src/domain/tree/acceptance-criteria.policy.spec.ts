import { describe, it, expect } from 'vitest';
import { calculateAcceptanceRatio } from './acceptance-criteria.policy';

describe('acceptance-criteria.policy', () => {
  it('returns explicit absence text when no criteria exist', () => {
    const res = calculateAcceptanceRatio([]);
    expect(res.hasCriteria).toBe(false);
    expect(res.ratioText).toBe('no acceptance criteria yet');
    expect(res.percentage).toBe(null);
  });

  it('calculates derived completion ratio accurately', () => {
    const children = [
      { id: '1', nodeType: 'AcceptanceCriterion', completed: true },
      { id: '2', nodeType: 'AcceptanceCriterion', completed: false },
      { id: '3', nodeType: 'AcceptanceCriterion', completed: true },
      { id: '4', nodeType: 'Feature', completed: false }, // Ignored
    ];

    const res = calculateAcceptanceRatio(children);
    expect(res.hasCriteria).toBe(true);
    expect(res.total).toBe(3);
    expect(res.completed).toBe(2);
    expect(res.ratioText).toBe('2 / 3 met');
    expect(res.percentage).toBe(67);
  });
});
