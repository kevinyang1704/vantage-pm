import { describe, expect, it } from 'vitest';
import { computeDeployEnvelopeDigest, CURRENT_DEV_DEPLOY_ENVELOPE } from '../src/deploy-envelope';
import type { DeployEnvelopeDescriptor } from '../src/deploy-envelope';

describe('deploy-envelope digest', () => {
  it('is deterministic for the same descriptor', async () => {
    const a = await computeDeployEnvelopeDigest(CURRENT_DEV_DEPLOY_ENVELOPE);
    const b = await computeDeployEnvelopeDigest(CURRENT_DEV_DEPLOY_ENVELOPE);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any field changes', async () => {
    const base = await computeDeployEnvelopeDigest(CURRENT_DEV_DEPLOY_ENVELOPE);
    const mutated: DeployEnvelopeDescriptor = {
      ...CURRENT_DEV_DEPLOY_ENVELOPE,
      workerIsolationHeaders: { ...CURRENT_DEV_DEPLOY_ENVELOPE.workerIsolationHeaders, 'Service-Worker-Allowed': '/changed' },
    };
    expect(await computeDeployEnvelopeDigest(mutated)).not.toBe(base);
  });

  it('is independent of descriptor key insertion order', async () => {
    const reordered: DeployEnvelopeDescriptor = {
      immutableAssetPaths: CURRENT_DEV_DEPLOY_ENVELOPE.immutableAssetPaths,
      redirects: CURRENT_DEV_DEPLOY_ENVELOPE.redirects,
      cacheDirectives: CURRENT_DEV_DEPLOY_ENVELOPE.cacheDirectives,
      mimeMappings: CURRENT_DEV_DEPLOY_ENVELOPE.mimeMappings,
      workerIsolationHeaders: CURRENT_DEV_DEPLOY_ENVELOPE.workerIsolationHeaders,
      cspHeaders: CURRENT_DEV_DEPLOY_ENVELOPE.cspHeaders,
      tlsPolicy: CURRENT_DEV_DEPLOY_ENVELOPE.tlsPolicy,
      serviceWorkerScope: CURRENT_DEV_DEPLOY_ENVELOPE.serviceWorkerScope,
      originPolicy: CURRENT_DEV_DEPLOY_ENVELOPE.originPolicy,
    };
    expect(await computeDeployEnvelopeDigest(reordered)).toBe(await computeDeployEnvelopeDigest(CURRENT_DEV_DEPLOY_ENVELOPE));
  });
});
