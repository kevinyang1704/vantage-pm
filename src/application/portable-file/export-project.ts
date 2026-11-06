/**
 * Export project use case (Story 1.8 Task 3, Epic 13 Story 13.1 Task 3).
 *
 * Exports the active project to a versioned UTF-8 *.pmapp.json envelope from
 * a current authoritative portable snapshot assembled at the persistence
 * boundary — never from UI projections (E13-AR1/AR2).
 *
 * AD-4: "unresolved failure blocks project switch/export/update" —
 * export requires isQueueSettled(projectId) before proceeding, and the
 * returned revision/current queue state is rechecked before publication so a
 * command beginning during snapshot assembly cannot produce a misleading
 * current backup.
 */

import {
  PORTABLE_FILE_SCHEMA_VERSION,
  serializePortableFileEnvelope,
  type PortableFileEnvelope,
  type PortableProjectSnapshot,
} from '../../contracts/portable-file.schema';
import type { Project } from '../../domain/project/project.entity';

/** Clock port for deterministic exportedAt timestamps (AD-8). */
export interface ClockPort {
  nowISO(): string;
}

/** Result of an export attempt. */
export type ExportResult =
  | Readonly<{ ok: true; envelope: PortableFileEnvelope; json: string; snapshotRevision: number }>
  | Readonly<{
      ok: false;
      code: 'QUEUE_NOT_SETTLED' | 'PROJECT_NOT_FOUND' | 'SNAPSHOT_FAILED' | 'STALE_REVISION';
      cause: string;
    }>;

/** Ports the export use case depends on (E13-AR1/AR2). */
export interface ExportProjectPorts {
  getProject: (id: string) => Project | null;
  isQueueSettled: (id: string) => boolean;
  queueBlockingCause: (id: string) => string | null;
  readPortableSnapshot: (id: string) => Promise<PortableProjectSnapshot>;
  clock: ClockPort;
}

/** Sanitizes a project name into a safe filename base (E13 Task 3). */
export function sanitizePortableFilenameBase(projectName: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug.slice(0, 80) : 'project';
}

/** Produces the canonical `<name>.pmapp.json` filename (indivisible suffix). */
export function portableBackupFilename(projectName: string): string {
  return `${sanitizePortableFilenameBase(projectName)}.pmapp.json`;
}

/**
 * Export the active project to a portable-file envelope.
 *
 * Flow (E13 Task 3):
 * 1. Check queue settlement BEFORE querying.
 * 2. Read one authoritative portable snapshot from the persistence boundary.
 * 3. Serialize schema v2 through the contract serializer.
 * 4. Recheck settlement (the caller re-invokes isQueueSettled after the
 *    async snapshot query returns, so a command beginning during assembly
 *    yields a typed stale outcome and no file).
 */
export async function exportProject(projectId: string, ports: ExportProjectPorts): Promise<ExportResult> {
  // AC1: queue must be settled before any work.
  if (!ports.isQueueSettled(projectId)) {
    const cause = ports.queueBlockingCause(projectId) ?? 'Command queue is not settled';
    return Object.freeze({ ok: false, code: 'QUEUE_NOT_SETTLED' as const, cause });
  }

  const project = ports.getProject(projectId);
  if (project === null) {
    return Object.freeze({ ok: false, code: 'PROJECT_NOT_FOUND' as const, cause: `Project ${projectId} not found` });
  }

  let snapshot: PortableProjectSnapshot;
  try {
    snapshot = await ports.readPortableSnapshot(projectId);
  } catch (err) {
    return Object.freeze({
      ok: false,
      code: 'SNAPSHOT_FAILED' as const,
      cause: err instanceof Error ? err.message : 'Portable snapshot query failed',
    });
  }

  // Recheck settlement after the async snapshot read: a command may have
  // begun during assembly; the snapshot would be stale (E13 Task 3).
  if (!ports.isQueueSettled(projectId)) {
    const cause = ports.queueBlockingCause(projectId) ?? 'Command queue is not settled';
    return Object.freeze({ ok: false, code: 'STALE_REVISION' as const, cause });
  }

  const envelope: PortableFileEnvelope = Object.freeze({
    schemaVersion: PORTABLE_FILE_SCHEMA_VERSION as 10,
    exportedAt: ports.clock.nowISO(),
    project: Object.freeze({
      id: project.id,
      name: snapshot.projectName,
    }),
    phases: snapshot.phases,
    nodes: snapshot.nodes,
    nodeCustomFields: snapshot.nodeCustomFields,
    typeTemplateFields: snapshot.typeTemplateFields,
    unlockEdges: snapshot.unlockEdges,
    findingDismissals: snapshot.findingDismissals,
    affectedReasons: snapshot.affectedReasons,
    openQuestions: snapshot.openQuestions,
    // Story 21.8 AC 4: the v6 envelope carries the forecast plan (with its
    // planningLevel) and any saved scenarios — the snapshot provides them,
    // and dropping them here would make a Theme-level export fail to
    // round-trip on its first member.
    ...(snapshot.forecastPlan ? { forecastPlan: snapshot.forecastPlan } : {}),
    ...(snapshot.forecastScenarios && snapshot.forecastScenarios.length > 0
      ? { forecastScenarios: snapshot.forecastScenarios }
      : {}),
  });

  const json = serializePortableFileEnvelope(envelope);

  return Object.freeze({ ok: true, envelope, json, snapshotRevision: snapshot.projectRevision });
}
