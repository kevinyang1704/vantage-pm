import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import { computeBuildIdentity, hashBuildFile, hashBuildValue } from './build-identity';

const spikeRoot = fileURLToPath(new URL('.', import.meta.url));
const identity = computeBuildIdentity();
const component = (paths: string[]) => hashBuildValue(paths.map((path) => `${path}:${hashBuildFile(path)}`).join('\n'));
const qualificationSubject = {
  sourceRevision: identity.headRevision,
  sourceProvenance: identity,
  productionCompositionRoot: identity.productionCompositionRoot,
  instrumentedCompositionRoot: identity.instrumentedCompositionRoot,
  componentDigests: {
    persistence: component(['src/sqlite-opfs.adapter.ts', 'src/recovery-safe-vfs.ts', 'src/repository-ledger.ts']),
    ownership: component([
      'src/ownership-protocol.ts', 'src/repository-ownership.ts', 'src/cooperative-handoff.ts',
    ]),
    migration: hashBuildFile('src/migration-protocol.ts'),
    update: hashBuildFile('src/update-gate.ts'),
    protocol: component(['src/repository-protocol.ts', 'src/revision-protocol.ts', 'src/command-receipt.ts']),
    fixture: component(['fixtures/known-project-v1.json', 'fixtures/compatibility-manifest.json']),
    evidence: component([
      'src/evidence.ts', 'src/evidence-contract.ts', 'test-support/harness.port.ts',
      'test-support/ownership-harness.port.ts',
      'test-support/run-isolation.ts', 'test-support/known-project.fixture.ts',
    ]),
  },
  toolchainDigest: hashBuildValue(`${process.version}\nnpm@11.16.0\ntypescript@7.0.2\nvite@8.1.5`),
  buildConfigurationDigest: hashBuildFile('vite.config.ts'),
  lockfileDigest: hashBuildValue(readFileSync(new URL('../../package-lock.json', import.meta.url))),
  dependencyClosureDigest: hashBuildValue(readFileSync(new URL('../../package-lock.json', import.meta.url))),
};

export default defineConfig(({ mode }) => {
  const qualification = mode === 'qualification';
  return {
    root: spikeRoot,
    base: './',
    define: { __PMAPP_QUALIFICATION_SUBJECT__: JSON.stringify(qualificationSubject) },
    build: {
      outDir: qualification ? 'dist/qualification' : 'dist/production',
      emptyOutDir: true,
      manifest: true,
      rollupOptions: {
        input: fileURLToPath(new URL(qualification ? './qualification.html' : './index.html', import.meta.url)),
      },
    },
    plugins: [{
      name: 'pmapp-build-identity',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'pmapp-build-identity.json',
          source: `${JSON.stringify({ mode, ...identity, buildConfigurationDigest: qualificationSubject.buildConfigurationDigest }, null, 2)}\n`,
        });
      },
    }],
    server: {
      host: '127.0.0.1',
      port: 4173,
      strictPort: true,
      fs: {
        allow: ['../..', '..', '.', 'C:/Projects/PMApp/node_modules'],
      },
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Service-Worker-Allowed': '/' },
    },
    worker: { format: 'es' },
    preview: {
      host: '127.0.0.1',
      port: 4173,
      strictPort: true,
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Service-Worker-Allowed': '/' },
    },
  };
});
