import { describe, it, expect } from 'vitest';
import {
  normalizeFieldKey,
  validateFieldKey,
  validateFieldLabel,
  validateFieldValue,
} from './field.policy';

describe('field.policy', () => {
  it('normalizes field keys correctly', () => {
    expect(normalizeFieldKey('Target Market')).toBe('target-market');
    expect(normalizeFieldKey('  Risk_Level_2026  ')).toBe('risk-level-2026');
    expect(normalizeFieldKey('Hello$$$World')).toBe('hello-world');
  });

  it('validates field keys', () => {
    expect(validateFieldKey('target-market').ok).toBe(true);
    expect(validateFieldKey('risk2').ok).toBe(true);
    expect(validateFieldKey('').ok).toBe(false);
    expect(validateFieldKey('Target Market').ok).toBe(false);
    expect(validateFieldKey('-leading-dash').ok).toBe(false);
  });

  it('validates field labels', () => {
    expect(validateFieldLabel('Target Market').ok).toBe(true);
    expect(validateFieldLabel('   ').ok).toBe(false);
  });

  it('validates field values', () => {
    expect(validateFieldValue(null).ok).toBe(true);
    expect(validateFieldValue('High value').ok).toBe(true);
    expect(validateFieldValue('a'.repeat(2001)).ok).toBe(false);
  });
});
