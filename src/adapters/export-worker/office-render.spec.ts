import { describe, it, expect } from 'vitest';
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
const F1 = '019ffe00-0000-7000-8000-000000000020';

describe('Office renderers (Story 8.3/8.4 structural smoke tests)', () => {
  it('renders a structurally valid PPTX (ZIP magic bytes)', async () => {
    const root = createNode({ id: R, projectId: P, position: 0n, title: 'Theme', nodeType: 'Theme' });
    const feat = createNode({
      id: F1, projectId: P, parentId: R, position: 0n, title: 'Feature One', nodeType: 'Feature',
      startDate: '2026-01-01', endDate: '2026-01-15', durationDays: 15, scheduleSourceMode: 'start_end',
    });
    const nodes: Node[] = [root, feat];
    const phases: Phase[] = [];
    const projection = projectGantt({ projectId: P, projectRevision: 1, nodes });
    const scope = resolveGanttVisibleScope({
      projection,
      window: { dateWindowStart: '2026-01-01', dateWindowEnd: '2026-01-31', granularity: 'month' },
    });
    const plan = buildGanttPptxSlidePlan({
      scope,
      phases,
      nodes,
      unlockEdges: [],
      projectName: 'Sample',
      generatedAt: '2026-08-16T12:00:00Z',
    });

    const bytes = await renderGanttPptx(plan);
    expect(bytes.byteLength).toBeGreaterThan(0);
    const view = new Uint8Array(bytes);
    // ZIP local-file-header magic: PK\x03\x04
    expect(view[0]).toBe(0x50);
    expect(view[1]).toBe(0x4B);
    expect(view[2]).toBe(0x03);
    expect(view[3]).toBe(0x04);
  });

  it('renders a structurally valid DOCX (ZIP magic bytes)', async () => {
    const root = createNode({ id: R, projectId: P, position: 0n, title: 'Vision', nodeType: 'Vision', bodyText: 'Body.' });
    const nodes: Node[] = [root];
    const viewScope: ViewScope = {
      kind: 'OutlineVisible',
      projectId: P,
      projectRevision: 1,
      zoomRootId: null,
      orderedNodeIds: [R],
      excluded: [],
    };
    const doc = projectDocument({
      projectId: P,
      projectRevision: 1,
      projectName: 'Sample',
      nodes,
      phases: [],
      scope: viewScope,
      generatedAt: '2026-08-16T12:00:00Z',
      locale: 'en-US',
    });

    const bytes = await renderDocx(doc, { generatedAtISO: '2026-08-16T12:00:00Z' });
    expect(bytes.byteLength).toBeGreaterThan(0);
    const view = new Uint8Array(bytes);
    expect(view[0]).toBe(0x50);
    expect(view[1]).toBe(0x4B);
    expect(view[2]).toBe(0x03);
    expect(view[3]).toBe(0x04);
  });
});
