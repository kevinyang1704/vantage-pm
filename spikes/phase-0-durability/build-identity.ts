import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const spikeRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(spikeRoot, '../..');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonical = (value: Record<string, string>) => Object.entries(value)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([key, digest]) => `${key}:${digest}`)
  .join('\n');

export const productionModules = [
  'src/repository.worker.entry.ts', 'src/repository.worker.ts', 'src/repository-ledger.ts',
  'src/sqlite-opfs.adapter.ts', 'src/recovery-safe-vfs.ts', 'src/restart-inspector.ts',
  'src/repository-protocol.ts', 'src/command-receipt.ts', 'src/ownership-protocol.ts',
  'src/repository-ownership.ts', 'src/cooperative-handoff.ts',
  'src/backup.ts', 'src/migration-runner.ts', 'src/recovery-selector.ts', 'src/update-coordinator.ts',
] as const;

export const instrumentationModules = [
  'src/repository.worker.qualification.entry.ts', 'src/qualification-main.test-only.ts',
  'src/interposing-vfs.test-only.ts', 'src/boundary-trace.test-only.ts', 'src/fault-control.test-only.ts',
  'src/lab-purpose.test-only.ts', 'src/parity.ts', 'src/qualification-subject.ts',
  'src/service-worker.test-only.ts',
] as const;

const identityFiles = [
  ...productionModules,
  ...instrumentationModules,
  'fixtures/known-project-v1.json', 'fixtures/candidate-v2.json', 'fixtures/compatibility-manifest.json',
  'src/migration-protocol.ts', 'src/update-gate.ts', 'src/revision-protocol.ts',
  'src/evidence.ts', 'src/evidence-contract.ts', 'src/harness.ts',
  'test-support/harness.port.ts', 'test-support/ownership-harness.port.ts',
  'test-support/migration-harness.port.ts', 'test-support/update-harness.port.ts',
  'test-support/run-isolation.ts', 'test-support/known-project.fixture.ts',
  'build-identity.ts', 'vite.config.ts', 'index.html', 'qualification.html',
  '../../package.json', '../../package-lock.json',
] as const;

function fileDigest(relativePath: string): string {
  return hash(readFileSync(path.resolve(spikeRoot, relativePath)));
}

export function computeBuildIdentity() {
  const sourceFiles = Object.fromEntries(identityFiles.map((relativePath) => [relativePath, fileDigest(relativePath)]));
  const productionFiles = Object.fromEntries(productionModules.map((relativePath) => [relativePath, sourceFiles[relativePath]!]));
  const instrumentedFiles = Object.fromEntries(
    [...productionModules, ...instrumentationModules].map((relativePath) => [relativePath, sourceFiles[relativePath]!]),
  );
  const headRevision = (() => {
    try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim(); }
    catch { return 'unavailable'; }
  })();
  const worktreeStatus = (() => {
    try {
      return execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', 'spikes/phase-0-durability', 'package.json', 'package-lock.json'], {
        cwd: projectRoot, encoding: 'utf8',
      }).trim();
    } catch { return 'unavailable'; }
  })();
  return Object.freeze({
    headRevision,
    worktreeState: (worktreeStatus && worktreeStatus !== 'unavailable') ? 'dirty' as const : 'clean' as const,
    worktreeStatusDigest: hash(worktreeStatus),
    executableTreeDigest: hash(canonical(sourceFiles)),
    sourceFiles,
    productionCompositionRoot: hash(canonical(productionFiles)),
    instrumentedCompositionRoot: hash(canonical(instrumentedFiles)),
    productionModules: [...productionModules],
    instrumentedModules: [...productionModules, ...instrumentationModules],
  });
}

export function hashBuildFile(relativePath: string): string {
  return fileDigest(relativePath);
}

export function hashBuildValue(value: string | Buffer): string {
  return hash(value);
}

export { projectRoot, spikeRoot };
