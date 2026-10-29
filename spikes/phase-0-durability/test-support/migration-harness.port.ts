import type { Page } from '@playwright/test';
import { allocateRun, type IsolatedRun } from './run-isolation';

export type MigrationFaultPoint =
  | 'BEFORE_MIGRATION' | 'BEFORE_STEP_EXPAND' | 'AFTER_STEP_EXPAND'
  | 'BEFORE_STEP_COPY' | 'AFTER_STEP_COPY'
  | 'BEFORE_ATOMIC_COMMIT' | 'AFTER_SUCCESS_COMMIT';

export type MigrationRecoveryResult = Readonly<{
  backup: Readonly<{
    createdBeforeMutation: true;
    restorable: true;
    quickCheck: 'ok';
    digest: string;
  }>;
  restart: Readonly<{
    mode: 'CandidateV2' | 'VerifiedBackupV1';
    writable: boolean;
  }>;
  oracle: Readonly<{
    quickCheck: 'ok';
    partialSchemaWritable: false;
    partialMutation: false;
    duplicateReceipts: 0;
    revisionRegressed: false;
  }>;
}>;

type PageRunMigrationInput = Readonly<{
  namespace: string;
  runId: string;
  faultPoint: MigrationFaultPoint;
}>;

type PageRunMigrationResult = Readonly<MigrationRecoveryResult>;

async function preparePage(page: Page): Promise<void> {
  await page.goto('/qualification.html');
  await page.locator('#qualification-status').waitFor({ state: 'attached' });
  const status = await page.locator('#qualification-status').textContent();
  if (status !== 'qualification-ready') throw new Error('CROSS_ORIGIN_ISOLATION_REQUIRED');
}

export async function createMigrationHarness(input: {
  faultPoint: MigrationFaultPoint;
  seed: string;
  page?: Page;
}) {
  if (!input.page) throw new Error('PLAYWRIGHT_PAGE_REQUIRED_FOR_REAL_BROWSER_AUTHORITY');
  await preparePage(input.page);
  const run: IsolatedRun = allocateRun(input.seed);
  const payload: PageRunMigrationInput = {
    namespace: run.opfsNamespace,
    runId: run.runId,
    faultPoint: input.faultPoint,
  };
  return Object.freeze({
    async runAndRestart(): Promise<MigrationRecoveryResult> {
      return input.page!.evaluate(async (request) => {
        const api = (window as unknown as {
          __pmappQualification: {
            runMigration: (payload: unknown) => Promise<PageRunMigrationResult>;
          };
        }).__pmappQualification;
        if (typeof api.runMigration !== 'function') throw new Error('RUN_MIGRATION_NOT_EXPOSED');
        return api.runMigration(request);
      }, payload);
    },
  });
}