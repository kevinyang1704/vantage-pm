/**
 * SideNav — the persistent left navigation (Epic 15, E15-FR1-FR8).
 *
 * Presentation only: state and callbacks come from props, nothing is
 * fetched or dispatched here (E15-AR1). Renders on both the workspace
 * overview and every project view (E15-FR2).
 *
 * Option A hierarchy (side-nav-workspace-project-hierarchy): the workspace
 * is the stable top-level container — workspace control + Overview at the
 * top, the selected project's views under Current Project, and every
 * project in a bottom shelf. The workspace disclosure is a non-modal menu
 * that owns workspace-level information and a single Overview action; it
 * never masquerades as a project switcher.
 *
 * Deliberately carries no coherence signal (open flags/affected-work
 * counts) — E15-FR9. See docs/UX-CONTRACT.md for why this departs from
 * the approved mock-up.
 */

import { useEffect, useRef, useState } from 'react';
import { BrandLockup } from '../brand/brand-lockup';
import './side-nav.css';

export type SideNavViewId = 'outline' | 'visual' | 'gantt' | 'forecast';

export interface SideNavProject {
  readonly id: string;
  readonly name: string;
}

export interface SideNavWorkspace {
  readonly id: string;
  readonly name: string;
  readonly projectCount: number;
}

export interface SideNavProps {
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  readonly inProject: boolean;
  readonly activeViewId: SideNavViewId | null;
  readonly onSelectView: (viewId: SideNavViewId) => void;
  readonly projects: readonly SideNavProject[];
  readonly selectedProjectId: string | null;
  readonly onSwitchProject: (projectId: string) => void;
  readonly onOpenWorkspace: () => void;
  readonly onCreateProject: () => void;
  /** Every workspace in this local store, ordered for display (Epic 17). */
  readonly workspaces: readonly SideNavWorkspace[];
  readonly activeWorkspaceId: string | null;
  readonly onSwitchWorkspace: (workspaceId: string) => void;
  readonly onCreateWorkspace: () => void;
  readonly onRenameWorkspace: (workspaceId: string) => void;
  readonly onDeleteWorkspace: (workspaceId: string) => void;
  readonly onOpenJump: () => void;
  /** Opens the view-scoped document export (.docx / .pptx). */
  readonly onOpenExport: () => void;
  /**
   * Writes a portable `.pmapp.json` copy of the selected project — the
   * export half of the Import/Export round-trip for moving a project to
   * another installation.
   */
  readonly onBackUpProject: () => void;
  readonly backupBusy: boolean;
  /** True when a portable-import picker is available (desktop dialog or browser file input). */
  readonly importEnabled: boolean;
  /** Runs the shared portable-import flow. */
  readonly onImportProject: () => void;
  /**
   * Story 27.6 (AD-20): opens Share for the selected project. Provided only
   * when the collaboration flag is on and a service is configured; a local
   * build never renders the control.
   */
  readonly onShareProject?: () => void;
  readonly onShareForEditing?: () => void;
  readonly onRecoverLocalMerge?: () => void;
  readonly localFileBusy?: boolean;
  /** `Share` for a local project, `Sharing` once shared (owner manages it). */
  readonly shareLabel?: string;
  /** Story 27.4 (AD-20): join a shared project from an invite link. */
  readonly onJoinProject?: () => void;
}

/** Small inline icon set — geometric shapes, no icon-library dependency
 * (matches the mock-up's hand-drawn approach; see the polish handoff's
 * "Assets" note). Always visible; only the text label collapses. */
const ICON_PROPS = {
  width: 16,
  height: 16,
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  'aria-hidden': true,
} as const;

