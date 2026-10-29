import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuidV7 } from './command-receipt';
import {
  LOGICAL_CASE_IDS,
  OWNERSHIP_CASE_IDS,
  parseEngineeringQualificationRun,
  type EngineeringQualificationRun,
  type OwnershipEvidenceEvent,
} from './evidence-contract';

const DEFAULT_ROOT = path.resolve('reports/evidence/phase-0-durability');
const MANIFEST_FIELDS = new Set([
  'schemaVersion', 'attemptId', 'runId', 'seed', 'required', 'adapter', 'source', 'qualification',
  'environment', 'fixture', 'command', 'injection',
]);

export function createRunManifest<T extends object>(manifest: T) {
  const unknown = Object.keys(manifest).find((key) => !MANIFEST_FIELDS.has(key));
  if (unknown) throw new Error(`UNKNOWN_MANIFEST_FIELD:${unknown}`);
  return Object.freeze({ schemaVersion: '1.0.0' as const, ...manifest });
}

export function serializeRetainedEvidence(value: unknown): string {
  return JSON.stringify(parseEngineeringQualificationRun(value), null, 2);
}

export function deriveAttemptReport(results: readonly EngineeringQualificationRun[]) {
  const attemptIds = new Set(results.map((result) => result.attemptId));
  const runIds = new Set<string>();
  const invalidReasons: string[] = [];
  if (!results.length) invalidReasons.push('EMPTY_ATTEMPT');
  if (attemptIds.size > 1) invalidReasons.push('ATTEMPT_IDENTITY_MISMATCH');
  const hasLogical = results.some((result) => (LOGICAL_CASE_IDS as readonly string[]).includes(result.caseId));
  const hasOwnership = results.some((result) => (OWNERSHIP_CASE_IDS as readonly string[]).includes(result.caseId));
  if (hasLogical && hasOwnership) invalidReasons.push('MIXED_CASE_FAMILIES');
  const caseCounts = new Map<string, number>();
  const campaigns = new Set<string>();
  const subjects = new Set<string>();
  for (const result of results) {
    if (runIds.has(result.runId)) invalidReasons.push(`DUPLICATE_RUN:${result.runId}`);
    runIds.add(result.runId);
    caseCounts.set(result.caseId, (caseCounts.get(result.caseId) ?? 0) + 1);
    if ((OWNERSHIP_CASE_IDS as readonly string[]).includes(result.caseId)) {
      const manifest = result.manifest as Record<string, unknown>;
      const qualification = manifest.qualification as Record<string, unknown>;
      campaigns.add(String(manifest.campaignId));
      subjects.add(String(qualification.qualificationSubjectDigest));
    }
  }
  // Case uniqueness is per-attempt; skip when attempt identities already mismatch.
  if (attemptIds.size === 1) {
    for (const [caseId, count] of caseCounts) if (count !== 1) invalidReasons.push(`DUPLICATE_CASE:${caseId}`);
  }
  if (campaigns.size > 1) invalidReasons.push('CAMPAIGN_IDENTITY_MISMATCH');
  if (subjects.size > 1) invalidReasons.push('QUALIFICATION_SUBJECT_MISMATCH');
  const retainedRequiredFailures = results
    .filter((result) => result.required && result.status === 'FAIL')
    .map((result) => ({
      runId: result.runId,
      code: String(result.failure?.code ?? 'UNKNOWN_FAILURE'),
      architectureDecisionRequired: result.failure?.architectureDecisionRequired ?? null,
    }));
  const requiredCases = [
    ...(hasLogical || !hasOwnership ? LOGICAL_CASE_IDS : []),
    ...(hasOwnership ? OWNERSHIP_CASE_IDS : []),
  ];
  const missingRequiredCases = requiredCases.filter(
    (caseId) => !results.some((result) => result.required && result.caseId === caseId),
  );
  return {
    schemaVersion: '1.0.0' as const,
    evidenceType: 'engineeringQualification' as const,
    attemptId: attemptIds.size === 1 ? [...attemptIds][0]! : null,
    status: retainedRequiredFailures.length || missingRequiredCases.length || invalidReasons.length
      ? 'FAIL' as const : 'PASS' as const,
    retainedRequiredFailures,
    missingRequiredCases,
    invalidReasons,
  };
}

export function deriveMaximumConcurrentResourceOwners(
  events: readonly OwnershipEvidenceEvent[],
  resource: 'web-lock' | 'sah-pool' | 'sqlite' = 'web-lock',
) {
  const active = new Set<string>();
  let maximum = 0;
  let priorSequence = 0;
  for (const event of events) {
    if (event.sequence <= priorSequence) throw new Error('NON_MONOTONIC_OWNERSHIP_EVENT');
    priorSequence = event.sequence;
    const sessionKey = `${event.contextId}:${event.ownerSessionId ?? 'none'}`;
    if (event.resource === resource && event.outcome === 'acquired') {
      if (event.ownerSessionId === null) throw new Error('RESOURCE_ACQUIRED_WITHOUT_OWNER_SESSION');
      if (active.has(sessionKey)) throw new Error('DUPLICATE_RESOURCE_ACQUISITION');
      active.add(sessionKey);
      maximum = Math.max(maximum, active.size);
    }
    if (event.resource === resource && event.outcome === 'released') active.delete(sessionKey);
    if ((event.resource === 'worker' || event.resource === 'page') && event.outcome === 'terminated') {
      for (const key of active) if (key.startsWith(`${event.contextId}:`)) active.delete(key);
    }
  }
  return maximum;
}

