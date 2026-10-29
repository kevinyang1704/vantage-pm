/**
 * Dismissal Filter Policy (Story 4.6, FR-37).
 *
 * Filters open coherence findings against durable dismissals.
 * A dismissal is only effective if its material-input fingerprint matches exactly.
 * Any change to material inputs produces a new fingerprint, resurfacing the finding.
 */

import type { CoherenceFinding, FindingDismissal } from '../../contracts/analysis-protocol';

export function filterActiveFindings(
  findings: readonly CoherenceFinding[],
  dismissals: readonly FindingDismissal[],
): readonly CoherenceFinding[] {
  if (dismissals.length === 0) return findings;

  const dismissalSet = new Set<string>();
  for (const d of dismissals) {
    dismissalSet.add(`${d.findingKind}:${d.targetId}:${d.fingerprint}`);
  }

  return Object.freeze(
    findings.filter((f) => {
      const key = `${f.kind}:${f.targetNodeId}:${f.fingerprint}`;
      return !dismissalSet.has(key);
    }),
  );
}
