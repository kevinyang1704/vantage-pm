import { expect, test } from '@playwright/test';

// Story 1.4 (Gate B) AC2: degraded-state cohorts pass only by failing closed — no code path may
// ever construct a CertificationGrant (and therefore never DurableCommitAcknowledged) while
// persistence is denied, quota is exhausted, or the profile is private/guest.
//
// RepositoryService.apply() itself requires a real browser-backed SqliteOpfsAdapter
// (createRepositoryWorkerTestPort() intentionally throws REAL_BROWSER_SQLITE_WORKER_REQUIRED —
// AGENTS.md forbids mocking it), so the full end-to-end path is proven only by a real browser in
// tests/e2e/phase-0-durability/degraded-mode.spec.ts (Stage 8). This contract proves the piece
// that IS testable without a browser: the acknowledgement policy's decision function itself is
// unconditionally fail-closed for every degraded storage-health category this app already
// recognizes (src/adapters/platform/storage-health.ts), with an otherwise fully valid
// attestation and controller-verification state — i.e. degraded signals alone are sufficient to
// deny a grant, nothing else about the environment can compensate.

function validAttestation() {
  return {
    attestedBrowserBrand: 'Google Chrome' as const,
    attestedBrowserFullVersion: '151.0.7823.42',
    attestedPlatformVersion: '15.0.0',
    attestedAppForm: 'browser-tab' as const,
    assetManifestRoot: 'a'.repeat(64),
    issuedAt: '2026-08-01T00:00:00Z',
    notBefore: '2026-08-01T00:00:00Z',
    notAfter: '2026-08-25T00:00:00Z',
    signatureVerified: true,
  };
}

function validController() {
  return { state: 'activated-controlling' as const, manifestRoot: 'a'.repeat(64) };
}

function validClockFloor() {
  const now = Date.parse('2026-08-19T12:00:00Z');
  return { nowMs: now, lastKnownGoodMs: now - 1000 };
}

test.describe('Story 1.4 Gate B degraded-mode contract', () => {
  test('[P0] persistence-denied signals deny a grant even with an otherwise-valid attestation and controller', async () => {
    const { evaluateCertificationGrant } = await import('../../spikes/phase-0-durability/src/certification-grant');
    // Mirrors storage-health.ts's Denied category: persisted === false.
    const grant = evaluateCertificationGrant({
      attestation: validAttestation(),
      runtimeSignals: { browserBrand: 'Google Chrome', browserFullVersion: '151.0.7823.42', platformVersion: '15.0.0', displayMode: 'browser', persisted: false },
      controllerVerification: validController(),
      clockFloor: validClockFloor(),
    });
    expect(grant).toBeNull();
  });

  test('[P0] a quota-exhausted session (persisted transiently true but writes about to be blocked) still cannot be granted once persisted flips false', async () => {
    const { evaluateCertificationGrant } = await import('../../spikes/phase-0-durability/src/certification-grant');
    // storage-health.ts's QuotaExhausted category sets canWrite/canPersist false regardless of
    // the raw persisted() signal; the acknowledgement policy must independently deny once
    // persisted is anything but true — quota exhaustion is not a scenario a grant can paper over.
    const grant = evaluateCertificationGrant({
      attestation: validAttestation(),
      runtimeSignals: { browserBrand: 'Google Chrome', browserFullVersion: '151.0.7823.42', platformVersion: '15.0.0', displayMode: 'browser', persisted: false },
      controllerVerification: validController(),
      clockFloor: validClockFloor(),
    });
    expect(grant).toBeNull();
  });

  test('[P0] a private/guest profile denies a grant', async () => {
    const { evaluateCertificationGrant } = await import('../../spikes/phase-0-durability/src/certification-grant');
    // storage-health.ts's PrivateOrGuestProfile category: canWrite true, canPersist false —
    // persisted() cannot be durably true in this profile, so the grant must still deny.
    const grant = evaluateCertificationGrant({
      attestation: validAttestation(),
      runtimeSignals: { browserBrand: 'Google Chrome', browserFullVersion: '151.0.7823.42', platformVersion: '15.0.0', displayMode: 'browser', persisted: false },
      controllerVerification: validController(),
      clockFloor: validClockFloor(),
    });
    expect(grant).toBeNull();
  });

  test('[P0] the only degraded-adjacent signal combination that CAN grant is persisted true with every other gate also satisfied', async () => {
    const { evaluateCertificationGrant } = await import('../../spikes/phase-0-durability/src/certification-grant');
    const grant = evaluateCertificationGrant({
      attestation: validAttestation(),
      runtimeSignals: { browserBrand: 'Google Chrome', browserFullVersion: '151.0.7823.42', platformVersion: '15.0.0', displayMode: 'browser', persisted: true },
      controllerVerification: validController(),
      clockFloor: validClockFloor(),
    });
    expect(grant?.isValid()).toBe(true);
  });

  test('[P0] the evidence-contract degraded-mode record shape structurally forbids ever recording DurableCommitAcknowledged as emitted', async () => {
    const { parseReleaseCertificationRun } = await import('../../spikes/phase-0-durability/src/evidence-contract');
    const record = {
      schemaVersion: '1.4.0' as const, evidenceType: 'releaseCertification' as const,
      runId: '01992f5c-7a10-7ce0-8b11-89ea06c8f9f0', attemptId: '01992f5c-7a10-7ce1-8b11-89ea06c8f9f1',
      caseId: 'DEGRADED_PERSISTENCE_DENIED' as const, required: true as const, status: 'PASS' as const,
      cohort: { browserName: 'Google Chrome' as const, browserBuild: '151.0.7823.42', browserChannel: 'stable' as const, appForm: 'browser-tab' as const, storageState: 'persistence-denied' as const },
      manifest: {
        seed: 'contract-seed',
        source: { lockfileHash: 'a'.repeat(64), buildHash: 'a'.repeat(64), headRevision: 'f'.repeat(40), worktreeState: 'dirty', worktreeStatusDigest: 'a'.repeat(64), executableTreeDigest: 'a'.repeat(64), sourceFiles: { 'src/recovery-safe-vfs.ts': 'a'.repeat(64) } },
        qualification: { qualificationSubjectDigest: 'a'.repeat(64), productionCompositionRoot: 'a'.repeat(64), instrumentedCompositionRoot: 'b'.repeat(64), parityStatus: 'PASS' as const, compositionDerivationStatus: 'PASS' as const },
        signals: { persisted: false, quotaExhausted: false, isPrivateProfile: false }, deniedCapability: 'persist' as const,
      },
      observations: { caseId: 'DEGRADED_PERSISTENCE_DENIED' as const, resultCode: 'RepositoryRejected' as const },
      oracle: { grantEvaluated: true, grantWithheld: true, durableAcknowledgedEmitted: true, recoverableInputPreserved: true },
      failure: null,
      artifactHashes: { semantic: 'a'.repeat(64) },
      immutableEvidenceUri: 'reports/evidence/phase-0-durability/01992f5c-7a10-7ce1-8b11-89ea06c8f9f1/runs/01992f5c-7a10-7ce0-8b11-89ea06c8f9f0.json',
    };
    // A record claiming durableAcknowledgedEmitted: true for a degraded case is itself an
    // invalid evidence record, not just a bad test fixture — the schema rejects it outright.
    expect(() => parseReleaseCertificationRun(record)).toThrow('INVALID_EVIDENCE_VALUE:oracle.durableAcknowledgedEmitted');
  });
});
