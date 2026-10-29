/**
 * Real-browser Forecast responsiveness harness (Story 23.10, AC 23.10-2/-3;
 * review R12). Opt-in: runs only with PMAPP_PERF=1.
 *
 * What it measures, in the real UI of whichever build BASE_URL serves:
 *   - keystroke-to-paint while typing in a live Points field, with one and
 *     then two saved scenario comparisons rendered (input `timeStamp` to the
 *     macrotask after the next animation frame, i.e. after that frame's
 *     paint); slow interactions are also recorded from the Event Timing API;
 *   - commit-to-paint for an estimate edit, split into commit-to-request,
 *     worker calculation (ForecastRequest posted -> ForecastResult received)
 *     and result-to-paint, from timestamps on the real analysis worker's
 *     messages;
 *   - scenario evaluation time in the worker for each saved comparison;
 *   - JS heap and DOM node count after a forced GC (Chrome DevTools Protocol).
 *
 * Fixtures come from tests/perf/support/staffing-benchmark.ts and are
 * imported through the app's own portable-import path (`importProject` +
 * `batchImportPortable`) inside the page, because the browser build has no
 * import UI. Shared-mode fixtures use schema 6 so the pre-staffing build
 * (9af96a2) imports the identical bytes.
 *
 * It asserts nothing about budgets: it records raw observations, the
 * distribution, warmup/sample counts and an environment manifest to
 * test-results/perf/*.json. The evidence report decides what they show.
 *
 *   PMAPP_PERF=1 PMAPP_PERF_LABEL=<label> PMAPP_PERF_MODES=staffed,shared \
 *   BASE_URL=http://127.0.0.1:5175 npx playwright test tests/e2e/forecast-staffing-ui.perf.spec.ts --project=chrome --workers=1
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '../support/fixtures';
import type { Page } from '@playwright/test';
import {
  benchmarkProjectName,
  buildBenchmarkPortableFile,
  type BenchmarkMode,
} from '../perf/support/staffing-benchmark';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const LABEL = process.env.PMAPP_PERF_LABEL ?? 'unlabelled';
const MODES = (process.env.PMAPP_PERF_MODES ?? 'staffed,shared').split(',') as BenchmarkMode[];
const TYPING_WARMUP = 5;
const TYPING_SAMPLES = 40;
const COMMIT_WARMUP = 2;
const COMMIT_SAMPLES = 10;

test.describe.configure({ mode: 'serial' });
test.setTimeout(20 * 60_000);

/** Installed before the app boots: worker message timestamps and keystroke-to-paint sampling. */
function installProbes(): void {
  type Perf = {
    armed: boolean;
    keys: Array<{ inputToFrame: number; inputToPaint: number }>;
    slowEvents: Array<{ name: string; duration: number }>;
    worker: Array<{ dir: 'out' | 'in'; type: string; token?: string; scenarioId?: string; t: number }>;
    /** Synchronous keystroke counter, used to sequence the typing loop without a race. */
    pressed: number;
  };
  const perf: Perf = { armed: false, keys: [], slowEvents: [], worker: [], pressed: 0 };
  (window as unknown as { __perf: Perf }).__perf = perf;

  const RealWorker = window.Worker;
  class ProbedWorker extends RealWorker {
    postMessage(message: unknown, ...rest: unknown[]): void {
      const m = message as { type?: string; requestToken?: string; scenarioId?: string } | null;
      if (m?.type) perf.worker.push({ dir: 'out', type: m.type, token: m.requestToken, scenarioId: m.scenarioId, t: performance.now() });
      (RealWorker.prototype.postMessage as (...a: unknown[]) => void).call(this, message, ...rest);
    }
    get onmessage(): ((this: Worker, ev: MessageEvent) => unknown) | null {
      return super.onmessage;
    }
    set onmessage(handler: ((this: Worker, ev: MessageEvent) => unknown) | null) {
      super.onmessage =
        handler === null
          ? null
          : (event: MessageEvent) => {
              const d = event.data as { type?: string; requestToken?: string; scenarioId?: string } | null;
              if (d?.type) perf.worker.push({ dir: 'in', type: d.type, token: d.requestToken, scenarioId: d.scenarioId, t: performance.now() });
              handler.call(this, event);
            };
    }
  }
  window.Worker = ProbedWorker as unknown as typeof Worker;

  document.addEventListener(
    'keydown',
    (e) => {
      if (!perf.armed) return;
      // Count the keydown synchronously so the typing loop can sequence on it
      // without a poll that races a re-render under load.
      perf.pressed += 1;
      const t0 = e.timeStamp;
      requestAnimationFrame(() => {
        const frame = performance.now();
        setTimeout(() => perf.keys.push({ inputToFrame: frame - t0, inputToPaint: performance.now() - t0 }), 0);
      });
    },
    true,
  );
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (perf.armed) perf.slowEvents.push({ name: entry.name, duration: entry.duration });
    }).observe({ type: 'event', durationThreshold: 16, buffered: false } as PerformanceObserverInit);
  } catch {
    // Event Timing unavailable: keystroke sampling above still runs.
  }
}

