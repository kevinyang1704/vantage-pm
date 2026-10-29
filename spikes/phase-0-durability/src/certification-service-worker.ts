// Story 1.4 (Gate B) — the controlling service worker's self-verification + nonce-bound
// MessageChannel handshake gate (AD-5, PHASE-0-DURABILITY.md "Evidence bundle"). Before granting
// a CertificationGrant, the service worker must fetch its own script and verify it plus every
// cached response body against the detached manifest, then complete a nonce-bound handshake
// reporting manifest root, script URL, scope, cache namespace, and controller state.
//
// This is deliberately new production code (not an extension of service-worker.test-only.ts,
// which is a Gate-A-only PING/PONG stub excluded from production). The pure adjudication logic
// below is separated from the ServiceWorkerGlobalScope I/O so it is directly unit-testable; the
// I/O wiring at the bottom is exercised only by a real browser in
// tests/e2e/phase-0-durability/service-worker-certification.spec.ts.
import { sha256Hex } from './restart-inspector';

export const CERTIFICATION_CACHE_NAMESPACE = 'pmapp-certification-v1';

export type AssetManifest = Readonly<{
  root: string;
  entries: Readonly<Record<string, string>>;
}>;

export type HandshakeRequest = Readonly<{ type: 'CERTIFY_HANDSHAKE'; nonce: string }>;
export type HandshakeAck = Readonly<{
  type: 'CERTIFY_HANDSHAKE_ACK';
  nonce: string;
  // null whenever self-verification failed — the caller must fail closed, never infer success.
  manifestRoot: string | null;
  scriptURL: string;
  scope: string;
  cacheNamespace: string;
  controllerState: 'activated-controlling';
}>;

export type ManifestVerification = Readonly<{
  verified: boolean;
  missing: readonly string[];
  mismatched: readonly string[];
}>;

/** Pure: never infers success from cache presence alone — every entry must hash-match exactly. */
export function adjudicateManifestVerification(
  manifest: AssetManifest,
  observedHashes: ReadonlyMap<string, string>,
): ManifestVerification {
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const [url, expected] of Object.entries(manifest.entries)) {
    const observed = observedHashes.get(url);
    if (observed === undefined) missing.push(url);
    else if (observed !== expected) mismatched.push(url);
  }
  return Object.freeze({ verified: missing.length === 0 && mismatched.length === 0, missing: Object.freeze(missing), mismatched: Object.freeze(mismatched) });
}

/** Pure: builds the handshake ack from already-adjudicated verification state. */
export function buildHandshakeAck(input: Readonly<{
  nonce: string;
  verification: ManifestVerification;
  manifestRoot: string;
  scriptURL: string;
  scope: string;
  cacheNamespace: string;
}>): HandshakeAck {
  return Object.freeze({
    type: 'CERTIFY_HANDSHAKE_ACK' as const,
    nonce: input.nonce,
    manifestRoot: input.verification.verified ? input.manifestRoot : null,
    scriptURL: input.scriptURL,
    scope: input.scope,
    cacheNamespace: input.cacheNamespace,
    controllerState: 'activated-controlling' as const,
  });
}

/** I/O: fetches the response body for every manifest entry and hashes it. Not unit-testable without a real Cache/fetch. */
export async function collectObservedHashes(manifest: AssetManifest, fetchEntry: (url: string) => Promise<ArrayBuffer>): Promise<Map<string, string>> {
  const observed = new Map<string, string>();
  for (const url of Object.keys(manifest.entries)) {
    try {
      const body = new Uint8Array(await fetchEntry(url));
      observed.set(url, await sha256Hex(body));
    } catch {
      // Leave unset — adjudicateManifestVerification treats it as 'missing', never as a pass.
    }
  }
  return observed;
}

// ---------------------------------------------------------------------------------------------
// I/O boundary: real ServiceWorkerGlobalScope wiring. Exercised only in a real browser.
// ---------------------------------------------------------------------------------------------
declare const self: ServiceWorkerGlobalScope;

let cachedVerification: Readonly<{ manifest: AssetManifest; verification: ManifestVerification }> | null = null;

async function loadManifest(): Promise<AssetManifest> {
  const response = await fetch('./pmapp-asset-manifest.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('ASSET_MANIFEST_FETCH_FAILED');
  return response.json() as Promise<AssetManifest>;
}

async function runSelfVerification(): Promise<Readonly<{ manifest: AssetManifest; verification: ManifestVerification }>> {
  const manifest = await loadManifest();
  const observed = await collectObservedHashes(manifest, async (url) => {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`ASSET_FETCH_FAILED:${url}`);
    return response.arrayBuffer();
  });
  const verification = adjudicateManifestVerification(manifest, observed);
  return Object.freeze({ manifest, verification });
}

// Guarded so this module stays import-safe outside a real ServiceWorkerGlobalScope (e.g. under
// vitest, which imports this file to unit-test the pure functions above) — `self` does not exist
// as a global in that environment, and this wiring must never execute there.
if (typeof self !== 'undefined' && typeof self.addEventListener === 'function' && 'skipWaiting' in self) {
  self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
      cachedVerification = await runSelfVerification().catch(() => Object.freeze({
        manifest: Object.freeze({ root: '', entries: Object.freeze({}) }),
        verification: Object.freeze({ verified: false, missing: Object.freeze([]), mismatched: Object.freeze([]) }),
      }));
      await self.skipWaiting();
    })());
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
  });

  self.addEventListener('message', (event) => {
    const data = event.data as Partial<HandshakeRequest> | undefined;
    if (!data || data.type !== 'CERTIFY_HANDSHAKE' || typeof data.nonce !== 'string' || !data.nonce) return;
    const state = cachedVerification ?? {
      manifest: { root: '', entries: {} },
      verification: { verified: false, missing: [], mismatched: [] },
    };
    const ack = buildHandshakeAck({
      nonce: data.nonce,
      verification: state.verification,
      manifestRoot: state.manifest.root,
      scriptURL: self.location.href,
      scope: self.registration.scope,
      cacheNamespace: CERTIFICATION_CACHE_NAMESPACE,
    });
    const port = event.ports[0];
    port?.postMessage(ack);
  });
}
