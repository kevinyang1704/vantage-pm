import { sha256Hex } from './restart-inspector';

export type QualificationSubject = Readonly<{
  productionCompositionRoot: string;
  runtimeStorageMode: Readonly<Record<string, string>>;
  componentDigests: Readonly<Record<string, string>>;
  toolchainDigest: string;
  buildConfigurationDigest: string;
  lockfileDigest: string;
  dependencyClosureDigest: string;
  sourceRevision: string;
}>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function digestQualificationSubject(subject: QualificationSubject) {
  const { sourceRevision, ...identity } = subject;
  return Object.freeze({
    qualificationSubjectDigest: await sha256Hex(canonical(identity)),
    sourceRevision,
  });
}

const ALLOWED_INSTRUMENTATION = new Set([
  'src/repository.worker.qualification.entry.ts',
  'src/qualification-main.test-only.ts',
  'src/interposing-vfs.test-only.ts',
  'src/boundary-trace.test-only.ts',
  'src/fault-control.test-only.ts',
  'src/lab-purpose.test-only.ts',
  'src/parity.ts',
  'src/qualification-subject.ts',
  'src/service-worker.test-only.ts',
]);

export function compareCompositionDerivation(input: {
  production: { subjectDigest: string; modules: string[] };
  instrumented: { subjectDigest: string; modules: string[] };
}) {
  const production = new Set(input.production.modules);
  const nonAllowListedDifferences = input.instrumented.modules.filter(
    (module) => !production.has(module) && !ALLOWED_INSTRUMENTATION.has(module),
  );
  for (const module of input.production.modules) {
    if (!input.instrumented.modules.includes(module)) nonAllowListedDifferences.push(`missing:${module}`);
  }
  if (input.production.subjectDigest !== input.instrumented.subjectDigest) {
    nonAllowListedDifferences.unshift('qualification-subject-digest');
  }
  return {
    status: nonAllowListedDifferences.length ? 'FAIL' as const : 'PASS' as const,
    nonAllowListedDifferences,
  };
}

export async function digestCompositionModules(modules: readonly string[]): Promise<string> {
  return sha256Hex(canonical([...modules].sort()));
}