function stats(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN;
  return {
    n: sorted.length,
    min: sorted[0] ?? NaN,
    p50: at(0.5),
    p90: at(0.9),
    p95: at(0.95),
    max: sorted[sorted.length - 1] ?? NaN,
    mean: sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1),
  };
}

function manifest(browserVersion: string) {
  const sh = (cmd: string) => {
    try {
      return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return 'unavailable';
    }
  };
  return {
    label: LABEL,
    baseUrl: PRODUCT_APP_URL,
    harnessCommit: sh('git rev-parse HEAD'),
    harnessTreeClean: sh('git status --porcelain') === '',
    cpu: os.cpus()[0]?.model ?? 'unknown',
    logicalCores: os.cpus().length,
    totalMemoryGiB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    node: process.version,
    browser: browserVersion,
    recordedAt: new Date().toISOString(),
    labProfile: process.env.PMAPP_LAB_RUNNER
      ? `PINNED lab runner (${process.env.PMAPP_LAB_RUNNER}) per QUALITY-CONTRACT §3`
      : 'NOT the pinned lab runner (QUALITY-CONTRACT §3): a shared developer workstation',
  };
}

async function seed(page: Page, raw: string): Promise<void> {
  const result = await page.evaluate(async (fileText) => {
    // The dev server's own modules, so the import runs through the app's
    // running repository worker (same module instances as the app).
    const importerUrl = '/src/application/portable-file/import-project.ts';
    const repositoryUrl = '/src/adapters/persistence/repository-worker.client.ts';
    const importer = (await import(/* @vite-ignore */ importerUrl)) as {
      importProject: (raw: string, exists: (id: string) => boolean) => { ok: true; candidate: unknown } | { ok: false; error: unknown };
    };
    const repository = (await import(/* @vite-ignore */ repositoryUrl)) as {
      batchImportPortable: (candidate: unknown) => Promise<{ ok: boolean }>;
    };
    const imported = importer.importProject(fileText, () => false);
    if (!imported.ok) return { ok: false, detail: JSON.stringify(imported.error) };
    const outcome = await repository.batchImportPortable(imported.candidate);
    return { ok: Boolean(outcome.ok), detail: JSON.stringify(outcome) };
  }, raw);
  expect(result.ok, result.detail).toBe(true);
}

async function openForecast(page: Page, projectName: string, scenarioCount: number): Promise<void> {
  await page.reload();
  await expect(page.getByText('Storage Available')).toBeVisible({ timeout: 60_000 });
  await page.locator('.pm-side-nav__project').filter({ hasText: projectName }).first().click();
  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
  await expect(page.locator('.pm-forecast__completion-value')).toBeVisible({ timeout: 120_000 });
  const scenarios = page.getByRole('region', { name: 'Scenarios' });
  await expect(scenarios.locator('li.pm-forecast__cause')).toHaveCount(scenarioCount, { timeout: 120_000 });
  await expect(scenarios.getByText('Evaluating…')).toHaveCount(0, { timeout: 120_000 });
  await scenarios.scrollIntoViewIfNeeded();
}

