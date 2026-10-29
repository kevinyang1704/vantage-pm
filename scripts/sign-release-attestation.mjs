#!/usr/bin/env node
/**
 * Story 1.4 (Gate B) — Node-only production attestation signing tool.
 * NEVER imported by, or bundled into, any Vite composition — signing happens only here, offline,
 * under release-authority control. Uses Node's native Ed25519 (node:crypto), matching
 * spikes/phase-0-durability/src/attestation.ts's canonicalizeJcs() byte-for-byte so a signature
 * produced here verifies under that module's verifyProductionAttestation().
 *
 * Usage:
 *   node scripts/sign-release-attestation.mjs --generate-dev-keypair --out my-key.dev-only.pem
 *   node scripts/sign-release-attestation.mjs --attestation attestation.json --key my-key.dev-only.pem --out signed-attestation.json
 *
 * The --generate-dev-keypair mode is for local testing only — it is not a source of any real
 * production release key. Production private keys must never be committed.
 */
import { generateKeyPairSync, sign as edSign, createPrivateKey } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function toBase64UrlUnpadded(bytes) {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    result += BASE64URL_ALPHABET[b0 >> 2];
    result += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    if (b1 !== undefined) result += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    if (b2 !== undefined) result += BASE64URL_ALPHABET[b2 & 0x3f];
  }
  return result;
}

// Must match spikes/phase-0-durability/src/attestation.ts's canonicalizeJcs() exactly: recursive
// key-sort by UTF-16 code unit, no exotic number formatting (this app's attestation fields are
// all strings/integers/booleans/arrays of such).
function canonicalizeJcs(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeJcs).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJcs(value[key])}`).join(',')}}`;
  }
  throw new Error(`CANONICALIZATION_UNSUPPORTED_VALUE:${typeof value}`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { args[key] = true; }
      else { args[key] = next; i += 1; }
    }
  }
  return args;
}

function generateDevKeypair(outPath) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const targetPrivate = outPath ?? 'gate-b-dev-signing-key.dev-only.pem';
  if (!targetPrivate.endsWith('.dev-only.pem')) {
    throw new Error('DEV_KEYPAIR_OUTPUT_MUST_END_WITH_.dev-only.pem — never write a real key with this flag');
  }
  writeFileSync(targetPrivate, privatePem, 'utf8');
  writeFileSync(targetPrivate.replace(/\.dev-only\.pem$/, '.pub.dev-only.pem'), publicPem, 'utf8');
  console.log(`Wrote dev-only Ed25519 keypair: ${targetPrivate} (+ matching .pub.dev-only.pem)`);
  console.log('This is NOT a production key. Never rename it to drop the .dev-only marker.');
}

function signAttestation(attestationPath, keyPath, outPath) {
  const unsigned = JSON.parse(readFileSync(attestationPath, 'utf8'));
  if ('signature' in unsigned) throw new Error('ATTESTATION_INPUT_MUST_NOT_ALREADY_CARRY_A_SIGNATURE');
  if (unsigned.purpose !== 'production') throw new Error('ONLY_PURPOSE_PRODUCTION_MAY_BE_SIGNED_HERE');
  const privateKey = createPrivateKey(readFileSync(keyPath, 'utf8'));
  const canonical = canonicalizeJcs(unsigned);
  const signatureBytes = edSign(null, Buffer.from(canonical, 'utf8'), privateKey);
  if (signatureBytes.length !== 64) throw new Error('UNEXPECTED_ED25519_SIGNATURE_LENGTH');
  const signed = { ...unsigned, signature: toBase64UrlUnpadded(signatureBytes) };
  const target = outPath ?? attestationPath.replace(/\.json$/, '.signed.json');
  writeFileSync(target, `${JSON.stringify(signed, null, 2)}\n`, 'utf8');
  console.log(`Wrote signed production attestation: ${target}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['generate-dev-keypair']) {
    generateDevKeypair(typeof args.out === 'string' ? args.out : undefined);
    return;
  }
  if (args.attestation && args.key) {
    signAttestation(args.attestation, args.key, typeof args.out === 'string' ? args.out : undefined);
    return;
  }
  console.error(
    'Usage:\n' +
    '  node scripts/sign-release-attestation.mjs --generate-dev-keypair [--out <path>.dev-only.pem]\n' +
    '  node scripts/sign-release-attestation.mjs --attestation <path>.json --key <path>.pem [--out <path>.json]',
  );
  process.exitCode = 1;
}

main();
