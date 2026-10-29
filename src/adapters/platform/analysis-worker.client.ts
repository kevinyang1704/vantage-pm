/**
 * Analysis Worker Client Adapter (Epic 4, Story 4.1, Epic 18 Story 18.4).
 *
 * Bridge between Main Thread application state and the background Analysis Web
 * Worker. When Workers are genuinely unavailable as a platform (Vitest / SSR —
 * no `window`, no `Worker`), a synchronous in-memory engine stands in so tests
 * and server render still resolve. In a real browser this fallback is NOT
 * used: if the Worker cannot be constructed, forecasting reports a recoverable
 * "unavailable" state rather than running heavy synchronous work on the
 * authoring path (AC 18.4-6, NFR-4).
 *
 * Story 18.4: forecast requests carry a request token and policy version; only
 * the response matching the current project, revision, policy, and token may
 * become current (AC 18.4-2). A newer request supersedes an older request;
 * out-of-order or structurally malformed responses are rejected.
 */

import { AnalysisEngine } from '../../application/analysis/analysis-engine';
import type {
  AnalysisWorkerRequest,
  AnalysisWorkerResponse,
  AnalysisResultResponse,
  AnalysisSnapshotRequest,
  AnalysisDeltaRequest,
  ForecastRequest,
  ForecastResultResponse,
  ScenarioEvaluationRequest,
  ScenarioEvaluationResponse,
} from '../../contracts/analysis-protocol';

/** Bound on worker reconstructions per rolling window (Story 25.1 AC 25.1-2). */
export const WORKER_RECREATE_MAX_ATTEMPTS = 3;
export const WORKER_RECREATE_WINDOW_MS = 30_000;

/**
 * Stale-result acceptance check (Story 18.4 AC2): only a response matching the
 * current project, revision, policy version, and request token may become
 * current. The token is a fresh per-request UUIDv7 so it alone orders
 * responses; the other fields are matched as defence in depth.
 */
export function isCurrentForecastResult(
  latest: ForecastRequest | null,
  msg: ForecastResultResponse,
): boolean {
  return (
    latest !== null &&
    latest.projectId === msg.projectId &&
    latest.projectRevision === msg.projectRevision &&
    latest.policyVersion === msg.policyVersion &&
    latest.requestToken === msg.requestToken &&
    // The date is part of the identity when both sides carry it; an error or
    // unavailable envelope omits it and must still be accepted as a reply.
    (latest.today === undefined || msg.today === undefined || latest.today === msg.today) &&
    (latest.materialFingerprint === undefined || latest.materialFingerprint === msg.materialFingerprint) &&
    (msg.result === null || msg.materialFingerprint === undefined || msg.materialFingerprint === msg.result.materialFingerprint)
  );
}

/** A scenario or draft evaluation that did not produce a current result (Story 23.7). */
export class ScenarioEvaluationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ScenarioEvaluationError';
    this.code = code;
  }
}

/**
 * Scenario reply acceptance (AC 23.7-5): the reply must carry the latest
 * request's project, scenario/draft identity, captured revision, policy,
 * fingerprint and token. Any mismatch is a stale or foreign reply.
 */
export function isCurrentScenarioEvaluation(latest: ScenarioEvaluationRequest, msg: ScenarioEvaluationResponse): boolean {
  return (
    latest.projectId === msg.projectId &&
    latest.scenarioId === msg.scenarioId &&
    latest.baselineRevision === msg.baselineRevision &&
    latest.policyVersion === msg.policyVersion &&
    latest.scenarioFingerprint === msg.scenarioFingerprint &&
    latest.requestToken === msg.requestToken
  );
}

/** Structural guard for a worker message crossing the structured-clone boundary (AR-21). */
function isForecastResultResponse(msg: unknown): msg is ForecastResultResponse {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  return (
    m.type === 'ForecastResult' &&
    typeof m.projectId === 'string' &&
    typeof m.projectRevision === 'number' &&
    typeof m.policyVersion === 'string' &&
      typeof m.requestToken === 'string' &&
    ('result' in m) &&
    (m.result === null || (typeof m.result === 'object' && m.result !== null))
  );
}

