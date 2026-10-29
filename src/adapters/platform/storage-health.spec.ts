import { describe, it, expect } from 'vitest';
import { deriveStorageHealth, StorageHealthSignals } from './storage-health';

// ---------------------------------------------------------------------------
// Shared signal factories — each test overrides only the fields it cares about
// ---------------------------------------------------------------------------

const baseSignals = (): StorageHealthSignals =>
  Object.freeze({
    persisted: true,
    quota: null,
    isPrivateProfile: false,
    browserBrand: 'Chromium',
    platformVersion: 'Windows',
  });

const quotaAt = (usage: number, quota: number): Readonly<{ usage: number; quota: number }> =>
  Object.freeze({ usage, quota });

// ---------------------------------------------------------------------------
// Category table-tests
// ---------------------------------------------------------------------------

describe('deriveStorageHealth', () => {
  describe('category detection', () => {
    it.each([
      // ── PrivateOrGuestProfile ──────────────────────────────────────────
      {
        label: 'private-or-guest profile',
        signals: { ...baseSignals(), isPrivateProfile: true },
        expected: {
          kind: 'PrivateOrGuestProfile' as const,
          cause: 'The browser profile appears to be private/guest — persistence is not durable.',
          capabilities: { canWrite: true, canPersist: false, isCertified: false },
        },
      },
      // ── QuotaExhausted ──────────────────────────────────────────────────
      {
        label: 'quota exhausted (usage at 99 %)',
        signals: { ...baseSignals(), quota: quotaAt(99, 100) },
        expected: {
          kind: 'QuotaExhausted' as const,
          cause: 'Storage quota is exhausted.',
          capabilities: { canWrite: false, canPersist: false, isCertified: false },
        },
      },
      {
        label: 'quota exhausted (usage well above 99 %)',
        signals: { ...baseSignals(), quota: quotaAt(999_999, 1_000_000) },
        expected: {
          kind: 'QuotaExhausted' as const,
          cause: 'Storage quota is exhausted.',
          capabilities: { canWrite: false, canPersist: false, isCertified: false },
        },
      },
      // ── BestEffort ──────────────────────────────────────────────────────
      // persisted() === false only means the browser has not promised to keep
      // the data under storage pressure. Writes still work, so edits stay
      // allowed; persistence and certification stay false.
      {
        label: 'persistence not granted',
        signals: { ...baseSignals(), persisted: false },
        expected: {
          kind: 'BestEffort' as const,
          cause: 'The browser has not granted persistent storage, so it may clear this data under storage pressure. Export the project to keep a backup.',
          capabilities: { canWrite: true, canPersist: false, isCertified: false },
        },
      },
      // ── UncertifiedCohort ──────────────────────────────────────────────
      {
        label: 'uncertified cohort (default)',
        signals: baseSignals(),
        expected: {
          kind: 'UncertifiedCohort' as const,
          cause: 'The browser cohort is not in the certified matrix.',
          capabilities: { canWrite: true, canPersist: true, isCertified: false },
        },
      },
    ])('returns $label → kind=$expected.kind', ({ signals, expected }) => {
      const result = deriveStorageHealth(signals);

      expect(result.kind).toBe(expected.kind);
      expect(result.cause).toBe(expected.cause);
      expect(result.capabilities).toEqual(expected.capabilities);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('classifies quota exactly at the 99 % threshold as QuotaExhausted', () => {
      const result = deriveStorageHealth({
        ...baseSignals(),
        quota: quotaAt(99, 100), // usage === quota * 0.99
      });
      expect(result.kind).toBe('QuotaExhausted');
    });

    it('does NOT classify quota just below the 99 % threshold as QuotaExhausted', () => {
      const result = deriveStorageHealth({
        ...baseSignals(),
        quota: quotaAt(98, 100), // usage < quota * 0.99
      });
      expect(result.kind).not.toBe('QuotaExhausted');
    });

    it('classifies zero-quota with zero-usage as QuotaExhausted (0 >= 0 * 0.99)', () => {
      const result = deriveStorageHealth({
        ...baseSignals(),
        quota: quotaAt(0, 0),
      });
      expect(result.kind).toBe('QuotaExhausted');
    });

    it('skips quota check when quota is null', () => {
      const result = deriveStorageHealth({
        ...baseSignals(),
        persisted: false,
        quota: null,
      });
      // Falls through to BestEffort (not QuotaExhausted)
      expect(result.kind).toBe('BestEffort');
    });

    it('skips quota check when quota is null and persisted is true → UncertifiedCohort', () => {
      const result = deriveStorageHealth({
        ...baseSignals(),
        quota: null,
      });
      expect(result.kind).toBe('UncertifiedCohort');
    });
  });

  // -----------------------------------------------------------------------
  // Priority ordering
  // -----------------------------------------------------------------------

  describe('priority ordering', () => {
    it('PrivateOrGuestProfile takes precedence over QuotaExhausted', () => {
      const result = deriveStorageHealth({
        ...baseSignals(),
        isPrivateProfile: true,
        quota: quotaAt(99, 100), // would be QuotaExhausted
      });
      expect(result.kind).toBe('PrivateOrGuestProfile');
    });

    it('PrivateOrGuestProfile takes precedence over BestEffort', () => {
      const result = deriveStorageHealth({
        ...baseSignals(),
        isPrivateProfile: true,
        persisted: false, // would be BestEffort
      });
      expect(result.kind).toBe('PrivateOrGuestProfile');
    });

    it('QuotaExhausted takes precedence over BestEffort', () => {
      const result = deriveStorageHealth({
        ...baseSignals(),
        persisted: false, // would be BestEffort
        quota: quotaAt(99, 100), // but quota exhausted wins
      });
      expect(result.kind).toBe('QuotaExhausted');
    });

    it('BestEffort takes precedence over UncertifiedCohort', () => {
      const result = deriveStorageHealth({
        ...baseSignals(),
        persisted: false,
      });
      expect(result.kind).toBe('BestEffort');
    });

    it('never blocks edits just because persistence was not granted', () => {
      const result = deriveStorageHealth({ ...baseSignals(), persisted: false });
      expect(result.capabilities.canWrite).toBe(true);
      expect(result.capabilities.canPersist).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Extra fields on specific categories
  // -----------------------------------------------------------------------

  describe('category-specific fields', () => {
    it('QuotaExhausted includes the frozen quota snapshot', () => {
      const result = deriveStorageHealth({
        ...baseSignals(),
        quota: quotaAt(990, 1000), // 99 % — triggers QuotaExhausted
      });
      expect(result.kind).toBe('QuotaExhausted');
      if (result.kind === 'QuotaExhausted') {
        expect(result.quota).toEqual({ usage: 990, quota: 1000 });
        expect(Object.isFrozen(result.quota)).toBe(true);
      }
    });

    it('UncertifiedCohort includes the frozen cohort snapshot', () => {
      const result = deriveStorageHealth({
        ...baseSignals(),
        browserBrand: 'Edge',
        platformVersion: 'macOS',
      });
      expect(result.kind).toBe('UncertifiedCohort');
      if (result.kind === 'UncertifiedCohort') {
        expect(result.cohort).toEqual({ browser: 'Edge', platform: 'macOS' });
        expect(Object.isFrozen(result.cohort)).toBe(true);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Immutability
  // -----------------------------------------------------------------------

  describe('immutability', () => {
    it.each([
      { label: 'PrivateOrGuestProfile', signals: { ...baseSignals(), isPrivateProfile: true } },
      { label: 'QuotaExhausted', signals: { ...baseSignals(), quota: quotaAt(99, 100) } },
      { label: 'BestEffort', signals: { ...baseSignals(), persisted: false } },
      { label: 'UncertifiedCohort', signals: baseSignals() },
    ])('returns a frozen object for $label', ({ signals }) => {
      const result = deriveStorageHealth(signals);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('freezes the capabilities sub-object on every category', () => {
      const categories = [
        deriveStorageHealth({ ...baseSignals(), isPrivateProfile: true }),
        deriveStorageHealth({ ...baseSignals(), quota: quotaAt(99, 100) }),
        deriveStorageHealth({ ...baseSignals(), persisted: false }),
        deriveStorageHealth(baseSignals()),
      ];

      for (const cat of categories) {
        expect(Object.isFrozen(cat.capabilities)).toBe(true);
      }
    });
  });

  // -----------------------------------------------------------------------
  // isCertified is always false (Gate B not done)
  // -----------------------------------------------------------------------

  describe('certification guard', () => {
    it('never sets isCertified to true regardless of input signals', () => {
      const allCategories = [
        deriveStorageHealth({ ...baseSignals(), isPrivateProfile: true }),
        deriveStorageHealth({ ...baseSignals(), quota: quotaAt(99, 100) }),
        deriveStorageHealth({ ...baseSignals(), persisted: false }),
        deriveStorageHealth(baseSignals()),
      ];

      for (const cat of allCategories) {
        expect(cat.capabilities.isCertified).toBe(false);
      }
    });
  });
});
