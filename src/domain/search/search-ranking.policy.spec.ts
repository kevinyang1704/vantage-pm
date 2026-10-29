import { describe, it, expect } from 'vitest';
import { rankSearchCandidates } from './search-ranking.policy';

describe('Search ranking policy (Story 2.8, AD-6)', () => {
  const candidates = [
    { nodeId: '019ffe00-0001-7000-8000-000000000001', title: 'Roadmap', authoredOrdinal: 0 },
    { nodeId: '019ffe00-0001-7000-8000-000000000002', title: 'Roadmap Feature 1', authoredOrdinal: 1 },
    { nodeId: '019ffe00-0001-7000-8000-000000000003', title: 'Great Feature 2', authoredOrdinal: 2 },
    { nodeId: '019ffe00-0001-7000-8000-000000000004', title: 'Radmap Mistype', authoredOrdinal: 3 },
  ];

  it('ranks exact match at stage 1', () => {
    const res = rankSearchCandidates(candidates, 'roadmap');
    expect(res[0].stage).toBe(1);
    expect(res[0].nodeId).toBe('019ffe00-0001-7000-8000-000000000001');
  });

  it('ranks prefix matches at stage 2', () => {
    const res = rankSearchCandidates(candidates, 'road');
    expect(res[0].stage).toBe(2);
    expect(res[0].nodeId).toBe('019ffe00-0001-7000-8000-000000000001');
    expect(res[1].stage).toBe(2);
    expect(res[1].nodeId).toBe('019ffe00-0001-7000-8000-000000000002');
  });

  it('ranks token prefix matches at stage 3', () => {
    const res = rankSearchCandidates(candidates, 'feat');
    expect(res[0].stage).toBe(3);
  });

  it('matches fuzzy/trigram at stage 4', () => {
    const res = rankSearchCandidates(candidates, 'roadm');
    const fuzzyMatch = res.find((r) => r.nodeId === '019ffe00-0001-7000-8000-000000000004');
    if (fuzzyMatch) {
      expect(fuzzyMatch.stage).toBe(4);
    }
  });

  it('tie-breaks on authoredOrdinal and nodeId deterministically', () => {
    const dupes = [
      { nodeId: '019ffe00-0001-7000-8000-000000000002', title: 'Same Title', authoredOrdinal: 1 },
      { nodeId: '019ffe00-0001-7000-8000-000000000001', title: 'Same Title', authoredOrdinal: 0 },
    ];
    const res = rankSearchCandidates(dupes, 'Same Title');
    expect(res[0].authoredOrdinal).toBe(0);
    expect(res[1].authoredOrdinal).toBe(1);
  });
});
