/**
 * The browser benchmark fixtures are importable, complete and self-consistent
 * (Story 23.10 AC 23.10-2/-3): every file passes the production portable
 * importer, including its scenario baseline fingerprint re-check.
 */

import { describe, expect, it } from 'vitest';
import { importProject } from '../../src/application/portable-file/import-project';
import { buildBenchmarkPortableFile, benchmarkProjectId } from './support/staffing-benchmark';

describe('Story 23.10 — browser benchmark portable fixtures', () => {
  it.each([
    ['staffed', 0],
    ['staffed', 1],
    ['staffed', 2],
    ['shared', 0],
    ['shared', 1],
    ['shared', 2],
  ] as const)('%s with %i scenario(s) imports through the production validator', (mode, scenarios) => {
    const raw = buildBenchmarkPortableFile(mode, scenarios);
    expect(raw.length).toBeLessThan(10 * 1024 * 1024);
    const result = importProject(raw, () => false);
    expect(result.ok, JSON.stringify(result.ok ? null : result.error)).toBe(true);
    if (!result.ok) return;
    const c = result.candidate;
    expect(c.projectId).toBe(benchmarkProjectId(mode, scenarios));
    expect(c.nodes).toHaveLength(5000);
    expect(c.forecastPlan?.selectedFeatureIds).toHaveLength(5000);
    expect(c.forecastScenarios ?? []).toHaveLength(scenarios);
    if (mode === 'staffed') {
      expect(c.forecastPlan?.roster).toHaveLength(100);
      const edges = Object.values(c.forecastPlan?.assignments ?? {}).reduce((n, ids) => n + ids.length, 0);
      expect(edges).toBe(10000);
    } else {
      expect(c.forecastPlan?.roster ?? []).toHaveLength(0);
    }
  });
});
