/**
 * CopyButton — a Copy action that confirms every successful click.
 * The label flips to "Copied ✓" for a moment and restarts on each click, so
 * a repeated copy is visibly acknowledged too. Failure leaves the label alone;
 * the caller explains it (e.g. "select the link and press Ctrl+C").
 */

import { useEffect, useRef, useState } from 'react';

export const COPIED_FLASH_MS = 1500;

export interface CopyButtonProps {
  /** Resolves whether the text actually reached the clipboard. */
  readonly onCopy: () => Promise<boolean>;
  readonly className?: string;
  readonly buttonRef?: React.Ref<HTMLButtonElement>;
}

export function CopyButton(props: CopyButtonProps): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const onClick = (): void => {
    void props.onCopy().then((ok) => {
      if (!ok) return;
      if (timer.current) clearTimeout(timer.current);
      // Drop to "Copy" for one frame first so a repeat click re-triggers the flash.
      setCopied(false);
      requestAnimationFrame(() => setCopied(true));
      timer.current = setTimeout(() => setCopied(false), COPIED_FLASH_MS);
    });
  };
  return (
    <button ref={props.buttonRef} type="button" className={props.className} onClick={onClick} aria-live="polite" data-copied={copied ? 'true' : undefined}>
      {copied ? 'Copied ✓' : 'Copy'}
    </button>
  );
}
