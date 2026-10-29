/**
 * Forecast domain module (Story 18.1, AD-18..AD-21, AD-24).
 *
 * Pure, framework-free forecast facts and policies. Domain imports no
 * adapter; forecast computation owns neither storage nor authored scheduling.
 */

export {
  FORECAST_POLICY_VERSION,
  STAFFED_FORECAST_POLICY_VERSION,
  FORECAST_CADENCE,
  createEmptyForecastPlan,
  createForecastConfiguration,
  createForecastPlan,
} from './forecast-plan.entity';
export type {
  ForecastPlan,
  ForecastConfiguration,
  ForecastParallelGroup,
  ForecastPolicyVersion,
  ForecastCadence,
  ForecastPerson,
} from './forecast-plan.entity';
export {
  isFiniteNonNegativeSafeInteger,
  isPositiveSafeInteger,
  isValidIsoDateOnly,
  validatePoints,
  validateCapacity,
  validateSprintLength,
  validateStartOrdinal,
  validateStartDate,
  validateForecastScope,
  validateForecastGroups,
  validatePolicyVersion,
  assertForecastPlanIdentity,
  assertForecastPolicyVersion,
  DEFAULT_STAFFING_WEIGHT_UNITS,
  parseStaffingWeightToUnits,
  isValidStaffingWeightUnits,
  formatStaffingWeightUnits,
  validateStaffingWeight,
  validateRoster,
  validateStaffingAssignments,
} from './forecast-validators';
export type { ForecastIssue } from './forecast-validators';
export {
  gcd,
  reduceRatio,
  formatRatio,
  sortIdsLexically,
  canonicalizeForecast,
  computeForecastFingerprint,
} from './forecast-canonical';
export type { ReducedRatio } from './forecast-canonical';
export { createForecastAssumptions } from './forecast-result';
export type {
  ForecastResultState,
  ForecastCoverage,
  ForecastArithmetic,
  ForecastAssumptions,
  ForecastInputs,
  ForecastResult,
} from './forecast-result';
export {
  createConfigureForecastPlanCommand,
  createRemoveForecastPlanCommand,
  createSetForecastMembershipCommand,
  createSetForecastBlockerCommand,
  createReorderForecastFeaturesCommand,
  createSetForecastSequenceCommand,
  createSetForecastParallelGroupsCommand,
  createRestoreForecastScopeCommand,
  createCreateForecastScenarioCommand,
  createRemoveForecastScenarioCommand,
  createRestoreForecastScenarioCommand,
  createSetForecastPlanningLevelCommand,
  createRestoreForecastPlanningLevelCommand,
  createAddForecastPersonCommand,
  createUpdateForecastPersonCommand,
  createRemoveForecastPersonCommand,
  createRestoreForecastPersonCommand,
  createSetForecastAssignmentsCommand,
  createSetForecastPolicyCommand,
  createMoveForecastFeatureCommand,
  createSetForecastAssignmentCommand,
} from './forecast.commands';
export type {
  ConfigureForecastPlanCommand,
  RemoveForecastPlanCommand,
  SetForecastMembershipCommand,
  SetForecastBlockerCommand,
  ReorderForecastFeaturesCommand,
  SetForecastSequenceCommand,
  SetForecastParallelGroupsCommand,
  RestoreForecastScopeCommand,
  CreateForecastScenarioCommand,
  RemoveForecastScenarioCommand,
  RestoreForecastScenarioCommand,
  SetForecastPlanningLevelCommand,
  RestoreForecastPlanningLevelCommand,
  AddForecastPersonCommand,
  UpdateForecastPersonCommand,
  RemoveForecastPersonCommand,
  RestoreForecastPersonCommand,
  SetForecastAssignmentsCommand,
  SetForecastPolicyCommand,
  MoveForecastFeatureCommand,
  ForecastGroupChange,
  SetForecastAssignmentCommand,
} from './forecast.commands';
export { normalizeForecastInputs } from './forecast-normalization';
export type { NormalizeForecastInputsResult } from './forecast-normalization';
export { calculateForecast } from './whole-set.policy';
export {
  calculateAllocation,
  addRatios,
  ratioFloor,
  ratioCeil,
} from './forecast-allocation';
export { compareForecasts, FORECAST_CAUSE_FIELD_ORDER } from './compare.policy';
export type {
  ForecastChangeCause,
  ForecastChangedDimensions,
  ForecastComparison,
  ForecastCauseField,
} from './compare.policy';
export {
  scenarioFingerprint,
  scenarioCanonicalBytes,
  baselineFromPersisted,
  normalizePersistedForecastScenario,
  isPersistedForecastScenario,
  validateForecastScenarioBaseline,
  validatePersistedForecastScenario,
  createForecastScenarioBaseline,
  createBaselineFromPlan,
} from './scenario';
export type {
  ForecastScenarioBaseline,
  ForecastScenarioPatch,
  ScenarioFeatureFact,
  ScenarioEvaluationIssue,
  ScenarioValidationIssue,
  ScenarioGroupCleanup,
  ScenarioAssignmentCleanup,
  PersistedForecastScenario,
} from './scenario';
export { evaluateScenario } from './scenario-evaluate';
export type { ScenarioEvaluation } from './scenario-evaluate';
export type {
  FeatureTimeline,
  CapacityShareEvent,
  ForecastAllocation,
} from './forecast-allocation';
export {
  compareRatios,
  maxRatio,
  subtractRatios,
  multiplyRatioByInt,
  calculateStaffedAllocation,
} from './staffed-calculation.policy';
export type { StaffedAllocationResult } from './staffed-calculation.policy';
