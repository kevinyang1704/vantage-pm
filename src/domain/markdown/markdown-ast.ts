/**
 * Lightweight Markdown AST (Story 16.2, Story 16.4, E16-FR1, E16-FR8).
 *
 * Pure, synchronous, single-pass parser for a deliberately small Markdown
 * subset (H1-H3, bold, italics, bullet lists, inline code, fenced code).
 * Shared by the UI MarkdownViewer (Story 16.2) and the DOCX renderer
 * (Story 16.4) so both compile the same AST. No React, no I/O, no external
 * markdown library — the pass stays well under the 2ms budget (E16-NFR1).
 */

export type MarkdownBlock =
  | Readonly<{ kind: 'heading'; level: 1 | 2 | 3; text: string }>
  | Readonly<{ kind: 'paragraph'; text: string }>
  | Readonly<{ kind: 'bullet'; text: string }>
  | Readonly<{ kind: 'code'; text: string }>;

export type MarkdownInline =
  | Readonly<{ kind: 'text'; text: string }>
  | Readonly<{ kind: 'bold'; text: string }>
  | Readonly<{ kind: 'italic'; text: string }>
  | Readonly<{ kind: 'code'; text: string }>;

const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const BULLET_RE = /^[-*+]\s+(.*)$/;
const FENCE_RE = /^```/;

/**
 * Parse inline emphasis (bold `**x**`, italic `*x*`/`_x_`, inline code `` `x` ``)
 * into a flat inline AST. Runs in a single linear pass — no backtracking.
 */
export function parseInline(text: string): readonly MarkdownInline[] {
  const out: MarkdownInline[] = [];
  let i = 0;
  let plain = '';
  const flush = (): void => {
    if (plain.length > 0) {
      out.push({ kind: 'text', text: plain });
      plain = '';
    }
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        flush();
        out.push({ kind: 'code', text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '*' || ch === '_') {
      const marker = ch;
      const isBold = text[i + 1] === marker;
      const close = isBold ? text.indexOf(marker + marker, i + 2) : text.indexOf(marker, i + 1);
      if (close !== -1) {
        const inner = text.slice(i + (isBold ? 2 : 1), close);
        if (inner.length > 0) {
          flush();
          out.push(isBold ? { kind: 'bold', text: inner } : { kind: 'italic', text: inner });
          i = close + (isBold ? 2 : 1);
          continue;
        }
      }
    }
    plain += ch;
    i += 1;
  }
  flush();
  return out;
}

/**
 * Parse a Markdown source string into a block AST. Synchronous, single pass,
 * O(n) — the <2ms budget holds for brief-sized bodies (E16-NFR1).
 */
export function parseMarkdown(source: string): readonly MarkdownBlock[] {
  const lines = source.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (FENCE_RE.test(line)) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1; // skip closing fence
      blocks.push({ kind: 'code', text: codeLines.join('\n') });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 3) as 1 | 2 | 3;
      blocks.push({ kind: 'heading', level, text: heading[2].trim() });
      i += 1;
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      blocks.push({ kind: 'bullet', text: bullet[1].trim() });
      i += 1;
      continue;
    }

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    blocks.push({ kind: 'paragraph', text: line.trim() });
    i += 1;
  }

  return blocks;
}