export class AnalysisWorkerClient {
  #worker: Worker | null = null;
  #fallbackEngine: AnalysisEngine | null = null;
  /** True when a real browser could not construct the Worker — no sync fallback. */
  #workerUnavailable = false;
  /** True once an existing worker errored; a later request may lazily recreate one (review L7). */
  #workerFailed = false;
  /** Worker reconstructions within the current window (bounded; Story 25.1 AC 25.1-2). */
  #recreateAttempts = 0;
  #recreateWindowStartedAt = 0;
  /** True after `terminate()`: no request may ever construct another worker. */
  #terminated = false;
  /** How long a scenario evaluation may stay unanswered before it settles as failed. */
  #scenarioTimeoutMs = 30_000;
  #onResultCallback: ((res: AnalysisResultResponse) => void) | null = null;
  #onResyncCallback: ((projectId: string) => void) | null = null;
  #onForecastResultCallback: ((res: ForecastResultResponse) => void) | null = null;
  #latestForecastRequest: ForecastRequest | null = null;
  /**
   * The most recent snapshot handed to the worker. A recreated worker has seen
   * no `initialize`, so without replaying this its forecast reply would carry
   * an empty project identity and be rejected as stale (review L7).
   */
  #latestSnapshot: AnalysisSnapshotRequest | null = null;
  /** Latest request per saved-scenario or draft identity, with its settlement (AC 23.7-5/-6). */
  #scenarioPending = new Map<
    string,
    Readonly<{
      request: ScenarioEvaluationRequest;
      resolve: (response: ScenarioEvaluationResponse) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout> | null;
    }>
  >();

  constructor(options: Readonly<{ scenarioTimeoutMs?: number }> = {}) {
    if (
      options.scenarioTimeoutMs !== undefined &&
      Number.isFinite(options.scenarioTimeoutMs) &&
      options.scenarioTimeoutMs > 0
    ) {
      this.#scenarioTimeoutMs = options.scenarioTimeoutMs;
    }
    if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
      this.#worker = this.#createWorker();
      if (!this.#worker) this.#workerUnavailable = true;
    } else {
      // No Worker platform at all (Vitest / SSR): synchronous engine stands in.
      this.#fallbackEngine = new AnalysisEngine();
    }
  }