const ICONS: Record<string, React.ReactElement> = {
  outline: (
    <svg {...ICON_PROPS} strokeLinecap="round">
      <path d="M3 5h14M6 10h11M9 15h8" />
    </svg>
  ),
  visual: (
    <svg {...ICON_PROPS}>
      <rect x="7.5" y="2.5" width="5" height="4" rx="1" />
      <rect x="2.5" y="13.5" width="5" height="4" rx="1" />
      <rect x="12.5" y="13.5" width="5" height="4" rx="1" />
      <path d="M10 6.5v3.5M5 13.5V10h10v3.5" />
    </svg>
  ),
  gantt: (
    <svg {...ICON_PROPS} strokeLinecap="round">
      <path d="M3 5.5h8M6 10h9M4 14.5h6" />
    </svg>
  ),
  forecast: (
    <svg {...ICON_PROPS} strokeLinecap="round">
      <path d="M3 15.5h14M5 12.5h10M7 9.5h6M9 6.5h2" />
    </svg>
  ),
  workspace: (
    <svg {...ICON_PROPS} strokeLinejoin="round">
      <path d="M2.5 6.2V15a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V7.5a1.5 1.5 0 0 0-1.5-1.5h-6L8 3.5H4a1.5 1.5 0 0 0-1.5 1.5v1.2Z" />
    </svg>
  ),
  overview: (
    <svg {...ICON_PROPS} strokeLinejoin="round">
      <rect x="3" y="3.5" width="5.5" height="5.5" rx="1" />
      <rect x="11.5" y="3.5" width="5.5" height="5.5" rx="1" />
      <rect x="3" y="12" width="5.5" height="5.5" rx="1" />
      <rect x="11.5" y="12" width="5.5" height="5.5" rx="1" />
    </svg>
  ),
  add: (
    <svg {...ICON_PROPS} strokeLinecap="round">
      <path d="M10 4.5v11M4.5 10h11" />
    </svg>
  ),
  share: (
    <svg {...ICON_PROPS} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5.5" cy="10" r="2" />
      <circle cx="14.5" cy="5" r="2" />
      <circle cx="14.5" cy="15" r="2" />
      <path d="M7.3 9l5.4-3M7.3 11l5.4 3" />
    </svg>
  ),
  import: (
    <svg {...ICON_PROPS} strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 3.5v9m0 0l-3.2-3.2M10 12.5l3.2-3.2M4 14.5V16a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 16 16v-1.5" />
    </svg>
  ),
  jump: (
    <svg {...ICON_PROPS}>
      <circle cx="8.5" cy="8.5" r="5" />
      <path d="M12.4 12.4 17 17" strokeLinecap="round" />
    </svg>
  ),
  export: (
    <svg {...ICON_PROPS} strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13V4m0 0L6.8 7.2M10 4l3.2 3.2M4 14v1.5A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5V14" />
    </svg>
  ),
};

const VIEW_ENTRIES: readonly { id: SideNavViewId; label: string; shortcut: string; icon: string }[] = [
  { id: 'outline', label: 'Outline', shortcut: '⌥1', icon: 'outline' },
  { id: 'visual', label: 'Visual Tree', shortcut: '⌥2', icon: 'visual' },
  { id: 'gantt', label: 'Gantt', shortcut: '⌥3', icon: 'gantt' },
  { id: 'forecast', label: 'Forecast', shortcut: '⌥4', icon: 'forecast' },
];

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