async function measureTyping(page: Page) {
  const field = page.getByRole('spinbutton', { name: 'Points for Item 2', exact: true });
  await field.scrollIntoViewIfNeeded();
  await field.focus();
  await page.keyboard.press('End');
  // Sequence on the SYNCHRONOUS keydown counter: the keystroke sample is
  // pushed on a later frame/macrotask, so polling `keys.length` could race a
  // re-render under load. `pressed` increments inside the keydown listener.
  const press = async (key: string) => {
    const before = await page.evaluate(() => (window as unknown as { __perf: { pressed: number } }).__perf.pressed);
    await page.keyboard.press(key);
    try {
      await expect.poll(
        () => page.evaluate(() => (window as unknown as { __perf: { pressed: number } }).__perf.pressed),
        { timeout: 10_000, message: `key="${key}" before=${before}` },
      ).toBeGreaterThanOrEqual(before + 1);
    } catch (err) {
      const diag = await page.evaluate(() => ({
        armed: (window as unknown as { __perf: { armed: boolean } }).__perf.armed,
        pressed: (window as unknown as { __perf: { pressed: number } }).__perf.pressed,
        active: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? 'none',
        hasPerf: Boolean((window as unknown as { __perf?: unknown }).__perf),
      }));
      throw new Error(`${String(err)} | DIAG ${JSON.stringify(diag)}`);
    }
  };
  await page.evaluate(() => {
    const p = (window as unknown as { __perf: { armed: boolean; keys: unknown[]; slowEvents: unknown[] } }).__perf;
    p.keys = [];
    p.slowEvents = [];
    p.armed = true;
  });
  // Alternate a digit and Backspace: every keystroke changes the field; nothing commits (no blur).
  for (let k = 0; k < TYPING_WARMUP + TYPING_SAMPLES; k++) await press(k % 2 === 0 ? '7' : 'Backspace');
  const raw = await page.evaluate(() => {
    const p = (window as unknown as {
      __perf: { armed: boolean; keys: Array<{ inputToFrame: number; inputToPaint: number }>; slowEvents: Array<{ name: string; duration: number }> };
    }).__perf;
    p.armed = false;
    return { keys: p.keys, slowEvents: p.slowEvents };
  });
  await page.keyboard.press('Escape');
  const samples = raw.keys.slice(TYPING_WARMUP);
  return {
    warmup: TYPING_WARMUP,
    inputToPaintMs: stats(samples.map((s) => s.inputToPaint)),
    inputToFrameMs: stats(samples.map((s) => s.inputToFrame)),
    eventTimingOver16ms: raw.slowEvents,
    raw: samples,
  };
}

async function measureCommits(page: Page) {
  const field = page.getByRole('spinbutton', { name: 'Points for Item 2', exact: true });
  const original = Number(await field.inputValue());
  const observations: Array<{ commitToRequest: number; calculation: number; resultToPaint: number; commitToPaint: number }> = [];
  for (let k = 0; k < COMMIT_WARMUP + COMMIT_SAMPLES; k++) {
    const next = k % 2 === 0 ? original + 1 : original;
    await field.fill(String(next));
    const o = await page.evaluate(async () => {
      const perf = (window as unknown as { __perf: { worker: Array<{ dir: string; type: string; token?: string; t: number }> } }).__perf;
      const input = document.activeElement as HTMLInputElement;
      const nextPaint = () => new Promise<number>((r) => requestAnimationFrame(() => setTimeout(() => r(performance.now()), 0)));
      await nextPaint();
      const t0 = performance.now();
      input.blur();
      // Wait on the ACTUAL worker round trip for this commit, matched by the
      // request token, rather than guessing the resulting total. A DOM-value
      // equality check is a fragile proxy that can miss under load; the worker
      // messages are the ground truth and are what this AC measures.
      let request: { token?: string; t: number } | undefined;
      let result: { token?: string; t: number } | undefined;
      for (;;) {
        request = perf.worker.find((w) => w.dir === 'out' && w.type === 'ForecastRequest' && w.t >= t0);
        if (request) {
          result = perf.worker.find((w) => w.dir === 'in' && w.type === 'ForecastResult' && w.token === request!.token);
          if (result) break;
        }
        await new Promise((r) => requestAnimationFrame(r));
        if (performance.now() - t0 > 60_000) throw new Error('commit did not settle');
      }
      const tPaint = await nextPaint();
      return {
        commitToRequest: request!.t - t0,
        calculation: result!.t - request!.t,
        resultToPaint: tPaint - result!.t,
        commitToPaint: tPaint - t0,
      };
    });
    observations.push(o);
    await field.focus();
  }
  const samples = observations.slice(COMMIT_WARMUP);
  return {
    warmup: COMMIT_WARMUP,
    commitToPaintMs: stats(samples.map((s) => s.commitToPaint)),
    commitToRequestMs: stats(samples.map((s) => s.commitToRequest)),
    calculationMs: stats(samples.map((s) => s.calculation)),
    resultToPaintMs: stats(samples.map((s) => s.resultToPaint)),
    raw: samples,
  };
}

