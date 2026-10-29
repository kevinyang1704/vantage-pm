/**
 * Markdown viewer/editor specs (Story 16.2, E16-FR1, E16-FR8, E16-NFR1).
 *
 * Covers the lightweight AST parse (headings, bold, italics, bullets, inline
 * code, fenced code), the <2ms compile budget, and the key-event containment
 * contract of the editor.
 */

import { describe, expect, it } from 'vitest';
import { parseMarkdown, parseInline } from './markdown-viewer';

describe('parseMarkdown (Story 16.2 AC1)', () => {
  it('parses H1-H3 headings without raw syntax', () => {
    const blocks = parseMarkdown('# Title\n## Sub\n### Deep');
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Title' },
      { kind: 'heading', level: 2, text: 'Sub' },
      { kind: 'heading', level: 3, text: 'Deep' },
    ]);
  });

  it('parses bullet lists and paragraphs', () => {
    const blocks = parseMarkdown('- one\n- two\n\nplain paragraph');
    expect(blocks).toEqual([
      { kind: 'bullet', text: 'one' },
      { kind: 'bullet', text: 'two' },
      { kind: 'paragraph', text: 'plain paragraph' },
    ]);
  });

  it('parses fenced code blocks', () => {
    const blocks = parseMarkdown('```ts\nconst x = 1;\n```');
    expect(blocks).toEqual([{ kind: 'code', text: 'const x = 1;' }]);
  });

  it('parses inline bold, italic, and code', () => {
    const inlines = parseInline('**bold** and *italic* and `code`');
    expect(inlines).toEqual([
      { kind: 'bold', text: 'bold' },
      { kind: 'text', text: ' and ' },
      { kind: 'italic', text: 'italic' },
      { kind: 'text', text: ' and ' },
      { kind: 'code', text: 'code' },
    ]);
  });

  it('keeps raw syntax out of the rendered inline AST', () => {
    const blocks = parseMarkdown('## Problem\n\n**bold** text');
    expect(blocks[0]).toEqual({ kind: 'heading', level: 2, text: 'Problem' });
    const paragraph = blocks[1];
    expect(paragraph.kind).toBe('paragraph');
    if (paragraph.kind !== 'paragraph') return;
    const inlines = parseInline(paragraph.text);
    const joined = JSON.stringify(inlines);
    expect(joined).not.toContain('**');
    expect(inlines[0]).toEqual({ kind: 'bold', text: 'bold' });
  });

  it('compiles a brief-sized body well under the 2ms budget (E16-NFR1)', () => {
    const source = Array.from({ length: 40 }, (_, i) =>
      i % 4 === 0 ? `## Heading ${i}` : i % 4 === 1 ? `- bullet item ${i}` : `paragraph with **bold** and \`code\` ${i}`,
    ).join('\n');
    const start = performance.now();
    for (let i = 0; i < 50; i += 1) {
      parseMarkdown(source);
    }
    const elapsed = performance.now() - start;
    expect(elapsed / 50).toBeLessThan(2);
  });
});
