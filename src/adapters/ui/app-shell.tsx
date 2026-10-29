/**
 * AppShell — the root React component (Story 1.5 Task 6, migrated Story 2.1 Task 4).
 * Renders the storage-health category and its capability summary.
 *
 * Uses Meridian CSS custom properties (--pm-*) from the generated token sheet.
 * AD-5 provisional copy: "Stored locally — durability not certified for this edit"
 * Never substitute "saved", "safe", "durable", or equivalent language.
 */

import type { StorageHealthCategory } from '../platform/storage-health';
import './app-shell.css';

export interface AppShellProps {
  health?: StorageHealthCategory | null;
  bootTime?: number;
  children?: React.ReactNode;
}

function statusClass(kind: string): string {
  switch (kind) {
    case 'Granted':
    case 'UncertifiedCohort':
    case 'NativeStorageAvailable':
      return 'pm-shell-status pm-shell-status--granted';
    case 'Denied':
    case 'QuotaExhausted':
    case 'NativeStorageLowSpace':
      return 'pm-shell-status pm-shell-status--denied';
    case 'PrivateOrGuestProfile':
    case 'BestEffort':
    case 'NativeStorageReadOnly':
      return 'pm-shell-status pm-shell-status--orphan';
    default:
      return 'pm-shell-status pm-shell-status--uncertified';
  }
}

function statusLabel(kind: string): string {
  switch (kind) {
    case 'Granted':
    case 'UncertifiedCohort':
      return 'Storage Available';
    case 'NativeStorageAvailable':
      return 'Desktop SQLite Ready';
    case 'Denied': return 'Storage Denied';
    case 'QuotaExhausted': return 'Quota Exhausted';
    case 'PrivateOrGuestProfile': return 'Private/Guest Profile';
    case 'BestEffort': return 'Best-Effort Storage';
    case 'NativeStorageReadOnly': return 'Read-Only Recovery';
    case 'NativeStorageLowSpace': return 'Low Disk Space';
    default: return 'Unknown';
  }
}

export function AppShell({ health, bootTime, children }: AppShellProps): React.ReactElement {
  if (children) {
    return (
      <div className="pm-shell-frame">
        {/* Epic 15: one flex row hosts the persistent side navigation
            alongside whichever scope is active (workspace overview or a
            project's AppFrame) — see main.tsx's root render. The nav is
            passed as the first child, the scope content as the second. */}
        <div className="pm-shell-body">{children}</div>
        {/* Storage-health meta as an in-flow bottom strip (UAT #10): the
            previous fixed bottom-right overlay (zIndex 9999) painted over the
            EdgeInspectionPanel. In-flow at the bottom it can never overlap. */}
        <div className="pm-shell-status-meta">
          {!health ? (
            <div className="pm-shell-status pm-shell-status--loading">
              Checking storage health…
            </div>
          ) : (
            <>
              <div className={statusClass(health.kind)}>
                <strong>{statusLabel(health.kind)}</strong>
                {health.kind !== 'UncertifiedCohort' && (
                  <div className="pm-shell-cause">{health.cause}</div>
                )}
              </div>
              {health.capabilities.canWrite && (
                <div className="pm-shell-provisional">
                  Stored locally — durability not certified for this edit
                </div>
              )}
              <div className="pm-shell-capabilities">
                {health.capabilities.canWrite ? 'Edits accepted' : '🚫 Edits blocked'}
                {' · '}
                {health.capabilities.canPersist ? 'Persistence available' : 'Persistence unavailable'}
              </div>
              <div className="pm-shell-boot">
                Boot: {bootTime ?? 12}ms
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="pm-shell">
      <div className="pm-shell-title">Vantage</div>

      {!health ? (
        <div className="pm-shell-status pm-shell-status--loading">
          Checking storage health…
        </div>
      ) : (
        <>
          <div className={statusClass(health.kind)}>
            <strong>{statusLabel(health.kind)}</strong>
            {health.kind !== 'UncertifiedCohort' && (
              <div className="pm-shell-cause">{health.cause}</div>
            )}
          </div>

          {/* AD-5 provisional copy — exact wording, never substitute */}
          {health.capabilities.canWrite && (
            <div className="pm-shell-provisional">
              Stored locally — durability not certified for this edit
            </div>
          )}

          {/* Capability summary — written words, no emoji */}
          <div className="pm-shell-capabilities">
            {health.capabilities.canWrite ? 'Edits accepted' : '🚫 Edits blocked'}
            {' · '}
            {health.capabilities.canPersist ? 'Persistence available' : 'Persistence unavailable'}
          </div>
        </>
      )}

      <div className="pm-shell-boot">
        Boot: {bootTime}ms
      </div>
    </div>
  );
}
