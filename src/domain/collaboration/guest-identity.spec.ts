import { describe, expect, it } from 'vitest';
import {
  DISPLAY_NAME_MAX_LENGTH,
  normalizeDisplayName,
  requestSigningPayload,
} from './guest-identity';

describe('guest-identity (Story 27.4, TC-FR1, R6)', () => {
  it('normalizes a display name (trims and collapses whitespace)', () => {
    expect(normalizeDisplayName('  Hera   the   Builder ')).toEqual({ ok: true, name: 'Hera the Builder' });
  });

  it('rejects empty, too-long and control-character names', () => {
    expect(normalizeDisplayName('   ')).toEqual({ ok: false, issue: 'EMPTY' });
    expect(normalizeDisplayName('x'.repeat(DISPLAY_NAME_MAX_LENGTH + 1))).toEqual({ ok: false, issue: 'TOO_LONG' });
    expect(normalizeDisplayName('Hera\u0000')).toEqual({ ok: false, issue: 'CONTROL_CHARACTERS' });
  });

  it('builds a canonical, order-stable signing payload', () => {
    const payload = requestSigningPayload({
      method: 'post',
      path: '/invites/redeem',
      bodyDigest: 'abc',
      nonce: 'n1',
      timestamp: '2026-09-30T00:00:00Z',
    });
    expect(payload).toBe('POST\n/invites/redeem\nabc\nn1\n2026-09-30T00:00:00Z');
  });
});
