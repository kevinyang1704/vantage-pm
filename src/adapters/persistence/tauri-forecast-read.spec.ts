import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { queryNativeAnalysisSnapshot, queryNativePortableSnapshot } from './tauri-repository.client';
import type { NativeProjectSnapshot } from './native-read-model';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('native forecast snapshot boundary', () => {
  it.each([
    ['Theme', 'Theme'], ['Component', 'Component'], ['Feature', 'Feature'],
    [undefined, 'Feature'], [null, 'Feature'], ['future-level', 'Feature'],
  ])('preserves or normalizes %s for both analysis and portable export', async (stored, expected) => {
    const snapshot: NativeProjectSnapshot = {
      projectId: '019ffe00-0000-7000-8000-000000000001', projectName: 'Synthetic', revision: 1,
      nodes: [], phases: [], unlockEdges: [], customFields: [], dismissals: [], affectedReasons: [],
      forecastPlan: {
        planningLevel: stored, selectedFeatureIds: [], parallelGroups: [], blockedFeatureIds: [],
        pointsPerSprint: 10, sprintLengthDays: 14, cadence: 'fixed-contiguous',
        startSprintOrdinal: 1, startDate: '2026-09-07', policyVersion: 'shared-capacity-v1',
      },
    };
    vi.mocked(invoke).mockResolvedValue(snapshot);
    const analysis = await queryNativeAnalysisSnapshot(snapshot.projectId);
    const portable = await queryNativePortableSnapshot(snapshot.projectId);
    expect(analysis.forecastPlan?.planningLevel).toBe(expected);
    expect(portable.forecastPlan?.planningLevel).toBe(expected);
    expect(analysis.forecastPlan?.configuration.pointsPerSprint).toBe(10);
  });
});
