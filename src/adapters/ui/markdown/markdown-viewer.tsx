/**
 * Lightweight Markdown viewer (Story 16.2, E16-FR1, E16-FR8, AC-MARKDOWN-LIGHTWEIGHT).
 *
 * Compiles the shared Markdown AST (src/domain/markdown/markdown-ast.ts) into
 * React elements. No external markdown library — the AST pass stays well under
 * the 2ms budget (E16-NFR1). Raw syntax symbols (`###`, `**`) never reach the
 * render.
 */

import React from 'react';
import { parseMarkdown, parseInline, type MarkdownInline } from '../../../domain/markdown/markdown-ast';
import './markdown-viewer.css';

export { parseMarkdown, parseInline };
export type { MarkdownBlock, MarkdownInline } from '../../../domain/markdown/markdown-ast';

function renderInline(inlines: readonly MarkdownInline[], keyBase: string): React.ReactNode[] {
  return inlines.map((node, idx) => {
    const key = `${keyBase}-${idx}`;
    switch (node.kind) {
      case 'bold':
        return (
          <strong key={key} className="pm-md__bold">
            {node.text}
          </strong>
        );
      case 'italic':
        return (
          <em key={key} className="pm-md__italic">
            {node.text}
          </em>
        );
      case 'code':
        return (
          <code key={key} className="pm-md__inline-code">
            {node.text}
          </code>
        );
      default:
        return <React.Fragment key={key}>{node.text}</React.Fragment>;
    }
  });
}

export interface MarkdownViewerProps {
  readonly source: string | null;
  readonly className?: string;
}

/**
 * Renders Markdown source as clean styled HTML. Never shows raw syntax.
 * Used in the Outline row body and the Side Inspector Brief tab (Story 16.2/16.3).
 */
export function MarkdownViewer({ source, className }: MarkdownViewerProps): React.ReactElement | null {
  if (source === null || source.trim() === '') {
    return null;
  }
  const blocks = parseMarkdown(source);
  return (
    <div className={`pm-md ${className ?? ''}`} data-testid="markdown-viewer">
      {blocks.map((block, idx) => {
        const key = `b-${idx}`;
        switch (block.kind) {
          case 'heading': {
            const Tag = (`h${block.level}` as 'h1') as 'h1' | 'h2' | 'h3';
            return (
              <Tag key={key} className={`pm-md__h${block.level}`}>
                {renderInline(parseInline(block.text), key)}
              </Tag>
            );
          }
          case 'bullet':
            return (
              <ul key={key} className="pm-md__list">
                <li>{renderInline(parseInline(block.text), key)}</li>
              </ul>
            );
          case 'code':
            return (
              <pre key={key} className="pm-md__code-block">
                <code>{block.text}</code>
              </pre>
            );
          default:
            return (
              <p key={key} className="pm-md__paragraph">
                {renderInline(parseInline(block.text), key)}
              </p>
            );
        }
      })}
    </div>
  );
}
