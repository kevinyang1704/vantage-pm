import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  exportRequestKey,
  isExportResultCurrent,
  ExportWorkerClient,
  DEFAULT_EXPORT_TIMEOUT_MS,
} from './export-worker.client';
import type { ExportWorkerRequest } from '../../contracts/export-protocol';

class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postedMessages: any[] = [];
  terminated = false;

  postMessage(msg: any) {
    this.postedMessages.push(msg);
  }

  terminate() {
    this.terminated = true;
  }
}

describe('export-worker client (Story 8.3/8.4/8.5 & Epic 12 Story 12.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a stable request key', () => {
    expect(exportRequestKey('p1', 3, 'pptx')).toBe('p1:pptx:3');
    expect(exportRequestKey('p1', 3, 'pptx')).toBe(exportRequestKey('p1', 3, 'pptx'));
  });

  it('accepts a current result and discards a stale one', () => {
    const current = { projectId: 'p1', projectRevision: 3, format: 'pptx' };
    const stale = { projectId: 'p1', projectRevision: 2, format: 'pptx' };

    expect(isExportResultCurrent('p1:pptx:3', current)).toBe(true);
    expect(isExportResultCurrent('p1:pptx:3', stale)).toBe(false);
  });

  it('discards a stale result and delivers the current one', () => {
    const latest = 'p1:pptx:3';
    const staleResp = { projectId: 'p1', projectRevision: 2, format: 'pptx' };
    const currentResp = { projectId: 'p1', projectRevision: 3, format: 'pptx' };

    // The pure filter is the mechanism by which the client discards stale results.
    expect(isExportResultCurrent(latest, staleResp)).toBe(false);
    expect(isExportResultCurrent(latest, currentResp)).toBe(true);
  });

  it('rejects and terminates worker when worker emits onerror (Story 12.2 AC2)', async () => {
    let fakeWorkerInstance: FakeWorker | null = null;
    const client = new ExportWorkerClient({
      workerFactory: () => {
        fakeWorkerInstance = new FakeWorker();
        return fakeWorkerInstance as unknown as Worker;
      },
    });

    const sampleReq: ExportWorkerRequest = {
      type: 'ExportDocx',
      requestId: 'req-1',
      format: 'docx',
      projectId: 'p1',
      projectRevision: 1,
      filename: 'sample.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      projection: {
        projectId: 'p1',
        projectRevision: 1,
        projectName: 'Sample',
        generatedAt: '2026-08-24T00:00:00Z',
        locale: 'en-US',
        sections: [],
        exclusions: {
          totalProjectNodes: 0,
          includedNodeCount: 0,
          undatedCount: 0,
          collapsedCount: 0,
          outOfWindowCount: 0,
        },
        style: {
          headingFontFamily: 'Calibri',
          bodyFontFamily: 'Calibri',
          baseFontSizePt: 11,
          headingLevelFontSizesPt: { 1: 20, 2: 16, 3: 14, 4: 12, 5: 11, 6: 11 },
        },
      },
    };

    const promise = client.request(sampleReq);
    expect(fakeWorkerInstance).not.toBeNull();

    // Trigger error on the worker
    fakeWorkerInstance!.onerror?.({ message: 'Out of memory during export' } as ErrorEvent);

    await expect(promise).rejects.toThrow('Out of memory during export');
    expect(fakeWorkerInstance!.terminated).toBe(true);
  });

  it('rejects and terminates worker on messageerror (Story 12.2 AC2)', async () => {
    let fakeWorkerInstance: FakeWorker | null = null;
    const client = new ExportWorkerClient({
      workerFactory: () => {
        fakeWorkerInstance = new FakeWorker();
        return fakeWorkerInstance as unknown as Worker;
      },
    });

    const sampleReq: ExportWorkerRequest = {
      type: 'ExportDocx',
      requestId: 'req-2',
      format: 'docx',
      projectId: 'p1',
      projectRevision: 1,
      filename: 'sample.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      projection: {
        projectId: 'p1',
        projectRevision: 1,
        projectName: 'Sample',
        generatedAt: '2026-08-24T00:00:00Z',
        locale: 'en-US',
        sections: [],
        exclusions: {
          totalProjectNodes: 0,
          includedNodeCount: 0,
          undatedCount: 0,
          collapsedCount: 0,
          outOfWindowCount: 0,
        },
        style: {
          headingFontFamily: 'Calibri',
          bodyFontFamily: 'Calibri',
          baseFontSizePt: 11,
          headingLevelFontSizesPt: { 1: 20, 2: 16, 3: 14, 4: 12, 5: 11, 6: 11 },
        },
      },
    };

    const promise = client.request(sampleReq);
    fakeWorkerInstance!.onmessageerror?.();

    await expect(promise).rejects.toThrow('Export worker failed to deserialize message payload.');
    expect(fakeWorkerInstance!.terminated).toBe(true);
  });

  it('rejects with bounded timeout and terminates worker when timeout expires (Story 12.2 AC3)', async () => {
    let fakeWorkerInstance: FakeWorker | null = null;
    const client = new ExportWorkerClient({
      timeoutMs: 5000,
      workerFactory: () => {
        fakeWorkerInstance = new FakeWorker();
        return fakeWorkerInstance as unknown as Worker;
      },
    });

    const sampleReq: ExportWorkerRequest = {
      type: 'ExportDocx',
      requestId: 'req-3',
      format: 'docx',
      projectId: 'p1',
      projectRevision: 1,
      filename: 'sample.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      projection: {
        projectId: 'p1',
        projectRevision: 1,
        projectName: 'Sample',
        generatedAt: '2026-08-24T00:00:00Z',
        locale: 'en-US',
        sections: [],
        exclusions: {
          totalProjectNodes: 0,
          includedNodeCount: 0,
          undatedCount: 0,
          collapsedCount: 0,
          outOfWindowCount: 0,
        },
        style: {
          headingFontFamily: 'Calibri',
          bodyFontFamily: 'Calibri',
          baseFontSizePt: 11,
          headingLevelFontSizesPt: { 1: 20, 2: 16, 3: 14, 4: 12, 5: 11, 6: 11 },
        },
      },
    };

    const promise = client.request(sampleReq);

    // Advance time past 5000ms
    vi.advanceTimersByTime(5001);

    await expect(promise).rejects.toThrow('Export generation timed out after 5000ms.');
    expect(fakeWorkerInstance!.terminated).toBe(true);
  });

  it('allows subsequent request to instantiate a fresh worker after termination (Story 12.2 AC3)', async () => {
    let workerCount = 0;
    const workers: FakeWorker[] = [];
    const client = new ExportWorkerClient({
      timeoutMs: 1000,
      workerFactory: () => {
        const fw = new FakeWorker();
        workers.push(fw);
        workerCount++;
        return fw as unknown as Worker;
      },
    });

    const sampleProjection = {
      projectId: 'p1',
      projectRevision: 1,
      projectName: 'Sample',
      generatedAt: '2026-08-24T00:00:00Z',
      locale: 'en-US',
      sections: [],
      exclusions: {
        totalProjectNodes: 0,
        includedNodeCount: 0,
        undatedCount: 0,
        collapsedCount: 0,
        outOfWindowCount: 0,
      },
      style: {
        headingFontFamily: 'Calibri',
        bodyFontFamily: 'Calibri',
        baseFontSizePt: 11,
        headingLevelFontSizesPt: { 1: 20, 2: 16, 3: 14, 4: 12, 5: 11, 6: 11 },
      },
    };

    const sampleReq1: ExportWorkerRequest = {
      type: 'ExportDocx',
      requestId: 'req-1',
      format: 'docx',
      projectId: 'p1',
      projectRevision: 1,
      filename: 'sample.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      projection: sampleProjection,
    };

    const p1 = client.request(sampleReq1);
    vi.advanceTimersByTime(1001);
    await expect(p1).rejects.toThrow('timed out');
    expect(workers[0].terminated).toBe(true);

    // Next request creates a new worker
    const sampleReq2: ExportWorkerRequest = {
      type: 'ExportDocx',
      requestId: 'req-2',
      format: 'docx',
      projectId: 'p1',
      projectRevision: 2,
      filename: 'sample.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      projection: { ...sampleProjection, projectRevision: 2 },
    };

    const p2 = client.request(sampleReq2);
    expect(workers.length).toBe(2);
    expect(workers[1].terminated).toBe(false);

    // Fulfill p2 normally
    workers[1].onmessage?.({
      data: {
        type: 'ExportDocxResult',
        requestId: 'req-2',
        format: 'docx',
        projectId: 'p1',
        projectRevision: 2,
        bytes: new ArrayBuffer(8),
      },
    } as MessageEvent);

    const result = await p2;
    expect(result.type).toBe('ExportDocxResult');
  });

  it('rejects with reason when ExportWorkerFailed message is returned', async () => {
    let fakeWorkerInstance: FakeWorker | null = null;
    const client = new ExportWorkerClient({
      workerFactory: () => {
        fakeWorkerInstance = new FakeWorker();
        return fakeWorkerInstance as unknown as Worker;
      },
    });

    const sampleReq: ExportWorkerRequest = {
      type: 'ExportDocx',
      requestId: 'req-4',
      format: 'docx',
      projectId: 'p1',
      projectRevision: 1,
      filename: 'sample.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      projection: {
        projectId: 'p1',
        projectRevision: 1,
        projectName: 'Sample',
        generatedAt: '2026-08-24T00:00:00Z',
        locale: 'en-US',
        sections: [],
        exclusions: {
          totalProjectNodes: 0,
          includedNodeCount: 0,
          undatedCount: 0,
          collapsedCount: 0,
          outOfWindowCount: 0,
        },
        style: {
          headingFontFamily: 'Calibri',
          bodyFontFamily: 'Calibri',
          baseFontSizePt: 11,
          headingLevelFontSizesPt: { 1: 20, 2: 16, 3: 14, 4: 12, 5: 11, 6: 11 },
        },
      },
    };

    const promise = client.request(sampleReq);
    fakeWorkerInstance!.onmessage?.({
      data: {
        type: 'ExportWorkerFailed',
        requestId: 'req-4',
        format: 'docx',
        projectId: 'p1',
        projectRevision: 1,
        reason: 'Invalid document structure',
      },
    } as MessageEvent);

    await expect(promise).rejects.toThrow('Invalid document structure');
  });
});

