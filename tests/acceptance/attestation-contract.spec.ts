import { execFileSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'sign-release-attestation.mjs');

function unsignedAttestation(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0.0',
    purpose: 'production',
    assetManifestRoot: 'a'.repeat(64),
    qualificationSubjectDigest: 'b'.repeat(64),
    lockfileDigest: 'c'.repeat(64),
    sqliteDigest: 'd'.repeat(64),
    wasmDigest: 'e'.repeat(64),
    vfsDigest: 'f'.repeat(64),
    adapterDigest: '0'.repeat(64),
    storageMode: 'opfs-sah-pool',
    schemaCompatibilityPair: { from: 'v1', to: 'v1' },
    deployEnvelopeDigest: '1'.repeat(64),
    cohorts: [{ browserName: 'Google Chrome', browserBuild: '151.0.7823.42', appForm: 'browser-tab', storageState: 'persistence-granted' }],
    attemptDigest: '2'.repeat(64),
    evidenceDigest: '3'.repeat(64),
    matrixDigest: '4'.repeat(64),
    testDate: '2026-08-19T00:00:00Z',
    issuedAt: '2026-08-19T00:00:00Z',
    notBefore: '2026-08-19T00:00:00Z',
    notAfter: '2026-08-25T00:00:00Z',
    evidenceUri: 'reports/evidence/phase-0-durability/attempt/runs/run.json',
    ...overrides,
  };
}

function rawPublicKeyBytes(publicKeyPemPath: string): Uint8Array {
  const jwk = createPublicKey(readFileSync(publicKeyPemPath, 'utf8')).export({ format: 'jwk' }) as { x: string };
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const map = new Map([...alphabet].map((char, index) => [char, index]));
  const bytes: number[] = [];
  let buffer = 0, bits = 0;
  for (const char of jwk.x) {
    const digit = map.get(char);
    if (digit === undefined) continue;
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 0xff); }
  }
  return new Uint8Array(bytes);
}

test.describe('Story 1.4 Gate B attestation', () => {
  test('[P0] canonicalizeJcs sorts keys deterministically regardless of input order', async () => {
    const { canonicalizeJcs } = await import('../../spikes/phase-0-durability/src/attestation');
    const a = canonicalizeJcs({ b: 1, a: 2, c: [3, 2, 1] });
    const b = canonicalizeJcs({ c: [3, 2, 1], a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":[3,2,1]}');
  });

  test('[P0] parseRejectingDuplicateKeys rejects duplicate keys at any nesting depth', async () => {
    const { parseRejectingDuplicateKeys } = await import('../../spikes/phase-0-durability/src/attestation');
    expect(parseRejectingDuplicateKeys('{"a":1,"b":2}')).toEqual({ a: 1, b: 2 });
    expect(() => parseRejectingDuplicateKeys('{"a":1,"a":2}')).toThrow('DUPLICATE_JSON_KEY');
    expect(() => parseRejectingDuplicateKeys('{"a":{"b":1,"b":2}}')).toThrow('DUPLICATE_JSON_KEY');
  });

  test('[P0] a dev-signed attestation verifies, and any single mutated field breaks verification', async ({}, testInfo) => {
    const dir = testInfo.outputPath('attestation');
    mkdirSync(dir, { recursive: true });
    const keyPath = path.join(dir, 'test-key.dev-only.pem');
    execFileSync('node', [SCRIPT, '--generate-dev-keypair', '--out', keyPath], { cwd: REPO_ROOT });

    const attestationPath = path.join(dir, 'attestation.json');
    writeFileSync(attestationPath, JSON.stringify(unsignedAttestation()), 'utf8');
    const signedPath = path.join(dir, 'signed.json');
    execFileSync('node', [SCRIPT, '--attestation', attestationPath, '--key', keyPath, '--out', signedPath], { cwd: REPO_ROOT });

    const signed = JSON.parse(readFileSync(signedPath, 'utf8'));
    expect(typeof signed.signature).toBe('string');
    const publicKeyBytes = rawPublicKeyBytes(keyPath.replace(/\.dev-only\.pem$/, '.pub.dev-only.pem'));

    const { verifyProductionAttestation } = await import('../../spikes/phase-0-durability/src/attestation');
    await expect(verifyProductionAttestation(signed, publicKeyBytes)).resolves.toBe(true);

    const tampered = { ...signed, assetManifestRoot: 'f'.repeat(64) };
    await expect(verifyProductionAttestation(tampered, publicKeyBytes)).resolves.toBe(false);

    const wrongKeyBytes = rawPublicKeyBytes(keyPath.replace(/\.dev-only\.pem$/, '.pub.dev-only.pem'));
    wrongKeyBytes[0] = (wrongKeyBytes[0] + 1) % 256;
    await expect(verifyProductionAttestation(signed, wrongKeyBytes)).resolves.toBe(false);
  });

  test('[P0] the signing script refuses to sign a non-production-purpose or already-signed attestation', async ({}, testInfo) => {
    const dir = testInfo.outputPath('attestation-refuse');
    mkdirSync(dir, { recursive: true });
    const keyPath = path.join(dir, 'test-key.dev-only.pem');
    execFileSync('node', [SCRIPT, '--generate-dev-keypair', '--out', keyPath], { cwd: REPO_ROOT });

    const labPath = path.join(dir, 'lab-attestation.json');
    writeFileSync(labPath, JSON.stringify(unsignedAttestation({ purpose: 'lab' })), 'utf8');
    expect(() => execFileSync('node', [SCRIPT, '--attestation', labPath, '--key', keyPath], { cwd: REPO_ROOT, stdio: 'pipe' }))
      .toThrow();

    const alreadySignedPath = path.join(dir, 'already-signed.json');
    writeFileSync(alreadySignedPath, JSON.stringify(unsignedAttestation({ signature: 'x' })), 'utf8');
    expect(() => execFileSync('node', [SCRIPT, '--attestation', alreadySignedPath, '--key', keyPath], { cwd: REPO_ROOT, stdio: 'pipe' }))
      .toThrow();
  });
});