  /**
   * Build the analysis worker and wire its handlers. Returns null when the real
   * browser cannot construct it (no synchronous fallback — AC 18.4-6).
   */
  #createWorker(): Worker | null {
    // Never resurrect a worker after an explicit teardown.
    if (this.#terminated) return null;
    try {
      const worker = new Worker(
        new URL('../../application/analysis/analysis.worker.ts', import.meta.url),
        { type: 'module' },
      );
      worker.onmessage = (e: MessageEvent<AnalysisWorkerResponse>) => {
        this.#handleMessage(e.data);
      };
      worker.onerror = () => {
        // A runtime worker failure: report forecasting as recoverably
        // unavailable for the latest request; do not fall back to the
        // authoring thread (AC 18.4-6). Pending scenario previews fail
        // recoverably too, so no editor waits forever (AC 23.7-6).
        //
        // An error while the worker's script is loading is terminal for THAT
        // worker: it can never answer another message (review L7). Tear it
        // down so it is never posted to again, and mark the failure so the
        // next request lazily recreates a fresh worker (allowing the editor's
        // Retry path to recover). Recreating lazily — not in this handler —
        // keeps `onerror` free of worker construction side effects.
        try {
          worker.terminate();
        } catch {
          // Best effort: the worker may already be dead.
        }
        // A stale generation's error must not settle the current worker's
        // requests: a superseded worker can fire onerror after a replacement
        // was installed (review L7, edge-case).
        if (this.#worker !== worker) return;
        this.#worker = null;
        this.#workerFailed = true;
        this.#emitForecastUnavailable('FORECAST_WORKER_ERROR', 'The forecast worker stopped responding.');
        this.#rejectAllScenarioRequests(new ScenarioEvaluationError('SCENARIO_WORKER_ERROR', 'The forecast worker stopped responding.'));
      };
      return worker;
    } catch {
      return null;
    }
  }

  onResult(callback: (res: AnalysisResultResponse) => void): void {
    this.#onResultCallback = callback;
  }

  onResyncRequired(callback: (projectId: string) => void): void {
    this.#onResyncCallback = callback;
  }

  onForecastResult(callback: (res: ForecastResultResponse) => void): void {
    this.#onForecastResultCallback = callback;
  }

  sendSnapshot(req: AnalysisSnapshotRequest): void {
    this.#latestSnapshot = req;
    if (this.#worker) {
      this.#worker.postMessage(req);
    } else if (this.#fallbackEngine) {
      const res = this.#fallbackEngine.initialize(req);
      this.#handleMessage(res);
    }
    // No worker, no fallback: the snapshot is retained and replayed to the
    // worker that `requestForecast`/`requestScenarioEvaluation` recreates.
  }

  sendDelta(req: AnalysisDeltaRequest): void {
    if (this.#worker) {
      this.#worker.postMessage(req);
    } else if (this.#fallbackEngine) {
      const res = this.#fallbackEngine.applyDelta(req);
      this.#handleMessage(res);
    }
  }

  /**
   * Lazily replace a worker that failed (review L7; bounded, Story 25.1
   * AC 25.1-2). A fresh worker has seen no snapshot, so the retained one is
   * replayed before anything is asked of it; otherwise its reply carries an
   * empty identity and is rejected as stale.
   *
   * Reconstruction is bounded: at most `WORKER_RECREATE_MAX_ATTEMPTS` attempts
   * per `WORKER_RECREATE_WINDOW_MS` window. A persistently failing script must
   * not construct a new Worker on every request forever; once the cap is hit
   * the client latches unavailable until the window elapses, then allows a
   * further bounded burst (a transient CSP/memory failure still recovers).
   */
  #recreateWorkerIfFailed(): void {
    if (!this.#workerFailed || this.#worker !== null) return;
    const now = Date.now();
    // A clock step backwards (NTP, VM resume) makes `elapsed` negative. Re-anchor
    // the window but do NOT re-arm the attempt budget, so a repeatedly-regressing
    // clock cannot defeat the cap (AC 25.1-2). A genuinely old window re-arms it.
    const elapsed = now - this.#recreateWindowStartedAt;
    if (elapsed >= WORKER_RECREATE_WINDOW_MS) {
      this.#recreateWindowStartedAt = now;
      this.#recreateAttempts = 0;
    } else if (elapsed < 0) {
      this.#recreateWindowStartedAt = now;
    }
    if (this.#recreateAttempts >= WORKER_RECREATE_MAX_ATTEMPTS) return; // latched for this window
    this.#recreateAttempts += 1;
    const worker = this.#createWorker();
    if (!worker) return; // stays failed; a later request may try again
    this.#worker = worker;
    this.#workerFailed = false;
    this.#workerUnavailable = false;
    if (this.#latestSnapshot) worker.postMessage(this.#latestSnapshot);
  }

  /**
   * Request a forecast computation. A newer request supersedes an older one:
   * only the response matching the latest request token may become current
   * (AC 18.4-2, AC 18.4-3). A failed computation yields a recoverable
   * unavailable response, never silence (AC 18.4-6).
   */
  requestForecast(req: ForecastRequest): void {
    this.#latestForecastRequest = req;
    // A prior terminal worker failure: try one fresh worker so a later refresh
    // can recover, rather than only ever reporting unavailable (review L7).
    this.#recreateWorkerIfFailed();
    if (this.#worker) {
      try {
        this.#worker.postMessage(req);
      } catch {
        // A synchronous postMessage failure must surface recoverably, never
        // throw on the authoring path (review edge-case).
        this.#emitForecastUnavailable('FORECAST_WORKER_ERROR', 'The forecast worker rejected the request.');
      }
      return;
    }
    // A prior terminal worker failure (review L7) or an unconstructable worker
    // must report recoverably unavailable rather than silently emitting
    // nothing: in a real browser there is no synchronous fallback (AC 18.4-6).
    if (this.#workerUnavailable || this.#workerFailed) {
      this.#emitForecastUnavailable('FORECAST_WORKER_UNAVAILABLE', 'The forecast worker is unavailable.');
      return;
    }
    if (this.#fallbackEngine) {
      this.#fallbackEngine.computeForecast(req).then(
        (res) => this.#handleMessage(res),
        (err: unknown) => {
          this.#handleMessage({
            type: 'ForecastResult',
            projectId: req.projectId,
            projectRevision: req.projectRevision,
            policyVersion: req.policyVersion,
            requestToken: req.requestToken,
            result: null,
            historicalAttributionAvailable: false,
            error: {
              code: 'FORECAST_COMPUTATION_FAILED',
              message: err instanceof Error ? err.message : 'Forecast computation failed.',
            },
          });
        },
      );
    }
  }

