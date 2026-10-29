/**
 * Visual-tree viewport controls (Epic 10, E10-FR11, E10-UX9).
 *
 * Compact non-modal Meridian control group: zoom out, current percentage,
 * zoom in, fit-all, and reset-to-100%-and-center. Keyboard-operable with
 * accessible names and a live zoom percentage. Rendered over the canvas,
 * unaffected by the world transform.
 */

export interface ViewportControlsProps {
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitAll: () => void;
  onReset: () => void;
}

export function ViewportControls({
  scale,
  onZoomIn,
  onZoomOut,
  onFitAll,
  onReset,
}: ViewportControlsProps): React.ReactElement {
  const percent = Math.round(scale * 100);

  return (
    <div className="pm-viewport-controls" role="group" aria-label="Visual tree viewport">
      <button
        type="button"
        className="pm-viewport-control"
        aria-label="Zoom out"
        onClick={onZoomOut}
      >
        −
      </button>
      <span className="pm-viewport-percent" aria-live="polite">
        {percent}%
      </span>
      <button
        type="button"
        className="pm-viewport-control"
        aria-label="Zoom in"
        onClick={onZoomIn}
      >
        +
      </button>
      <button
        type="button"
        className="pm-viewport-control"
        aria-label="Fit the whole tree"
        onClick={onFitAll}
      >
        Fit
      </button>
      <button
        type="button"
        className="pm-viewport-control"
        aria-label="Reset to 100% and center"
        onClick={onReset}
      >
        Reset
      </button>
    </div>
  );
}
