import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createAuthenticator, createNonce, sha256Hex } from './credential.port';
import { requestSigningPayload } from '../../domain/collaboration/guest-identity';

// A minimal WebCrypto ECDSA key for the browser path.
async function browserCredential() {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  return {
    credential: { kind: 'public-key' as const, publicKeyB64: 'x', cryptoKey: keyPair.privateKey },
    publicKey: keyPair.publicKey,
  };
}

describe('credential authenticator (Story 27.4/27.7, R6/H01)', () => {
  it('the desktop path returns the bearer and no proof', async () => {
    const auth = createAuthenticator('dev-1', { kind: 'bearer-hash', bearer: 'sekret' }, () => '2026-10-04T00:00:00Z');
    const headers = await auth({ method: 'POST', path: '/x', bodyBytes: new Uint8Array() });
    expect(headers).toEqual({ deviceId: 'dev-1', bearer: 'sekret', proof: null });
  });

  it('the browser path signs the canonical payload (method/path/digest/nonce/timestamp)', async () => {
    const { credential, publicKey } = await browserCredential();
    const now = () => '2026-10-04T00:00:00Z';
    const auth = createAuthenticator('dev-2', credential, now);
    const body = new TextEncoder().encode('{"a":1}');
    const headers = await auth({ method: 'POST', path: '/projects/p/commands', bodyBytes: body });
    expect(headers.bearer).toBeNull();
    expect(headers.proof).not.toBeNull();
    // The signature verifies against the canonical payload the server rebuilds.
    const digest = await sha256Hex(body);
    const payload = requestSigningPayload({ method: 'POST', path: '/projects/p/commands', bodyDigest: digest, nonce: headers.proof!.nonce, timestamp: headers.proof!.timestamp });
    const sigBytes = Uint8Array.from(atob(headers.proof!.signature.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sigBytes as unknown as BufferSource, new TextEncoder().encode(payload));
    expect(ok).toBe(true);
  });

  it('createNonce produces distinct URL-safe values', () => {
    const a = createNonce();
    const b = createNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
