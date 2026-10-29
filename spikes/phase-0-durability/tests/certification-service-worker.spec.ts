import { describe, expect, it } from 'vitest';
import { adjudicateManifestVerification, buildHandshakeAck, collectObservedHashes } from '../src/certification-service-worker';
import type { AssetManifest } from '../src/certification-service-worker';

const MANIFEST: AssetManifest = {
  root: 'root-hash',
  entries: { '/a.js': 'a'.repeat(64), '/b.js': 'b'.repeat(64) },
};

describe('certification-service-worker pure logic', () => {
  it('verifies only when every manifest entry hash-matches exactly', () => {
    const observed = new Map([['/a.js', 'a'.repeat(64)], ['/b.js', 'b'.repeat(64)]]);
    expect(adjudicateManifestVerification(MANIFEST, observed)).toMatchObject({ verified: true, missing: [], mismatched: [] });
  });

  it('never infers success from partial presence — a missing entry fails, not warns', () => {
    const observed = new Map([['/a.js', 'a'.repeat(64)]]);
    const result = adjudicateManifestVerification(MANIFEST, observed);
    expect(result.verified).toBe(false);
    expect(result.missing).toEqual(['/b.js']);
  });

  it('fails on any hash mismatch, even a single byte difference in effect', () => {
    const observed = new Map([['/a.js', 'a'.repeat(64)], ['/b.js', 'c'.repeat(64)]]);
    const result = adjudicateManifestVerification(MANIFEST, observed);
    expect(result.verified).toBe(false);
    expect(result.mismatched).toEqual(['/b.js']);
  });

  it('withholds manifestRoot in the ack whenever verification failed — never reports a root for a failed check', () => {
    const failedAck = buildHandshakeAck({
      nonce: 'n1', verification: { verified: false, missing: ['/b.js'], mismatched: [] },
      manifestRoot: MANIFEST.root, scriptURL: 'https://x/sw.js', scope: '/', cacheNamespace: 'ns',
    });
    expect(failedAck.manifestRoot).toBeNull();
    expect(failedAck.nonce).toBe('n1');

    const passedAck = buildHandshakeAck({
      nonce: 'n2', verification: { verified: true, missing: [], mismatched: [] },
      manifestRoot: MANIFEST.root, scriptURL: 'https://x/sw.js', scope: '/', cacheNamespace: 'ns',
    });
    expect(passedAck.manifestRoot).toBe(MANIFEST.root);
  });

  it('collectObservedHashes treats a fetch failure as an unset (missing) entry, never a fabricated hash', async () => {
    const observed = await collectObservedHashes(MANIFEST, async (url) => {
      if (url === '/a.js') return new TextEncoder().encode('body-a').buffer as ArrayBuffer;
      throw new Error('network error');
    });
    expect(observed.has('/a.js')).toBe(true);
    expect(observed.has('/b.js')).toBe(false);
  });
});
