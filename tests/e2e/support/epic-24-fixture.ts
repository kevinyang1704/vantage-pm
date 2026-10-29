/**
 * Epic 24 e2e support: build and import a deterministic workspace fixture
 * through the application's own portable-import path (the browser build has no
 * Import button). Mirrors the pattern in
 * `tests/e2e/forecast-staffing-recertification.spec.ts`.
 *
 * All values are synthetic and independently specified so the same numbers can
 * be asserted by the browser test and by a native run of the same file.
 */

import type { Browser, Page } from '@playwright/test';

export interface Epic24FeatureSpec {
  readonly id: string;
  readonly title: string;
  readonly deliveryStatus: 'not_started' | 'in_progress' | 'delivered';
  readonly startDate?: string | null;
  readonly endDate?: string | null;
  readonly parentId?: string | null;
  readonly nodeType?: 'Feature' | 'Component' | null;
}

export interface Epic24ThemeSpec {
  readonly id: string;
  readonly title: string;
  readonly features: readonly Epic24FeatureSpec[];
  readonly startDate?: string | null;
  readonly endDate?: string | null;
}

export interface Epic24ProjectSpec {
  readonly id: string;
  readonly name: string;
  readonly themes: readonly Epic24ThemeSpec[];
  /** Features parented to the Vision (no Theme ancestor). */
  readonly unattributed?: readonly Epic24FeatureSpec[];
}

/** Stable, valid UUIDv7 project ids for the fixtures. */
const PROJECT_ID_CANONICAL = '019ffea0-0000-7000-8000-000000000001';
const PROJECT_ID_LARGE = '019ffea0-0000-7000-8000-000000000002';

function nodeId(prefix: string, index: number): string {
  return `019ffea0-${prefix}-7000-8000-${index.toString(16).padStart(12, '0')}`;
}

/** Build a schema-v8 portable envelope JSON string for a project spec. */
export function buildEpic24PortableJson(project: Epic24ProjectSpec): string {
  const nodes: Record<string, unknown>[] = [];
  const visionId = project.id;
  let position = 1n;

  nodes.push({
    id: visionId,
    parentId: null,
    title: project.name,
    bodyText: null,
    position: position.toString(),
    nodeType: 'Vision',
    startDate: null,
    endDate: null,
    durationDays: null,
    scheduleSourceMode: null,
    completed: false,
    effortPoints: null,
    strategicWeight: null,
    phaseId: null,
    deliveryStatus: 'not_started',
  });
  position += 1n;

  for (const theme of project.themes) {
    nodes.push({
      id: theme.id,
      parentId: visionId,
      title: theme.title,
      bodyText: null,
      position: position.toString(),
      nodeType: 'Theme',
      startDate: theme.startDate ?? null,
      endDate: theme.endDate ?? null,
      durationDays: null,
      scheduleSourceMode: theme.startDate && theme.endDate ? 'start_end' : null,
      completed: false,
      effortPoints: null,
      strategicWeight: null,
      phaseId: null,
      deliveryStatus: 'not_started',
    });
    position += 1n;

    for (const feature of theme.features) {
      nodes.push({
        id: feature.id,
        parentId: feature.parentId ?? theme.id,
        title: feature.title,
        bodyText: null,
        position: position.toString(),
        nodeType: feature.nodeType ?? 'Feature',
        startDate: feature.startDate ?? null,
        endDate: feature.endDate ?? null,
        durationDays: null,
        scheduleSourceMode: feature.startDate && feature.endDate ? 'start_end' : null,
        completed: false,
        effortPoints: null,
        strategicWeight: null,
        phaseId: null,
        deliveryStatus: feature.deliveryStatus,
      });
      position += 1n;
    }
  }

  for (const feature of project.unattributed ?? []) {
    nodes.push({
      id: feature.id,
      parentId: visionId,
      title: feature.title,
      bodyText: null,
      position: position.toString(),
      nodeType: feature.nodeType ?? 'Feature',
      startDate: feature.startDate ?? null,
      endDate: feature.endDate ?? null,
      durationDays: null,
      scheduleSourceMode: feature.startDate && feature.endDate ? 'start_end' : null,
      completed: false,
      effortPoints: null,
      strategicWeight: null,
      phaseId: null,
      deliveryStatus: feature.deliveryStatus,
    });
    position += 1n;
  }

  return JSON.stringify({
    schemaVersion: 8,
    exportedAt: '2026-09-26T00:00:00.000Z',
    project: { id: project.id, name: project.name },
    phases: [],
    nodes,
    nodeCustomFields: [],
    typeTemplateFields: [],
    unlockEdges: [],
    findingDismissals: [],
    affectedReasons: [],
    openQuestions: [],
  });
}

/**
 * The canonical Epic 24 fixture, independently specified:
 *   - Theme "Measurement at scale": 5 Features -> 2 not started, 2 in progress, 1 delivered
 *   - Theme "Performance Transparency": 1 delivered Feature
 *   - Theme "Empty Theme": 0 Features
 *   - One unattributed Feature (in progress)
 * Project totals: 7 Features; 2 delivered.
 * Spans: May 1–Dec 1 and Sep 5–Sep 30 (shared timeline assertions).
 */
