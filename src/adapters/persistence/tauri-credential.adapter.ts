/**
 * Desktop guest-identity credentials (Story 27.4, D5, R6).
 *
 * The desktop app keeps a random bearer credential in the OS keychain. The
 * server stores only `sha256(credential)`; the bearer is sent over TLS and
 * compared by hash. The keychain access goes through a Tauri command
 * (`collaboration_credential_*`) so the secret never lives in webview storage.
 *
 * Composed only when the `collaboration` flag is on (AD-20).
 */

import { invoke } from '@tauri-apps/api/core';
import type { CredentialPort, DeviceCredential } from '../../application/collaboration/credential.port';

/** Generate a random 256-bit bearer credential as lowercase hex. */
export function generateBearerCredential(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of the bearer, lowercase hex (matches the server verifier). */
export async function bearerVerifier(bearer: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bearer));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Tauri keychain credential port. Each method invokes a native command; the
 * secret is returned to the webview only for the request that needs it.
 */
export function createDesktopCredentialPort(): CredentialPort {
  return {
    async load(actorId: string): Promise<DeviceCredential | null> {
      const bearer = await invoke<string | null>('collaboration_credential_get', { actorId });
      return bearer ? Object.freeze({ kind: 'bearer-hash' as const, bearer }) : null;
    },
    async store(actorId: string, credential: DeviceCredential): Promise<void> {
      if (credential.kind !== 'bearer-hash') throw new Error('DESKTOP_EXPECTS_BEARER_CREDENTIAL');
      await invoke('collaboration_credential_set', { actorId, bearer: credential.bearer });
    },
    async remove(actorId: string): Promise<void> {
      await invoke('collaboration_credential_delete', { actorId });
    },
  };
}
