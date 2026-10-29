/**
 * Native staffed analysis parity (Story 22.10, AC 22.10-1/-2; review R1).
 *
 * The native build reads the project through `queryNativeAnalysisSnapshot`
 * on initial load, reload and resync (`main.tsx` → `queryAnalysisSnapshot`).
 * These tests drive that production adapter with the snapshot DTO the Rust
 * runtime serializes, then run the result through the real `AnalysisEngine`
 * and compare it with the plan the browser worker builds from the same
 * stored facts (`readForecastPlan` → `createForecastPlan`). A mapper stub or
 * a Rust-only DTO round trip would not catch the defect this guards: at
 * 0522d6e the adapter mapped the roster but replaced every assignment with
 * `{}`, so a fully staffed native plan analysed as incomplete work.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { queryNativeAnalysisSnapshot } from './tauri-repository.client';
import type { NativeNodeRow, NativeProjectSnapshot } from './native-read-model';
import { AnalysisEngine } from '../../application/analysis/analysis-engine';
import type { AnalysisSnapshotRequest, ForecastRequest } from '../../contracts/analysis-protocol';
import {
  createForecastConfiguration,
  createForecastPlan,
  STAFFED_FORECAST_POLICY_VERSION,
} from '../../domain/forecast/forecast-plan.entity';
import restoredFixture from './fixtures/native-staffed-restored-snapshot.json';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const PROJECT_ID = '019ffe00-0000-7000-8000-000000000001';
const FEATURE_A = '019ffe00-0000-7000-8000-00000000000a';
const FEATURE_B = '019ffe00-0000-7000-8000-00000000000b';
const FEATURE_C = '019ffe00-0000-7000-8000-00000000000c';
const ADA = '019ffe00-0000-7000-8000-0000000000a1';
const BEN = '019ffe00-0000-7000-8000-0000000000b1';
/** Idle roster member: on the roster, assigned to nothing. */
const CARA = '019ffe00-0000-7000-8000-0000000000c1';

function nativeFeature(id: string, position: number, effortPoints: number): NativeNodeRow {
  return {
    id,
    parentId: null,
    title: `Feature ${id.slice(-1)}`,
    bodyText: null,
    position,
    nodeType: 'Feature',
    startDate: null,
    endDate: null,
    durationDays: null,
    scheduleSourceMode: null,
    completed: false,
    effortPoints,
    strategicWeight: null,
    phaseId: null,
    deliveryStatus: 'not_started',
  };
}

const ROSTER = [
  { id: ADA, name: 'Ada', weightUnits: 100 },
  { id: BEN, name: 'Ben', weightUnits: 150 },
  { id: CARA, name: 'Cara', weightUnits: 50 },
] as const;

/**
 * Stored assignments exactly as the Rust runtime emits them: a JSON object
 * built from a HashMap (key order is not meaningful) whose per-item arrays
 * keep their stored order — here deliberately not the canonical order.
 */
const STORED_ASSIGNMENTS: Readonly<Record<string, readonly string[]>> = {
  [FEATURE_C]: [BEN],
  [FEATURE_A]: [BEN, ADA],
  [FEATURE_B]: [ADA],
};

function nativeSnapshot(revision: number): NativeProjectSnapshot {
  return {
    projectId: PROJECT_ID,
    projectName: 'Synthetic staffing',
    revision,
    nodes: [nativeFeature(FEATURE_A, 1, 20), nativeFeature(FEATURE_B, 2, 10), nativeFeature(FEATURE_C, 3, 15)],
    phases: [],
    unlockEdges: [],
    customFields: [],
    dismissals: [],
    affectedReasons: [],
    forecastPlan: {
      planningLevel: 'Feature',
      selectedFeatureIds: [FEATURE_A, FEATURE_B, FEATURE_C],
      parallelGroups: [],
      blockedFeatureIds: [],
      pointsPerSprint: 10,
      sprintLengthDays: 14,
      cadence: 'fixed-contiguous',
      startSprintOrdinal: 1,
      startDate: '2026-09-07',
      policyVersion: STAFFED_FORECAST_POLICY_VERSION,
      roster: ROSTER,
      assignments: STORED_ASSIGNMENTS,
    },
  };
}

/** What the browser worker hands the engine for the same stored facts. */
function browserSnapshot(native: AnalysisSnapshotRequest): AnalysisSnapshotRequest {
  return Object.freeze({
    ...native,
    forecastPlan: createForecastPlan({
      projectId: PROJECT_ID,
      selectedFeatureIds: [FEATURE_A, FEATURE_B, FEATURE_C],
      configuration: createForecastConfiguration({
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        startSprintOrdinal: 1,
        startDate: '2026-09-07',
      }),
      policyVersion: STAFFED_FORECAST_POLICY_VERSION,
      planningLevel: 'Feature',
      roster: ROSTER,
      assignments: STORED_ASSIGNMENTS,
    }),
  });
}

