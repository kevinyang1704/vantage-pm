import { describe, it, expect } from 'vitest';
import { scanMotionBudget } from './motion-budget';

describe('check-motion-budget', () => {
  it('passes on allowed 110ms opacity reveal and reduced motion 0ms', () => {
    const validCss = `
      .lane {
        transition: opacity 110ms ease-out;
      }
      @media (prefers-reduced-motion: reduce) {
        .lane {
          transition: opacity 0ms;
        }
      }
    `;
    const violations = scanMotionBudget(validCss, 'test.css');
    expect(violations).toHaveLength(0);
  });

  it('flags unapproved transitions', () => {
    const invalidCss = `
      .card {
        transition: background-color 0.2s ease;
      }
    `;
    const violations = scanMotionBudget(invalidCss, 'test.css');
    expect(violations).toHaveLength(1);
    expect(violations[0].property).toBe('transition');
    expect(violations[0].value).toBe('background-color 0.2s ease');
  });

  it('flags animation and @keyframes', () => {
    const invalidCss = `
      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      .spinner {
        animation: spin 1s linear infinite;
      }
    `;
    const violations = scanMotionBudget(invalidCss, 'test.css');
    expect(violations).toHaveLength(2);
  });
});
