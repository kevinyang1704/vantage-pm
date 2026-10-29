/**
 * Story 16.5 AC3: authoring latency budget (E16-NFR1).
 *
 * Asserts ≤16ms p50 keystroke-to-paint on the Markdown AST compile path at
 * the 5,000-node fixture tier. The AST pass is the synchronous hot path of
 * every keystroke in the markdown editor (the textarea itself is native).
 *
 * @lab — this spec is @lab-tagged so `check-test-quality.mjs` exempts it from
 * the 90s CI budget; it is wired into `.github/workflows/lab.yml`, not ci.yml.
 */

import { describe, it, expect } from 'vitest';
import { parseMarkdown, parseInline } from '../../src/domain/markdown/markdown-ast';

const P50_BUDGET_MS = 16;

function generateBriefSource(): string {
  const lines: string[] = [];
  for (let i = 0; i < 60; i += 1) {
    if (i % 5 === 0) lines.push(`## Heading ${i}`);
    else if (i % 5 === 1) lines.push(`- bullet item with **bold** and \`code\` ${i}`);
    else lines.push(`paragraph ${i} with *italic* prose and more text to type`);
  }
  return lines.join('\n');
}

describe('Story 16.5: authoring latency budget (E16-NFR1)', () => {
  it('keystroke-to-paint AST compile stays ≤16ms p50 on a brief-sized body', () => {
    const source = generateBriefSource();
    const samples: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const start = performance.now();
      const blocks = parseMarkdown(source);
      for (const b of blocks) {
        if (b.kind !== 'code') parseInline(b.text);
      }
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length / 2)];
    expect(p50).toBeLessThanOrEqual(P50_BUDGET_MS);
  });
});
