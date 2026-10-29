import { describe, it, expect } from 'vitest';
import { formatExportFailure } from './export-feedback';

describe('formatExportFailure (Story 8.5 Task 7)', () => {
  it('maps ScopeStale with both revisions', () => {
    const fb = formatExportFailure({ kind: 'ScopeStale', staleProjectRevision: 2, currentProjectRevision: 5 });
    expect(fb.cause).toContain('2');
    expect(fb.cause).toContain('5');
    expect(fb.resultingState.toLowerCase()).toContain('no file was generated');
  });

  it('maps GenerationFailed interpolating the detail', () => {
    const fb = formatExportFailure({ kind: 'GenerationFailed', detail: 'worker crashed' });
    expect(fb.cause).toContain('worker crashed');
    expect(fb.resultingState).toContain('No file was written');
  });

  it('maps PublicationFailed to the republish-retry copy (AC3)', () => {
    const fb = formatExportFailure({ kind: 'PublicationFailed', detail: 'disk full' });
    expect(fb.cause).toContain('disk full');
    expect(fb.resultingState).toContain('republish the same generated document');
  });

  it('SelectionCancelled copy is neutral — no failed/error language', () => {
    const fb = formatExportFailure({ kind: 'SelectionCancelled' });
    const lower = `${fb.cause} ${fb.resultingState}`.toLowerCase();
    expect(lower).not.toContain('failed');
    expect(lower).not.toContain('error');
    expect(fb.resultingState).toContain('retry');
  });
});