export function canonicalEpic24Project(): Epic24ProjectSpec {
  // Theme spans are DERIVED from descendant dated nodes (the existing
  // canonical rollup), so the dates live on the Features here.
  const measurement: Epic24ThemeSpec = {
    id: '019ffea0-0001-7000-8000-000000000001',
    title: 'Measurement at scale',
    features: [
      { id: '019ffea0-0011-7000-8000-000000000001', title: 'Experiment event collection', deliveryStatus: 'delivered', startDate: '2026-05-01', endDate: '2026-07-01' },
      { id: '019ffea0-0011-7000-8000-000000000002', title: 'Metric definitions', deliveryStatus: 'in_progress', startDate: '2026-06-01', endDate: '2026-09-01' },
      { id: '019ffea0-0011-7000-8000-000000000003', title: 'Results dashboard', deliveryStatus: 'in_progress', startDate: '2026-08-01', endDate: '2026-10-01' },
      { id: '019ffea0-0011-7000-8000-000000000004', title: 'Segment comparisons', deliveryStatus: 'not_started', startDate: '2026-09-01', endDate: '2026-11-01' },
      { id: '019ffea0-0011-7000-8000-000000000005', title: 'Measurement quality checks', deliveryStatus: 'not_started', startDate: '2026-10-01', endDate: '2026-12-01' },
    ],
  };
  const performance: Epic24ThemeSpec = {
    id: '019ffea0-0001-7000-8000-000000000002',
    title: 'Performance Transparency',
    features: [
      { id: '019ffea0-0012-7000-8000-000000000001', title: 'Experiment performance reporting', deliveryStatus: 'delivered', startDate: '2026-09-05', endDate: '2026-09-30' },
    ],
  };
  const empty: Epic24ThemeSpec = {
    id: '019ffea0-0001-7000-8000-000000000003',
    title: 'Empty Theme',
    features: [],
  };
  const unattributed: Epic24FeatureSpec = {
    id: '019ffea0-0013-7000-8000-000000000001',
    title: 'Unparented feature',
    deliveryStatus: 'in_progress',
    parentId: null,
  };

  return {
    id: PROJECT_ID_CANONICAL,
    name: 'Epic 24 Canonical',
    themes: [measurement, performance, empty],
    unattributed: [unattributed],
  };
}

/** Build a project with a single theme holding `count` Features (for paging). */
export function largeThemeProject(count: number): Epic24ProjectSpec {
  const features: Epic24FeatureSpec[] = Array.from({ length: count }, (_, i) => ({
    id: nodeId('0014', i),
    title: `Paged Feature ${String(i).padStart(3, '0')}`,
    deliveryStatus: 'not_started',
  }));
  return {
    id: PROJECT_ID_LARGE,
    name: 'Epic 24 Large',
    themes: [
      {
        id: '019ffea0-0001-7000-8000-000000000004',
        title: 'Large Theme',
        startDate: '2026-01-05',
        endDate: '2026-03-20',
        features,
      },
    ],
  };
}

/** Import a project spec into the current browser profile and reload. */
export async function importEpic24Project(page: Page, spec: Epic24ProjectSpec): Promise<void> {
  const raw = buildEpic24PortableJson(spec);
  // Import after the app has finished booting (its starter project is on the
  // shelf), as a user would. Importing mid-boot races the "create a starter
  // project when the workspace is empty" step.
  await page.locator('.pm-side-nav__project').first().waitFor({ timeout: 30_000 });
  const outcome = await page.evaluate(async (fileText) => {
    const importerUrl = '/src/application/portable-file/import-project.ts';
    const repositoryUrl = '/src/adapters/persistence/repository-worker.client.ts';
    const importer = (await import(/* @vite-ignore */ importerUrl)) as {
      importProject: (raw: string, exists: (id: string) => boolean, options?: { asNewProject?: boolean }) => { ok: true; candidate: unknown } | { ok: false; error: unknown };
    };
    const repository = (await import(/* @vite-ignore */ repositoryUrl)) as {
      batchImportPortable: (candidate: unknown) => Promise<{ ok: boolean; detail?: string }>;
    };
    // Import WITHOUT remapping so the fixture's stable node ids (and therefore
    // its `data-theme-id` attributes) survive into the rendered overview.
    const imported = importer.importProject(fileText, () => false);
    if (!imported.ok) return { ok: false, detail: JSON.stringify(imported.error) };
    const result = await repository.batchImportPortable(imported.candidate);
    return { ok: result.ok, detail: JSON.stringify(result) };
  }, raw);
  if (!outcome.ok) {
    throw new Error(`Epic 24 import failed: ${outcome.detail}`);
  }
  await page.reload();
}

/**
 * Open a fresh browser context pinned to a deterministic local date and import
 * the canonical Epic 24 project. Returns the page positioned on the workspace
 * overview with the imported project visible.
 */
export async function openEpic24Workspace(
  browser: Browser,
  productUrl: string,
  spec: Epic24ProjectSpec = canonicalEpic24Project(),
  todayIso = '2026-09-26',
): Promise<Page> {
  const context = await browser.newContext();
  await context.addInitScript((iso) => {
    (globalThis as Record<string, unknown>)['__PMAPP_TODAY_ISO__'] = iso;
  }, todayIso);
  const page = await context.newPage();
  await page.goto(productUrl);
  await importEpic24Project(page, spec);
  return page;
}
