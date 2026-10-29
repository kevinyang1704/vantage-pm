import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validatePptx, validateDocx } from '../../../tests/support/oracles/office-package.oracle';
import { renderGanttPptx } from './gantt-pptx.renderer';
import { renderDocx } from './document-docx.renderer';
import { createNode } from '../../domain/tree/node.entity';
import { createPhase } from '../../domain/phase/phase.entity';
import { projectGantt } from '../../application/gantt/gantt.projection';
import { resolveGanttVisibleScope } from '../../application/gantt/gantt-scope';
import { buildGanttPptxSlidePlan } from '../../application/gantt/gantt-pptx.projection';
import { projectDocument } from '../../application/document/document.projection';
import type { ViewScope } from '../../contracts/view-scope';
import { publishExport, type GeneratedPackage } from '../../application/export/publish-export';
import { saveViaTauriDialog, EXPORT_MIME_TYPES } from '../platform/save-generated-file';

const P = '019ffe00-0000-7000-8000-000000000001';
const R = '019ffe00-0000-7000-8000-000000000010';
const F1 = '019ffe00-0000-7000-8000-000000000020';

describe('Tauri Office Export End-to-End Certification (Epic 12 Story 12.3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('generates PPTX, invokes Tauri save dialog, writes bytes, and validates Office package structure (Story 12.3 AC1/AC2)', async () => {
    const root = createNode({ id: R, projectId: P, position: 0n, title: 'Roadmap Theme', nodeType: 'Theme' });
    const feat = createNode({
      id: F1, projectId: P, parentId: R, position: 0n, title: 'Feature Launch', nodeType: 'Feature',
      startDate: '2026-03-01', endDate: '2026-03-31', durationDays: 31, scheduleSourceMode: 'start_end',
    });
    const nodes = [root, feat];
    const phases = [createPhase({ id: '019ffe00-0000-7000-8000-000000000030', projectId: P, name: 'Q1 Launch', position: 0n })];
    const projection = projectGantt({ projectId: P, projectRevision: 4, nodes });
    const scope = resolveGanttVisibleScope({
      projection,
      window: { dateWindowStart: '2026-03-01', dateWindowEnd: '2026-03-31', granularity: 'month' },
    });
    const plan = buildGanttPptxSlidePlan({
      scope,
      phases,
      nodes,
      unlockEdges: [],
      projectName: 'Q1 Launch Deck',
      generatedAt: '2026-08-24T00:00:00Z',
    });

    const pptxBuffer = await renderGanttPptx(plan);
    expect(pptxBuffer.byteLength).toBeGreaterThan(0);

    // Validate the package structure via oracle before save
    const validation = await validatePptx(pptxBuffer);
    expect(validation.valid).toBe(true);
    expect(validation.isZip).toBe(true);
    expect(validation.packageType).toBe('pptx');
    expect(validation.extractedText).toContain('Roadmap Theme');
    expect(validation.extractedText).toContain('Feature Launch');

    // Simulate Tauri save
    let writtenPath: string | null = null;
    let writtenBytes: number[] = [];
    const mockSave = vi.fn().mockResolvedValue('C:\\Temp\\roadmap.pptx');
    const mockInvoke = vi.fn().mockImplementation((cmd: string, args: { path: string; bytes: number[] }) => {
      if (cmd === 'save_office_export') {
        writtenPath = args.path;
        writtenBytes = args.bytes;
        return Promise.resolve({ saved: true, path: args.path, bytesWritten: args.bytes.length });
      }
      return Promise.reject(new Error(`unknown command ${cmd}`));
    });

    vi.doMock('@tauri-apps/plugin-dialog', () => ({ save: mockSave }));
    vi.doMock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

    const pkg: GeneratedPackage = {
      bytes: new Uint8Array(pptxBuffer),
      filename: 'roadmap.pptx',
      mimeType: EXPORT_MIME_TYPES.pptx,
      sourceProjectRevision: 4,
    };

    const publishResult = await publishExport(pkg, saveViaTauriDialog);
    expect(publishResult.ok).toBe(true);
    if (publishResult.ok) {
      expect(publishResult.savedVia).toBe('TauriSaveDialog');
      expect(publishResult.filename).toBe('roadmap.pptx');
    }
    expect(writtenPath).toBe('C:\\Temp\\roadmap.pptx');
    expect(writtenBytes.length).toBe(pptxBuffer.byteLength);
  });

  it('generates DOCX, invokes Tauri save dialog, writes bytes, and validates Office package structure (Story 12.3 AC1/AC2)', async () => {
    const root = createNode({ id: R, projectId: P, position: 0n, title: 'System Architecture', nodeType: 'Vision', bodyText: 'Overview of system.' });
    const feat = createNode({
      id: F1, projectId: P, parentId: R, position: 0n, title: 'Persistence Subsystem', nodeType: 'Feature',
      bodyText: 'Local SQLite engine.', startDate: '2026-02-01', endDate: '2026-02-28', durationDays: 28, scheduleSourceMode: 'start_end',
    });
    const nodes = [root, feat];
    const viewScope: ViewScope = {
      kind: 'OutlineVisible', projectId: P, projectRevision: 2, zoomRootId: null,
      orderedNodeIds: [R, F1], excluded: [],
    };
    const doc = projectDocument({
      projectId: P, projectRevision: 2, projectName: 'Architecture Spec', nodes, phases: [],
      scope: viewScope, generatedAt: '2026-08-24T00:00:00Z', locale: 'en-US',
    });

    const docxBuffer = await renderDocx(doc, { generatedAtISO: '2026-08-24T00:00:00Z' });
    expect(docxBuffer.byteLength).toBeGreaterThan(0);

    const validation = await validateDocx(docxBuffer);
    expect(validation.valid).toBe(true);
    expect(validation.isZip).toBe(true);
    expect(validation.packageType).toBe('docx');
    expect(validation.extractedText).toContain('System Architecture');
    expect(validation.extractedText).toContain('Persistence Subsystem');

    let writtenBytes: number[] = [];
    const mockSave = vi.fn().mockResolvedValue('C:\\Temp\\spec.docx');
    const mockInvoke = vi.fn().mockImplementation((cmd: string, args: { path: string; bytes: number[] }) => {
      if (cmd === 'save_office_export') {
        writtenBytes = args.bytes;
        return Promise.resolve({ saved: true, path: args.path, bytesWritten: args.bytes.length });
      }
      return Promise.reject(new Error(`unknown command ${cmd}`));
    });

    vi.doMock('@tauri-apps/plugin-dialog', () => ({ save: mockSave }));
    vi.doMock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

    const pkg: GeneratedPackage = {
      bytes: new Uint8Array(docxBuffer),
      filename: 'spec.docx',
      mimeType: EXPORT_MIME_TYPES.docx,
      sourceProjectRevision: 2,
    };

    const publishResult = await publishExport(pkg, saveViaTauriDialog);
    expect(publishResult.ok).toBe(true);
    if (publishResult.ok) {
      expect(publishResult.savedVia).toBe('TauriSaveDialog');
      expect(publishResult.filename).toBe('spec.docx');
    }
    expect(writtenBytes.length).toBe(docxBuffer.byteLength);
  });

  it('handles save cancellation without error states and preserves package for retry (Story 12.3 AC3)', async () => {
    const mockSave = vi.fn().mockResolvedValue(null);
    const mockInvoke = vi.fn();

    vi.doMock('@tauri-apps/plugin-dialog', () => ({ save: mockSave }));
    vi.doMock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

    const sampleBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // ZIP header
    const pkg: GeneratedPackage = {
      bytes: sampleBytes,
      filename: 'test.pptx',
      mimeType: EXPORT_MIME_TYPES.pptx,
      sourceProjectRevision: 5,
    };

    const result = await publishExport(pkg, saveViaTauriDialog);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('SelectionCancelled');
    }
    expect(mockInvoke).not.toHaveBeenCalled();

    // Retry with user choosing path now
    mockSave.mockResolvedValue('C:\\Temp\\test.pptx');
    mockInvoke.mockResolvedValue({ saved: true, path: 'C:\\Temp\\test.pptx', bytesWritten: 4 });

    const retryResult = await publishExport(pkg, saveViaTauriDialog);
    expect(retryResult.ok).toBe(true);
    if (retryResult.ok) {
      expect(retryResult.savedVia).toBe('TauriSaveDialog');
    }
    expect(mockInvoke).toHaveBeenCalledWith('save_office_export', {
      path: 'C:\\Temp\\test.pptx',
      bytes: [0x50, 0x4b, 0x03, 0x04],
    });
  });

  it('handles publication write failure, returns PublicationFailed, and allows successful retry (Story 12.3 AC3)', async () => {
    const mockSave = vi.fn().mockResolvedValue('C:\\Temp\\protected.docx');
    const mockInvoke = vi.fn().mockRejectedValueOnce(new Error('Disk full or write permission denied'));

    vi.doMock('@tauri-apps/plugin-dialog', () => ({ save: mockSave }));
    vi.doMock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

    const sampleBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const pkg: GeneratedPackage = {
      bytes: sampleBytes,
      filename: 'protected.docx',
      mimeType: EXPORT_MIME_TYPES.docx,
      sourceProjectRevision: 1,
    };

    const failedResult = await publishExport(pkg, saveViaTauriDialog);
    expect(failedResult.ok).toBe(false);
    if (!failedResult.ok) {
      expect(failedResult.failure.kind).toBe('PublicationFailed');
      if (failedResult.failure.kind === 'PublicationFailed') {
        expect(failedResult.failure.detail).toContain('Disk full');
      }
    }

    // Subsequent retry with fixed permissions succeeds without regenerating
    mockInvoke.mockResolvedValueOnce({ saved: true, path: 'C:\\Temp\\protected.docx', bytesWritten: 4 });
    const successResult = await publishExport(pkg, saveViaTauriDialog);
    expect(successResult.ok).toBe(true);
  });
});