function NavItem({
  icon,
  label,
  hint,
  current,
  className,
  ...rest
}: {
  icon: string;
  label: string;
  hint?: string;
  current?: boolean;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>): React.ReactElement {
  const mergedClassName = ['pm-side-nav__item', className].filter(Boolean).join(' ');
  return (
    <button
      type="button"
      className={mergedClassName}
      aria-label={label}
      aria-current={current ? 'page' : undefined}
      {...rest}
    >
      <span className="pm-side-nav__item-icon" aria-hidden="true">
        {ICONS[icon]}
      </span>
      <span className="pm-side-nav__item-label" aria-hidden="true">{label}</span>
      {hint && <span className="pm-side-nav__item-hint" aria-hidden="true">{hint}</span>}
    </button>
  );
}

export function SideNav({
  collapsed,
  onToggleCollapsed,
  inProject,
  activeViewId,
  onSelectView,
  projects,
  selectedProjectId,
  onSwitchProject,
  onOpenWorkspace,
  onCreateProject,
  workspaces,
  activeWorkspaceId,
  onSwitchWorkspace,
  onCreateWorkspace,
  onRenameWorkspace,
  onDeleteWorkspace,
  onOpenJump,
  onOpenExport,
  onBackUpProject,
  backupBusy,
  importEnabled,
  onImportProject,
  onShareProject,
  onShareForEditing,
  onRecoverLocalMerge,
  localFileBusy = false,
  shareLabel = 'Share',
  onJoinProject,
}: SideNavProps): React.ReactElement {
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const workspaceTriggerRef = useRef<HTMLButtonElement>(null);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);

  const closeWorkspaceMenu = (restoreFocus: boolean): void => {
    setWorkspaceMenuOpen(false);
    if (restoreFocus) {
      workspaceTriggerRef.current?.focus();
    }
  };

  // Non-modal menu contract: outside interaction closes with focus restore.
  useEffect(() => {
    if (!workspaceMenuOpen) return;
    const onPointerDown = (e: PointerEvent): void => {
      if (workspaceMenuRef.current && !workspaceMenuRef.current.contains(e.target as Node)) {
        closeWorkspaceMenu(true);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [workspaceMenuOpen]);

  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;
  const projectCount = projects.length;
  // Falls back to the generic label only in the moment before the registry
  // has loaded — ensureDefaultWorkspace guarantees a real one exists.
  const activeWorkspaceName =
    workspaces.find((w) => w.id === activeWorkspaceId)?.name ?? 'Workspace';

  return (
    <nav className={`pm-side-nav${collapsed ? ' pm-side-nav--collapsed' : ''}`} aria-label="Primary">
      <div className="pm-side-nav__head">
        <BrandLockup onActivate={onOpenWorkspace} />
        <button
          type="button"
          className="pm-side-nav__collapse-btn"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-expanded={!collapsed}
        >
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {collapsed ? <path d="M9 6l4 4-4 4" /> : <path d="M11 6l-4 4 4 4" />}
          </svg>
        </button>
      </div>

      <div className="pm-side-nav__workspace">
        <button
          ref={workspaceTriggerRef}
          type="button"
          className="pm-side-nav__workspace-control"
          aria-haspopup="menu"
          aria-expanded={workspaceMenuOpen}
          aria-label={`Workspace: ${activeWorkspaceName}. ${projectCount} ${
            projectCount === 1 ? 'project' : 'projects'
          }, local. Switch workspace`}
          onClick={() => setWorkspaceMenuOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') closeWorkspaceMenu(true);
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setWorkspaceMenuOpen(true);
            }
          }}
        >
          <span className="pm-side-nav__workspace-icon" aria-hidden="true">
            {ICONS.workspace}
          </span>
          <span className="pm-side-nav__workspace-copy">
            <strong>{activeWorkspaceName}</strong>
            <span>{projectCount} {projectCount === 1 ? 'PROJECT' : 'PROJECTS'} · LOCAL</span>
          </span>
          <span className="pm-side-nav__workspace-caret" aria-hidden="true">⌄</span>
        </button>
        {workspaceMenuOpen && (
          <div
            ref={workspaceMenuRef}
            className="pm-side-nav__workspace-menu"
            role="menu"
            aria-label="Switch workspace"
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeWorkspaceMenu(true);
            }}
          >
            <div className="pm-side-nav__workspace-menu-info" aria-hidden="true">
              {workspaces.length} {workspaces.length === 1 ? 'workspace' : 'workspaces'} · local
            </div>

            {workspaces.map((ws) => {
              const isActive = ws.id === activeWorkspaceId;
              return (
                <button
                  key={ws.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  className={`pm-side-nav__workspace-menu-item pm-side-nav__workspace-menu-item--ws${
                    isActive ? ' pm-side-nav__workspace-menu-item--current' : ''
                  }`}
                  onClick={() => {
                    closeWorkspaceMenu(false);
                    if (!isActive) onSwitchWorkspace(ws.id);
                  }}
                >
                  <span className="pm-side-nav__ws-tick" aria-hidden="true">
                    {isActive ? (
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 8.5l3.5 3.5L13 4.5" />
                      </svg>
                    ) : null}
                  </span>
                  <span className="pm-side-nav__ws-avatar" aria-hidden="true">
                    {initials(ws.name)}
                  </span>
                  <span className="pm-side-nav__ws-name">{ws.name}</span>
                  <span className="pm-side-nav__ws-count" aria-hidden="true">
                    {ws.projectCount}
                  </span>
                </button>
              );
            })}

            <div className="pm-side-nav__workspace-menu-sep" aria-hidden="true" />

            <button
              type="button"
              role="menuitem"
              className="pm-side-nav__workspace-menu-item"
              onClick={() => {
                closeWorkspaceMenu(false);
                onOpenWorkspace();
              }}
            >
              Workspace overview
            </button>
            <button
              type="button"
              role="menuitem"
              className="pm-side-nav__workspace-menu-item"
              onClick={() => {
                closeWorkspaceMenu(false);
                onCreateWorkspace();
              }}
            >
              New workspace…
            </button>
            {activeWorkspaceId && (
              <button
                type="button"
                role="menuitem"
                className="pm-side-nav__workspace-menu-item"
                onClick={() => {
                  closeWorkspaceMenu(false);
                  onRenameWorkspace(activeWorkspaceId);
                }}
              >
                Rename “{activeWorkspaceName}”…
              </button>
            )}
            {activeWorkspaceId && (
              <button
                type="button"
                role="menuitem"
                className="pm-side-nav__workspace-menu-item pm-side-nav__workspace-menu-item--danger"
                /* Deliberately NOT disabled when the workspace still holds
                   projects. A disabled item gives no reason; letting it
                   through means the refusal explains itself in the status
                   line, which is how the user learns the rule. */
                onClick={() => {
                  closeWorkspaceMenu(false);
                  onDeleteWorkspace(activeWorkspaceId);
                }}
              >
                Delete “{activeWorkspaceName}”…
              </button>
            )}
          </div>
        )}
      </div>

      <NavItem
        icon="overview"
        label="Overview"
        current={!inProject}
        className="pm-side-nav__overview-link"
        onClick={onOpenWorkspace}
      />

      {selectedProject && (
        <>
          <p className="pm-side-nav__section-label">Current project</p>
          <div className="pm-side-nav__current-card">
            <div className="pm-side-nav__current-name">
              <span className="pm-side-nav__current-avatar" aria-hidden="true">
                {initials(selectedProject.name)}
              </span>
              <span className="pm-side-nav__current-title">{selectedProject.name}</span>
              <span className="pm-side-nav__current-dot" aria-hidden="true" />
            </div>
            {VIEW_ENTRIES.map((entry) => (
              <NavItem
                key={entry.id}
                icon={entry.icon}
                label={entry.label}
                hint={entry.shortcut}
                current={activeViewId === entry.id}
                className="pm-side-nav__view"
                onClick={() => onSelectView(entry.id)}
              />
            ))}
          </div>
        </>
      )}

      <div className="pm-side-nav__spacer" />

      <div className="pm-side-nav__projects-shelf">
        <div className="pm-side-nav__projects-head">
          <p className="pm-side-nav__section-label">Projects</p>
          <span className="pm-side-nav__projects-count">{projectCount}</span>
        </div>
        <ul className="pm-side-nav__project-list" aria-label="Projects in this workspace">
          {projects.map((p) => {
            const isCurrent = p.id === selectedProjectId;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  className={`pm-side-nav__project${isCurrent ? ' pm-side-nav__project--current' : ''}`}
                  aria-label={p.name}
                  aria-current={isCurrent ? 'true' : undefined}
                  title={p.name}
                  onClick={() => onSwitchProject(p.id)}
                >
                  <span className="pm-side-nav__project-mini" aria-hidden="true">
                    {initials(p.name)}
                  </span>
                  <span className="pm-side-nav__project-name">{p.name}</span>
                  <span className="pm-side-nav__project-arrow" aria-hidden="true">›</span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="pm-side-nav__actions">
          <button type="button" className="pm-side-nav__action pm-side-nav__action--wide" aria-label="New project" onClick={onCreateProject}>
            <span className="pm-side-nav__action-icon" aria-hidden="true">{ICONS.add}</span>
            <span className="pm-side-nav__action-label" aria-hidden="true">New project</span>
          </button>
          {importEnabled && (
            <button type="button" className="pm-side-nav__action" aria-label="Import" onClick={onImportProject} data-testid="import-trigger">
              <span className="pm-side-nav__action-icon" aria-hidden="true">{ICONS.import}</span>
              <span className="pm-side-nav__action-label" aria-hidden="true">Import</span>
            </button>
          )}
          {selectedProject && (
            <button
              type="button"
              className="pm-side-nav__action"
              aria-label="Export project"
              aria-disabled={backupBusy}
              onClick={() => {
                if (!backupBusy) onBackUpProject();
              }}
              data-testid="export-project-trigger"
            >
              <span className="pm-side-nav__action-icon" aria-hidden="true">{ICONS.export}</span>
              <span className="pm-side-nav__action-label" aria-hidden="true">Export project</span>
            </button>
          )}
          {selectedProject && onShareForEditing && (
            <button type="button" className="pm-side-nav__action pm-side-nav__action--wide" aria-label="Share for editing" disabled={localFileBusy} onClick={onShareForEditing} data-testid="share-file-trigger">
              <span className="pm-side-nav__action-icon" aria-hidden="true">{ICONS.share}</span>
              <span className="pm-side-nav__action-label" aria-hidden="true">Share for editing</span>
            </button>
          )}
          {selectedProject && onRecoverLocalMerge && (
            <button type="button" className="pm-side-nav__action pm-side-nav__action--wide" aria-label="Recover previous merge" disabled={localFileBusy} onClick={onRecoverLocalMerge} data-testid="recover-merge-trigger">
              <span className="pm-side-nav__action-icon" aria-hidden="true">{ICONS.import}</span>
              <span className="pm-side-nav__action-label" aria-hidden="true">Recover previous merge</span>
            </button>
          )}
          {onJoinProject && (
            <button type="button" className="pm-side-nav__action" aria-label="Join with invite" onClick={onJoinProject} data-testid="join-project-trigger">
              <span className="pm-side-nav__action-icon" aria-hidden="true">{ICONS.share}</span>
              <span className="pm-side-nav__action-label" aria-hidden="true">Join</span>
            </button>
          )}
          {selectedProject && onShareProject && (
            <button type="button" className="pm-side-nav__action" aria-label={shareLabel} onClick={onShareProject} data-testid="share-project-trigger">
              <span className="pm-side-nav__action-icon" aria-hidden="true">{ICONS.share}</span>
              <span className="pm-side-nav__action-label" aria-hidden="true">{shareLabel}</span>
            </button>
          )}
        </div>
      </div>

      {inProject && (
        <div className="pm-side-nav__foot">
          <NavItem icon="jump" label="Jump to item" hint="⌘K" onClick={onOpenJump} />
          <NavItem icon="export" label="Export document…" data-testid="export-trigger" onClick={onOpenExport} />
        </div>
      )}
    </nav>
  );
}
