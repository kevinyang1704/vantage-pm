/**
 * View-only presentation for a shared project the device may not edit
 * (viewer role or a read-only copy, AC 27.4-5 / 27.6-4). The service and the
 * local dispatcher already refuse such edits; this makes the edit controls
 * look and behave unavailable instead of accepting input that is then refused.
 *
 * Applied to the app body while active: text fields become read-only, selects
 * and checkboxes are disabled, drag sources stop dragging, and each touched
 * control is marked so CSS can mute it and the change is undone exactly on
 * exit. Dialogs and navigation stay fully usable (reading, copying, Activity,
 * leaving the project). Controls rendered later are covered by an observer.
 */

const MARK = 'data-pm-view-only';
const EXEMPT = '.pm-share-dialog, nav.pm-side-nav, .pm-collaboration-layer, [data-pm-view-only-exempt]';
const TEXT_INPUT = 'input:not([type]), input[type="text"], input[type="search"], input[type="number"], input[type="date"], textarea, [contenteditable="true"]';
const TOGGLE = 'select, input[type="checkbox"], input[type="radio"]';

function lock(el: Element): void {
  if (el.closest(EXEMPT) || el.hasAttribute(MARK)) return;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.matches(TOGGLE)) {
      if (el.disabled) return;
      el.disabled = true;
      el.setAttribute(MARK, 'disabled');
    } else {
      if (el.readOnly) return;
      el.readOnly = true;
      el.setAttribute('aria-readonly', 'true');
      el.setAttribute(MARK, 'readonly');
    }
  } else if (el instanceof HTMLSelectElement) {
    if (el.disabled) return;
    el.disabled = true;
    el.setAttribute(MARK, 'disabled');
  } else if (el instanceof HTMLElement && el.isContentEditable) {
    el.contentEditable = 'false';
    el.setAttribute(MARK, 'contenteditable');
  } else if (el instanceof HTMLElement && el.draggable) {
    el.draggable = false;
    el.setAttribute(MARK, 'draggable');
  }
}

function unlock(el: Element): void {
  const how = el.getAttribute(MARK);
  el.removeAttribute(MARK);
  if (how === 'readonly' && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    el.readOnly = false;
    el.removeAttribute('aria-readonly');
  } else if (how === 'disabled' && (el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) {
    el.disabled = false;
  } else if (how === 'contenteditable' && el instanceof HTMLElement) {
    el.contentEditable = 'true';
  } else if (how === 'draggable' && el instanceof HTMLElement) {
    el.draggable = true;
  }
}

function lockWithin(root: ParentNode): void {
  root.querySelectorAll(`${TEXT_INPUT}, ${TOGGLE}, [draggable="true"]`).forEach(lock);
}

/** Make `root`'s edit controls unavailable until the returned cleanup runs. */
export function applyViewOnly(root: HTMLElement): () => void {
  document.body.setAttribute(MARK, 'true');
  lockWithin(root);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        lock(node);
        lockWithin(node);
      });
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    document.body.removeAttribute(MARK);
    root.querySelectorAll(`[${MARK}]`).forEach(unlock);
  };
}
