import { expect, test } from '@playwright/test';

const qualificationModule = '../../spikes/phase-0-durability/src/qualification-subject';
const parityModule = '../../spikes/phase-0-durability/src/parity';

test.describe('Story 1.1 qualification identity and parity contracts', () => {
  test('[P0] AC1 keys qualification to the canonical subject rather than source revision', async () => {
    const { digestQualificationSubject } = await import(qualificationModule);
    const base = {
      productionCompositionRoot: 'a'.repeat(64),
      runtimeStorageMode: { vfs: 'opfs-sahpool', journalMode: 'delete', synchronous: 'extra' },
      componentDigests: { persistence: 'b'.repeat(64), ownership: 'c'.repeat(64), migration: 'd'.repeat(64), update: 'e'.repeat(64), protocol: 'f'.repeat(64), fixture: '1'.repeat(64) },
      toolchainDigest: '2'.repeat(64), buildConfigurationDigest: '3'.repeat(64), lockfileDigest: '4'.repeat(64), dependencyClosureDigest: '5'.repeat(64),
    };
    const first = await digestQualificationSubject({ ...base, sourceRevision: 'commit-a' });
    const second = await digestQualificationSubject({ ...base, sourceRevision: 'commit-b' });
    expect(first.qualificationSubjectDigest).toBe(second.qualificationSubjectDigest);
    expect(first.sourceRevision).not.toBe(second.sourceRevision);
  });

  test('[P0] AC2 permits only the interposer trace sink and termination harness to differ', async () => {
    const { compareCompositionDerivation } = await import(qualificationModule);
    expect(compareCompositionDerivation({
      production: { subjectDigest: 'a'.repeat(64), modules: ['src/repository.worker.ts', 'src/sqlite-opfs.adapter.ts'] },
      instrumented: {
        subjectDigest: 'a'.repeat(64),
        modules: [
          'src/repository.worker.ts', 'src/sqlite-opfs.adapter.ts', 'src/interposing-vfs.test-only.ts',
          'src/boundary-trace.test-only.ts', 'src/fault-control.test-only.ts',
        ],
      },
    })).toEqual({ status: 'PASS', nonAllowListedDifferences: [] });
    expect(compareCompositionDerivation({
      production: { subjectDigest: 'a'.repeat(64), modules: ['repository'] },
      instrumented: { subjectDigest: 'b'.repeat(64), modules: ['repository', 'changed-ledger'] },
    })).toMatchObject({ status: 'FAIL', nonAllowListedDifferences: expect.arrayContaining(['changed-ledger']) });
  });

  test('[P0] AC2 requires exact disarmed forwarding and semantic parity', async () => {
    const { adjudicateParity } = await import(parityModule);
    const outcome = adjudicateParity({
      forwarding: [{ method: 'xSync', downstreamCalls: 1, argumentsEqual: true, returnCodeEqual: true, order: 17 }],
      production: { resultHash: 'a', receiptHash: 'b', revision: 42, semanticDbHash: 'c', quickCheck: 'ok', migrationOutcome: 'v2', updateOutcome: 'active-v2', restartHash: 'd' },
      instrumented: { resultHash: 'a', receiptHash: 'b', revision: 42, semanticDbHash: 'c', quickCheck: 'ok', migrationOutcome: 'v2', updateOutcome: 'active-v2', restartHash: 'd' },
    });
    expect(outcome).toEqual({ status: 'PASS', differences: [] });
  });

  test('[P0] AC2 invalidates every logical boundary result after a parity mismatch', async () => {
    const { adjudicateParity } = await import(parityModule);
    expect(adjudicateParity({
      forwarding: [{ method: 'xDelete', downstreamCalls: 2, argumentsEqual: true, returnCodeEqual: true, order: 18 }],
      production: { semanticDbHash: 'a', quickCheck: 'ok' },
      instrumented: { semanticDbHash: 'b', quickCheck: 'ok' },
    })).toMatchObject({ status: 'FAIL', logicalEvidenceAccepted: false });
  });

  test('[P0] recovery semantics are part of production identity rather than qualification-only controls', async () => {
    const { listProductionCompositionModules } = await import('../../spikes/phase-0-durability/src/harness');
    const modules = await listProductionCompositionModules();
    expect(modules).toContain('src/recovery-safe-vfs.ts');
    expect(modules.every((module) => !module.includes('.test-only.'))).toBe(true);
  });
});
