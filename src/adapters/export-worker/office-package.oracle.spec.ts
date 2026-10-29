import { describe, it, expect } from 'vitest';
import { validatePptx, validateDocx } from '../../../tests/support/oracles/office-package.oracle';
import { renderGanttPptx } from './gantt-pptx.renderer';
import { renderDocx } from './document-docx.renderer';
import { createNode } from '../../domain/tree/node.entity';
import { createNodeOpenQuestion } from '../../domain/tree/node-question.entity';
import { createPhase, type Phase } from '../../domain/phase/phase.entity';
import { projectGantt } from '../../application/gantt/gantt.projection';
import { resolveGanttVisibleScope } from '../../application/gantt/gantt-scope';
import { buildGanttPptxSlidePlan } from '../../application/gantt/gantt-pptx.projection';
import { projectDocument } from '../../application/document/document.projection';
import { projectFeatureOnePager } from '../../application/export/project-document';
import type { ViewScope } from '../../contracts/view-scope';

const P = '019ffe00-0000-7000-8000-000000000001';
const R = '019ffe00-0000-7000-8000-000000000010';
const F1 = '019ffe00-0000-7000-8000-000000000020';
const F2 = '019ffe00-0000-7000-8000-000000000021';

async function buildPptxBytes(): Promise<ArrayBuffer> {
  const root = createNode({ id: R, projectId: P, position: 0n, title: 'Theme', nodeType: 'Theme' });
  const feat1 = createNode({
    id: F1, projectId: P, parentId: R, position: 0n, title: 'Feature One', nodeType: 'Feature',
    startDate: '2026-01-01', endDate: '2026-01-15', durationDays: 15, scheduleSourceMode: 'start_end',
  });
  const feat2 = createNode({
    id: F2, projectId: P, parentId: R, position: 1n, title: 'Feature Two', nodeType: 'Feature',
    startDate: '2026-01-10', endDate: '2026-01-31', durationDays: 22, scheduleSourceMode: 'start_end',
  });
  const nodes = [root, feat1, feat2];
  const phases: Phase[] = [createPhase({ id: '019ffe00-0000-7000-8000-000000000030', projectId: P, name: 'Phase A', position: 0n })];
  const projection = projectGantt({ projectId: P, projectRevision: 1, nodes });
  const scope = resolveGanttVisibleScope({
    projection,
    window: { dateWindowStart: '2026-01-01', dateWindowEnd: '2026-01-31', granularity: 'month' },
  });
  const plan = buildGanttPptxSlidePlan({ scope, phases, nodes, unlockEdges: [], projectName: 'Sample', generatedAt: '2026-08-16T12:00:00Z' });
  return renderGanttPptx(plan);
}

async function buildDocxBytes(): Promise<ArrayBuffer> {
  const root = createNode({ id: R, projectId: P, position: 0n, title: 'Vision Root', nodeType: 'Vision', bodyText: 'Body text.' });
  const feat = createNode({
    id: F1, projectId: P, parentId: R, position: 0n, title: 'Feature Alpha', nodeType: 'Feature',
    bodyText: 'Feature body.', startDate: '2026-01-01', endDate: '2026-01-15', durationDays: 15, scheduleSourceMode: 'start_end',
  });
  const nodes = [root, feat];
  const viewScope: ViewScope = {
    kind: 'OutlineVisible', projectId: P, projectRevision: 1, zoomRootId: null,
    orderedNodeIds: [R, F1], excluded: [],
  };
  const doc = projectDocument({
    projectId: P, projectRevision: 1, projectName: 'Sample', nodes, phases: [],
    scope: viewScope, generatedAt: '2026-08-16T12:00:00Z', locale: 'en-US',
  });
  return renderDocx(doc, { generatedAtISO: '2026-08-16T12:00:00Z' });
}

describe('office-package oracle (Story 8.6)', () => {
  it('validates a real PPTX and extracts known text', async () => {
    const bytes = await buildPptxBytes();
    const result = await validatePptx(bytes);
    expect(result.valid).toBe(true);
    expect(result.isZip).toBe(true);
    expect(result.packageType).toBe('pptx');
    expect(result.missingParts.length).toBe(0);
    expect(result.foundParts).toContain('[Content_Types].xml');
    expect(result.foundParts).toContain('ppt/presentation.xml');
    // Known fixture title text present
    expect(result.extractedText.some((t) => t.includes('Feature One'))).toBe(true);
  });

  it('validates a real DOCX and extracts known text', async () => {
    const bytes = await buildDocxBytes();
    const result = await validateDocx(bytes);
    expect(result.valid).toBe(true);
    expect(result.isZip).toBe(true);
    expect(result.packageType).toBe('docx');
    expect(result.missingParts.length).toBe(0);
    expect(result.foundParts).toContain('word/document.xml');
    expect(result.extractedText.some((t) => t.includes('Vision Root'))).toBe(true);
  });

  it('fails for a non-ZIP buffer', async () => {
    const result = await validatePptx(new Uint8Array([1, 2, 3]).buffer as ArrayBuffer);
    expect(result.valid).toBe(false);
    expect(result.isZip).toBe(false);
  });

  it('validates a Feature 1-Pager DOCX with callout and markdown body (Story 16.4)', async () => {
    const theme = createNode({ id: R, projectId: P, position: 0n, title: 'Core Engine', nodeType: 'Theme' });
    const feat = createNode({
      id: F1, projectId: P, parentId: R, position: 0n, title: 'SQLite-OPFS Persistence', nodeType: 'Feature',
      bodyText: '## Problem\n\nWe need **durable** local storage.\n\n- Option A\n- Option B',
      startDate: '2026-01-01', endDate: '2026-01-15', durationDays: 15, scheduleSourceMode: 'start_end',
    });
    const nodes = [theme, feat];
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
      nodes,
      phases: [],
      unlockEdges: [],
      openQuestionsByNode: questions,
      generatedAt: '2026-08-16T12:00:00Z',
      locale: 'en-US',
    });
    if (!('projection' in built)) throw new Error('one-pager projection failed');
    const bytes = await renderDocx(built.projection, { generatedAtISO: '2026-08-16T12:00:00Z' });

    const result = await validateDocx(bytes);
    expect(result.valid).toBe(true);
    expect(result.isZip).toBe(true);
    expect(result.packageType).toBe('docx');
    expect(result.missingParts.length).toBe(0);
    expect(result.foundParts).toContain('word/document.xml');
    // Executive header + callout question + markdown body all present.
    expect(result.extractedText.some((t) => t.includes('SQLite-OPFS Persistence'))).toBe(true);
    expect(result.extractedText.some((t) => t.includes('Should we ship v1 without sync?'))).toBe(true);
    expect(result.extractedText.some((t) => t.includes('durable'))).toBe(true);
  });
});
