import { expect, test } from '../../support/fixtures';

const RUN_SEED = 'story-1-1-evidence-seed-0001';
const AUTHORED_SENTINEL = 'PRIVATE-AUTHORED-TEXT-MUST-NOT-LEAK';

test.describe('Story 1.1 evidence safety and test-control isolation', () => {
  test('[P0] labels successful Story 1.1 storage only VfsCommitAccepted and makes no durability certification claim', async ({ page }) => {
    const [{ createDurabilityHarnessTestPort }, { loadKnownProjectFixture }] =
      await Promise.all([
        import('../../../spikes/phase-0-durability/test-support/harness.port'),
        import('../../../spikes/phase-0-durability/test-support/known-project.fixture'),
      ]);
    const durabilityHarness = await createDurabilityHarnessTestPort(page);
    const knownProjectFixture = await loadKnownProjectFixture();
    const outcome = await durabilityHarness.runAndRestart({
      seed: RUN_SEED,
      boundaryId: 'F6_AFTER_CANDIDATE_BOUNDARY_OBSERVED',
      terminationMechanism: 'worker-terminate',
      fixture: knownProjectFixture,
      command: knownProjectFixture.command,
    });

    expect(outcome.result.observations.vfsResult).toBe('VfsCommitAccepted');
    expect(outcome.result.observations.uiAcknowledgement).toBe('CandidateDurabilityBoundaryObserved');
    expect(outcome.result.observations.labPurpose).toBe(true);
    expect(outcome.report.productionCapability).toBe('disabled');
    expect(outcome.report.certificationStatus).toBe('NOT_CERTIFIED');
    expect(outcome.report.claims).not.toContain('DurableCommitAcknowledged');
    expect(outcome.report.claims).not.toContain('durable');
  });

  test('[P0] creates isolated run storage and permits reset only for the current verified namespace', async ({ page }) => {
    const { createDurabilityHarnessTestPort } = await import(
      '../../../spikes/phase-0-durability/test-support/harness.port'
    );
    const durabilityHarness = await createDurabilityHarnessTestPort(page);
    const first = await durabilityHarness.allocateIsolatedRun({ seed: RUN_SEED });
    const second = await durabilityHarness.allocateIsolatedRun({ seed: RUN_SEED });
    expect(first.runId).not.toBe(second.runId);
    expect(first.profilePath).not.toBe(second.profilePath);
    expect(first.origin).not.toBe(second.origin);
    expect(first.opfsNamespace).not.toBe(second.opfsNamespace);

    await durabilityHarness.writeResetSentinel(first);
    await durabilityHarness.writeResetSentinel(second);
    const reset = await durabilityHarness.safeReset({
      runId: first.runId,
      expectedNamespace: first.opfsNamespace,
    });

    expect(reset.verifiedTarget).toBe(first.opfsNamespace);
    expect(reset.deletedNamespaces).toEqual([first.opfsNamespace]);
    expect(await durabilityHarness.namespaceExists(first.opfsNamespace)).toBe(false);
    expect(await durabilityHarness.namespaceExists(second.opfsNamespace)).toBe(true);

    await expect(
      durabilityHarness.safeReset({
        runId: first.runId,
        expectedNamespace: second.opfsNamespace,
      }),
    ).rejects.toThrow(/SAFE_RESET_TARGET_MISMATCH/);
  });

  test('[P0] retains technical evidence without authored body text', async ({ page }) => {
    const [
      { createDurabilityHarnessTestPort, extractRetainedEvidenceStrings },
      { loadKnownProjectFixture },
    ] = await Promise.all([
      import('../../../spikes/phase-0-durability/test-support/harness.port'),
      import('../../../spikes/phase-0-durability/test-support/known-project.fixture'),
    ]);
    const durabilityHarness = await createDurabilityHarnessTestPort(page);
    const knownProjectFixture = await loadKnownProjectFixture();
    const outcome = await durabilityHarness.runAndRestart({
      seed: RUN_SEED,
      boundaryId: 'F4_AFTER_COMMIT_RETURN',
      terminationMechanism: 'worker-terminate',
      fixture: knownProjectFixture.withAuthoredBody(AUTHORED_SENTINEL),
      command: knownProjectFixture.command,
    });

    const retainedStrings = extractRetainedEvidenceStrings(outcome.retainedArtifacts);
    expect(retainedStrings).not.toContain(AUTHORED_SENTINEL);
    expect(outcome.result.observations.commandedValueHash).toMatch(/^[a-f0-9]{64}$/);
    expect(outcome.manifest).toEqual(expect.objectContaining({
      runId: expect.any(String),
      seed: RUN_SEED,
      source: expect.objectContaining({
        lockfileHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        buildHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      environment: expect.objectContaining({
        osBuild: expect.any(String),
        browserName: expect.any(String),
        browserBuild: expect.any(String),
        appForm: expect.any(String),
        storageState: expect.any(String),
      }),
    }));
  });
});
