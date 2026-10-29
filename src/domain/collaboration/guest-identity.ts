/**
 * Guest identity domain (Story 27.4, D5, R6, TC-FR1).
 *
 * A collaborating device has a guest identity: a display name the user chooses
 * plus a device credential. There is no account, password or email. The
 * credential is represented on the server only by a verifier (desktop: SHA-256
 * of a bearer credential; browser: public proof-of-possession material), so the
 * client never sends a secret the server could replay.
 *
 * Pure: no I/O, no WebCrypto here (AD-1). The adapter signs.
 */

/** A display name is bounded, self-declared plain text (R6). */
export const DISPLAY_NAME_MAX_LENGTH = 40;

export type GuestIdentity = Readonly<{
  /** Stable actor id for the device (UUIDv7). */
  actorId: string;
  /** Self-declared name shown beside the device's changes. */
  displayName: string;
  /**
   * How the credential is proven. The server stores the verifier matching this
   * kind; the client keeps the secret material.
   */
  credentialKind: 'bearer-hash' | 'public-key';
}>;

export type DisplayNameIssue = 'EMPTY' | 'TOO_LONG' | 'CONTROL_CHARACTERS';

/** Validate a display name; returns the normalized name or a named issue. */
export function normalizeDisplayName(raw: string): { ok: true; name: string } | { ok: false; issue: DisplayNameIssue } {
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, issue: 'CONTROL_CHARACTERS' };
  // Names are rendered as text, never HTML; collapse whitespace and trim.
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length === 0) return { ok: false, issue: 'EMPTY' };
  if (name.length > DISPLAY_NAME_MAX_LENGTH) return { ok: false, issue: 'TOO_LONG' };
  return { ok: true, name };
}

/**
 * The payload a device registers with the service. The `verifier` is public
 * material (a hash or a public key); `proof` is the kind-specific registration
 * evidence. No bearer secret ever crosses this boundary.
 */
export type DeviceRegistration = Readonly<{
  actorId: string;
  displayName: string;
  verifier: Readonly<{ kind: 'bearer-hash'; sha256: string } | { kind: 'public-key'; publicKeyB64: string }>;
}>;

/** The canonical bytes a browser device signs for a request (R6 freshness). */
export function requestSigningPayload(input: {
  method: string;
  path: string;
  bodyDigest: string;
  nonce: string;
  timestamp: string;
}): string {
  return [input.method.toUpperCase(), input.path, input.bodyDigest, input.nonce, input.timestamp].join('\n');
}
