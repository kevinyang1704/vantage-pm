import { expect, test } from '../../support/fixtures';

const RUN_SEED = 'story-1-1-logical-boundaries-seed-0001';
const COMMAND_ID = '0198a000-0000-7000-8000-000000000001';
const PROJECT_ID = '0198a000-0000-7000-8000-000000000002';
const BASE_REVISION = 7;
const FAULT_BOUNDARY_IDS = [
  'F1_BEFORE_JOURNAL_SYNC',
  'F2_AFTER_JOURNAL_SYNC',
  'F3_BEFORE_JOURNAL_DELETE_FORWARD',
  'F4_AFTER_COMMIT_RETURN',
  'F5_AFTER_REPOSITORY_RESULT',
  'F6_AFTER_CANDIDATE_BOUNDARY_OBSERVED',
] as const;

test.describe('Story 1.1 logical commit boundaries', () => {
  for (const boundaryId of FAULT_BOUNDARY_IDS) {
    test(`[P0] reproduces ${boundaryId} from the same seed and retains complete restart evidence`, async ({ page }) => {
      const [{ createDurabilityHarnessTestPort }, { loadKnownProjectFixture }] =
        await Promise.all([
          import('../../../spikes/phase-0-durability/test-support/harness.port'),
          import('../../../spikes/phase-0-durability/test-support/known-project.fixture'),
        ]);
      const durabilityHarness = await createDurabilityHarnessTestPort(page);
      const knownProjectFixture = await loadKnownProjectFixture();
      const request = {
        seed: RUN_SEED,
        boundaryId,
        terminationMechanism: 'worker-terminate' as const,
        fixture: knownProjectFixture,
        command: {
          commandId: COMMAND_ID,
          projectId: PROJECT_ID,
          baseRevision: BASE_REVISION,
          safeValueLabel: 'fixture-value-b',
        },
      };

      const first = await durabilityHarness.runAndRestart(request);
      const replay = await durabilityHarness.runAndRestart(request);

      expect(first.result.status).toBe('PASS');
      expect(first.manifest.seed).toBe(RUN_SEED);
      expect(first.manifest.injection.boundaryId).toBe(boundaryId);
      expect(first.result.observations.boundaryId).toBe(boundaryId);
      expect(first.result.observations.commandedValueHash).toMatch(/^[a-f0-9]{64}$/);
      expect(first.result.observations.expectedRevision).toBe(BASE_REVISION + 1);
      expect(first.result.observations.terminationMechanism).toBe('worker-terminate');
      expect(first.result.observations).toEqual(expect.objectContaining({
        vfsResult: expect.any(String),
        repositoryResult: expect.any(String),
        uiAcknowledgement: expect.any(String),
        restartResult: expect.any(String),
      }));
      expect(first.result.oracle.quickCheck).toBe('ok');
      expect(first.manifest.qualification).toEqual(expect.objectContaining({
        qualificationSubjectDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        productionCompositionRoot: expect.stringMatching(/^[a-f0-9]{64}$/),
        instrumentedCompositionRoot: expect.stringMatching(/^[a-f0-9]{64}$/),
        parityStatus: 'PASS',
        compositionDerivationStatus: 'PASS',
      }));
      expect(first.manifest.source).toEqual(expect.objectContaining({
        headRevision: expect.stringMatching(/^[a-f0-9]{40}$/),
        // Worktree state is environment-dependent (clean checkout vs. in-progress
        // fix) — the contract is the field's shape, not a specific value.
        worktreeState: expect.stringMatching(/^(clean|dirty|unavailable)$/),
        worktreeStatusDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        executableTreeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        sourceFiles: expect.objectContaining({
          'src/recovery-safe-vfs.ts': expect.stringMatching(/^[a-f0-9]{64}$/),
          'test-support/harness.port.ts': expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }));
      if (boundaryId === 'F3_BEFORE_JOURNAL_DELETE_FORWARD') {
        expect(first.result.observations.boundaryEvent).toEqual(expect.objectContaining({
          downstreamDatabaseSyncReturn: 'SQLITE_OK',
          nextCall: 'xDelete',
          doSyncDir: true,
          forwardedBeforeTermination: false,
          physicalDirectorySync: 'Unobservable',
          runId: expect.any(String),
          connectionId: expect.any(String),
          commandId: COMMAND_ID,
          commitAttemptId: expect.any(String),
        }));
      }
      if (boundaryId === 'F6_AFTER_CANDIDATE_BOUNDARY_OBSERVED') {
        expect(first.result.observations.uiAcknowledgement).toBe('CandidateDurabilityBoundaryObserved');
        expect(first.result.observations.labPurpose).toBe(true);
      }
      expect(first.reproducibilityFingerprint).toBe(replay.reproducibilityFingerprint);
      expect(first.result.artifactHashes).toEqual(replay.result.artifactHashes);
    });
  }

  test('[P0] disarmed production and qualification compositions have semantic parity', async ({ page }) => {
    const [{ createDurabilityHarnessTestPort }, { loadKnownProjectFixture }] = await Promise.all([
      import('../../../spikes/phase-0-durability/test-support/harness.port'),
      import('../../../spikes/phase-0-durability/test-support/known-project.fixture'),
    ]);
    const harness = await createDurabilityHarnessTestPort(page);
    const fixture = await loadKnownProjectFixture();
    const parity = await harness.runDisarmedParity({
      seed: `${RUN_SEED}-parity`,
      fixture,
      command: {
        commandId: COMMAND_ID,
        projectId: PROJECT_ID,
        baseRevision: fixture.initialRevision,
        safeValueHash: 'c20ad4d76fe97759aa27a0c99bff6710c7f4b66dcbf15a3512c3f5b2b60690b2',
      },
    });
    expect(parity).toMatchObject({ status: 'PASS', differences: [] });
    expect(parity.production.applied).toMatchObject({
      type: 'CommandApplied', receipt: expect.any(Object), repositoryResult: expect.any(Object),
    });
    expect(parity.instrumented.applied).toMatchObject({
      type: 'CommandApplied', receipt: expect.any(Object), repositoryResult: expect.any(Object),
    });
  });
});
