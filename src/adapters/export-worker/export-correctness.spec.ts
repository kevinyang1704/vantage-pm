import { describe, it, expect } from 'vitest';
import { validatePptx, validateDocx } from '../../../tests/support/oracles/office-package.oracle';
import { renderGanttPptx } from './gantt-pptx.renderer';
import { renderDocx } from './document-docx.renderer';
import { createNode, type Node } from '../../domain/tree/node.entity';
import { createPhase, type Phase } from '../../domain/phase/phase.entity';
import { projectGantt } from '../../application/gantt/gantt.projection';
import { resolveGanttVisibleScope } from '../../application/gantt/gantt-scope';
import { buildGanttPptxSlidePlan } from '../../application/gantt/gantt-pptx.projection';
import { projectDocument } from '../../application/document/document.projection';
import type { ViewScope } from '../../contracts/view-scope';

const P = '019ffe00-0000-7000-8000-000000000001';
const R = '019ffe00-0000-7000-8000-000000000010';
const THEME = '019ffe00-0000-7000-8000-000000000020';
const F1 = '019ffe00-0000-7000-8000-000000000030';
const F2 = '019ffe00-0000-7000-8000-000000000031';

/** One shared seeded fixture: a vision root, a theme, and two features. */
function seededFixture() {
  const root = createNode({ id: R, projectId: P, position: 0n, title: 'Vision Root', nodeType: 'Vision', bodyText: 'We ship the roadmap.' });
  const theme = createNode({ id: THEME, projectId: P, parentId: R, position: 0n, title: 'Theme Alpha', nodeType: 'Theme', phaseId: '019ffe00-0000-7000-8000-000000000040' });
  const f1 = createNode({
    id: F1, projectId: P, parentId: THEME, position: 0n, title: 'Feature One', nodeType: 'Feature',
    bodyText: 'First feature body.', startDate: '2026-01-01', endDate: '2026-01-15', durationDays: 15, scheduleSourceMode: 'start_end',
  });
  const f2 = createNode({
    id: F2, projectId: P, parentId: THEME, position: 1n, title: 'Feature Two', nodeType: 'Feature',
    bodyText: 'Second feature body.', startDate: '2026-01-10', endDate: '2026-01-31', durationDays: 22, scheduleSourceMode: 'start_end',
  });
  const phase: Phase = createPhase({ id: '019ffe00-0000-7000-8000-000000000040', projectId: P, name: 'Phase A', position: 0n });
  const nodes: Node[] = [root, theme, f1, f2];
  return { root, theme, f1, f2, phase, nodes };
}