  /**
   * Evaluate a saved scenario or an open draft in the analysis worker. A
   * newer request for the same scenario/draft identity supersedes the older
   * one, whose promise rejects with `SCENARIO_EVALUATION_SUPERSEDED`; only a
   * reply matching every identity field of the latest request resolves
   * (AC 23.7-5). A failed evaluation, a cancelled draft, a terminated or
   * failed worker all reject — never leave the caller pending (AC 23.7-6).
   */
  requestScenarioEvaluation(req: ScenarioEvaluationRequest): Promise<ScenarioEvaluationResponse> {
    // A prior terminal worker failure: try one fresh worker so a Retry can
    // recover, rather than posting into a dead worker (review L7).
    this.#recreateWorkerIfFailed();
    const prior = this.#scenarioPending.get(req.scenarioId);
    if (prior) {
      if (prior.timeout !== null) clearTimeout(prior.timeout);
      prior.reject(new ScenarioEvaluationError('SCENARIO_EVALUATION_SUPERSEDED', 'A newer evaluation replaced this one.'));
    }
    return new Promise((resolve, reject) => {
      if (!this.#worker && !this.#fallbackEngine) {
        this.#scenarioPending.delete(req.scenarioId);
        reject(new ScenarioEvaluationError('SCENARIO_WORKER_UNAVAILABLE', 'The forecast worker is unavailable.'));
        return;
      }
      // A reply that never arrives (a dead worker that neither posts nor fires
      // onerror) still settles recoverably instead of hanging forever
      // (AC 23.7-6, review L7). A per-request override lets a legitimately long
      // lab-scale evaluation wait longer than the default (Story 25.1 AC 25.1-3).
      const effectiveTimeout =
        typeof req.timeoutMs === 'number' && Number.isFinite(req.timeoutMs) && req.timeoutMs > 0
          ? req.timeoutMs
          : this.#scenarioTimeoutMs;
      const timeout = setTimeout(() => {
        const current = this.#scenarioPending.get(req.scenarioId);
        if (!current || current.request.requestToken !== req.requestToken) return;
        this.#scenarioPending.delete(req.scenarioId);
        current.reject(new ScenarioEvaluationError('SCENARIO_EVALUATION_TIMEOUT', 'The forecast worker did not respond in time.'));
      }, effectiveTimeout);
      this.#scenarioPending.set(req.scenarioId, Object.freeze({ request: req, resolve, reject, timeout }));
      if (this.#worker) {
        try {
          this.#worker.postMessage(req);
        } catch (err) {
          // A synchronous postMessage failure (e.g. DataCloneError) rejects
          // the executor, but the registered pending entry and its timer would
          // otherwise survive until the timeout fires against a settled
          // promise. Clean both up before surfacing the error (review edge-case).
          if (this.#scenarioPending.get(req.scenarioId)?.request.requestToken === req.requestToken) {
            this.#scenarioPending.delete(req.scenarioId);
          }
          clearTimeout(timeout);
          throw err;
        }
      } else {
        void this.#fallbackEngine!
          .evaluateScenario(req)
          .then(
            (response) => this.#handleMessage(response),
            (err: unknown) => {
              // A rejected fallback evaluation must settle immediately, not
              // hang until the timeout with an unhandled rejection
              // (AC 23.7-6, review edge-case).
              const current = this.#scenarioPending.get(req.scenarioId);
              if (!current || current.request.requestToken !== req.requestToken) return;
              this.#scenarioPending.delete(req.scenarioId);
              if (current.timeout !== null) clearTimeout(current.timeout);
              current.reject(
                new ScenarioEvaluationError('SCENARIO_EVALUATION_FAILED', err instanceof Error ? err.message : 'Scenario evaluation failed.'),
              );
            },
          );
      }
    });
  }

