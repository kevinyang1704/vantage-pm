/**
 * Story 16.5 AC4: OOXML / ZIP package oracle for Epic 16 Word exports.
 *
 * Extracts and validates OOXML tags in exported `.docx` archives: valid ZIP,
 * well-formed `word/document.xml`, native headings, shaded callout tables,
 * and stamped metadata. Runs against the real renderer (no webServer).
 */

import { expect, test } from '@playwright/test';
import { renderDocx } from '../../src/adapters/export-worker/document-docx.renderer';
import { projectFeatureOnePager } from '../../src/application/export/project-document';
import { createNode } from '../../src/domain/tree/node.entity';
import { createNodeOpenQuestion } from '../../src/domain/tree/node-question.entity';
import JSZip from 'jszip';

const P = '019ffe00-0000-7000-8000-000000000001';
const R = '019ffe00-0000-7000-8000-000000000010';
const F1 = '019ffe00-0000-7000-8000-000000000020';

test.describe('Story 16.5: Epic 16 DOCX oracle', () => {
  test('validates a Feature 1-Pager archive: ZIP, headings, callout table, metadata', async () => {
    const theme = createNode({ id: R, projectId: P, position: 0n, title: 'Core Engine', nodeType: 'Theme' });
    const feat = createNode({
      id: F1, projectId: P, parentId: R, position: 0n, title: 'SQLite-OPFS Persistence', nodeType: 'Feature',
      bodyText: '## Problem\n\nWe need **durable** local storage.',
      startDate: '2026-01-01', endDate: '2026-01-15', durationDays: 15, scheduleSourceMode: 'start_end',
    });
    const questions = new Map([
      [
        F1,
        [
          createNodeOpenQuestion({
            id: '019ffe00-0000-7000-8000-000000000040',
            projectId: P,
            nodeId: F1,
            questionText: 'Should we ship v1 without sync?',
            status: 'OPEN',
            position: 1n,
            createdAtISO: '2026-08-16T12:00:00Z',
          }),
        ],
      ],
    ]);
    const built = projectFeatureOnePager({
      projectId: P,
      projectRevision: 1,
      projectName: 'Sample',
      featureNodeId: F1,
      nodes: [theme, feat],
      phases: [],
      unlockEdges: [],
      openQuestionsByNode: questions,
      generatedAt: '2026-08-16T12:00:00Z',
      locale: 'en-US',
    });
    if (!('projection' in built)) throw new Error('one-pager projection failed');

    const bytes = await renderDocx(built.projection, { generatedAtISO: '2026-08-16T12:00:00Z' });
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = await zip.file('word/document.xml')?.async('string');
    expect(documentXml).toBeDefined();
    if (!documentXml) return;

    // Native heading hierarchy (Heading1 style reference)
    expect(documentXml).toContain('Heading1');
    // Shaded callout table (amber fill)
    expect(documentXml).toContain('FFF3D6');
    // Stamped metadata
    expect(documentXml).toContain('Generated 2026-08-16T12:00:00Z');
    // Callout question text present
    expect(documentXml).toContain('Should we ship v1 without sync?');
  });
});
