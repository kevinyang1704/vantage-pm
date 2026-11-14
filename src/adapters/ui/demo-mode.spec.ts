import { describe, expect, it } from 'vitest';
import { isDemoMode } from './demo-mode';

describe('isDemoMode', () => {
  it.each([
    ['', false, false],
    ['?demo=1', false, true],
    ['?foo=bar&demo=1', false, true],
    ['?demo=0', false, false],
    ['?demo=1', true, false],
  ])('scopes %s, native=%s to %s', (search, native, expected) => {
    expect(isDemoMode({ search }, native)).toBe(expected);
  });
});
