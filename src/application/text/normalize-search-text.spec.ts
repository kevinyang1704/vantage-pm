import { describe, it, expect } from 'vitest';
import { normalizeSearchText } from './normalize-search-text';

describe('normalizeSearchText (Story 2.8)', () => {
  it('folds compatibility characters via NFKC', () => {
    expect(normalizeSearchText('ﬁle')).toBe('file');
    expect(normalizeSearchText('①')).toBe('1');
    expect(normalizeSearchText('№')).toBe('no');
  });

  it('performs case folding on ß and ς', () => {
    expect(normalizeSearchText('Straße')).toBe('strasse');
    expect(normalizeSearchText('ΒΌΛΟΣ')).toBe('βόλοσ');
  });

  it('collapses arbitrary whitespace to single space', () => {
    expect(normalizeSearchText('Q3   Roadmap\t\nPlan')).toBe('q3 roadmap plan');
  });

  it('is strictly idempotent', () => {
    const raw = '  ﬁle №①  Straße   ';
    const first = normalizeSearchText(raw);
    const second = normalizeSearchText(first);
    expect(first).toBe(second);
  });
});
