/**
 * Dedicated Analysis Web Worker (Epic 4, Story 4.1, FR-31).
 *
 * Executes all coherence and strategic analysis computations off the main thread.
 * Exposes zero direct persistence or UI mutation APIs.
 */

import { AnalysisEngine } from './analysis-engine';
import type {
  AnalysisWorkerRequest,
  AnalysisWorkerResponse,
} from '../../contracts/analysis-protocol';

const engine = new AnalysisEngine();

self.onmessage = (event: MessageEvent<AnalysisWorkerRequest>) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  let response: AnalysisWorkerResponse | null = null;

  try {
    if (msg.type === 'AnalysisSnapshot') {
      response = engine.initialize(msg);
    } else if (msg.type === 'AnalysisDelta') {
      response = engine.applyDelta(msg);
    } else if (msg.type === 'ForecastRequest') {
      // The forecast branch is async and outside the surrounding try/catch —
      // a rejected computation must surface a recoverable "unavailable"
      // response, never silence (AC 18.4-6). The authoring thread is not
      // blocked either way.
      engine.computeForecast(msg).then(
        (res) => self.postMessage(res),
        (err: unknown) => {
          self.postMessage({
            type: 'ForecastResult',
            projectId: msg.projectId,
            projectRevision: msg.projectRevision,
            policyVersion: msg.policyVersion,
            requestToken: msg.requestToken,
            result: null,
            historicalAttributionAvailable: false,
            error: {
              code: 'FORECAST_COMPUTATION_FAILED',
              message: err instanceof Error ? err.message : 'Forecast computation failed.',
            },
          });
        },
      );
      return;
    } else if (msg.type === 'ScenarioEvaluationRequest') {
      engine.evaluateScenario(msg).then((res) => self.postMessage(res));
      return;
    }

    if (response) {
      self.postMessage(response);
    }
  } catch (err) {
    // In the event of an unexpected runtime failure, post a resync required
    self.postMessage({
      type: 'AnalysisResyncRequired',
      projectId: msg.projectId,
      expectedRevision: engine.projectRevision,
      receivedRevision: 'baseRevision' in msg ? msg.baseRevision : 0,
    });
  }
};
