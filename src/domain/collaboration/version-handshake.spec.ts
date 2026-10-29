import { describe, expect, it } from 'vitest';
import {
  handshake,
  supportedCountAt,
  updateMayProceed,
  type SupportedVersion,
} from './version-handshake';

const N: SupportedVersion = { protocolVersion: '1.0.0', schemaVersion: 17, retiresAtISO: '2026-10-30T00:00:00Z' };
const N_MINUS_1: SupportedVersion = { protocolVersion: '1.0.0', schemaVersion: 16, retiresAtISO: '2026-10-30T00:00:00Z' };
const NOW = '2026-09-30T00:00:00Z';

describe('version-handshake (Story 27.9, TC-NFR5, R10)', () => {
  it('accepts a client inside the support window', () => {
    expect(handshake({ protocolVersion: '1.0.0', schemaVersion: 17 }, [N, N_MINUS_1], NOW)).toMatchObject({ kind: 'accepted' });
    expect(handshake({ protocolVersion: '1.0.0', schemaVersion: 16 }, [N, N_MINUS_1], NOW)).toMatchObject({ kind: 'accepted' });
  });

  it('refuses an unknown protocol', () => {
    expect(handshake({ protocolVersion: '9.9.9', schemaVersion: 17 }, [N], NOW)).toEqual({ kind: 'update-required', reason: 'UNSUPPORTED_PROTOCOL' });
  });

  it('refuses an unsupported schema on a known protocol', () => {
    expect(handshake({ protocolVersion: '1.0.0', schemaVersion: 15 }, [N, N_MINUS_1], NOW)).toEqual({ kind: 'update-required', reason: 'UNSUPPORTED_SCHEMA' });
  });

  it('refuses a retired version even if listed', () => {
    const retired: SupportedVersion = { ...N, retiresAtISO: '2026-09-01T00:00:00Z' };
    expect(handshake({ protocolVersion: '1.0.0', schemaVersion: 17 }, [retired], NOW)).toEqual({ kind: 'update-required', reason: 'RETIRED' });
  });

  it('counts live supported protocols (N, N-1, N-2 in window)', () => {
    const n2: SupportedVersion = { protocolVersion: '0.9.0', schemaVersion: 15, retiresAtISO: '2026-10-15T00:00:00Z' };
    expect(supportedCountAt([N, N_MINUS_1, n2], NOW)).toBe(2);
    expect(supportedCountAt([N, N_MINUS_1, n2], '2026-10-20T00:00:00Z')).toBe(1);
  });

  it('an update waits for a settled queue and a durable outbox', () => {
    expect(updateMayProceed({ queueSettled: true, outboxDurable: true })).toBe(true);
    expect(updateMayProceed({ queueSettled: false, outboxDurable: true })).toBe(false);
    expect(updateMayProceed({ queueSettled: true, outboxDurable: false })).toBe(false);
  });
});
