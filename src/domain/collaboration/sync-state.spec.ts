import { describe, expect, it } from 'vitest';
import { promisesFutureSync, resolveSyncIndicator } from './sync-state';

describe('sync-state (Story 27.6/27.7, TC-UX1, R8)', () => {
  it('a local project shows no collaboration indicator', () => {
    const indicator = resolveSyncIndicator({ kind: 'local' });
    expect(indicator.text).toBeNull();
    expect(indicator.notice).toBeNull();
  });

  it('renders the exact TC-UX1 labels', () => {
    expect(resolveSyncIndicator({ kind: 'saved-on-device' }).text).toBe('Saved on this device');
    expect(resolveSyncIndicator({ kind: 'synced' }).text).toBe('Synced');
    expect(resolveSyncIndicator({ kind: 'pending', count: 3 }).text).toBe('3 changes waiting');
    expect(resolveSyncIndicator({ kind: 'pending', count: 1 }).text).toBe('1 change waiting');
    expect(resolveSyncIndicator({ kind: 'offline', pendingCount: 0, revoked: false }).text).toBe('Offline — changes will sync');
    expect(resolveSyncIndicator({ kind: 'update-required' }).text).toBe('Update to keep syncing');
  });

  it('Synced cannot hide unresolved rejected work', () => {
    const indicator = resolveSyncIndicator({ kind: 'rejected', unresolvedCount: 2, connected: true, pendingCount: 0 });
    expect(indicator.notice).toContain('2 changes could not be applied');
    expect(indicator.text).not.toBe('Synced');
    expect(indicator.text).toBe('2 changes waiting');
  });

  it('Offline does not promise sync after known revocation', () => {
    const revoked = resolveSyncIndicator({ kind: 'revoked' });
    expect(promisesFutureSync(revoked.label)).toBe(false);
    expect(revoked.notice).toContain('will not sync');
    const offlineRevoked = resolveSyncIndicator({ kind: 'offline', pendingCount: 3, revoked: true });
    expect(offlineRevoked.notice).toContain('will not sync');
  });

  it('rejected work with a rejected+pending state prefers the pending label', () => {
    const indicator = resolveSyncIndicator({ kind: 'rejected', unresolvedCount: 1, connected: true, pendingCount: 4 });
    expect(indicator.text).toBe('5 changes waiting');
    expect(indicator.notice).toContain('1 change could not be applied');
  });
});
