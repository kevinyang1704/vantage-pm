/**
 * Search ranking policy (Story 2.8 Task 2, AD-6).
 *
 * 4-stage deterministic ladder:
 * Stage 1: Exact normalized title match
 * Stage 2: Title prefix match
 * Stage 3: Token prefix match
 * Stage 4: Character trigram similarity (threshold >= 0.40)
 *
 * Tie-breaks: Persisted authored ordinal ASC, then node UUID ASC.
 * Pure and framework-free.
 */

import { normalizeSearchText } from '../../application/text/normalize-search-text';

export interface SearchCandidate {
  readonly nodeId: string;
  readonly title: string;
  readonly authoredOrdinal: number;
}

export interface RankedSearchResult {
  readonly nodeId: string;
  readonly title: string;
  readonly stage: 1 | 2 | 3 | 4;
  readonly score: number;
  readonly authoredOrdinal: number;
}

function computeTrigrams(text: string): Set<string> {
  const trigrams = new Set<string>();
  const padded = `  ${text} `;
  for (let i = 0; i < padded.length - 2; i++) {
    trigrams.add(padded.slice(i, i + 3));
  }
  return trigrams;
}

function trigramSimilarity(queryTrigrams: Set<string>, titleTrigrams: Set<string>): number {
  if (queryTrigrams.size === 0) return 0;
  let matches = 0;
  for (const tri of queryTrigrams) {
    if (titleTrigrams.has(tri)) {
      matches++;
    }
  }
  return matches / queryTrigrams.size;
}

export function rankSearchCandidates(
  candidates: readonly SearchCandidate[],
  rawQuery: string,
): readonly RankedSearchResult[] {
  const normQuery = normalizeSearchText(rawQuery);
  if (!normQuery) return Object.freeze([]);

  const queryTrigrams = normQuery.length >= 3 ? computeTrigrams(normQuery) : null;
  const results: RankedSearchResult[] = [];

  for (const candidate of candidates) {
    const normTitle = normalizeSearchText(candidate.title);
    if (!normTitle) continue;

    // Stage 1: Exact match
    if (normTitle === normQuery) {
      results.push({
        nodeId: candidate.nodeId,
        title: candidate.title,
        stage: 1,
        score: 1000,
        authoredOrdinal: candidate.authoredOrdinal,
      });
      continue;
    }

    // Stage 2: Prefix match
    if (normTitle.startsWith(normQuery)) {
      results.push({
        nodeId: candidate.nodeId,
        title: candidate.title,
        stage: 2,
        score: 800,
        authoredOrdinal: candidate.authoredOrdinal,
      });
      continue;
    }

    // Stage 3: Token prefix match
    const tokens = normTitle.split(' ');
    const tokenPrefixMatch = tokens.some((t) => t.startsWith(normQuery));
    if (tokenPrefixMatch) {
      results.push({
        nodeId: candidate.nodeId,
        title: candidate.title,
        stage: 3,
        score: 600,
        authoredOrdinal: candidate.authoredOrdinal,
      });
      continue;
    }

    // Stage 4: Trigram similarity (if query >= 3 chars)
    if (queryTrigrams) {
      const titleTrigrams = computeTrigrams(normTitle);
      const similarity = trigramSimilarity(queryTrigrams, titleTrigrams);
      if (similarity >= 0.4) {
        results.push({
          nodeId: candidate.nodeId,
          title: candidate.title,
          stage: 4,
          score: Math.round(similarity * 400),
          authoredOrdinal: candidate.authoredOrdinal,
        });
      }
    }
  }

  // Deterministic total ordering: Stage ASC, score DESC, authoredOrdinal ASC, nodeId ASC
  results.sort((a, b) => {
    if (a.stage !== b.stage) return a.stage - b.stage;
    if (b.score !== a.score) return b.score - a.score;
    if (a.authoredOrdinal !== b.authoredOrdinal) return a.authoredOrdinal - b.authoredOrdinal;
    return a.nodeId.localeCompare(b.nodeId);
  });

  return Object.freeze(results);
}
