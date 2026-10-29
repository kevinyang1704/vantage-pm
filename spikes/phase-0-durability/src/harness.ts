import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { computeBuildIdentity, hashBuildFile, productionModules } from '../build-identity';

const RUN_NAMESPACE = /^\/pmapp-phase0\/run-([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

export function createHarnessTestPort(input: { origin: string; runId: string; namespace: string; seed: number }) {
  if (!RUN_NAMESPACE.test(input.namespace) || input.namespace !== `/pmapp-phase0/run-${input.runId}`) {
    throw new Error('INVALID_RUN_NAMESPACE');
  }
  return {
    async resetRunNamespace(target: string) {
      if (target !== input.namespace) throw new Error('RESET_TARGET_OUTSIDE_CURRENT_RUN');
      return { code: 'RUN_NAMESPACE_TARGET_VALIDATED', target } as const;
    },
  };
}

export async function listProductionCompositionModules() {
  return productionModules;
}

export async function listProductionMessageTypes() {
  return ['ApplyCommand', 'InspectCommandLedger', 'VfsCommitAccepted'] as const;
}

export async function inspectProductionBundleForForbiddenControls(
  root = path.resolve('spikes/phase-0-durability/dist/production'),
) {
  const current = computeBuildIdentity();
  const retained = JSON.parse(await readFile(path.join(root, 'pmapp-build-identity.json'), 'utf8')) as Record<string, unknown>;
  if (retained.mode !== 'production' ||
      retained.executableTreeDigest !== current.executableTreeDigest ||
      retained.productionCompositionRoot !== current.productionCompositionRoot ||
      retained.buildConfigurationDigest !== hashBuildFile('vite.config.ts')) {
    throw new Error('STALE_PRODUCTION_BUNDLE');
  }
  const manifest = JSON.parse(await readFile(path.join(root, '.vite', 'manifest.json'), 'utf8')) as Record<
    string, { file: string; imports?: string[]; isEntry?: boolean }
  >;
  const entryKeys = Object.entries(manifest).filter(([, item]) => item.isEntry).map(([key]) => key);
  if (entryKeys.length !== 1) throw new Error('INVALID_PRODUCTION_BUNDLE_GRAPH');
  const graphFiles = new Set<string>();
  const visit = (key: string) => {
    const item = manifest[key];
    if (!item) throw new Error(`MISSING_PRODUCTION_BUNDLE_NODE:${key}`);
    graphFiles.add(item.file);
    for (const dependency of item.imports ?? []) visit(dependency);
  };
  visit(entryKeys[0]!);

  const forbidden = [
    'InjectFault', 'DurableCommitAcknowledged', 'CandidateDurabilityBoundaryObserved',
    'F1_BEFORE_JOURNAL_SYNC', 'F2_AFTER_JOURNAL_SYNC', 'F3_BEFORE_JOURNAL_DELETE_FORWARD',
    'fault-control.test-only', 'lab-purpose.test-only',
  ];
  const matches: string[] = [];
  const allJavaScript = new Set<string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.name.endsWith('.js')) {
        allJavaScript.add(path.relative(root, target).replaceAll('\\', '/'));
        const source = await readFile(target, 'utf8');
        for (const token of forbidden) if (source.includes(token)) matches.push(`${entry.name}:${token}`);
      }
    }
  };
  await walk(root);
  const missingGraphFiles = [...graphFiles].filter((file) => !allJavaScript.has(file));
  if (missingGraphFiles.length) throw new Error(`MISSING_GRAPH_ASSET:${missingGraphFiles.join(',')}`);
  return {
    status: matches.length ? 'FAIL' as const : 'PASS' as const,
    matches,
    graphFiles: [...graphFiles].sort(),
    scannedJavaScript: [...allJavaScript].sort(),
  };
}
