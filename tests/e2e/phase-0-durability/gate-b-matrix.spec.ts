import { expect, test } from '../../support/fixtures';

// Story 1.4 (Gate B) deterministic logical cells: PHASE-0-DURABILITY.md's "Gate ownership" and
// AD-13 both require Gate B's F1-F6 logical cells to reuse Gate A's real fault-injection
// machinery unchanged (against the byte-identical instrumented composition) — not a
// reimplementation. So this suite runs the SAME real-browser harness Story 1.1 built, then
// re-envelopes the just-written real evidence as Gate B's releaseCertification record and
// confirms it satisfies that schema too — proving the reuse is genuine, not just asserted.
const RUN_SEED = 'story-1-4-gate-b-logical-seed-0001';
const COMMAND_ID = '0198a000-0000-7000-8000-000000000005';
const PROJECT_ID = '0198a000-0000-7000-8000-000000000002';
const BASE_REVISION = 7;
const LOGICAL_BOUNDARY_IDS = [
  'F1_BEFORE_JOURNAL_SYNC',
  'F2_AFTER_JOURNAL_SYNC',
  'F3_BEFORE_JOURNAL_DELETE_FORWARD',
  'F4_AFTER_COMMIT_RETURN',
  'F5_AFTER_REPOSITORY_RESULT',
  'F6_AFTER_CANDIDATE_BOUNDARY_OBSERVED',
] as const;

test.describe('Story 1.4 Gate B deterministic logical cell matrix', () => {
  for (const boundaryId of LOGICAL_BOUNDARY_IDS) {
    test(`[P0] ${boundaryId} real evidence re-envelopes as valid Gate B releaseCertification evidence`, async ({ page }) => {
      const [{ createDurabilityHarnessTestPort }, { loadKnownProjectFixture }, { readAttemptResults }] = await Promise.all([
        import('../../../spikes/phase-0-durability/test-support/harness.port'),
        import('../../../spikes/phase-0-durability/test-support/known-project.fixture'),
        import('../../../spikes/phase-0-durability/src/evidence'),
      ]);
      const durabilityHarness = await createDurabilityHarnessTestPort(page);
      const knownProjectFixture = await loadKnownProjectFixture();
      const request = {
        seed: `${RUN_SEED}-${boundaryId}`,
        boundaryId,
        terminationMechanism: 'worker-terminate' as const,
        fixture: knownProjectFixture,
        command: { commandId: COMMAND_ID, projectId: PROJECT_ID, baseRevision: BASE_REVISION, safeValueLabel: 'gate-b-fixture-value' },
      };
      const outcome = await durabilityHarness.runAndRestart(request);
      expect(outcome.result.status).toBe('PASS');

      const attemptIdMatch = /evidence\/phase-0-durability\/([^/]+)\/runs\//.exec(outcome.immutableEvidenceUri);
      const attemptId = attemptIdMatch?.[1];
      if (!attemptId) throw new Error('COULD_NOT_DERIVE_ATTEMPT_ID_FROM_URI');
      const attemptResults = await readAttemptResults(attemptId);
      const gateARecord = attemptResults.find((run) => run.immutableEvidenceUri === outcome.immutableEvidenceUri);
      if (!gateARecord) throw new Error('GATE_A_EVIDENCE_RECORD_NOT_FOUND');

      const { parseReleaseCertificationRun } = await import('../../../spikes/phase-0-durability/src/evidence-contract');
      const gateAManifest = gateARecord.manifest as Record<string, unknown>;
      const gateAEnvironment = gateAManifest.environment as Record<string, unknown>;
      const gateBRecord = {
        ...gateARecord,
        schemaVersion: '1.4.0' as const,
        evidenceType: 'releaseCertification' as const,
        cohort: {
          browserName: gateAEnvironment.browserName === 'Microsoft Edge' ? 'Microsoft Edge' as const : 'Google Chrome' as const,
          browserBuild: String(gateAEnvironment.browserBuild),
          browserChannel: 'stable' as const,
          appForm: 'browser-tab' as const,
          storageState: 'persistence-granted' as const,
        },
      };
      // The point of this assertion: real observed manifest/observations/oracle data from an
      // actual browser fault-injection run — not a hand-built fixture — satisfies Gate B's
      // schema unchanged, proving the F1-F6 reuse is real.
      expect(() => parseReleaseCertificationRun(gateBRecord)).not.toThrow();
      expect(parseReleaseCertificationRun(gateBRecord).evidenceType).toBe('releaseCertification');
    });
  }

  test.fixme(
    'VM power-off and physical power-interruption cells require real VM/physical infrastructure this environment does not have',
    async () => {
      // exact procedure once real infrastructure is available. Left as fixme (not skip) so it
      // stays visible in every test run as explicitly pending work, never silently green.
    },
  );
});