export function createEvidenceStore(root: string) {
  const resolvedRoot = path.resolve(root);
  const attemptDirectory = (attemptId: string) => {
    assertUuidV7(attemptId, 'attemptId');
    return path.join(resolvedRoot, attemptId);
  };
  return Object.freeze({
    root: resolvedRoot,
    async appendRunResult(result: unknown) {
      const parsed = parseEngineeringQualificationRun(result);
      const directory = path.join(attemptDirectory(parsed.attemptId), 'runs');
      await mkdir(directory, { recursive: true });
      const filename = path.join(directory, `${parsed.runId}.json`);
      const handle = await open(filename, 'wx');
      try { await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8'); }
      finally { await handle.close(); }
      return filename;
    },
    async writeAttemptManifest(input: {
      attemptId: string;
      campaignId: string;
      seed: string;
      rootCause: string;
      correctiveChange: string;
      priorFailedEvidence: readonly string[];
    }) {
      const directory = attemptDirectory(input.attemptId);
      assertUuidV7(input.campaignId, 'campaignId');
      if (!input.seed) throw new Error('ATTEMPT_SEED_REQUIRED');
      await mkdir(directory, { recursive: true });
      const filename = path.join(directory, 'attempt-manifest.json');
      const expected = {
        schemaVersion: '1.0.0', evidenceType: 'engineeringQualificationAttempt', ...input,
      };
      let handle;
      try { handle = await open(filename, 'wx'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = JSON.parse(await readFile(filename, 'utf8')) as Record<string, unknown>;
        if (JSON.stringify(existing) !== JSON.stringify(expected)) throw new Error('ATTEMPT_MANIFEST_MISMATCH');
        return filename;
      }
      try { await handle.writeFile(`${JSON.stringify(expected, null, 2)}\n`, 'utf8'); }
      finally { await handle.close(); }
      return filename;
    },
    async readAttemptResults(attemptId: string): Promise<EngineeringQualificationRun[]> {
      const directory = path.join(attemptDirectory(attemptId), 'runs');
      const files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
      const results: EngineeringQualificationRun[] = [];
      for (const name of files) {
        const filenameRunId = name.slice(0, -'.json'.length);
        assertUuidV7(filenameRunId, 'runFilename');
        const parsed = parseEngineeringQualificationRun(JSON.parse(await readFile(path.join(directory, name), 'utf8')));
        if (parsed.runId !== filenameRunId) throw new Error(`RUN_FILENAME_IDENTITY_MISMATCH:${name}`);
        if (parsed.attemptId !== attemptId) throw new Error(`RUN_ATTEMPT_IDENTITY_MISMATCH:${name}`);
        results.push(parsed);
      }
      return results;
    },
    async writeDerivedAttemptIndex(attemptId: string, results: readonly EngineeringQualificationRun[]) {
      const report = deriveAttemptReport(results);
      if (report.attemptId !== null && report.attemptId !== attemptId) throw new Error('REPORT_ATTEMPT_IDENTITY_MISMATCH');
      const directory = path.join(attemptDirectory(attemptId), 'derived');
      const manifest = JSON.parse(await readFile(path.join(attemptDirectory(attemptId), 'attempt-manifest.json'), 'utf8')) as Record<string, unknown>;
      if ((OWNERSHIP_CASE_IDS as readonly string[]).some((caseId) => results.some((result) => result.caseId === caseId))) {
        const prior = manifest.priorFailedEvidence;
        if (!Array.isArray(prior) || !prior.includes('reports/evidence/phase-0-durability/019ffd50-0000-7e76-8216-9330e894b9d0/')) {
          report.invalidReasons.push('KNOWN_BAD_OWNERSHIP_ATTEMPT_NOT_RETAINED');
          report.status = 'FAIL';
        }
      }
      await mkdir(directory, { recursive: true });
      const filename = path.join(directory, 'attempt-report.json');
      await writeFile(filename, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      return filename;
    },
  });
}

const defaultStore = createEvidenceStore(DEFAULT_ROOT);
export const appendRunResult = defaultStore.appendRunResult;
export const writeAttemptManifest = defaultStore.writeAttemptManifest;
export const readAttemptResults = defaultStore.readAttemptResults;
export const writeDerivedAttemptIndex = defaultStore.writeDerivedAttemptIndex;
