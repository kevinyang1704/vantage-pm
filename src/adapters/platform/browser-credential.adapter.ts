/**
 * Browser guest-identity credentials (Story 27.4, D5, R6).
 *
 * The browser build uses a NON-EXPORTABLE WebCrypto key pair (ECDSA P-256).
 * `extractable: false` means the private key never leaves the browser; the
 * server stores only the public verification material and verifies a signature
 * over a freshness nonce. The key is persisted as a non-extractable `CryptoKey`
 * in IndexedDB (structured-clonable), never as raw bytes in `localStorage`.
 *
 * This module is only composed when the `collaboration` flag is on (AD-20);
 * a local project never creates a key or touches IndexedDB.
 */

import type { CredentialPort, DeviceCredential } from '../../application/collaboration/credential.port';

const STORE = 'device-credentials';
/** Nonportable shared-project mapping (H08); see shared-project-registry.ts. */
export const SHARED_PROJECTS_STORE = 'shared-projects';
const DB_NAME = 'pmapp-collaboration';
const DB_VERSION = 2;

/** Open the collaboration database, creating every store it owns. */
export function openCollaborationDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      for (const name of [STORE, SHARED_PROJECTS_STORE]) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('CREDENTIAL_REQUEST_FAILED'));
  });
}

/**
 * Run one request in its own transaction and settle only when the transaction
 * completes. Request success is provisional: a later abort must not
 * acknowledge a write that was never persisted.
 */
export function collaborationTx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = run(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error ?? new Error('CREDENTIAL_TRANSACTION_ABORTED'));
    transaction.onerror = () => reject(transaction.error ?? new Error('CREDENTIAL_TRANSACTION_FAILED'));
    request.onerror = () => reject(request.error);
  });
}

const openDb = openCollaborationDb;
function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return collaborationTx(db, STORE, mode, run);
}

/** Generate a non-exportable P-256 key pair for a new device identity. */
export async function generateBrowserCredential(): Promise<DeviceCredential> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, // NOT extractable — the private key stays in the browser.
    ['sign', 'verify'],
  );
  const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey);
  return Object.freeze({
    kind: 'public-key' as const,
    publicKeyB64: base64url(new Uint8Array(spki)),
    cryptoKey: keyPair.privateKey,
  });
}

/**
 * IndexedDB credential port. The `CryptoKey` is stored via structured clone;
 * the private half cannot be exported even if the database is read.
 */
export function createBrowserCredentialPort(): CredentialPort {
  return {
    async load(actorId: string): Promise<DeviceCredential | null> {
      const db = await openDb();
      try {
        const record = await tx<DeviceCredential | undefined>(db, 'readonly', (s) => s.get(actorId));
        return record ?? null;
      } finally { db.close(); }
    },
    async store(actorId: string, credential: DeviceCredential): Promise<void> {
      const db = await openDb();
      try { await tx(db, 'readwrite', (s) => s.put(credential, actorId)); }
      finally { db.close(); }
    },
    async remove(actorId: string): Promise<void> {
      const db = await openDb();
      try { await tx(db, 'readwrite', (s) => s.delete(actorId)); }
      finally { db.close(); }
    },
  };
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
