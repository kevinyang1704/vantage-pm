import { canonicalizeJcs } from './attestation';
import { sha256Hex } from './restart-inspector';

// Story 1.4 (Gate B), AD-14 "Deployment envelope": binds the release job's hosting configuration
// into the attestation so a hosting-provider swap or header/CSP drift is detected, not silently
// trusted. KNOWN GAP: no real hosting/headers config (_headers, netlify.toml, vercel.json, ...)
// exists anywhere in this repo yet — this module computes the digest correctly from the one real
// config that DOES exist today (the dev/preview server headers in vite.config.ts), but live
// deploy-envelope verification (comparing this digest against an actually-deployed origin, per
// AD-14) has nothing real to verify against until a hosting target is chosen. That verification
// step stays a documented TODO, not simulated here.
export type DeployEnvelopeDescriptor = Readonly<{
  originPolicy: string;
  serviceWorkerScope: string;
  tlsPolicy: string;
  cspHeaders: Readonly<Record<string, string>>;
  workerIsolationHeaders: Readonly<Record<string, string>>;
  mimeMappings: Readonly<Record<string, string>>;
  cacheDirectives: Readonly<Record<string, string>>;
  redirects: readonly Readonly<{ from: string; to: string; status: number }>[];
  immutableAssetPaths: readonly string[];
}>;

export const CURRENT_DEV_DEPLOY_ENVELOPE: DeployEnvelopeDescriptor = Object.freeze({
  originPolicy: 'http://127.0.0.1:4173',
  serviceWorkerScope: '/',
  tlsPolicy: 'dev-server-no-tls',
  cspHeaders: Object.freeze({}),
  workerIsolationHeaders: Object.freeze({
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Service-Worker-Allowed': '/',
  }),
  mimeMappings: Object.freeze({}),
  cacheDirectives: Object.freeze({}),
  redirects: Object.freeze([]),
  immutableAssetPaths: Object.freeze(['/assets/']),
});

export async function computeDeployEnvelopeDigest(descriptor: DeployEnvelopeDescriptor): Promise<string> {
  return sha256Hex(canonicalizeJcs(descriptor));
}
