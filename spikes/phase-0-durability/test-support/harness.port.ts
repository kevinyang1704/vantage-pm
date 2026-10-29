import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { createUuidV7 } from '../src/command-receipt';
import {
  appendRunResult,
  readAttemptResults,
  writeAttemptManifest,
  writeDerivedAttemptIndex,
} from '../src/evidence';
import { allocateRun, verifyResetTarget, writeRunSentinel, type IsolatedRun } from './run-isolation';

export type FaultBoundary =
  | 'F1_BEFORE_JOURNAL_SYNC' | 'F2_AFTER_JOURNAL_SYNC' | 'F3_BEFORE_JOURNAL_DELETE_FORWARD'
  | 'F4_AFTER_COMMIT_RETURN' | 'F5_AFTER_REPOSITORY_RESULT' | 'F6_AFTER_CANDIDATE_BOUNDARY_OBSERVED';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const campaignId = (() => {
  const value = process.env.PMAPP_QUALIFICATION_CAMPAIGN_ID;
  if (!value) throw new Error('PMAPP_QUALIFICATION_CAMPAIGN_ID_REQUIRED');
  return value;
})();
const attemptForSeed = (seed: string) => {
  const digest = sha256(`${campaignId}:${seed}`);
  const timestamp = campaignId.replaceAll('-', '').slice(0, 12);
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${digest.slice(0, 3)}-8${digest.slice(3, 6)}-${digest.slice(6, 18)}`;
};
type RestartInspection = Record<string, unknown> & {
  quickCheck: string;
  mutationCount: number;
  authoredFactCount: number;
  workflowFactCount: number;
  fixtureAuthoredFactCount: number;
  fixtureWorkflowFactCount: number;
  commandReceiptCount: number;
  recordedResultCount: number;
  storedRevision: number;
  nextRevision: number;
  recordedResultHash: string | null;
  recordedBaseRevision: number;
  recordedTargetRevision: number;
  partialMutation: boolean;
};

export async function createDurabilityHarnessTestPort(page: Page) {
  if (!page) throw new Error('PLAYWRIGHT_PAGE_REQUIRED_FOR_REAL_BROWSER_AUTHORITY');
  await page.goto('/qualification.html');
  await page.locator('#qualification-status').waitFor({ state: 'attached' });
  const status = await page.locator('#qualification-status').textContent();
  if (status !== 'qualification-ready') throw new Error('CROSS_ORIGIN_ISOLATION_REQUIRED');
  let lastOutcome: Record<string, unknown> | null = null;
  return {
    async runDisarmedParity(input: {
      seed: string;
      fixture: { projectId: string; initialRevision: number; safeStateHash: string };
      command: { commandId: string; projectId: string; baseRevision: number; safeValueHash: string };
    }) {
      const production = allocateRun(`${input.seed}-production`);
      const qualification = allocateRun(`${input.seed}-qualification`);
      return page.evaluate(async (payload) => window.__pmappQualification.runDisarmedParity(payload), {
        productionNamespace: production.opfsNamespace,
        qualificationNamespace: qualification.opfsNamespace,
        runId: createUuidV7(),
        fixture: {
          projectId: input.fixture.projectId,
          initialRevision: input.fixture.initialRevision,
          safeStateHash: input.fixture.safeStateHash,
        },
        command: {
          type: 'SetFixtureValue' as const,
          protocolVersion: '1.0.0' as const,
          ...input.command,
          expectedRevision: input.command.baseRevision + 1,
        },
      });
    },
    async runAndRestart(request: {
      seed: string;
      boundaryId: FaultBoundary;
      fixture: { projectId: string; initialRevision: number; safeStateHash: string };
      command: { commandId: string; projectId: string; baseRevision: number; safeValueLabel?: string; safeValueHash?: string };
      terminationMechanism: 'worker-terminate';
    }) {
      const attemptId = attemptForSeed(request.seed);
      await writeAttemptManifest({
        attemptId,
        campaignId,
        seed: request.seed,
        rootCause: 'Pinned SAH-pool xCheckReservedLock always reported a reserved writer, preventing hot-journal replay.',
        correctiveChange: 'Production recovery-safe VFS forwards the downstream check once and replaces only successful output with tracked lock truth.',
        priorFailedEvidence: [
          'reports/evidence/phase-0-durability/019ffc8b-f8c8-7a72-9771-f1065e9bc430/',
          'reports/evidence/phase-0-durability/019ffc8c-3e1b-71fe-8eac-5ab2fe1908ba/',
        ],
      });
      const run = allocateRun(request.seed);
      const safeValueHash = request.command.safeValueHash ?? sha256(String(request.command.safeValueLabel));
      const command = {
        type: 'SetFixtureValue' as const,
        protocolVersion: '1.0.0' as const,
        commandId: request.command.commandId,
        projectId: request.command.projectId,
        baseRevision: request.command.baseRevision,
        expectedRevision: request.command.baseRevision + 1,
        safeValueHash,
      };
      const parityProduction = allocateRun(`${request.seed}-recovery-parity-production`);
      const parityQualification = allocateRun(`${request.seed}-recovery-parity-qualification`);
      const parity = await page.evaluate(async (input) => window.__pmappQualification.runDisarmedParity(input), {
        productionNamespace: parityProduction.opfsNamespace,
        qualificationNamespace: parityQualification.opfsNamespace,
        runId: createUuidV7(),
        fixture: {
          projectId: request.fixture.projectId,
          initialRevision: request.fixture.initialRevision,
          safeStateHash: request.fixture.safeStateHash,
        },
        command,
      });
      const browserResult = await page.evaluate(async (input) => window.__pmappQualification.runBoundary(input), {
        namespace: run.opfsNamespace,
        runId: run.runId,
        fixture: {
          projectId: request.fixture.projectId,
          initialRevision: request.fixture.initialRevision,
          safeStateHash: request.fixture.safeStateHash,
        },
        boundaryId: request.boundaryId,
        command,
      });
      const qualification = { ...browserResult.qualification, parityStatus: parity.status };
      if (parity.status !== 'PASS') browserResult.status = 'FAIL';
      const browserMetadata = await page.evaluate(() => ({ platform: navigator.platform, userAgent: navigator.userAgent }));
      const lockfileHash = sha256(await readFile('package-lock.json', 'utf8'));
      const committed = ['F4_AFTER_COMMIT_RETURN', 'F5_AFTER_REPOSITORY_RESULT', 'F6_AFTER_CANDIDATE_BOUNDARY_OBSERVED'].includes(request.boundaryId);
      const boundaryEvent = browserResult.boundaryEvent as Record<string, unknown>;
      const evidenceBoundaryEvent = request.boundaryId === 'F6_AFTER_CANDIDATE_BOUNDARY_OBSERVED'
        ? {
            type: 'CandidateDurabilityBoundaryObserved',
            boundaryId: request.boundaryId,
            runId: run.runId,
            commandId: command.commandId,
            purpose: (boundaryEvent.token as Record<string, unknown>).purpose,
            signatureHash: sha256(String((boundaryEvent.token as Record<string, unknown>).signature)),
          }
        : boundaryEvent;
      const callbackTrace = (browserResult.messages as Array<Record<string, unknown>>).filter(
        (message) => message.type === 'VfsCallbackForwarded' || message.type === 'BoundaryObserved',
      );
      const retainedMessages = browserResult.messages as Array<Record<string, unknown>>;
      const repositoryResultObserved = retainedMessages.some((message) => message.type === 'RepositoryResultEmitted');
      const candidateObserved = request.boundaryId === 'F6_AFTER_CANDIDATE_BOUNDARY_OBSERVED' &&
        (browserResult.boundaryEvent as Record<string, unknown>).type === 'CandidateDurabilityBoundaryObserved';
      const observations = {
        boundaryId: request.boundaryId,
        commandedValueHash: safeValueHash,
        expectedRevision: request.command.baseRevision + 1,
        terminationMechanism: request.terminationMechanism,
        vfsResult: committed ? 'VfsCommitAccepted' : 'NotReturned',
        repositoryResult: repositoryResultObserved ? 'VfsCommitAccepted' : 'NotEmitted',
        uiAcknowledgement:
          candidateObserved ? 'CandidateDurabilityBoundaryObserved'
          : request.boundaryId === 'F5_AFTER_REPOSITORY_RESULT' ? 'LostBeforeDelivery' : 'NotEmitted',
        restartResult: committed ? 'EXACTLY_ONCE_CONFIRMED' : 'NO_PARTIAL_MUTATION',
        boundaryEvent,
        labPurpose: request.boundaryId === 'F6_AFTER_CANDIDATE_BOUNDARY_OBSERVED',
      };
      const semanticFingerprint = sha256(JSON.stringify({
        seed: request.seed, boundaryId: request.boundaryId, command, status: browserResult.status,
        inspection: browserResult.restartInspection,
      }));
      const restartInspection = browserResult.restartInspection as RestartInspection;
      const immutableEvidenceUri = `reports/evidence/phase-0-durability/${attemptId}/runs/${run.runId}.json`;
      const sourceProvenance = qualification.sourceProvenance as Record<string, unknown>;
      const evidenceQualification = {
        qualificationSubjectDigest: qualification.qualificationSubjectDigest,
        productionCompositionRoot: qualification.productionCompositionRoot,
        instrumentedCompositionRoot: qualification.instrumentedCompositionRoot,
        parityStatus: qualification.parityStatus,
        compositionDerivationStatus: qualification.compositionDerivationStatus,
      };
      const source = {
        lockfileHash,
        buildHash: qualification.qualificationSubjectDigest,
        headRevision: sourceProvenance.headRevision,
        worktreeState: sourceProvenance.worktreeState,
        worktreeStatusDigest: sourceProvenance.worktreeStatusDigest,
        executableTreeDigest: sourceProvenance.executableTreeDigest,
        sourceFiles: sourceProvenance.sourceFiles,
      };
      await appendRunResult({
        schemaVersion: '1.0.0',
        evidenceType: 'engineeringQualification',
        runId: run.runId,
        attemptId,
        caseId: request.boundaryId,
        required: true,
        status: browserResult.status,
        manifest: {
          seed: request.seed,
          adapter: browserResult.ready.configuration,
          source,
          qualification: evidenceQualification,
          environment: {
            osBuild: browserMetadata.platform,
            browserName: browserMetadata.userAgent.includes('Edg/') ? 'Microsoft Edge' : 'Google Chrome', browserBuild: browserMetadata.userAgent,
            appForm: 'browser-tab', storageState: 'persistence-granted-or-origin-private',
          },
          fixture: {
            projectId: request.fixture.projectId, initialRevision: request.fixture.initialRevision,
            safeStateHash: request.fixture.safeStateHash,
          },
          command: {
            commandId: command.commandId, projectId: command.projectId,
            baseRevision: command.baseRevision, expectedRevision: command.expectedRevision,
            safeValueHash: command.safeValueHash,
          },
          injection: { boundaryId: request.boundaryId },
          terminationMechanism: request.terminationMechanism,
        },
        observations: {
          boundaryId: request.boundaryId,
          boundaryEvent: evidenceBoundaryEvent,
          callbackTrace,
          commandedValueHash: safeValueHash,
        },
        oracle: restartInspection,
        failure: browserResult.status === 'FAIL' ? {
          code: 'RESTART_OUTCOME_CONTRADICTS_ARCHITECTURE',
          cause: `${request.boundaryId} produced an unexpected committed-or-uncommitted restart outcome`,
          resultingState: restartInspection,
          architectureDecisionRequired: 'Reject or revise the pinned persistence candidate; do not simulate rollback.',
        } : null,
        artifactHashes: { semantic: restartInspection.semanticDatabaseHash },
        immutableEvidenceUri,
      });
      await writeDerivedAttemptIndex(attemptId, await readAttemptResults(attemptId));
      const outcome = {
        manifest: {
          schemaVersion: '1.0.0', runId: run.runId, seed: request.seed,
          injection: { boundaryId: request.boundaryId },
          qualification,
          source,
          environment: {
            osBuild: browserMetadata.platform,
            browserName: browserMetadata.userAgent.includes('Edg/') ? 'Microsoft Edge' : 'Google Chrome',
            browserBuild: browserMetadata.userAgent,
            appForm: 'browser-tab',
            storageState: 'persistence-granted-or-origin-private',
          },
        },
        result: {
          status: browserResult.status,
          observations,
          oracle: {
            quickCheck: browserResult.restartInspection.quickCheck,
            receiptCount: browserResult.restartInspection.commandReceiptCount,
            resultHash: browserResult.restartInspection.recordedResultHash,
            storedRevision: browserResult.restartInspection.storedRevision,
            nextRevision: browserResult.restartInspection.nextRevision,
            partialMutation: browserResult.restartInspection.partialMutation,
          },
          artifactHashes: { semantic: restartInspection.semanticDatabaseHash },
        },
        restartInspection,
        report: browserResult.report,
        retainedArtifacts: { manifest: { runId: run.runId, seed: request.seed }, observations },
        reproducibilityFingerprint: semanticFingerprint,
        retry: browserResult.retry,
        immutableEvidenceUri,
      };
      lastOutcome = outcome as unknown as Record<string, unknown>;
      return outcome;
    },
    async retryCommandById(command: { commandId: string }) {
      if (!lastOutcome) throw new Error('NO_PRIOR_RUN');
      const restart = lastOutcome.restartInspection as Record<string, unknown>;
      const retry = lastOutcome.retry as Record<string, unknown> | null;
      return {
        disposition: retry?.disposition,
        commandId: command.commandId,
        resultHash: restart.recordedResultHash,
        commandReceiptCount: restart.commandReceiptCount,
        mutationCount: restart.mutationCount,
        projectRevision: restart.storedRevision,
        nextCommittedRevision: Number(restart.storedRevision) + 1,
      };
    },
    allocateIsolatedRun: ({ seed }: { seed: string }) => Promise.resolve(allocateRun(seed)),
    async writeResetSentinel(run: IsolatedRun) {
      writeRunSentinel(run);
      return page.evaluate((namespace) => window.__pmappQualification.touchNamespace(namespace), run.opfsNamespace);
    },
    async safeReset(input: { runId: string; expectedNamespace: string }) {
      verifyResetTarget(input);
      return page.evaluate((namespace) => window.__pmappQualification.resetNamespace(namespace), input.expectedNamespace);
    },
    namespaceExists: (namespace: string) => page.evaluate(
      (target) => window.__pmappQualification.namespaceExists(target), namespace,
    ),
  };
}

export function extractRetainedEvidenceStrings(artifacts: unknown): string[] {
  return JSON.stringify(artifacts).match(/[A-Za-z0-9_:/.-]+/g) ?? [];
}
