/**
 * Credential port (Story 27.4, D5, R6).
 *
 * The client keeps its device credential and proves possession on each request.
 * Two adapter families implement this:
 * - desktop: a random bearer credential held in the OS keychain; the port
 *   returns the bearer secret (sent over TLS), and the server compares its hash.
 * - browser: a non-exportable WebCrypto key pair; the port never returns a
 *   secret, only a signature over the request payload.
 *
 * Inward-owned: adapters depend on this, not the reverse (AD-1).
 */

import { requestSigningPayload } from '../../domain/collaboration/guest-identity';

export type DeviceCredential =
  | Readonly<{ kind: 'bearer-hash'; bearer: string }>
  | Readonly<{ kind: 'public-key'; publicKeyB64: string; cryptoKey: CryptoKey }>;

export interface CredentialPort {
  /**
   * Load the device credential for a project's registration, or null when the
   * device has not joined. `actorId` keys the stored credential.
   */
  load(actorId: string): Promise<DeviceCredential | null>;

  /** Persist a newly created device credential (registration). */
  store(actorId: string, credential: DeviceCredential): Promise<void>;

  /** Remove a device credential (leave / stop sharing). */
  remove(actorId: string): Promise<void>;
}

/** Sign a request payload with the loaded credential (browser proof-of-possession). */
export async function provePossession(credential: DeviceCredential, payload: string): Promise<string> {
  if (credential.kind === 'bearer-hash') {
    // The desktop bearer credential is sent directly; the payload binding is the
    // bearer secret's hash, which the server records. No separate signature.
    return credential.bearer;
  }
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    credential.cryptoKey,
    new TextEncoder().encode(payload),
  );
  return base64url(new Uint8Array(signature));
}

/** Lowercase-hex SHA-256 of bytes (matches the server's `sha256_hex`). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A random URL-safe nonce for the browser proof. */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/**
 * Build an authenticator that yields the exact headers the server verifies
 * (H01). Desktop sends the bearer; the browser signs the canonical payload
 * `method\npath\nbodyDigest\nnonce\ntimestamp` with its non-exportable key.
 * Returns a `AuthHeaders`-shaped object (typed loosely to avoid an adapter
 * import cycle).
 */
export function createAuthenticator(
  deviceId: string,
  credential: DeviceCredential,
  nowISO: () => string,
): (input: { method: string; path: string; bodyBytes: Uint8Array }) => Promise<{
  deviceId: string;
  bearer: string | null;
  proof: { nonce: string; timestamp: string; signature: string } | null;
}> {
  return async ({ method, path, bodyBytes }) => {
    if (credential.kind === 'bearer-hash') {
      return { deviceId, bearer: credential.bearer, proof: null };
    }
    const digest = await sha256Hex(bodyBytes);
    const nonce = createNonce();
    const timestamp = nowISO();
    const payload = requestSigningPayload({ method, path, bodyDigest: digest, nonce, timestamp });
    const signature = await provePossession(credential, payload);
    return { deviceId, bearer: null, proof: { nonce, timestamp, signature } };
  };
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
