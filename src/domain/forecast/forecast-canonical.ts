/**
 * Forecast canonical serialization (Story 18.1, AC 18.1-5, AR-15, AR-16).
 *
 * Canonical serialization is an architectural contract: use the project's
 * RFC 8785 canonical JSON convention for fingerprints and deterministic
 * result bytes; integer ratio components serialize as canonical unsigned
 * base-10 strings without leading zeros. Reduce ratios by GCD with positive
 * denominator (`25/10` serializes as `5/2`, zero as `0/1`). Preserve ordered
 * scope arrays exactly. Sort semantically unordered ID arrays by lowercase
 * UUID lexical order. Schema specifies explicit nulls, never
 * omitted-versus-null alternatives.
 */

import { canonicalizeJcs } from '../../../spikes/phase-0-durability/src/attestation';

/** Greatest common divisor (Euclid) for exact rational reduction. */
export function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

/**
 * An exact rational ratio with a positive reduced denominator. Serializes
 * as `numerator/denominator` with GCD-reduced components (AR-16).
 */
export type ReducedRatio = Readonly<{
  numerator: number;
  denominator: number;
}>;

export function reduceRatio(numerator: number, denominator: number): ReducedRatio {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new Error('INVALID_RATIO');
  }
  if (numerator === 0) {
    return Object.freeze({ numerator: 0, denominator: 1 });
  }
  const g = gcd(numerator, denominator);
  return Object.freeze({ numerator: numerator / g, denominator: denominator / g });
}

export function formatRatio(ratio: ReducedRatio): string {
  return `${ratio.numerator}/${ratio.denominator}`;
}

/** Sort unordered ID arrays by lowercase UUID lexical order (AR-16). */
export function sortIdsLexically(ids: readonly string[]): readonly string[] {
  return Object.freeze(
    [...ids].sort((a, b) => {
      const la = a.toLowerCase();
      const lb = b.toLowerCase();
      return la < lb ? -1 : la > lb ? 1 : 0;
    }),
  );
}

/**
 * Canonicalize a forecast value to deterministic bytes. Object keys are
 * sorted at every level (RFC 8785); arrays preserve source order — callers
 * must pre-sort semantically unordered collections with `sortIdsLexically`
 * before canonicalizing.
 */
export function canonicalizeForecast(value: unknown): string {
  return canonicalizeJcs(value);
}

/**
 * Compute the lowercase-hex SHA-256 material fingerprint of a canonicalized
 * forecast value. Uses the Web Crypto API so it works in the browser, the
 * worker, and Node (no `node:crypto` in client bundles).
 */
export async function computeForecastFingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeForecast(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Synchronous SHA-256 for repository command boundaries that cannot await Web Crypto. */
export function computeForecastFingerprintSync(value: unknown): string {
  const bytes = new TextEncoder().encode(canonicalizeForecast(value));
  const words: number[] = [];
  for (const byte of bytes) words.push(byte);
  words.push(0x80);
  while (words.length % 64 !== 56) words.push(0);
  const bitLength = bytes.length * 8;
  for (let shift = 56; shift >= 0; shift -= 8) {
    words.push(shift >= 32 ? 0 : (bitLength >>> shift) & 0xff);
  }
  const k = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < words.length; offset += 64) {
    const w = new Array<number>(64);
    for (let i = 0; i < 16; i += 1) {
      const p = offset + i * 4;
      w[i] = ((words[p] << 24) | (words[p + 1] << 16) | (words[p + 2] << 8) | words[p + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + k[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    const next = [a,b,c,d,e,f,g,hh];
    for (let i = 0; i < 8; i += 1) h[i] = (h[i] + next[i]) >>> 0;
  }
  return h.map((word) => word.toString(16).padStart(8, '0')).join('');
}
