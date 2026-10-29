// Story 1.4 (Gate B) — the repository worker's inward-owned acknowledgement policy.
// Only this module may construct a CertificationGrant; only repository.worker.ts's apply()
// pipeline may consult one before upgrading a response to DurableCommitAcknowledged (AD-5).
// UI/command payloads can never provide, persist, or upgrade a grant.

const FOUR_COMPONENT_VERSION = /^\d+\.\d+\.\d+\.\d+$/;
const WINDOWS_PLATFORM_VERSION = /^\d+(\.\d+)*$/;
const RFC3339_WHOLE_SECOND_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
// getHighEntropyValues()'s brands array always includes at least one deliberately "greased"
// entry (e.g. `"Not;A=Brand";v="8"`) to discourage brand sniffing. The only safe response is an
// allow-list of the exact real tokens, never a pattern match against the greased shape itself.
const REAL_BRAND_TOKENS = new Set(['google chrome', 'microsoft edge']);

export type RuntimeEligibilitySignals = Readonly<{
  browserBrand: string;
  browserFullVersion: string;
  platformVersion: string;
  displayMode: 'standalone' | 'browser';
  persisted: boolean;
}>;

export type ProductionAttestation = Readonly<{
  attestedBrowserBrand: 'Google Chrome' | 'Microsoft Edge';
  attestedBrowserFullVersion: string;
  attestedPlatformVersion: string;
  attestedAppForm: 'browser-tab' | 'installed';
  assetManifestRoot: string;
  issuedAt: string;
  notBefore: string;
  notAfter: string;
  // Set true only after attestation.ts's verifyProductionAttestation() has checked the
  // Ed25519 signature against the production public key — this module never re-verifies bytes.
  signatureVerified: boolean;
}>;

export type ServiceWorkerVerificationResult = Readonly<{
  state: 'activated-controlling' | 'installing' | 'waiting' | 'redundant' | 'uncontrolled';
  manifestRoot: string | null;
}>;

export type ClockFloor = Readonly<{ nowMs: number; lastKnownGoodMs: number }>;

export type CertificationGrant = Readonly<{
  readonly kind: 'CertificationGrant';
  isValid(): true;
}>;

function normalizedBrandMatches(signal: string, attested: string): boolean {
  const normalize = (value: string) => value.trim().toLowerCase();
  const normalizedSignal = normalize(signal);
  if (!REAL_BRAND_TOKENS.has(normalizedSignal)) return false;
  return normalizedSignal === normalize(attested);
}

function parseRfc3339WholeSecondUtc(value: string): number | null {
  if (!RFC3339_WHOLE_SECOND_UTC.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Pure, fail-closed decision function. Returns null (never throws) whenever any eligibility
 * signal is missing, ambiguous, greased, mismatched, or the attestation/controller state is not
 * exactly valid — the caller must treat null as "no grant," always falling back to VfsCommitAccepted.
 * Re-evaluate at session start and immediately before every durable result; never cache across commands.
 */
export function evaluateCertificationGrant(input: Readonly<{
  attestation: ProductionAttestation;
  runtimeSignals: RuntimeEligibilitySignals;
  controllerVerification: ServiceWorkerVerificationResult;
  clockFloor: ClockFloor;
}>): CertificationGrant | null {
  const { attestation, runtimeSignals, controllerVerification, clockFloor } = input;

  if (!attestation.signatureVerified) return null;

  // Runtime eligibility (PHASE-0-DURABILITY.md Evidence bundle): exact 4-component browser
  // version, exact Windows platformVersion, matching display-mode, persisted === true.
  if (!runtimeSignals.browserBrand || !runtimeSignals.browserFullVersion || !runtimeSignals.platformVersion) return null;
  if (!normalizedBrandMatches(runtimeSignals.browserBrand, attestation.attestedBrowserBrand)) return null;
  if (!FOUR_COMPONENT_VERSION.test(runtimeSignals.browserFullVersion)) return null;
  if (runtimeSignals.browserFullVersion !== attestation.attestedBrowserFullVersion) return null;
  if (!WINDOWS_PLATFORM_VERSION.test(runtimeSignals.platformVersion)) return null;
  if (runtimeSignals.platformVersion !== attestation.attestedPlatformVersion) return null;
  const expectedAppForm = runtimeSignals.displayMode === 'standalone' ? 'installed' : 'browser-tab';
  if (expectedAppForm !== attestation.attestedAppForm) return null;
  if (runtimeSignals.persisted !== true) return null;

  // Attestation validity window: <=30 days, notBefore <= now <= notAfter, and fail closed on
  // apparent clock rollback using the durable last-known-good clock floor (no remote revocation in v1).
  const issuedAtMs = parseRfc3339WholeSecondUtc(attestation.issuedAt);
  const notBeforeMs = parseRfc3339WholeSecondUtc(attestation.notBefore);
  const notAfterMs = parseRfc3339WholeSecondUtc(attestation.notAfter);
  if (issuedAtMs === null || notBeforeMs === null || notAfterMs === null) return null;
  if (notAfterMs - notBeforeMs > THIRTY_DAYS_MS) return null;
  if (clockFloor.nowMs < clockFloor.lastKnownGoodMs) return null;
  if (clockFloor.nowMs < notBeforeMs || clockFloor.nowMs > notAfterMs) return null;

  // Two independent gates, both mandatory (AD-5): runtime eligibility above, and the
  // service-worker self-verification + nonce-bound MessageChannel handshake here. Fail closed
  // on installing/waiting/redundant/uncontrolled controller states.
  if (controllerVerification.state !== 'activated-controlling') return null;
  if (!controllerVerification.manifestRoot || controllerVerification.manifestRoot !== attestation.assetManifestRoot) return null;

  return Object.freeze({ kind: 'CertificationGrant' as const, isValid: () => true as const });
}
