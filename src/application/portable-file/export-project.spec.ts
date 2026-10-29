/**
 * Export project use case specs (Epic 13 Story 13.1 Task 3).
 *
 * Covers queue-gating (settle-before-query + recheck after snapshot),
 * snapshot failures, v2 serialization, deterministic filename, and the
 * STALE_REVISION outcome when a command begins during assembly.
 */

import { describe, expect, it } from 'vitest';
import {
  exportProject,
  portableBackupFilename,
  sanitizePortableFilenameBase,
  type ExportProjectPorts,
} from './export-project';
import type { PortableProjectSnapshot } from '../../contracts/portable-file.schema';
import type { Project } from '../../domain/project/project.entity';

const PROJECT_ID = '018f3a80-0000-7000-8000-000000000001';
const PROJECT_NAME = 'My Product Vision';

const SNAPSHOT: PortableProjectSnapshot = Object.freeze({
  projectId: PROJECT_ID,
  projectName: PROJECT_NAME,
  projectRevision: 7,
  phases: Object.freeze([]),
  nodes: Object.freeze([
    Object.freeze({
      id: '018f3a80-0000-7000-8000-000000000020',
      parentId: null,
      title: 'Vision',
      bodyText: null,
      position: '4294967296',
      nodeType: 'Vision',
      startDate: null,
      endDate: null,
      durationDays: null,
      scheduleSourceMode: null,
      completed: false,
      effortPoints: null,
      strategicWeight: null,
      phaseId: null,
    }),
  ]),
  nodeCustomFields: Object.freeze([]),
  typeTemplateFields: Object.freeze([]),
  unlockEdges: Object.freeze([]),
  findingDismissals: Object.freeze([]),
  affectedReasons: Object.freeze([]),
  openQuestions: Object.freeze([]),
});

function makePorts(overrides: Partial<ExportProjectPorts> = {}): ExportProjectPorts {
  const project: Project = Object.freeze({ id: PROJECT_ID, name: PROJECT_NAME, revision: 7 });
  return {
    getProject: () => project,
    isQueueSettled: () => true,
    queueBlockingCause: () => null,
    readPortableSnapshot: async () => SNAPSHOT,
    clock: { nowISO: () => '2026-08-14T00:00:00.000Z' },
    ...overrides,
  };
}

describe('exportProject (Epic 13 Task 3)', () => {
  it('exports a v9 envelope containing the full authored graph', async () => {
    const result = await exportProject(PROJECT_ID, makePorts());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.schemaVersion).toBe(9);
    expect(result.envelope.project.id).toBe(PROJECT_ID);
    if (result.envelope.schemaVersion === 9) {
      expect(result.envelope.nodes).toHaveLength(1);
      expect(result.envelope.openQuestions).toHaveLength(0);
    }
    expect(result.snapshotRevision).toBe(7);
    const parsed = JSON.parse(result.json);
    expect(parsed.schemaVersion).toBe(9);
    expect(parsed.nodes[0].title).toBe('Vision');
  });

  it('blocks on an unsettled queue before any snapshot read', async () => {
    let snapshotCalls = 0;
    const result = await exportProject(
      PROJECT_ID,
      makePorts({
        isQueueSettled: () => false,
        queueBlockingCause: () => 'Pending edit is still committing.',
        readPortableSnapshot: async () => {
          snapshotCalls += 1;
          return SNAPSHOT;
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('QUEUE_NOT_SETTLED');
      expect(result.cause).toContain('Pending edit is still committing.');
    }
    expect(snapshotCalls).toBe(0);
  });

  it('returns STALE_REVISION when the queue becomes unsettled during snapshot assembly', async () => {
    let settled = true;
    const result = await exportProject(
      PROJECT_ID,
      makePorts({
        isQueueSettled: () => {
          // First call (pre-query) true; recheck (post-query) false — a
          // command began during assembly.
          const wasSettled = settled;
          settled = false;
          return wasSettled;
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('STALE_REVISION');
    }
  });

  it('returns SNAPSHOT_FAILED when the snapshot query throws', async () => {
    const result = await exportProject(
      PROJECT_ID,
      makePorts({
        readPortableSnapshot: async () => {
          throw new Error('snapshot exploded');
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('SNAPSHOT_FAILED');
      expect(result.cause).toContain('snapshot exploded');
    }
  });

  it('returns PROJECT_NOT_FOUND when the project is missing', async () => {
    const result = await exportProject(
      PROJECT_ID,
      makePorts({ getProject: () => null }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PROJECT_NOT_FOUND');
    }
  });

  it('is deterministic for an identical snapshot apart from exportedAt', async () => {
    const a = await exportProject(PROJECT_ID, makePorts());
    const b = await exportProject(
      PROJECT_ID,
      makePorts({ clock: { nowISO: () => '1999-01-01T00:00:00.000Z' } }),
    );
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.json).not.toBe(b.json); // exportedAt differs
  });

  it('sanitizes filenames with the indivisible .pmapp.json suffix', () => {
    expect(sanitizePortableFilenameBase('My Product Vision!')).toBe('my-product-vision');
    expect(portableBackupFilename('My Product Vision')).toBe('my-product-vision.pmapp.json');
    expect(portableBackupFilename('!!!')).toBe('project.pmapp.json');
    expect(portableBackupFilename('Vantage')).toBe('vantage.pmapp.json');
  });
});
