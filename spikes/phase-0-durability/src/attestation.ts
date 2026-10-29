// Story 1.4 (Gate B) — RFC 8785 canonical JSON, SHA-256 digesting, and Ed25519 signature
// verification for the production attestation object (PHASE-0-DURABILITY.md "Evidence bundle").
// Signing itself is deliberately NOT in this file — it happens only in the Node-only tooling
// script scripts/sign-release-attestation.mjs, never inside any bundle this app ships.

export type ProductionAttestationDocument = Readonly<{
  schemaVersion: '1.0.0';
  purpose: 'production';
  assetManifestRoot: string;
  qualificationSubjectDigest: string;
  lockfileDigest: string;
  sqliteDigest: string;
  wasmDigest: string;
  vfsDigest: string;
  adapterDigest: string;
  storageMode: string;
  schemaCompatibilityPair: Readonly<{ from: string; to: string }>;
  deployEnvelopeDigest: string;
  cohorts: readonly Readonly<{ browserName: string; browserBuild: string; appForm: 'browser-tab' | 'installed'; storageState: string }>[];
  attemptDigest: string;
  evidenceDigest: string;
  matrixDigest: string;
  testDate: string;
  issuedAt: string;
  notBefore: string;
  notAfter: string;
  evidenceUri: string;
}>;

export type SignedProductionAttestation = ProductionAttestationDocument & Readonly<{ signature: string }>;

/**
 * A scoped RFC 8785 (JSON Canonicalization Scheme) implementation sufficient for this app's own
 * fixed, ASCII-keyed, integer/string-valued attestation shape: recursively sorts object keys by
 * UTF-16 code unit, arrays keep source order, no floats requiring JCS's exotic ECMAScript
 * number-formatting rules appear anywhere in this object. Not a general-purpose JCS library.
 */
export function canonicalizeJcs(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`).join(',')}}`;
  }
  throw new Error(`CANONICALIZATION_UNSUPPORTED_VALUE:${typeof value}`);
}

/**
 * A compliant canonicalizer must REJECT duplicate keys when parsing untrusted JSON text, not
 * silently canonicalize the last-one-wins value away (plain JSON.parse is last-one-wins). This
 * is a small recursive-descent parser scoped to enforce that one rule per object, at every
 * nesting depth, before the value is handed to canonicalizeJcs().
 */
export function parseRejectingDuplicateKeys(rawJson: string): unknown {
  let index = 0;
  const error = (code: string): never => { throw new Error(code); };
  const skipWhitespace = () => { while (index < rawJson.length && /\s/.test(rawJson[index]!)) index += 1; };
  const parseValue = (): unknown => {
    skipWhitespace();
    const char = rawJson[index];
    if (char === '{') return parseObject();
    if (char === '[') return parseArray();
    if (char === '"') return parseString();
    if (char === 't' || char === 'f') return parseKeyword();
    if (char === 'n') return parseKeyword();
    if (char === '-' || (char !== undefined && char >= '0' && char <= '9')) return parseNumber();
    return error('MALFORMED_JSON');
  };
  const parseKeyword = (): unknown => {
    if (rawJson.startsWith('true', index)) { index += 4; return true; }
    if (rawJson.startsWith('false', index)) { index += 5; return false; }
    if (rawJson.startsWith('null', index)) { index += 4; return null; }
    return error('MALFORMED_JSON');
  };
  const parseNumber = (): number => {
    const start = index;
    if (rawJson[index] === '-') index += 1;
    while (index < rawJson.length && /[0-9.eE+-]/.test(rawJson[index]!)) index += 1;
    const text = rawJson.slice(start, index);
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) return error('MALFORMED_JSON');
    return parsed;
  };
  const parseString = (): string => {
    index += 1;
    let result = '';
    while (rawJson[index] !== '"') {
      if (index >= rawJson.length) return error('MALFORMED_JSON');
      if (rawJson[index] === '\\') {
        index += 1;
        const esc = rawJson[index];
        const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (esc === 'u') {
          result += String.fromCharCode(parseInt(rawJson.slice(index + 1, index + 5), 16));
          index += 5;
        } else {
          result += map[esc!] ?? error('MALFORMED_JSON');
          index += 1;
        }
      } else {
        result += rawJson[index];
        index += 1;
      }
    }
    index += 1;
    return result;
  };
  const parseArray = (): unknown[] => {
    index += 1;
    const result: unknown[] = [];
    skipWhitespace();
    if (rawJson[index] === ']') { index += 1; return result; }
    for (;;) {
      result.push(parseValue());
      skipWhitespace();
      if (rawJson[index] === ',') { index += 1; continue; }
      if (rawJson[index] === ']') { index += 1; return result; }
      return error('MALFORMED_JSON');
    }
  };
  const parseObject = (): Record<string, unknown> => {
    index += 1;
    const result: Record<string, unknown> = {};
    const seen = new Set<string>();
    skipWhitespace();
    if (rawJson[index] === '}') { index += 1; return result; }
    for (;;) {
      skipWhitespace();
      if (rawJson[index] !== '"') return error('MALFORMED_JSON');
      const key = parseString();
      if (seen.has(key)) return error('DUPLICATE_JSON_KEY');
      seen.add(key);
      skipWhitespace();
      if (rawJson[index] !== ':') return error('MALFORMED_JSON');
      index += 1;
      result[key] = parseValue();
      skipWhitespace();
      if (rawJson[index] === ',') { index += 1; continue; }
      if (rawJson[index] === '}') { index += 1; return result; }
      return error('MALFORMED_JSON');
    }
  };
  const value = parseValue();
  skipWhitespace();
  if (index !== rawJson.length) error('MALFORMED_JSON');
  return value;
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toBase64UrlUnpadded(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!, b1 = bytes[i + 1], b2 = bytes[i + 2];
    result += BASE64URL_ALPHABET[b0 >> 2];
    result += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    if (b1 !== undefined) result += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    if (b2 !== undefined) result += BASE64URL_ALPHABET[b2 & 0x3f];
  }
  return result;
}

export function fromBase64UrlUnpadded(value: string): Uint8Array {
  const map = new Map([...BASE64URL_ALPHABET].map((char, index) => [char, index]));
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of value) {
    const digit = map.get(char);
    if (digit === undefined) throw new Error('INVALID_BASE64URL');
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Verifies an already-issued production attestation's Ed25519 signature via WebCrypto. Requires
 * a browser/worker runtime with Ed25519 support in SubtleCrypto (landed in Chromium ~137+, well
 * within this story's minimum major-150 cohort). This module never signs — only verifies.
 */
export async function verifyProductionAttestation(
  attestation: SignedProductionAttestation,
  publicKeyRawBytes: Uint8Array,
): Promise<boolean> {
  const { signature, ...unsigned } = attestation;
  const canonical = canonicalizeJcs(unsigned);
  const key = await crypto.subtle.importKey('raw', publicKeyRawBytes as BufferSource, { name: 'Ed25519' }, false, ['verify']);
  const signatureBytes = fromBase64UrlUnpadded(signature);
  const message = new TextEncoder().encode(canonical);
  return crypto.subtle.verify({ name: 'Ed25519' }, key, signatureBytes as BufferSource, message as BufferSource);
}
