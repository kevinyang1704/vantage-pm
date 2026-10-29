/**
 * Phase 2 Certification: Staffing trade-offs and complete Phase 2 suite
 * (Story 23.6, AC 23.6-2, AC 23.6-3, AC 23.6-7; SF-FR15..19, SF-NFR1..8, SF-AR10..11, SF-UX8..9).
 *
 * This spec provides:
 *   - AC 23.6-3: Regression suite proving legacy shared fixtures and historical scenarios remain unchanged.
 *
 * Story 23.10 (R12) removed two blocks from this file. A self-authored
 * requirement inventory (file lists, booleans, a length check) is not
 * evidence: the traceability matrix is docs/reviews/staffing-traceability-2026-09-26.md,
 * checked for drift by staffing-traceability.spec.ts. Freshness tests that
 * exercised local copies of the token logic are replaced by production-code
 * tests in src/application/analysis/forecast-worker.spec.ts and the
 * real-editor journeys in tests/e2e/forecast-scenario-draft.spec.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  createForecastConfiguration,
  createForecastPlan,
  FORECAST_POLICY_VERSION,
  STAFFED_FORECAST_POLICY_VERSION,
  type ForecastPerson,
  type ForecastPolicyVersion,
} from './forecast-plan.entity';
import { evaluateScenario } from './scenario-evaluate';
import {
  baselineFromPersisted,
  scenarioFingerprint,
  validateForecastScenarioBaseline,
  validatePersistedForecastScenario,
  type ForecastScenarioBaseline,
  type ForecastScenarioPatch,
  type PersistedForecastScenario,
} from './scenario';
import { calculateForecast, forecastMaterialFacts } from './whole-set.policy';
import { computeForecastFingerprintSync } from './forecast-canonical';
import { PRODUCT_SCHEMA_VERSION } from '../../adapters/persistence/schema';
import { PORTABLE_FILE_SCHEMA_VERSION } from '../../contracts/portable-file.schema';

const PROJECT_ID = '018f3a80-0000-7000-8000-000000000001';
const FEAT_ALPHA = '018f3a80-0000-7000-8000-0000000000a1';
const FEAT_BETA = '018f3a80-0000-7000-8000-0000000000a2';
const PERSON_ADA = '018f3a80-0000-7000-8000-0000000000b1';
const PERSON_BEN = '018f3a80-0000-7000-8000-0000000000b2';

describe('Story 23.6 AC 23.6-3 — Legacy shared fixtures and historical scenarios regression', () => {
  it('legacy shared-capacity plan produces unchanged results and ignores empty or unused staffing fields', async () => {
    const config = createForecastConfiguration({
      pointsPerSprint: 10,
      sprintLengthDays: 14,
      startSprintOrdinal: 1,
      startDate: '2026-09-07',
    });

    const sharedInputsWithoutStaffing = {
      projectId: PROJECT_ID,
      projectRevision: 1,
      policyVersion: 'shared-capacity-v1' as ForecastPolicyVersion,
      selectedFeatureIds: [FEAT_ALPHA, FEAT_BETA],
      estimates: { [FEAT_ALPHA]: 10, [FEAT_BETA]: 20 },
      parallelGroups: [],
      blockedFeatureIds: [],
      pointsPerSprint: config.pointsPerSprint,
      sprintLengthDays: config.sprintLengthDays,
      startSprintOrdinal: config.startSprintOrdinal,
      startDate: config.startDate,
    };

    const resultWithout = await calculateForecast(sharedInputsWithoutStaffing);
    expect(resultWithout.state).toBe('ready');
    expect(resultWithout.arithmetic?.occupiedSprints).toBe(3); // 30 / 10 = 3
    expect(resultWithout.arithmetic?.completionSprint).toBe(3);
    expect(resultWithout.arithmetic?.completionDate).toBe('2026-10-18');

    // Adding staffing fields to shared-capacity inputs does NOT alter the result
    const sharedInputsWithStaffingFields = {
      ...sharedInputsWithoutStaffing,
      roster: [{ id: PERSON_ADA, name: 'Ada', weightUnits: 1000 }],
      assignments: { [FEAT_ALPHA]: [PERSON_ADA] },
    };

    const resultWith = await calculateForecast(sharedInputsWithStaffingFields);
    expect(resultWith.state).toBe('ready');
    expect(resultWith.arithmetic?.occupiedSprints).toBe(resultWithout.arithmetic?.occupiedSprints);
    expect(resultWith.arithmetic?.completionDate).toBe(resultWithout.arithmetic?.completionDate);
  });

  it('historical shared scenario evaluates without executing staffed logic or inventing assignments', async () => {
    const config = createForecastConfiguration({
      pointsPerSprint: 10,
      sprintLengthDays: 14,
      startSprintOrdinal: 1,
      startDate: '2026-09-07',
    });

    const sharedBaseline: ForecastScenarioBaseline = Object.freeze({
      projectId: PROJECT_ID,
      baselineRevision: 1,
      policyVersion: 'shared-capacity-v1',
      planningLevel: 'Feature',
      orderedScope: [FEAT_ALPHA, FEAT_BETA],
      configuration: config,
      parallelGroups: [],
      blockedFeatureIds: [],
      factMap: {
        [FEAT_ALPHA]: { effortPoints: 10, projectId: PROJECT_ID, ancestorIds: [], nodeType: 'Feature' },
        [FEAT_BETA]: { effortPoints: 20, projectId: PROJECT_ID, ancestorIds: [], nodeType: 'Feature' },
      },
    });

    const patch: ForecastScenarioPatch = Object.freeze({
      pointsPerSprint: 15,
    });

    const evaluation = await evaluateScenario(sharedBaseline, patch);
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) return;

    expect(evaluation.baselineInputs.policyVersion).toBe('shared-capacity-v1');
    expect(evaluation.variantInputs.policyVersion).toBe('shared-capacity-v1');
    expect(evaluation.baselineInputs.roster).toBeUndefined();
    expect(evaluation.baselineInputs.assignments).toBeUndefined();
    expect(evaluation.baselineResult.arithmetic?.occupiedSprints).toBe(3);
    expect(evaluation.variantResult.arithmetic?.occupiedSprints).toBe(2); // 30 / 15 = 2
  });
});

describe('Story 23.6 — storage and portable versions', () => {
  it('confirms storage schema version 20 and portable version 9 — collaboration sidecar migration', () => {
    expect(PRODUCT_SCHEMA_VERSION).toBe(20);
    expect(PORTABLE_FILE_SCHEMA_VERSION).toBe(9);
  });
});
