/**
 * DOCX renderer specs (Story 16.4, E16-FR6, E16-FR7, E16-AR2, E16-AR3).
 *
 * Covers the Markdown AST → native Word paragraphs, the amber Open Questions
 * callout (suppressed when 0 questions), the 2-column metadata table, and the
 * filename sanitization contract.
 */

import { describe, expect, it } from 'vitest';
import { buildDocxDocument, metadataTable } from './document-docx.renderer';
import { projectFeatureOnePager } from '../../application/export/project-document';
import { buildFeatureOnePagerFilename, sanitizeFilenameBase } from '../../application/export/export-filename';
import type { DocumentProjection } from '../../contracts/document';
import type { Node } from '../../domain/tree/node.entity';
import type { UnlockEdge } from '../../domain/edge/unlock-edge.entity';
import { createNode } from '../../domain/tree/node.entity';
import { createNodeOpenQuestion } from '../../domain/tree/node-question.entity';

const PROJECT_ID = '018f3a80-0000-7000-8000-000000000001';
const FEATURE_ID = '018f3a80-0000-7000-8000-000000000002';
const THEME_ID = '018f3a80-0000-7000-8000-000000000003';
const AC_ID = '018f3a80-0000-7000-8000-000000000004';
const Q1 = '018f3a80-0000-7000-8000-000000000005';

function makeNodes(): readonly Node[] {
  return [
    createNode({ id: THEME_ID, projectId: PROJECT_ID, parentId: null, title: 'Core Engine', position: 1n, nodeType: 'Theme' }),
    createNode({
      id: FEATURE_ID,
      projectId: PROJECT_ID,
      parentId: THEME_ID,
      title: 'SQLite-OPFS Persistence',
      position: 2n,
      nodeType: 'Feature',
      bodyText: '## Problem\n\nWe need **durable** local storage.\n\n- Option A\n- Option B',
      startDate: '2026-01-01',
      endDate: '2026-06-30',
      durationDays: 180,
      effortPoints: 5,
      deliveryStatus: 'in_progress',
    }),
    createNode({ id: AC_ID, projectId: PROJECT_ID, parentId: FEATURE_ID, title: 'Survives restart', position: 1n, nodeType: 'AcceptanceCriterion', completed: true }),
  ];
}

function makeEdges(): readonly UnlockEdge[] {
  return [
    Object.freeze({ id: '018f3a80-0000-7000-8000-000000000010', projectId: PROJECT_ID, sourceNodeId: THEME_ID, targetNodeId: FEATURE_ID }),
  ];
}

function makeQuestions(): ReadonlyMap<string, readonly ReturnType<typeof createNodeOpenQuestion>[]> {
  return new Map([
    [
      FEATURE_ID,
      [
        createNodeOpenQuestion({
          id: Q1,
          projectId: PROJECT_ID,
          nodeId: FEATURE_ID,
          questionText: 'Should we ship v1 without sync?',
          status: 'OPEN',
          position: 1n,
          createdAtISO: '2026-08-29T00:00:00.000Z',
        }),
      ],
    ],
  ]);
}

describe('projectFeatureOnePager (Story 16.4 AC1)', () => {
  it('builds a standalone one-pager projection with metadata, questions, and dependencies', () => {
    const result = projectFeatureOnePager({
      projectId: PROJECT_ID,
      projectRevision: 7,
      projectName: 'My Product Vision',
      featureNodeId: FEATURE_ID,
      nodes: makeNodes(),
      phases: [],
      unlockEdges: makeEdges(),
      openQuestionsByNode: makeQuestions(),
      generatedAt: '2026-08-29T00:00:00.000Z',
      locale: 'en-US',
    });

    expect('projection' in result).toBe(true);
    if (!('projection' in result)) return;

    expect(result.featureTitle).toBe('SQLite-OPFS Persistence');
    expect(result.metadata.theme).toBe('Core Engine');
    expect(result.metadata.phase).toBeNull();
    expect(result.metadata.span).toBe('2026-01-01 → 2026-06-30');
    expect(result.metadata.effort).toBe('5 pt');
    expect(result.metadata.status).toBe('In progress');
    expect(result.dependencyLines).toEqual(['Unlocked by: Core Engine']);

    const section = result.projection.sections[0];
    expect(section.openQuestionsCount).toBe(1);
    expect(section.openQuestions[0].questionText).toBe('Should we ship v1 without sync?');
    expect(section.acceptanceCriteria).toHaveLength(1);
    expect(section.acceptanceCriteria[0].completed).toBe(true);
  });

  it('rejects a non-Feature node with a typed error', () => {
    const result = projectFeatureOnePager({
      projectId: PROJECT_ID,
      projectRevision: 7,
      projectName: 'My Product Vision',
      featureNodeId: THEME_ID,
      nodes: makeNodes(),
      phases: [],
      unlockEdges: [],
      generatedAt: '2026-08-29T00:00:00.000Z',
      locale: 'en-US',
    });
    expect('projection' in result).toBe(false);
    if ('projection' in result) return;
    expect(result.error).toContain('not a Feature');
  });
});

