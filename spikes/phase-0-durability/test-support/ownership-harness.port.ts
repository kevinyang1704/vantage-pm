import { createHash } from 'node:crypto';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import type { BrowserContext, CDPSession, Page } from '@playwright/test';
import { createUuidV7 } from '../src/command-receipt';
import { adjudicateOwnershipJournal, type OwnershipCaseId, type OwnershipEvidenceEvent } from '../src/evidence-contract';
import { appendRunResult, readAttemptResults, writeAttemptManifest, writeDerivedAttemptIndex } from '../src/evidence';
import { REPOSITORY_WRITE_LOCK } from '../src/ownership-protocol';
import { allocateRun, type IsolatedRun } from './run-isolation';

type Json = Record<string, unknown>;
type Variant = OwnershipEvidenceEvent['variant'];
type OwnershipPageApi = {
  ownershipStart(input: Json): Promise<Json>;
  ownershipApply(input: Json): Promise<Json>;
  ownershipHandoff(input: Json): Promise<Json>;
  ownershipInspect(input: Json): Promise<Json>;
  ownershipTerminateWorker(input: Json): Promise<Json>;
  ownershipDispose(input: Json): Promise<Json>;
  qualificationIdentity(): Promise<Json>;
  runDisarmedParity(input: Json): Promise<Json>;
};
type Actor = { actorId: string; contextId: string; ownerSessionId: string | null; writerEpoch: number; page: Page };
type SuccessorReady = Readonly<Json & {
  type: 'OwnerReady';
  ownerSessionId: string;
  writerEpoch: number;
  lifecycleEvents: readonly string[];
}>;
type SuccessorBusy = Readonly<Json & { type: 'StorageBusy'; code: 'REPOSITORY_WRITER_BUSY' }>;
type SuccessorTerminal = Readonly<Json & {
  type: 'StorageUnavailable' | 'OwnershipFailed' | 'QualificationFailure' | 'QualificationBlocked';
}>;
type SuccessorStartResult = SuccessorReady | SuccessorBusy | SuccessorTerminal;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const campaignId = process.env.PMAPP_QUALIFICATION_CAMPAIGN_ID ?? (() => { throw new Error('PMAPP_QUALIFICATION_CAMPAIGN_ID_REQUIRED'); })();
const attemptId = (() => {
  const digest = sha256(`${campaignId}:story-1-2-review-repair`);
  const timestamp = campaignId.replaceAll('-', '').slice(0, 12);
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${digest.slice(0, 3)}-8${digest.slice(3, 6)}-${digest.slice(6, 18)}`;
})();
const KNOWN_BAD_ATTEMPT = 'reports/evidence/phase-0-durability/019ffd50-0000-7e76-8216-9330e894b9d0/';
const fixture = Object.freeze({
  projectId: '01992f5c-7a10-7cc4-8b11-89ea06c8f9f4', initialRevision: 7,
  safeStateHash: sha256('story-1-2-fixture'),
});
const SUCCESSOR_ACQUISITION_ATTEMPTS = 5;
const MAXIMUM_RECOVERY_TIME_MS = 3_000;

async function pageCall<T>(page: Page, method: keyof OwnershipPageApi, input: Json): Promise<T> {
  return page.evaluate(async ({ method, input }) => {
    const api = (window as unknown as { __pmappQualification: OwnershipPageApi }).__pmappQualification;
    const callable = api[method] as (payload: Json) => Promise<unknown>;
    if (typeof callable !== 'function') throw new Error(`OWNERSHIP_PAGE_API_MISSING:${method}`);
    return callable(input);
  }, { method, input }) as Promise<T>;
}

async function preparePage(page: Page) {
  await page.goto('/qualification.html');
  await page.locator('#qualification-status').waitFor({ state: 'attached' });
  if (await page.locator('#qualification-status').textContent() !== 'qualification-ready') throw new Error('CROSS_ORIGIN_ISOLATION_REQUIRED');
}

const makeActor = (page: Page, actorId: string): Actor => ({ actorId, contextId: createUuidV7(), ownerSessionId: null, writerEpoch: 0, page });
const startInput = (actor: Actor, run: IsolatedRun): Json => ({
  actorId: actor.actorId, namespace: run.opfsNamespace, runId: run.runId, connectionId: createUuidV7(),
  contextId: actor.contextId, fixture,
});

function resourceFor(type: string): OwnershipEvidenceEvent['resource'] {
  if (type.startsWith('WebLock')) return 'web-lock';
  if (type.startsWith('SAH') || type === 'VfsPaused') return 'sah-pool';
  if (type.includes('SQLite') || type === 'StatementsClosed') return 'sqlite';
  if (type.includes('Worker')) return 'worker';
  if (type.includes('Page') || type.includes('Frozen')) return 'page';
  return 'repository';
}

function outcomeFor(type: string): OwnershipEvidenceEvent['outcome'] {
  if (type.includes('Acquired') || type === 'SQLiteOpened') return 'acquired';
  if (type.includes('Released') || ['SQLiteClosed', 'VfsPaused', 'StatementsClosed'].includes(type)) return 'released';
  if (type.includes('Ready')) return 'ready';
  if (type.includes('Busy')) return 'busy';
  if (type.includes('Rejected')) return 'rejected';
  if (type.includes('Terminated') || type.includes('Closed')) return 'terminated';
  if (type.includes('Failure') || type.includes('Failed')) return 'failed';
  return 'attempted';
}

function journal() {
  const events: OwnershipEvidenceEvent[] = [];
  const append = (run: IsolatedRun, variant: Variant, actor: Actor, type: string, detail: Json = {}) => {
    const event: OwnershipEvidenceEvent = Object.freeze({
      sequence: events.length + 1, runId: run.runId, namespace: run.opfsNamespace, variant,
      actorId: actor.actorId, contextId: String(detail.contextId ?? actor.contextId),
      ownerSessionId: detail.ownerSessionId === null ? null : String(detail.ownerSessionId ?? actor.ownerSessionId ?? '') || null,
      writerEpoch: Number(detail.writerEpoch ?? actor.writerEpoch), resource: resourceFor(type), type,
      outcome: outcomeFor(type), requestId: typeof detail.requestId === 'string' ? detail.requestId : null,
      commandId: typeof detail.commandId === 'string' ? detail.commandId : null,
      baseRevision: Number.isSafeInteger(detail.baseRevision) ? Number(detail.baseRevision) : null,
      targetRevision: Number.isSafeInteger(detail.targetRevision) ? Number(detail.targetRevision) : null,
      quickCheck: detail.quickCheck === 'ok' ? 'ok' : null,
      mutationCount: Number.isSafeInteger(detail.mutationCount) ? Number(detail.mutationCount) : null,
      receiptCount: Number.isSafeInteger(detail.commandReceiptCount ?? detail.receiptCount) ? Number(detail.commandReceiptCount ?? detail.receiptCount) : null,
      resultCount: Number.isSafeInteger(detail.recordedResultCount ?? detail.resultCount) ? Number(detail.recordedResultCount ?? detail.resultCount) : null,
      partialMutation: typeof detail.partialMutation === 'boolean' ? detail.partialMutation : null,
    });
    events.push(event);
    return event;
  };
  return { events, append };
}

function recordLifecycle(target: ReturnType<typeof journal>, run: IsolatedRun, variant: Variant, actor: Actor, result: Json) {
  if (result.type === 'OwnerReady') {
    actor.ownerSessionId = String(result.ownerSessionId);
    actor.writerEpoch = Number(result.writerEpoch);
    for (const eventName of result.lifecycleEvents as string[]) target.append(run, variant, actor, eventName, result);
    target.append(run, variant, actor, 'OwnerReady', result);
  } else target.append(run, variant, actor, String(result.type), result);
}

function typedResultDetail(result: Json): string {
  const type = typeof result.type === 'string' ? result.type : 'UnknownResult';
  const code = typeof result.code === 'string' ? `:${result.code}` : '';
  const detail = typeof result.detail === 'string' ? `:${result.detail}` : '';
  return `${type}${code}${detail}`;
}

function successorStartResult(result: Json): SuccessorStartResult {
  if (result.type === 'OwnerReady') {
    if (
      typeof result.ownerSessionId !== 'string'
      || !Number.isSafeInteger(result.writerEpoch)
      || !Array.isArray(result.lifecycleEvents)
    ) throw new Error(`SUCCESSOR_ACQUISITION_MALFORMED:${typedResultDetail(result)}`);
    return result as SuccessorReady;
  }
  if (result.type === 'StorageBusy' && result.code === 'REPOSITORY_WRITER_BUSY') return result as SuccessorBusy;
  if ([
    'StorageUnavailable', 'OwnershipFailed', 'QualificationFailure', 'QualificationBlocked',
  ].includes(String(result.type))) return result as SuccessorTerminal;
  throw new Error(`SUCCESSOR_ACQUISITION_MALFORMED:${typedResultDetail(result)}`);
}

function remainingRecoveryTime(deadline: number): number {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error('SUCCESSOR_RECOVERY_DEADLINE_EXCEEDED');
  return remainingMs;
}

async function pageCallBeforeDeadline<T>(
  page: Page,
  method: keyof OwnershipPageApi,
  input: Json,
  deadline: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadlineExceeded = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('SUCCESSOR_RECOVERY_DEADLINE_EXCEEDED')), remainingRecoveryTime(deadline));
  });
  try {
    return await Promise.race([pageCall<T>(page, method, input), deadlineExceeded]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function disposeSuccessorAttempt(actor: Actor): Promise<void> {
  await pageCall(actor.page, 'ownershipDispose', { actorId: actor.actorId });
}

async function waitForRepositoryLockRelease(page: Page, deadline: number): Promise<void> {
  try {
    await page.waitForFunction(async (lockName) => {
      const snapshot = await navigator.locks.query();
      return !snapshot.held?.some((lock) => lock.name === lockName);
    }, REPOSITORY_WRITE_LOCK, { timeout: remainingRecoveryTime(deadline) });
  } catch (error) {
    if (Date.now() >= deadline) throw new Error('SUCCESSOR_RECOVERY_DEADLINE_EXCEEDED', { cause: error });
    throw error;
  }
}

async function startSuccessor(
  target: ReturnType<typeof journal>,
  run: IsolatedRun,
  variant: Variant,
  actor: Actor,
): Promise<Json> {
  const deadline = Date.now() + MAXIMUM_RECOVERY_TIME_MS;
  await waitForRepositoryLockRelease(actor.page, deadline);
  let lastBusy: SuccessorBusy | null = null;
  for (let attempt = 0; attempt < SUCCESSOR_ACQUISITION_ATTEMPTS; attempt += 1) {
    let result: SuccessorStartResult;
    try {
      result = successorStartResult(await pageCallBeforeDeadline<Json>(
        actor.page, 'ownershipStart', startInput(actor, run), deadline,
      ));
    } catch (error) {
      await disposeSuccessorAttempt(actor);
      throw error;
    }
    recordLifecycle(target, run, variant, actor, result);
    if (result.type === 'OwnerReady') return result;
    await disposeSuccessorAttempt(actor);
    if (result.type !== 'StorageBusy') {
      throw new Error(`SUCCESSOR_ACQUISITION_FAILED:${typedResultDetail(result)}`);
    }
    lastBusy = result;
    if (attempt + 1 < SUCCESSOR_ACQUISITION_ATTEMPTS) {
      try {
        await waitForRepositoryLockRelease(actor.page, deadline);
      } catch (error) {
        if (error instanceof Error && error.message === 'SUCCESSOR_RECOVERY_DEADLINE_EXCEEDED') break;
        throw error;
      }
    }
  }
  throw new Error(`SUCCESSOR_ACQUISITION_EXHAUSTED:${typedResultDetail(lastBusy ?? {})}`);
}

async function inspect(actor: Actor, commandId: string) {
  const wrapped = await pageCall<Json>(actor.page, 'ownershipInspect', {
    actorId: actor.actorId, requestId: createUuidV7(), contextId: actor.contextId,
    ownerSessionId: actor.ownerSessionId, writerEpoch: actor.writerEpoch, projectId: fixture.projectId, commandId,
  });
  return (wrapped.inspection as Json | undefined) ?? wrapped;
}

async function applySuccessor(target: ReturnType<typeof journal>, run: IsolatedRun, variant: Variant, actor: Actor, baseRevision: number) {
  const requestId = createUuidV7();
  const commandId = createUuidV7();
  const result = await pageCall<Json>(actor.page, 'ownershipApply', {
    actorId: actor.actorId, requestId, contextId: actor.contextId, ownerSessionId: actor.ownerSessionId,
    writerEpoch: actor.writerEpoch,
    command: {
      type: 'SetFixtureValue', protocolVersion: '1.0.0', commandId, projectId: fixture.projectId,
      baseRevision, expectedRevision: baseRevision + 1, safeValueHash: sha256(`${variant}:successor`),
    },
  });
  if (result.type !== 'CommandApplied') throw new Error(`SUCCESSOR_FIRST_COMMAND_REJECTED:${typedResultDetail(result)}`);
  target.append(run, variant, actor, 'SuccessorCommandApplied', {
    ...result, requestId, commandId, baseRevision, targetRevision: baseRevision + 1,
  });
  const inspection = await inspect(actor, commandId);
  target.append(run, variant, actor, 'SuccessorCommandInspected', {
    ...inspection, requestId, commandId, baseRevision, targetRevision: baseRevision + 1,
  });
  return { result, inspection, commandId };
}

async function observeEnvironment(page: Page, browserContext: BrowserContext) {
  const browser = await page.evaluate(async () => ({
    userAgent: navigator.userAgent,
    persisted: await navigator.storage.persisted() || await navigator.storage.persist(),
  }));
  const browserBuild = browserContext.browser()?.version() ?? 'unavailable';
  const isChrome = /Chrome\/[0-9.]+/.test(browser.userAgent) && !browser.userAgent.includes('Edg/') && !browser.userAgent.includes('Headless');
  const isEdge = /Edg\/[0-9.]+/.test(browser.userAgent) && !browser.userAgent.includes('Headless');
  const externallyObservedOsBuild = process.env.PMAPP_QUALIFICATION_OS_BUILD ?? 'unavailable';
  const headedByRunner = process.env.PMAPP_QUALIFICATION_BROWSER_MODE === 'headed';
  return {
    osPlatform: os.platform(), osBuild: externallyObservedOsBuild === 'unavailable' ? os.release() : externallyObservedOsBuild,
    browserName: isChrome ? 'Google Chrome' : isEdge ? 'Microsoft Edge' : 'Unqualified Browser', browserBuild, userAgent: browser.userAgent,
    appForm: 'browser-tab', headless: !headedByRunner,
    persisted: true,
  };
}

async function runParity(page: Page, seed: string) {
  const production = allocateRun(`${seed}-parity-production`);
  const qualification = allocateRun(`${seed}-parity-qualification`);
  const commandId = createUuidV7();
  const result = await pageCall<Json>(page, 'runDisarmedParity', {
    productionNamespace: production.opfsNamespace, qualificationNamespace: qualification.opfsNamespace,
    runId: createUuidV7(), fixture,
    command: {
      type: 'SetFixtureValue', protocolVersion: '1.0.0', commandId, projectId: fixture.projectId,
      baseRevision: fixture.initialRevision, expectedRevision: fixture.initialRevision + 1, safeValueHash: sha256(`${seed}:parity`),
    },
  });
  return { status: result.status, hash: sha256(JSON.stringify(result)) };
}

async function retain(input: {
  caseId: OwnershipCaseId; seed: string; evidenceRunId: string; runs: Array<{ variant: Variant; run: IsolatedRun }>;
  page: Page; browserContext: BrowserContext; events: OwnershipEvidenceEvent[];
}) {
  await writeAttemptManifest({
    attemptId, campaignId, seed: 'story-1-2-review-repair',
    rootCause: 'Mandatory review invalidated the first ownership PASS because chronology cohort parity and successor writes were asserted or synthesized.',
    correctiveChange: 'Journal-derived case oracles observed cohort facts real successor commands repeated contenders and per-variant recovery.',
    priorFailedEvidence: [KNOWN_BAD_ATTEMPT],
  });
  const [qualification, environment, parity] = await Promise.all([
    pageCall<Json>(input.page, 'qualificationIdentity', {}), observeEnvironment(input.page, input.browserContext),
    runParity(input.page, input.seed),
  ]);
  const sourceProvenance = qualification.sourceProvenance as Json;
  const oracle = adjudicateOwnershipJournal(input.caseId, input.events);
  const status = oracle.status === 'PASS' && environment.osPlatform === 'win32' && environment.browserName === 'Google Chrome' &&
    environment.headless === false && environment.persisted === true && parity.status === 'PASS' ? 'PASS' as const : 'FAIL' as const;
  const immutableEvidenceUri = `reports/evidence/phase-0-durability/${attemptId}/runs/${input.evidenceRunId}.json`;
  await appendRunResult({
    schemaVersion: '1.2.0', evidenceType: 'engineeringQualification', runId: input.evidenceRunId, attemptId,
    caseId: input.caseId, required: true, status,
    manifest: {
      seed: input.seed, campaignId, lockName: 'pmapp-repository-write',
      runs: input.runs.map(({ variant, run }) => ({ variant, runId: run.runId, namespace: run.opfsNamespace })),
      source: {
        lockfileHash: sha256(await readFile('package-lock.json', 'utf8')), buildHash: qualification.qualificationSubjectDigest,
        headRevision: sourceProvenance.headRevision, worktreeState: sourceProvenance.worktreeState,
        worktreeStatusDigest: sourceProvenance.worktreeStatusDigest, executableTreeDigest: sourceProvenance.executableTreeDigest,
        sourceFiles: sourceProvenance.sourceFiles,
      },
      qualification: {
        qualificationSubjectDigest: qualification.qualificationSubjectDigest,
        productionCompositionRoot: qualification.productionCompositionRoot,
        instrumentedCompositionRoot: qualification.instrumentedCompositionRoot,
        parityStatus: parity.status, compositionDerivationStatus: qualification.compositionDerivationStatus,
      },
      environment: {
        osPlatform: environment.osPlatform, osBuild: environment.osBuild, browserName: environment.browserName,
        browserBuild: environment.browserBuild, userAgent: environment.userAgent, appForm: environment.appForm,
        headless: environment.headless,
      },
      persistence: { persisted: environment.persisted, observedBy: 'navigator.storage.persisted' },
    },
    observations: { caseId: input.caseId, events: input.events }, oracle,
    failure: status === 'FAIL' ? { code: 'OWNERSHIP_EVIDENCE_OR_COHORT_FAILED', cause: `${input.caseId} failed journal or observed cohort adjudication`, resultingState: 'read-only-frozen' } : null,
    artifactHashes: { ownershipTrace: sha256(JSON.stringify(input.events)), parityResult: parity.hash }, immutableEvidenceUri,
  });
  await writeDerivedAttemptIndex(attemptId, await readAttemptResults(attemptId));
  return { immutableEvidenceUri, oracle, parity, environment };
}

async function dispose(actor: Actor) {
  if (actor.page.isClosed()) return;
  try { await pageCall(actor.page, 'ownershipDispose', { actorId: actor.actorId }); } finally { await actor.page.close(); }
}

export async function createOwnershipHarness(input: { caseId: OwnershipCaseId; seed: string; page: Page; browserContext: BrowserContext }) {
  if (!input.page || !input.browserContext) throw new Error('REAL_BROWSER_CONTEXT_REQUIRED');
  await preparePage(input.page);

  return Object.freeze({
    async runContenderCase() {
      const run = allocateRun(input.seed);
      const target = journal();
      const ownerPage = await input.browserContext.newPage();
      await preparePage(ownerPage);
      const owner = makeActor(ownerPage, 'owner');
      const ownerReady = await pageCall<Json>(owner.page, 'ownershipStart', startInput(owner, run));
      recordLifecycle(target, run, 'primary', owner, ownerReady);
      let freezeObserved = false;
      let cdp: CDPSession | null = null;
      if (input.caseId === 'O2_FROZEN_OWNER') {
        cdp = await input.browserContext.newCDPSession(owner.page);
        await cdp.send('Page.enable');
        await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
        freezeObserved = true;
        target.append(run, 'primary', owner, 'PageFrozenObserved');
      }
      const contenders: Json[] = [];
      const contenderActors: Actor[] = [];
      for (let index = 0; index < 3; index += 1) {
        const page = await input.browserContext.newPage();
        await preparePage(page);
        const actor = makeActor(page, `contender-${index + 1}`);
        contenderActors.push(actor);
        const busy = await pageCall<Json>(page, 'ownershipStart', startInput(actor, run));
        contenders.push(busy);
        recordLifecycle(target, run, 'primary', actor, busy);
      }
      if (cdp) {
        await cdp.send('Page.setWebLifecycleState', { state: 'active' });
        await cdp.detach();
      }
      const inspection = await inspect(owner, createUuidV7());
      await Promise.all(contenderActors.map(dispose));
      await dispose(owner);
      const retained = await retain({ caseId: input.caseId, seed: input.seed, evidenceRunId: createUuidV7(), runs: [{ variant: 'primary', run }], page: input.page, browserContext: input.browserContext, events: target.events });
      return {
        pagesShareBrowserContext: true, pagesShareOriginAndNamespace: true, owner: ownerReady,
        contender: contenders[0], contenders, maximumSimultaneousOwners: retained.oracle.maximumSimultaneousOwners,
        oracle: { ...retained.oracle, quickCheck: inspection.quickCheck, revisionChanged: false, receiptCountChanged: false, partialMutation: inspection.partialMutation },
        freezeObserved, immutableEvidenceUri: retained.immutableEvidenceUri,
      };
    },

    async runCooperativeHandoff() {
      const run = allocateRun(input.seed);
      const target = journal();
      const [ownerPage, successorPage] = await Promise.all([input.browserContext.newPage(), input.browserContext.newPage()]);
      await Promise.all([preparePage(ownerPage), preparePage(successorPage)]);
      const owner = makeActor(ownerPage, 'owner');
      const successor = makeActor(successorPage, 'successor');
      const ownerReady = await pageCall<Json>(owner.page, 'ownershipStart', startInput(owner, run));
      recordLifecycle(target, run, 'primary', owner, ownerReady);
      const handoff = await pageCall<Json>(owner.page, 'ownershipHandoff', {
        actorId: owner.actorId, requestId: createUuidV7(), contextId: owner.contextId,
        ownerSessionId: owner.ownerSessionId, writerEpoch: owner.writerEpoch,
      });
      for (const eventName of handoff.events as string[]) target.append(run, 'primary', owner, eventName, handoff);
      const successorReady = await pageCall<Json>(successor.page, 'ownershipStart', startInput(successor, run));
      recordLifecycle(target, run, 'primary', successor, successorReady);
      const authoritativeRevision = Number(successorReady.authoritativeRevision);
      const formerOwnerWrite = await pageCall<Json>(owner.page, 'ownershipApply', {
        actorId: owner.actorId, requestId: createUuidV7(), contextId: owner.contextId,
        ownerSessionId: owner.ownerSessionId, writerEpoch: owner.writerEpoch,
        command: { type: 'SetFixtureValue', protocolVersion: '1.0.0', commandId: createUuidV7(), projectId: fixture.projectId, baseRevision: authoritativeRevision, expectedRevision: authoritativeRevision + 1, safeValueHash: sha256('former-owner') },
      });
      target.append(run, 'primary', owner, String(formerOwnerWrite.type), formerOwnerWrite);
      const first = await applySuccessor(target, run, 'primary', successor, authoritativeRevision);
      await Promise.all([dispose(owner), dispose(successor)]);
      const retained = await retain({ caseId: input.caseId, seed: input.seed, evidenceRunId: createUuidV7(), runs: [{ variant: 'primary', run }], page: input.page, browserContext: input.browserContext, events: target.events });
      const transitions = target.events.filter((event) => [
        'IntakeStopped', 'QueueResolved', 'StatementsClosed', 'SQLiteClosed', 'VfsPaused', 'WebLockReleased', 'FormerOwnerFenced',
        'WebLockAcquired', 'SAHAcquired', 'SQLiteOpened', 'IntegrityVerified', 'ReceiptsReconciled', 'RevisionReconciled',
      ].includes(event.type)).map((event) => event.type);
      return {
        events: transitions.slice(transitions.indexOf('IntakeStopped')), formerOwnerWrite: { ...formerOwnerWrite, accepted: false },
        successor: { ...successorReady, quickCheck: first.inspection.quickCheck, firstCommandBaseRevision: authoritativeRevision, firstCommandResult: first.result },
        authoritativeRevision, maximumSimultaneousOwners: retained.oracle.maximumSimultaneousOwners, immutableEvidenceUri: retained.immutableEvidenceUri,
      };
    },

    async runOwnerDeath() {
      const target = journal();
      const runs: Array<{ variant: Variant; run: IsolatedRun }> = [];
      const summaries: Json[] = [];
      for (const variant of ['result-lost-after-commit', 'terminate-before-commit'] as const) {
        const run = allocateRun(`${input.seed}-${variant}`);
        runs.push({ variant, run });
        const [ownerPage, successorPage] = await Promise.all([input.browserContext.newPage(), input.browserContext.newPage()]);
        await Promise.all([preparePage(ownerPage), preparePage(successorPage)]);
        const owner = makeActor(ownerPage, `owner-${variant}`);
        const successor = makeActor(successorPage, `successor-${variant}`);
        const ownerReady = await pageCall<Json>(owner.page, 'ownershipStart', startInput(owner, run));
        recordLifecycle(target, run, variant, owner, ownerReady);
        const requestId = createUuidV7();
        const interruptedCommandId = createUuidV7();
        const barrier = await pageCall<Json>(owner.page, 'ownershipApply', {
          actorId: owner.actorId, requestId, contextId: owner.contextId, ownerSessionId: owner.ownerSessionId,
          writerEpoch: owner.writerEpoch, lossMode: variant,
          command: { type: 'SetFixtureValue', protocolVersion: '1.0.0', commandId: interruptedCommandId, projectId: fixture.projectId, baseRevision: fixture.initialRevision, expectedRevision: fixture.initialRevision + 1, safeValueHash: sha256(variant) },
        });
        target.append(run, variant, owner, 'OwnershipLossBarrierObserved', { ...barrier, requestId, commandId: interruptedCommandId });
        if (input.caseId === 'O4_WORKER_DEATH') {
          const terminated = await pageCall<Json>(owner.page, 'ownershipTerminateWorker', { actorId: owner.actorId });
          target.append(run, variant, owner, 'WorkerTerminatedObserved', terminated);
        } else {
          await owner.page.close();
          target.append(run, variant, owner, 'OwnerPageClosedObserved');
        }
        const successorReady = await startSuccessor(target, run, variant, successor);
        const recovered = await inspect(successor, interruptedCommandId);
        target.append(run, variant, successor, 'RecoveryInspected', { ...recovered, commandId: interruptedCommandId, quickCheck: recovered.quickCheck });
        const authoritativeRevision = recovered.storedRevision;
        if (typeof authoritativeRevision !== 'number' || !Number.isSafeInteger(authoritativeRevision) || authoritativeRevision < 0) {
          throw new Error(`SUCCESSOR_RECOVERY_INSPECTION_FAILED:${typedResultDetail(recovered)}`);
        }
        const first = await applySuccessor(target, run, variant, successor, authoritativeRevision);
        await successor.page.close();
        target.append(run, variant, successor, 'SuccessorPageClosedObserved');
        summaries.push({ variant, successorReady, recovered, first, authoritativeRevision });
      }
      const retained = await retain({ caseId: input.caseId, seed: input.seed, evidenceRunId: createUuidV7(), runs, page: input.page, browserContext: input.browserContext, events: target.events });
      const committed = summaries.find((item) => item.variant === 'result-lost-after-commit')!;
      const uncommitted = summaries.find((item) => item.variant === 'terminate-before-commit')!;
      const committedRecovery = committed.recovered as Json;
      const uncommittedRecovery = uncommitted.recovered as Json;
      return {
        successor: { ...(committed.successorReady as Json), legitimatelyAcquiredWebLock: true, legitimatelyAcquiredSah: true, quickCheck: committedRecovery.quickCheck, firstCommandBaseRevision: committed.authoritativeRevision },
        committedCommand: { mutationCount: committedRecovery.mutationCount, receiptCount: committedRecovery.commandReceiptCount, reconciliation: 'VfsCommitAccepted' },
        uncommittedCommand: { mutationCount: uncommittedRecovery.mutationCount, receiptCount: uncommittedRecovery.commandReceiptCount, partialMutation: uncommittedRecovery.partialMutation },
        authoritativeRevision: committed.authoritativeRevision, maximumSimultaneousOwners: retained.oracle.maximumSimultaneousOwners,
        variants: summaries, immutableEvidenceUri: retained.immutableEvidenceUri,
      };
    },
  });
}
