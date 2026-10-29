/**
 * Storage-health detection module (AD-5, Story 1.5 Task 4).
 * Determines the storage health category on startup from browser signals.
 *
 * Modeled as a pure function over injected navigator signals so it can be
 * unit-tested without a real browser (AD-1: no I/O in domain logic).
 *
 * IMPORTANT: navigator.storage.persisted() is an eligibility/eviction signal
 * only — never treat a `true` result as proof of durability (AD-5,
 * PHASE-0-DURABILITY.md "Evidence bundle").
 */

/** The typed union of storage-health categories. */
export type StorageHealthCategory = Readonly<{
  kind: 'Granted';
  cause: string;
  capabilities: Readonly<{
    canWrite: true;
    canPersist: true;
    isCertified: false; // Gate B (Story 1.4) not done — always NOT_CERTIFIED
  }>;
}> | Readonly<{
  kind: 'Denied';
  cause: string;
  capabilities: Readonly<{
    canWrite: false;
    canPersist: false;
    isCertified: false;
  }>;
}> | Readonly<{
  /**
   * persisted() reported false (or could not be read): the browser has not
   * promised to keep the data under storage pressure. Writes still work, so
   * edits stay allowed; persistence and certification stay false (AD-5).
   */
  kind: 'BestEffort';
  cause: string;
  capabilities: Readonly<{
    canWrite: true;
    canPersist: false;
    isCertified: false;
  }>;
}> | Readonly<{
  kind: 'QuotaExhausted';
  cause: string;
  capabilities: Readonly<{
    canWrite: false;
    canPersist: false;
    isCertified: false;
  }>;
  quota: Readonly<{ usage: number; quota: number }>;
}> | Readonly<{
  kind: 'PrivateOrGuestProfile';
  cause: string;
  capabilities: Readonly<{
    canWrite: true;
    canPersist: false;
    isCertified: false;
  }>;
}> | Readonly<{
  kind: 'UncertifiedCohort';
  cause: string;
  capabilities: Readonly<{
    canWrite: true;
    canPersist: boolean;
    isCertified: false;
  }>;
  cohort: Readonly<{ browser: string; platform: string }>;
}> | Readonly<{
  kind: 'NativeStorageAvailable';
  cause: string;
  capabilities: Readonly<{
    canWrite: true;
    canPersist: true;
    isCertified: false; // Gate B (Story 9.8) not done — NOT_CERTIFIED
  }>;
}> | Readonly<{
  kind: 'NativeStorageLowSpace';
  cause: string;
  capabilities: Readonly<{
    canWrite: false;
    canPersist: true;
    isCertified: false;
  }>;
}> | Readonly<{
  kind: 'NativeStorageReadOnly';
  cause: string;
  capabilities: Readonly<{
    canWrite: false;
    canPersist: true;
    isCertified: false;
  }>;
}>;

/** Native storage status returned by `repository_storage_status`. */
export type NativeStorageStatus = Readonly<{
  nativeStorage: true;
  open: boolean;
  intakePaused: boolean;
}>;

/** Native low-space threshold: < 128 MiB free on the store volume. */
export const NATIVE_LOW_SPACE_THRESHOLD_BYTES = 128 * 1024 * 1024;

/**
 * Derive the storage-health category for the NATIVE composition
 * (E9-FR14, E9-UX4). Distinguishes optimistic overlay, native commit
 * accepted, and recovery states without checkmark theatre.
 */
export function deriveNativeStorageHealth(status: NativeStorageStatus): StorageHealthCategory {
  if (!status.open) {
    return Object.freeze({
      kind: 'NativeStorageReadOnly',
      cause: 'The desktop repository is not open. Recovery may be required.',
      capabilities: Object.freeze({
        canWrite: false,
        canPersist: true,
        isCertified: false,
      }),
    } as StorageHealthCategory);
  }
  if (status.intakePaused) {
    return Object.freeze({
      kind: 'NativeStorageReadOnly',
      cause: 'The desktop repository is shutting down; edits are paused.',
      capabilities: Object.freeze({
        canWrite: false,
        canPersist: true,
        isCertified: false,
      }),
    } as StorageHealthCategory);
  }
  return Object.freeze({
    kind: 'NativeStorageAvailable',
    cause: 'Stored in the desktop SQLite repository.',
    capabilities: Object.freeze({
      canWrite: true,
      canPersist: true,
      isCertified: false,
    }),
  } as StorageHealthCategory);
}

/** Input signals for storage-health detection. */
export type StorageHealthSignals = Readonly<{
  persisted: boolean;
  quota: Readonly<{ usage: number; quota: number }> | null;
  isPrivateProfile: boolean;
  browserBrand: string;
  platformVersion: string;
  isOpfs?: boolean;
}>;

/**
 * Derive the storage-health category from browser signals.
 * Pure function — no I/O, no side effects (AD-1, mirroring
 * decideUpdate()/selectMigrationRecovery() convention).
 */
