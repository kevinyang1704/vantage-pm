/**
 * Browser-role demotion banner (E9-FR15, Story 9.6 Task 4).
 *
 * Rendered ONLY in the browser composition: tells the user that the desktop
 * app is the authoritative storage host and offers a one-click portable
 * export of the current project for migration. Never auto-deletes browser
 * data; the export path is the migration boundary (E9-FR13).
 */

import { useCallback, useState } from 'react';

import { exportProject, portableBackupFilename } from '../../../application/portable-file/export-project';
import type { Project } from '../../../domain/project/project.entity';
import { saveGeneratedFile } from '../../platform/save-generated-file';
import type { PublishResult } from '../../../contracts/export-publish';
import type { PortableProjectSnapshot } from '../../../contracts/portable-file.schema';

export interface BrowserRoleBannerProps {
  getProject: (id: string) => Project | null;
  isQueueSettled: (id: string) => boolean;
  queueBlockingCause: (id: string) => string | null;
  readPortableSnapshot: (id: string) => Promise<PortableProjectSnapshot>;
}

export function BrowserRoleBanner({
  getProject,
  isQueueSettled,
  queueBlockingCause,
  readPortableSnapshot,
}: BrowserRoleBannerProps): React.ReactElement {
  const [status, setStatus] = useState<string | null>(null);

  const handleExport = useCallback(
    async (projectId: string, projectName: string): Promise<void> => {
      const result = await exportProject(projectId, {
        getProject: (id) => getProject(id),
        isQueueSettled: (id) => isQueueSettled(id),
        queueBlockingCause: (id) => queueBlockingCause(id),
        readPortableSnapshot,
        clock: { nowISO: () => new Date().toISOString() },
      });
      if (!result.ok) {
        setStatus(`Export could not start: ${result.cause}`);
        return;
      }
      const saved: PublishResult = await saveGeneratedFile(
        new TextEncoder().encode(result.json),
        portableBackupFilename(projectName),
        'application/json',
      );
      setStatus(
        saved.ok
          ? 'Portable copy exported — the desktop app can import it.'
          : `Export could not be saved (${saved.failure.kind}).`,
      );
    },
    [getProject, isQueueSettled, queueBlockingCause, readPortableSnapshot],
  );

  return (
    <aside className="pm-browser-role-banner" role="region" aria-label="Desktop app notice">
      <p className="pm-browser-role-banner__copy">
        Vantage now runs as a desktop app with native SQLite storage. Use the desktop app for
        authoritative storage; this browser build is a migration surface.
      </p>
      <p className="pm-browser-role-banner__hint">
        Export a project here, then import it into the desktop app. Your browser copy is never
        deleted automatically.
      </p>
      {status && <p className="pm-browser-role-banner__status" role="status" aria-live="polite">{status}</p>}
    </aside>
  );
}