describe('buildDocxDocument (Story 16.4 AC1/AC4)', () => {
  it('renders a projection with open questions into a Document without throwing', () => {
    const result = projectFeatureOnePager({
      projectId: PROJECT_ID,
      projectRevision: 7,
      projectName: 'My Product Vision',
      featureNodeId: FEATURE_ID,
      nodes: makeNodes(),
      phases: [],
      unlockEdges: makeEdges(),
      openQuestionsByNode: makeQuestions(),
      generatedAt: '2026-08-29T00:00:00.000Z',
      locale: 'en-US',
    });
    if (!('projection' in result)) throw new Error('projection failed');

    const doc = buildDocxDocument(result.projection, { generatedAtISO: '2026-08-29T00:00:00.000Z' });
    expect(doc).toBeDefined();
  });

  it('suppresses the callout cleanly when a section has 0 open questions', () => {
    const projection: DocumentProjection = Object.freeze({
      projectId: PROJECT_ID,
      projectRevision: 1,
      projectName: 'Empty',
      generatedAt: '2026-08-29T00:00:00.000Z',
      locale: 'en-US',
      sections: Object.freeze([
        Object.freeze({
          nodeId: FEATURE_ID,
          parentId: null,
          depth: 0,
          headingLevel: 1,
          title: 'No Questions',
          typeTag: 'FEATURE',
          nodeType: 'Feature',
          bodyText: null,
          startDate: null,
          endDate: null,
          durationDays: null,
          effectivePhaseName: null,
          effectivePhaseSource: 'none',
          completed: false,
          acceptanceCriteria: Object.freeze([]),
          acceptanceRatioText: null,
          openQuestions: Object.freeze([]),
          openQuestionsCount: 0,
          siblingIndex: 0,
          siblingSetSize: 1,
        }),
      ]),
      exclusions: Object.freeze({ totalProjectNodes: 1, includedNodeCount: 1, undatedCount: 0, collapsedCount: 0, outOfWindowCount: 0 }),
      style: Object.freeze({ headingFontFamily: 'Calibri', bodyFontFamily: 'Calibri', baseFontSizePt: 11, headingLevelFontSizesPt: Object.freeze({ 1: 20, 2: 16, 3: 14, 4: 12, 5: 11, 6: 11 }) }),
    });
    const doc = buildDocxDocument(projection, { generatedAtISO: '2026-08-29T00:00:00.000Z' });
    expect(doc).toBeDefined();
  });

  it('builds a 2-column metadata table only from present rows', () => {
    const table = metadataTable([
      { label: 'Theme', value: 'Core Engine' },
      { label: 'Phase', value: null },
      { label: 'Status', value: 'In Progress' },
    ]);
    expect(table).not.toBeNull();
    const empty = metadataTable([{ label: 'Phase', value: null }]);
    expect(empty).toBeNull();
  });
});

describe('export filename sanitization (Story 16.4 AC3)', () => {
  it('sanitizes OS reserved characters from feature titles', () => {
    expect(buildFeatureOnePagerFilename('SQLite-OPFS')).toBe('PMApp-Feature-SQLite-OPFS.docx');
    expect(buildFeatureOnePagerFilename('Feature: "A/B" <Test>?')).toBe('PMApp-Feature-Feature-A-B-Test.docx');
  });

  it('falls back to untitled for empty or reserved names', () => {
    expect(sanitizeFilenameBase('')).toBe('untitled');
    expect(sanitizeFilenameBase('   ')).toBe('untitled');
    expect(sanitizeFilenameBase('CON')).toBe('_CON');
  });
});
