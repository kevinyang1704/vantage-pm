import { describe, expect, it } from 'vitest';
import { evaluateCertificationGrant } from '../src/certification-grant';
import type { ProductionAttestation, RuntimeEligibilitySignals, ServiceWorkerVerificationResult, ClockFloor } from '../src/certification-grant';

const NOW = Date.parse('2026-08-19T12:00:00Z');
const MANIFEST_ROOT = 'a'.repeat(64);

function attestation(overrides: Partial<ProductionAttestation> = {}): ProductionAttestation {
  return {
    attestedBrowserBrand: 'Google Chrome',
    attestedBrowserFullVersion: '151.0.7823.42',
    attestedPlatformVersion: '15.0.0',
    attestedAppForm: 'browser-tab',
    assetManifestRoot: MANIFEST_ROOT,
    issuedAt: '2026-08-01T00:00:00Z',
    notBefore: '2026-08-01T00:00:00Z',
    notAfter: '2026-08-25T00:00:00Z',
    signatureVerified: true,
    ...overrides,
  };
}

function signals(overrides: Partial<RuntimeEligibilitySignals> = {}): RuntimeEligibilitySignals {
  return {
    browserBrand: 'Google Chrome',
    browserFullVersion: '151.0.7823.42',
    platformVersion: '15.0.0',
    displayMode: 'browser',
    persisted: true,
    ...overrides,
  };
}

function controller(overrides: Partial<ServiceWorkerVerificationResult> = {}): ServiceWorkerVerificationResult {
  return { state: 'activated-controlling', manifestRoot: MANIFEST_ROOT, ...overrides };
}

function clockFloor(overrides: Partial<ClockFloor> = {}): ClockFloor {
  return { nowMs: NOW, lastKnownGoodMs: NOW - 1000, ...overrides };
}

function evaluate(overrides: Partial<{
  attestation: Partial<ProductionAttestation>;
  runtimeSignals: Partial<RuntimeEligibilitySignals>;
  controllerVerification: Partial<ServiceWorkerVerificationResult>;
  clockFloor: Partial<ClockFloor>;
}> = {}) {
  return evaluateCertificationGrant({
    attestation: attestation(overrides.attestation),
    runtimeSignals: signals(overrides.runtimeSignals),
    controllerVerification: controller(overrides.controllerVerification),
    clockFloor: clockFloor(overrides.clockFloor),
  });
}

describe('certification-grant eligibility matrix', () => {
  it('grants only when every gate is exactly satisfied', () => {
    const grant = evaluate();
    expect(grant?.isValid()).toBe(true);
  });

  it('fails closed when the signature has not been verified', () => {
    expect(evaluate({ attestation: { signatureVerified: false } })).toBeNull();
  });

  it('fails closed on any browser-version mismatch, even a patch-level difference', () => {
    expect(evaluate({ runtimeSignals: { browserFullVersion: '151.0.7823.43' } })).toBeNull();
  });

  it('fails closed on a non-four-component version string', () => {
    expect(evaluate({ runtimeSignals: { browserFullVersion: '151.0.7823' } })).toBeNull();
  });

  it('fails closed on a greased brand token', () => {
    expect(evaluate({ runtimeSignals: { browserBrand: 'Not;A=Brand' }, attestation: { attestedBrowserBrand: 'Not;A=Brand' as never } })).toBeNull();
  });

  it('fails closed on a platform-version mismatch', () => {
    expect(evaluate({ runtimeSignals: { platformVersion: '15.0.1' } })).toBeNull();
  });

  it('fails closed when persisted is not exactly true', () => {
    expect(evaluate({ runtimeSignals: { persisted: false } })).toBeNull();
  });

  it('fails closed on a display-mode / app-form mismatch in either direction', () => {
    expect(evaluate({ runtimeSignals: { displayMode: 'standalone' }, attestation: { attestedAppForm: 'browser-tab' } })).toBeNull();
    expect(evaluate({ runtimeSignals: { displayMode: 'browser' }, attestation: { attestedAppForm: 'installed' } })).toBeNull();
  });

  it('grants for a matching installed-PWA cohort', () => {
    const grant = evaluate({ runtimeSignals: { displayMode: 'standalone' }, attestation: { attestedAppForm: 'installed' } });
    expect(grant?.isValid()).toBe(true);
  });

  it('fails closed on an attestation window wider than 30 days', () => {
    expect(evaluate({ attestation: { notBefore: '2026-08-01T00:00:00Z', notAfter: '2026-09-05T00:00:00Z' } })).toBeNull();
  });

  it('fails closed before notBefore and after notAfter', () => {
    expect(evaluate({ clockFloor: { nowMs: Date.parse('2026-07-31T00:00:00Z') } })).toBeNull();
    expect(evaluate({ clockFloor: { nowMs: Date.parse('2026-08-26T00:00:00Z') } })).toBeNull();
  });

  it('fails closed on apparent clock rollback relative to the last-known-good floor', () => {
    expect(evaluate({ clockFloor: { nowMs: NOW, lastKnownGoodMs: NOW + 1000 } })).toBeNull();
  });

  it('fails closed on every non-activated-controlling controller state', () => {
    for (const state of ['installing', 'waiting', 'redundant', 'uncontrolled'] as const) {
      expect(evaluate({ controllerVerification: { state, manifestRoot: MANIFEST_ROOT } })).toBeNull();
    }
  });

  it('fails closed when the verified manifest root does not match the attestation', () => {
    expect(evaluate({ controllerVerification: { manifestRoot: 'b'.repeat(64) } })).toBeNull();
    expect(evaluate({ controllerVerification: { manifestRoot: null } })).toBeNull();
  });
});
