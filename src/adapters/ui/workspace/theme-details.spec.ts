import { describe, expect, it } from 'vitest';
import { FEATURE_DETAIL_PAGE_SIZE, paginateFeatures, themeDetailsPanelId, untitledFeature } from './theme-details';
import type { WorkspaceFeatureRow } from '../../../contracts/workspace-overview';

function feature(id: string, title: string): WorkspaceFeatureRow {
  return Object.freeze({ featureId: id, title, deliveryStatus: 'not_started' });
}

function many(count: number): readonly WorkspaceFeatureRow[] {
  return Object.freeze(
    Array.from({ length: count }, (_, i) => feature(`f-${String(i).padStart(4, '0')}`, `Feature ${i}`)),
  );
}

describe('theme details paging (Story 24.3 AC 24.3-6)', () => {
  it('renders at most 50 rows per page', () => {
    const features = many(120);
    const page0 = paginateFeatures(features, 0);
    expect(page0.rows).toHaveLength(FEATURE_DETAIL_PAGE_SIZE);
    expect(page0.pageCount).toBe(3);
    expect(page0.page).toBe(0);
  });

  it('covers every Feature across pages with no omissions or duplicates', () => {
    const features = many(120);
    const seen: string[] = [];
    for (let page = 0; page < 3; page += 1) {
      const result = paginateFeatures(features, page);
      seen.push(...result.rows.map((row) => row.featureId));
    }
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
  });

  it('clamps an out-of-range page onto the last available page', () => {
    const features = many(10);
    expect(paginateFeatures(features, 5).page).toBe(0);
    expect(paginateFeatures(many(120), 99).page).toBe(2);
  });

  it('reports a single page when there are no Features', () => {
    const result = paginateFeatures([], 0);
    expect(result.pageCount).toBe(1);
    expect(result.rows).toEqual([]);
  });

  it('has an exactly-50 boundary with one page only', () => {
    const result = paginateFeatures(many(50), 0);
    expect(result.pageCount).toBe(1);
    expect(result.rows).toHaveLength(50);
  });

  it('uses a deterministic, DOM-safe panel id', () => {
    expect(themeDetailsPanelId('019ffe00-0000-7000-8000-000000000001', '019ffe00-0000-7000-8000-000000000020')).toBe(
      'pm-theme-details-019ffe00-0000-7000-8000-000000000001-019ffe00-0000-7000-8000-000000000020',
    );
  });

  it('applies the existing Untitled fallback only to blank titles', () => {
    expect(untitledFeature('')).toBe('Untitled Feature');
    expect(untitledFeature('   ')).toBe('Untitled Feature');
    expect(untitledFeature('Named')).toBe('Named');
  });
});
