import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashBuildValue, projectRoot } from './build-identity';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonical = (value: Record<string, string>) => Object.entries(value)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([key, digest]) => `${key}:${digest}`)
  .join('\n');

const srcTauriRoot = path.resolve(projectRoot, 'src-tauri');

const nativeIdentityFiles = [
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/build.rs',
  'src-tauri/tauri.conf.json',
  'src-tauri/capabilities/default.json',
  'src-tauri/src/main.rs',
  'src-tauri/src/lib.rs',
  'src-tauri/src/protocol/mod.rs',
  'src-tauri/src/protocol/uuid_v7.rs',
  'src-tauri/src/protocol/errors.rs',
  'src-tauri/src/db/mod.rs',
  'src-tauri/src/db/schema.rs',
  'src-tauri/src/db/handler.rs',
  'src-tauri/src/db/runtime.rs',
  'src-tauri/src/commands/mod.rs',
  'src-tauri/src/commands/repository.rs',
  'src-tauri/src/events.rs',
  'src-tauri/src/backup/mod.rs',
  'src-tauri/src/backup/package.rs',
  'src-tauri/src/migration/registry.rs',
  'src-tauri/src/migration/runner.rs',
  'src-tauri/src/state.rs',
  'src-tauri/src/fault_injection.rs',
] as const;

function fileDigest(relativePath: string): string {
  return hash(readFileSync(path.resolve(projectRoot, relativePath)));
}

function fileDigestOptional(relativePath: string): string | null {
  try {
    return fileDigest(relativePath);
  } catch {
    return null;
  }
}

function toolchainDigest(): string {
  const rustc = (() => {
    try { return execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(); }
    catch { return 'unavailable'; }
  })();
  const cargo = (() => {
    try { return execFileSync('cargo', ['--version'], { encoding: 'utf8' }).trim(); }
    catch { return 'unavailable'; }
  })();
  return hash(`${rustc}\n${cargo}`);
}

export function computeNativeBuildIdentity() {
  const files = Object.fromEntries(
    nativeIdentityFiles.map((relativePath) => {
      const digest = fileDigestOptional(relativePath);
      return [relativePath, digest ?? 'absent'];
    }),
  );
  return Object.freeze({
    nativeBridgeDigest: hash(canonical(files)),
    nativeModules: [...nativeIdentityFiles],
    toolchainDigest: toolchainDigest(),
    buildConfigurationDigest: hash(
      canonical({
        'Cargo.toml': fileDigest('src-tauri/Cargo.toml'),
        'tauri.conf.json': fileDigest('src-tauri/tauri.conf.json'),
        'capabilities/default.json': fileDigest('src-tauri/capabilities/default.json'),
      }),
    ),
    sourceFiles: files,
  });
}

export function hashBuild(value: string | Buffer): string {
  return hash(value);
}
