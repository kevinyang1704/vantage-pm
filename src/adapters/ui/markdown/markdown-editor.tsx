/**
 * Native styled Markdown editor (Story 16.2, E16-FR8, E16-UX2, AC-BRIEF-KEY-ISOLATION).
 *
 * A plain `<textarea>` with key-event containment: Tab / Shift+Tab / Enter
 * stop propagation so the outliner never indents the node or creates a sibling
 * while the user is typing prose. Esc and blur commit via the caller.
 */

import React, { useRef, useEffect } from 'react';
import './markdown-editor.css';

export interface MarkdownEditorProps {
  readonly value: string;
  readonly placeholder?: string;
  readonly autoFocus?: boolean;
  readonly ariaLabel?: string;
  readonly dataInspectorPrimary?: boolean;
  onChange?: (value: string) => void;
  onCommit?: (value: string) => void;
  onCancel?: () => void;
}

/**
 * Markdown textarea with keyboard containment. `Tab` inserts two spaces
 * (preserving the caret) instead of moving focus; `Enter` inserts a newline
 * without bubbling to the outline row handler.
 */
export function MarkdownEditor({
  value,
  placeholder,
  autoFocus = false,
  ariaLabel,
  dataInspectorPrimary = false,
  onChange,
  onCommit,
  onCancel,
}: MarkdownEditorProps): React.ReactElement {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus && ref.current) {
      ref.current.focus({ preventScroll: true });
    }
  }, [autoFocus]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!dataInspectorPrimary) {
      el.style.height = 'auto';
      const targetHeight = Math.max(220, el.scrollHeight + 4);
      el.style.height = `${targetHeight}px`;
    }
  }, [value, dataInspectorPrimary]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      const el = ref.current;
      if (!el) return;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const next = `${el.value.slice(0, start)}  ${el.value.slice(end)}`;
      onChange?.(next);
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + 2;
      });
      return;
    }
    if (e.key === 'Enter') {
      e.stopPropagation();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel?.();
      return;
    }
  };

  const handleBlur = (): void => {
    onCommit?.(value);
  };

  return (
    <textarea
      ref={ref}
      className="pm-md-editor"
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      data-inspector-primary={dataInspectorPrimary || undefined}
      onChange={(e) => onChange?.(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      spellCheck={false}
    />
  );
}
