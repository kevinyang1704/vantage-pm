import type { Page } from '@playwright/test';
import { allocateRun, type IsolatedRun } from './run-isolation';

export type UpdateCaseId =
  | 'DIRTY_STATE' | 'UNRESOLVED_COMMANDS' | 'OWNERSHIP_UNRESOLVED'
  | 'VERIFIED_BACKUP_UNAVAILABLE' | 'INCOMPATIBLE_ASSET_SCHEMA' | 'APPROVAL_REQUIRED'
  | 'CLEAN_COMPATIBLE_UPDATE'
  | 'BEFORE_PREPARED' | 'AFTER_PREPARED' | 'AFTER_SQLITE_CLOSE' | 'AFTER_VFS_PAUSE'
  | 'AFTER_LOCK_RELEASE' | 'AFTER_CONTROLLER_CHANGE' | 'AFTER_RELOAD' | 'AFTER_REACQUIRE'
  | 'DURING_MIGRATION' | 'AFTER_SUCCESS_COMMIT' | 'BEFORE_ACTIVE';

export type BlockedCaseId =
  | 'DIRTY_STATE' | 'UNRESOLVED_COMMANDS' | 'OWNERSHIP_UNRESOLVED'
  | 'VERIFIED_BACKUP_UNAVAILABLE' | 'INCOMPATIBLE_ASSET_SCHEMA' | 'APPROVAL_REQUIRED';

export type BlockedResult = Readonly<{
  type: 'ActivationBlocked';
  code: BlockedCaseId;
  controllerChanged: false;
  databaseMutated: false;
  currentAssetsRemainActive: true;
}>;

export type ActiveResult = Readonly<{
  events: readonly string[];
  expectedNewRoot: string;
  expectedTargetSchema: string;
  active: Readonly<{
    root: string;
    schema: string;
    quickCheck: 'ok';
    generalWritesEnabled: true;
  }>;
}>;

export type InterruptionResult = Readonly<{
  mixedAssetsWritable: false;
  controllerChanged: boolean;
  restart: Readonly<{
    mode: 'Recovery' | 'old-assets-active';
    writable: boolean;
  }>;
  oracle: Readonly<{
    partialSchemaWritable: false;
    dataLoss: false;
    duplicateReceipts: 0;
  }>;
}>;

type PageRunUpdateInput = Readonly<{
  namespace: string;
  runId: string;
  caseId: UpdateCaseId;
}>;

async function preparePage(page: Page): Promise<void> {
  await page.goto('/qualification.html');
  await page.locator('#qualification-status').waitFor({ state: 'attached' });
  const status = await page.locator('#qualification-status').textContent();
  if (status !== 'qualification-ready') throw new Error('CROSS_ORIGIN_ISOLATION_REQUIRED');
}

export async function createUpdateHarness(input: {
  caseId: UpdateCaseId;
  seed: string;
  page?: Page;
}) {
  if (!input.page) throw new Error('PLAYWRIGHT_PAGE_REQUIRED_FOR_REAL_BROWSER_AUTHORITY');
  await preparePage(input.page);
  const run: IsolatedRun = allocateRun(input.seed);
  const payload: PageRunUpdateInput = {
    namespace: run.opfsNamespace,
    runId: run.runId,
    caseId: input.caseId,
  };
  const call = <T>(variant: 'blocked' | 'active' | 'interruption') =>
    input.page!.evaluate(async (request) => {
      const api = (window as unknown as {
        __pmappQualification: {
          runUpdate: (payload: unknown) => Promise<Record<string, unknown>>;
        };
      }).__pmappQualification;
      if (typeof api.runUpdate !== 'function') throw new Error('RUN_UPDATE_NOT_EXPOSED');
      return api.runUpdate(request);
    }, { ...payload, variant }) as Promise<T>;
  return Object.freeze({
    async requestActivation(): Promise<BlockedResult> {
      return call<BlockedResult>('blocked');
    },
    async runToActive(): Promise<ActiveResult> {
      return call<ActiveResult>('active');
    },
    async runAndRestart(): Promise<InterruptionResult> {
      return call<InterruptionResult>('interruption');
    },
  });
}