async function scenarioEvaluationTimes(page: Page) {
  return page.evaluate(() => {
    const log = (window as unknown as { __perf: { worker: Array<{ dir: string; type: string; token?: string; scenarioId?: string; t: number }> } }).__perf.worker;
    return log
      .filter((w) => w.dir === 'out' && w.type === 'ScenarioEvaluationRequest')
      .map((req) => {
        const res = log.find((w) => w.dir === 'in' && w.type === 'ScenarioEvaluationResult' && w.token === req.token);
        return res ? res.t - req.t : null;
      })
      .filter((d): d is number => d !== null);
  });
}

async function memory(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('Performance.enable');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const pick = (name: string) => metrics.find((m) => m.name === name)?.value ?? null;
  const domNodes = await page.evaluate(() => document.getElementsByTagName('*').length);
  await cdp.detach();
  return {
    jsHeapUsedMiB: (pick('JSHeapUsedSize') ?? 0) / 1024 ** 2,
    jsHeapTotalMiB: (pick('JSHeapTotalSize') ?? 0) / 1024 ** 2,
    cdpNodes: pick('Nodes'),
    domElements: domNodes,
  };
}

for (const mode of MODES) {
  for (const scenarioCount of [1, 2] as const) {
    test(`forecast UI responsiveness @lab — ${mode}, ${scenarioCount} visible comparison(s)`, async ({ page, browser }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.addInitScript(installProbes);
      await page.goto(PRODUCT_APP_URL);
      await expect(page.getByText('Storage Available')).toBeVisible({ timeout: 60_000 });
      const raw = buildBenchmarkPortableFile(mode, scenarioCount);
      await seed(page, raw);
      const loadStart = Date.now();
      await openForecast(page, benchmarkProjectName(mode, scenarioCount), scenarioCount);
      const openToSettledMs = Date.now() - loadStart;

      const typing = await measureTyping(page);
      const commits = await measureCommits(page);
      const evaluations = await scenarioEvaluationTimes(page);
      const mem = await memory(page);

      const record = {
        manifest: manifest(browser.version()),
        fixture: {
          mode,
          scenarioCount,
          items: 5000,
          people: mode === 'staffed' ? 100 : 0,
          assignmentEdges: mode === 'staffed' ? 10000 : 0,
          distribution: 'tests/perf/support/staffing-benchmark.ts (22.9 feasible fixture)',
          portableBytes: raw.length,
        },
        openToSettledMs,
        typing,
        commits,
        scenarioEvaluationMs: { raw: evaluations, ...stats(evaluations) },
        memory: mem,
      };
      const dir = path.join('test-results', 'perf');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `forecast-ui-${LABEL}-${mode}-${scenarioCount}.json`);
      writeFileSync(file, JSON.stringify(record, null, 2));
      console.log(
        `[perf ${LABEL} ${mode} ${scenarioCount}] keystroke-to-paint p50=${typing.inputToPaintMs.p50.toFixed(1)}ms p95=${typing.inputToPaintMs.p95.toFixed(1)}ms; ` +
          `commit-to-paint p50=${commits.commitToPaintMs.p50.toFixed(1)}ms (calc p50=${commits.calculationMs.p50.toFixed(1)}ms); ` +
          `heap=${mem.jsHeapUsedMiB.toFixed(1)}MiB dom=${mem.domElements} -> ${file}`,
      );
    });
  }
}
