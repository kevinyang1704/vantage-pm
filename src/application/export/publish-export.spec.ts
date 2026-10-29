import { describe, it, expect } from 'vitest';
import { publishExport, checkExportScopeFresh, type GeneratedPackage } from './publish-export';
import type { PublishResult, ExportFailure } from '../../contracts/export-publish';

describe('publishExport (Story 8.5 Task 8)', () => {
  const pkg: GeneratedPackage = Object.freeze({
    bytes: new Uint8Array([1, 2, 3]),
    filename: 'plan.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    sourceProjectRevision: 3,
  });

  it('publishes the package via the injected saveFile port', async () => {
    const calls: { bytes: Uint8Array; filename: string; mimeType: string }[] = [];
    const saveFile = async (bytes: Uint8Array, filename: string, mimeType: string): Promise<PublishResult> => {
      calls.push({ bytes, filename, mimeType });
      return Object.freeze({ ok: true, filename, savedVia: 'DownloadFallback' });
    };

    const result = await publishExport(pkg, saveFile);
    expect(result.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].bytes).toBe(pkg.bytes); // identical bytes, no regeneration
    expect(calls[0].filename).toBe('plan.pptx');
  });

  it('retry passes the same package with no regeneration', async () => {
    const seen: Uint8Array[] = [];
    let failFirst = true;
    const saveFile = async (bytes: Uint8Array): Promise<PublishResult> => {
      seen.push(bytes);
      if (failFirst) {
        failFirst = false;
        const failure: ExportFailure = { kind: 'PublicationFailed', detail: 'transient' };
        return Object.freeze({ ok: false, failure });
      }
      return Object.freeze({ ok: true, filename: pkg.filename, savedVia: 'DownloadFallback' });
    };

    const first = await publishExport(pkg, saveFile);
    expect(first.ok).toBe(false);
    const retry = await publishExport(pkg, saveFile);
    expect(retry.ok).toBe(true);
    // Same bytes object both times — republish, never regenerate.
    expect(seen[0]).toBe(seen[1]);
  });

  it('detects stale scope before any worker call', () => {
    const stale = checkExportScopeFresh(2, 5);
    expect(stale).not.toBeNull();
    expect(stale!.ok).toBe(false);
    if (!stale!.ok) {
      expect(stale!.failure.kind).toBe('ScopeStale');
      if (stale!.failure.kind === 'ScopeStale') {
        expect(stale!.failure.staleProjectRevision).toBe(2);
        expect(stale!.failure.currentProjectRevision).toBe(5);
      }
    }
  });

  it('returns null (proceed) when revisions match', () => {
    expect(checkExportScopeFresh(3, 3)).toBeNull();
  });
});