function forecastRequest(revision: number, token: string): ForecastRequest {
  return Object.freeze({
    type: 'ForecastRequest',
    projectId: PROJECT_ID,
    projectRevision: revision,
    policyVersion: STAFFED_FORECAST_POLICY_VERSION,
    requestToken: token,
  });
}

async function analyse(snapshot: AnalysisSnapshotRequest, token: string) {
  const engine = new AnalysisEngine();
  engine.initialize(snapshot);
  const response = await engine.computeForecast(forecastRequest(snapshot.projectRevision, token));
  if (response.type !== 'ForecastResult') throw new Error(`unexpected ${response.type}`);
  return response;
}

describe('native staffed analysis snapshot (AC 22.10-1, R1)', () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it('carries every stored assignment and the idle roster member into analysis', async () => {
    vi.mocked(invoke).mockResolvedValue(nativeSnapshot(4));
    const snapshot = await queryNativeAnalysisSnapshot(PROJECT_ID);

    const plan = snapshot.forecastPlan;
    expect(plan?.roster.map((p) => p.id)).toEqual([ADA, BEN, CARA]);
    expect(Object.keys(plan?.assignments ?? {}).sort()).toEqual([FEATURE_A, FEATURE_B, FEATURE_C].sort());
    // Same membership as stored; canonical order, exactly as the browser reads it.
    expect(plan?.assignments[FEATURE_A]).toEqual([ADA, BEN]);
    expect(plan?.assignments[FEATURE_B]).toEqual([ADA]);
    expect(plan?.assignments[FEATURE_C]).toEqual([BEN]);
  });

  it('returns immutable copies that do not alias the native DTO', async () => {
    const dto = nativeSnapshot(4);
    vi.mocked(invoke).mockResolvedValue(dto);
    const plan = (await queryNativeAnalysisSnapshot(PROJECT_ID)).forecastPlan!;

    expect(Object.isFrozen(plan.assignments)).toBe(true);
    for (const personIds of Object.values(plan.assignments)) {
      expect(Object.isFrozen(personIds)).toBe(true);
    }
    expect(Object.isFrozen(plan.roster)).toBe(true);
    expect(plan.assignments).not.toBe(dto.forecastPlan!.assignments);
    expect(plan.assignments[FEATURE_B]).not.toBe(dto.forecastPlan!.assignments![FEATURE_B]);
  });

  it('analyses to the same ready result and material fingerprint as the browser', async () => {
    vi.mocked(invoke).mockResolvedValue(nativeSnapshot(4));
    const native = await queryNativeAnalysisSnapshot(PROJECT_ID);

    const fromNative = await analyse(native, 'native');
    const fromBrowser = await analyse(browserSnapshot(native), 'browser');

    expect(fromNative.result?.state).toBe('ready');
    expect(fromNative.result?.policyVersion).toBe(STAFFED_FORECAST_POLICY_VERSION);
    expect(fromNative.result?.materialFingerprint).toBe(fromBrowser.result?.materialFingerprint);
    expect(fromNative.result).toEqual(fromBrowser.result);
  });

  it('keeps the assignments on reload and resync at a later revision', async () => {
    // Initial load, then the same adapter call the app makes on reload and
    // on a delta-gap resync (`queryAnalysisSnapshot` → native adapter).
    vi.mocked(invoke).mockResolvedValueOnce(nativeSnapshot(4)).mockResolvedValueOnce(nativeSnapshot(9));
    const initial = await analyse(await queryNativeAnalysisSnapshot(PROJECT_ID), 'load');
    const resynced = await analyse(await queryNativeAnalysisSnapshot(PROJECT_ID), 'resync');

    expect(resynced.projectRevision).toBe(9);
    expect(resynced.result?.state).toBe('ready');
    expect(resynced.result?.materialFingerprint).toBe(initial.result?.materialFingerprint);
    expect(resynced.result?.arithmetic).toEqual(initial.result?.arithmetic);
  });
});

describe('native .pmapp restore into analysis (AC 22.10-2)', () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it('opens the restored project through the production adapter with assignments and completion intact', async () => {
    // Written by the Rust test `native_backup_restore_staffed_snapshot_matches_
    // adapter_fixture`: package → validate → extract → verify → the real
    // `query_project_snapshot` reader, serialized exactly as the webview
    // receives it. That test fails if the restored shape drifts from this file.
    const restored = restoredFixture as unknown as NativeProjectSnapshot;
    vi.mocked(invoke).mockResolvedValue(restored);

    const snapshot = await queryNativeAnalysisSnapshot(PROJECT_ID);
    expect(snapshot.forecastPlan?.roster.map((p) => p.id)).toEqual([ADA, BEN, CARA]);
    expect(snapshot.forecastPlan?.assignments[FEATURE_A]).toEqual([ADA, BEN]);

    const fromRestore = await analyse(snapshot, 'restore');
    const fromBrowser = await analyse(browserSnapshot(snapshot), 'browser');
    expect(fromRestore.result?.state).toBe('ready');
    expect(fromRestore.result?.arithmetic?.completionDate).toBeTruthy();
    expect(fromRestore.result).toEqual(fromBrowser.result);
  });
});
