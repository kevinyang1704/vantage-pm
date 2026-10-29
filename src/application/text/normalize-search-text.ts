/**
 * Text normalization for deterministic fuzzy search (Story 2.7, Story 2.8, AD-6).
 *
 * Algorithm:
 * 1. String.prototype.normalize('NFKC')
 * 2. toLowerCase()
 * 3. Case-folding divergences (ß -> ss, ς -> σ)
 * 4. normalize('NFKC') again
 * 5. Whitespace collapse and trim
 */

const DIVERGENCE_MAP: Record<string, string> = {
  '\u00DF': 'ss', // ß -> ss
  '\u1E9E': 'ss', // ẞ -> ss
  '\u03C2': '\u03C3', // ς -> σ (Greek small letter final sigma to small sigma)
};

export function normalizeSearchText(raw: string): string {
  if (!raw) return '';

  let text = raw.normalize('NFKC').toLowerCase();

  for (const [divergence, replacement] of Object.entries(DIVERGENCE_MAP)) {
    if (text.includes(divergence)) {
      text = text.replaceAll(divergence, replacement);
    }
  }

  text = text.normalize('NFKC');

  // Collapse whitespace
  return text.replace(/\p{White_Space}+/gu, ' ').trim();
}
