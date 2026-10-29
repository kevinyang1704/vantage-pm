/**
 * AppFrame — the full-viewport authoring shell layout.
 *
 * Structure per DESIGN.md → Layout & Spacing and Elevation & Depth:
 *   canvas ground → toolbar (40px) → tree region (flex-grow) → status line (28px)
 *
 * Full-viewport, no rounded outer frame. The 2xl/border-strong frame in
 * DESIGN.md → Shapes is an artifact of the study page, not the running app
 * at viewport scale (see docs/UX-CONTRACT.md Entry 1).
 */

import type { ReactNode } from 'react';
import './app-frame.css';

export interface AppFrameProps {
  /** Toolbar content (project switcher, breadcrumb, view toggle — Stories 5.4, 2.5, Epics 6/8). */
  toolbar?: ReactNode;
  /** Tree region content (Story 2.2 supplies the virtualized list). */
  children: ReactNode;
  /** Status line content. */
  statusLine?: ReactNode;
  /** Whether tree region is currently busy / loading */
  isBusy?: boolean;
  /** Optional full-width banner (e.g. browser-role notice) below the toolbar. */
  banner?: ReactNode;
}

export function AppFrame({ toolbar, children, statusLine, isBusy, banner }: AppFrameProps): React.ReactElement {
  return (
    <div className="pm-app-frame">
      <header className="pm-toolbar" role="toolbar" aria-label="Authoring toolbar">
        {toolbar}
      </header>
      {banner}
      <main
        className="pm-tree-region"
        role="region"
        aria-label="Outline tree"
        aria-busy={isBusy ? 'true' : undefined}
      >
        {children}
      </main>
      <footer className="pm-status-line" role="contentinfo">
        {statusLine}
      </footer>
    </div>
  );
}