  /** Drop the pending evaluation for a closed or replaced draft; a late reply is then ignored. */
  cancelScenarioEvaluation(scenarioId: string): void {
    const pending = this.#scenarioPending.get(scenarioId);
    if (!pending) return;
    this.#scenarioPending.delete(scenarioId);
    if (pending.timeout !== null) clearTimeout(pending.timeout);
    pending.reject(new ScenarioEvaluationError('SCENARIO_EVALUATION_CANCELLED', 'The evaluation was cancelled.'));
  }

  #rejectAllScenarioRequests(error: ScenarioEvaluationError): void {
    const pending = [...this.#scenarioPending.values()];
    this.#scenarioPending.clear();
    for (const p of pending) {
      if (p.timeout !== null) clearTimeout(p.timeout);
      p.reject(error);
    }
  }

  #emitForecastUnavailable(code: string, message: string): void {
    const req = this.#latestForecastRequest;
    if (!req) return;
    this.#handleMessage({
      type: 'ForecastResult',
      projectId: req.projectId,
      projectRevision: req.projectRevision,
      policyVersion: req.policyVersion,
      requestToken: req.requestToken,
      result: null,
      historicalAttributionAvailable: false,
      error: { code, message },
    });
  }

  #handleMessage(msg: AnalysisWorkerResponse): void {
    if (msg.type === 'AnalysisResult') {
      this.#onResultCallback?.(msg);
    } else if (msg.type === 'ForecastResult') {
      // Structural guard + stale-result rejection: only a well-formed response
      // matching the current project, revision, policy, and token may become
      // current (AC 18.4-2, AR-21).
      if (isForecastResultResponse(msg) && isCurrentForecastResult(this.#latestForecastRequest, msg)) {
        this.#onForecastResultCallback?.(msg);
      }
    } else if (msg.type === 'ScenarioEvaluationResult') {
      const pending = this.#scenarioPending.get(msg.scenarioId);
      if (pending && isCurrentScenarioEvaluation(pending.request, msg)) {
        this.#scenarioPending.delete(msg.scenarioId);
        if (pending.timeout !== null) clearTimeout(pending.timeout);
        if (msg.evaluation === null) {
          pending.reject(
            new ScenarioEvaluationError(msg.error?.code ?? 'SCENARIO_EVALUATION_FAILED', msg.error?.message ?? 'Scenario evaluation failed.'),
          );
        } else {
          pending.resolve(msg);
        }
      }
    } else if (msg.type === 'AnalysisResyncRequired') {
      this.#onResyncCallback?.(msg.projectId);
    }
  }

  terminate(): void {
    this.#terminated = true;
    this.#worker?.terminate();
    this.#worker = null;
    this.#fallbackEngine = null;
    this.#latestForecastRequest = null;
    this.#rejectAllScenarioRequests(new ScenarioEvaluationError('SCENARIO_EVALUATION_CANCELLED', 'The forecast worker was stopped.'));
  }
}