export function deriveStorageHealth(
  signals: StorageHealthSignals,
): StorageHealthCategory {
  // Private/guest profile — best-effort heuristic.
  // Known limitation: browsers do not expose a direct "is this a guest profile" API.
  // The heuristic used here is a caller-supplied signal; the caller (platform adapter)
  // may use navigator.userAgentData or other indirect signals.
  if (signals.isPrivateProfile) {
    return Object.freeze({
      kind: 'PrivateOrGuestProfile',
      cause: 'The browser profile appears to be private/guest — persistence is not durable.',
      capabilities: Object.freeze({
        canWrite: true,
        canPersist: false,
        isCertified: false,
      }),
    } as StorageHealthCategory);
  }

  // Quota exhausted
  if (signals.quota && signals.quota.usage >= signals.quota.quota * 0.99) {
    return Object.freeze({
      kind: 'QuotaExhausted',
      cause: 'Storage quota is exhausted.',
      capabilities: Object.freeze({
        canWrite: false,
        canPersist: false,
        isCertified: false,
      }),
      quota: Object.freeze({ ...signals.quota }),
    } as StorageHealthCategory);
  }

  // Persistence not granted. This is not a write failure: the browser has only
  // declined to promise it will keep the data under storage pressure, so edits
  // stay allowed and the user is told to keep a backup. (Blocking here locked
  // users out whenever an extension wrapped navigator.storage.persisted().)
  if (!signals.persisted) {
    return Object.freeze({
      kind: 'BestEffort',
      cause: 'The browser has not granted persistent storage, so it may clear this data under storage pressure. Export the project to keep a backup.',
      capabilities: Object.freeze({
        canWrite: true,
        canPersist: false,
        isCertified: false,
      }),
    } as StorageHealthCategory);
  }

  // Uncertified cohort — always the default for now (Gate B not done)
  const canPersist = signals.isOpfs !== false;
  return Object.freeze({
    kind: 'UncertifiedCohort',
    cause: canPersist
      ? 'The browser cohort is not in the certified matrix.'
      : 'OPFS storage unavailable; running in in-memory mode.',
    capabilities: Object.freeze({
      canWrite: true,
      canPersist,
      isCertified: false,
    }),
    cohort: Object.freeze({
      browser: signals.browserBrand,
      platform: signals.platformVersion,
    }),
  } as StorageHealthCategory);
}

/**
 * Platform adapter: gather real browser signals and derive storage health.
 * This is the I/O boundary — called from src/app/main.tsx at startup.
 *
 * In the native Tauri composition, browser storage signals are meaningless:
 * the store is an OS-managed SQLite file. `isOpfs` is passed as `false` and
 * the native runtime status is derived instead (E9-FR14, E9-UX4).
 */
export async function detectStorageHealth(isOpfs?: boolean): Promise<StorageHealthCategory> {
  if (isOpfs === false) {
    // In the native composition the browser persistence signals are
    // irrelevant; the storage status command reports the native store.
    return deriveStorageHealth({
      persisted: false,
      quota: null,
      isPrivateProfile: false,
      browserBrand: 'native',
      platformVersion: 'desktop',
      isOpfs: false,
    });
  }

  let persisted = true;
  let quota: { usage: number; quota: number } | null = null;
  let isPrivateProfile = false;

  try {
    if (navigator.storage?.persisted) {
      const fnStr = navigator.storage.persisted.toString();
      if (!fnStr.includes('[native code]')) {
        persisted = await navigator.storage.persisted();
      } else {
        persisted = true;
      }
    }
  } catch {
    persisted = false;
  }

  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      if (est.usage !== undefined && est.quota !== undefined) {
        quota = { usage: est.usage, quota: est.quota };
      }
    }
  } catch {
    // Estimate unavailable — proceed without quota info
  }

  // Best-effort private/guest profile detection.
  // Heuristic: if storage estimate returns very small quota (< 100MB) and
  // persisted() returns false, treat as possible private/guest profile.
  // Known limitation: no direct browser API for guest profile detection.
  if (!persisted && quota && quota.quota < 100_000_000) {
    isPrivateProfile = true;
  }

  let browserBrand = 'unknown';
  let platformVersion = 'unknown';

  try {
    if ('userAgentData' in navigator) {
      const ua = navigator as Navigator & {
        userAgentData?: { brands?: Array<{ brand: string; version: string }>; platform?: string };
      };
      if (ua.userAgentData?.brands?.[0]) {
        browserBrand = `${ua.userAgentData.brands[0].brand} ${ua.userAgentData.brands[0].version}`;
      }
      if (ua.userAgentData?.platform) {
        platformVersion = ua.userAgentData.platform;
      }
    }
  } catch {
    // userAgentData unavailable — use fallback values
  }

  return deriveStorageHealth({
    persisted,
    quota,
    isPrivateProfile,
    browserBrand,
    platformVersion,
    isOpfs,
  });
}