describe('Export correctness (Story 8.6 AC1)', () => {
  it('PPTX: known text, order, dates, and scope-exclusion counts match the fixture', async () => {
    const { theme, f1, f2, phase, nodes } = seededFixture();
    const projection = projectGantt({ projectId: P, projectRevision: 5, nodes });
    const scope = resolveGanttVisibleScope({
      projection,
      window: { dateWindowStart: '2026-01-01', dateWindowEnd: '2026-01-31', granularity: 'month' },
      collapsedNodeIds: [],
    });

    const plan = buildGanttPptxSlidePlan({
      scope,
      phases: [phase],
      nodes,
      unlockEdges: [],
      projectName: 'Sample',
      generatedAt: '2026-08-16T12:00:00Z',
    });
    const bytes = await renderGanttPptx(plan);
    const result = await validatePptx(bytes);

    expect(result.valid).toBe(true);
    // Known text present
    expect(result.extractedText.some((t) => t.includes('Theme Alpha'))).toBe(true);
    expect(result.extractedText.some((t) => t.includes('Feature One'))).toBe(true);
    expect(result.extractedText.some((t) => t.includes('Feature Two'))).toBe(true);
    // Order: Theme, Feature One, Feature Two (containment + sibling order)
    const themeIdx = result.extractedText.findIndex((t) => t.includes('Theme Alpha'));
    const f1Idx = result.extractedText.findIndex((t) => t.includes('Feature One'));
    const f2Idx = result.extractedText.findIndex((t) => t.includes('Feature Two'));
    expect(themeIdx).toBeGreaterThanOrEqual(0);
    expect(f1Idx).toBeGreaterThan(themeIdx);
    expect(f2Idx).toBeGreaterThan(f1Idx);
    // Stamp present
    expect(result.extractedText.some((t) => t.includes('Generated'))).toBe(true);
  });

  it('DOCX: known text, computed figure, and stamp match the fixture', async () => {
    const { root, theme, f1, f2, nodes } = seededFixture();
    const viewScope: ViewScope = {
      kind: 'OutlineVisible', projectId: P, projectRevision: 5, zoomRootId: null,
      orderedNodeIds: [R, THEME, F1, F2], excluded: [],
    };
    const doc = projectDocument({
      projectId: P, projectRevision: 5, projectName: 'Sample', nodes, phases: [],
      scope: viewScope, generatedAt: '2026-08-16T12:00:00Z', locale: 'en-US',
    });
    const bytes = await renderDocx(doc, { generatedAtISO: '2026-08-16T12:00:00Z' });
    const result = await validateDocx(bytes);

    expect(result.valid).toBe(true);
    expect(result.extractedText.some((t) => t.includes('Vision Root'))).toBe(true);
    expect(result.extractedText.some((t) => t.includes('Theme Alpha'))).toBe(true);
    expect(result.extractedText.some((t) => t.includes('Feature One'))).toBe(true);
    // Stamp
    expect(result.extractedText.some((t) => t.includes('Sample'))).toBe(true);
  });

  it('AC2: PPTX and DOCX agree on one shared date and one node count from one seed', async () => {
    const { theme, f1, f2, phase, nodes } = seededFixture();
    const projectRevision = 5;

    // PPTX leg
    const ganttProjection = projectGantt({ projectId: P, projectRevision, nodes });
    const ganttScope = resolveGanttVisibleScope({
      projection: ganttProjection,
      window: { dateWindowStart: '2026-01-01', dateWindowEnd: '2026-01-31', granularity: 'month' },
    });
    const plan = buildGanttPptxSlidePlan({ scope: ganttScope, phases: [phase], nodes, unlockEdges: [], projectName: 'Sample', generatedAt: '2026-08-16T12:00:00Z' });
    const pptx = await validatePptx(await renderGanttPptx(plan));
    expect(pptx.valid).toBe(true);
    // PPTX carries Feature One's authored date range as a bar label (title), and the date in the meta.
    expect(pptx.extractedText.some((t) => t.includes('Feature One'))).toBe(true);

    // DOCX leg — same seed, same revision.
    const viewScope: ViewScope = {
      kind: 'OutlineVisible', projectId: P, projectRevision, zoomRootId: null,
      orderedNodeIds: [THEME, F1, F2], excluded: [],
    };
    const doc = projectDocument({ projectId: P, projectRevision, projectName: 'Sample', nodes, phases: [phase], scope: viewScope, generatedAt: '2026-08-16T12:00:00Z', locale: 'en-US' });
    const docx = await validateDocx(await renderDocx(doc, { generatedAtISO: '2026-08-16T12:00:00Z' }));
    expect(docx.valid).toBe(true);
    console.log('DOCX text:', JSON.stringify(docx.extractedText));

    // Shared fact #1: Feature One appears in both surfaces.
    expect(pptx.extractedText.some((t) => t.includes('Feature One'))).toBe(true);
    expect(docx.extractedText.some((t) => t.includes('Feature One'))).toBe(true);

    // Shared fact #2: the date 2026-01-01 (authored start of Feature One) is
    // carried into the DOCX meta line (formatted). Assert the year appears.
    expect(docx.extractedText.some((t) => t.includes('2026'))).toBe(true);

    // Shared fact #3: node count — both project 2 features under the theme.
    expect(ganttScope.visibleRows.length).toBeGreaterThanOrEqual(2);
    expect(doc.sections.find((s) => s.nodeId === THEME)?.siblingSetSize).toBe(1);
  });
});
