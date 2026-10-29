import { useEffect, useRef, useState } from 'react';
import type { WorkspaceOverviewProjection, WorkspaceProjectRow, WorkspaceThemeRow } from '../../../contracts/workspace-overview';
import { DeleteProjectDialog } from './delete-project-dialog';
import { CoherenceChips } from './coherence-chips';
import { encodeCoherenceChips } from './coherence.encoding';
import { ThemeDetailsToggle, ThemeDetailsPanel } from './theme-details';
import { ThemeTimelineAxis, ThemeTimelineLane } from './theme-timeline';
import { deliveryBuckets, deliveryCountPhrase } from './delivery-status';
import { useLocalToday } from './use-local-today';
import {
  classifyTimelineSpan,
  computeTimelineDomain,
  type TimelineDomain,
} from '../../../application/workspace/workspace-overview-timeline';
import { itemCountPhrase, riskCountPhrase } from '../vocabulary';
import './workspace-overview.css';

export interface WorkspaceOverviewProps {
  overview: WorkspaceOverviewProjection;
  /**
   * App-level status/refusal copy (Epic 17). The overview has no StatusLine,
   * so refusals and confirmations are surfaced here.
   */
  statusMessage?: string | null;
  pendingRenameProjectId?: string | null;
  onPendingRenameConsumed?: () => void;
  onCreateProject: (name: string) => void;
  onRenameProject: (projectId: string, name: string) => void;
  onDeleteProject: (projectId: string) => void;
  onOpenTheme: (projectId: string, themeId: string) => void;
  /**
   * Open a specific project in the full Gantt through the guarded project/view
   * route (AC 24.2-5). Never falls back to Outline or the previously selected
   * project's Gantt.
   */
  onOpenGantt: (projectId: string) => void;
  /** Injected local calendar date for deterministic runs (tests). */
  todayIso?: string | null;
}

function featureCountPhrase(count: number): string {
  return `${count} ${count === 1 ? 'feature' : 'features'}`;
}

/** Non-zero status buckets as an accessible phrase, e.g. `2 Not started · 1 Delivered`. */
function statusPhrase(statusCounts: WorkspaceProjectRow['statusCounts']): string {
  const parts = deliveryBuckets(statusCounts).map(deliveryCountPhrase);
  return parts.length > 0 ? parts.join(' · ') : 'No features yet';
}

function ProjectDeliverySummary({ project }: { project: WorkspaceProjectRow }): React.ReactElement {
  return (
    <div className="pm-project-card-summary">
      <span className="pm-project-card-count">{itemCountPhrase(project.nodeCount)}</span>
      <span className="pm-project-card-count">{featureCountPhrase(project.featureCount)}</span>
      <span className="pm-project-card-count pm-project-card-count--delivered">
        <strong>{project.statusCounts.delivered}</strong> delivered
      </span>
      {project.openFindingCount > 0 ? (
        <span className="pm-flag-count-chip pm-flag-count-chip--has-flags">
          {riskCountPhrase(project.openFindingCount)}
        </span>
      ) : (
        <span className="pm-flag-count-chip pm-flag-count-chip--no-flags">
          {riskCountPhrase(0)}
        </span>
      )}
      {project.unattributedFeatureCount > 0 && (
        <span className="pm-project-card-count pm-project-card-count--unattributed">
          {featureCountPhrase(project.unattributedFeatureCount)} without a theme
        </span>
      )}
    </div>
  );
}

export function WorkspaceOverview({
  overview,
  statusMessage,
  pendingRenameProjectId,
  onPendingRenameConsumed,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onOpenTheme,
  onOpenGantt,
  todayIso = null,
}: WorkspaceOverviewProps): React.ReactElement {
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  // Disclosure state lives only here (in-memory), keyed by projectId/themeId.
  // Never persisted, never a graph write (AC 24.3-3/4).
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const today = useLocalToday({ fixedTodayIso: todayIso });

  useEffect(() => {
    if (!pendingRenameProjectId) return;
    const target = overview.projects.find((p) => p.projectId === pendingRenameProjectId);
    if (!target) return;
    setEditingId(target.projectId);
    setEditValue(target.projectName);
    onPendingRenameConsumed?.();
  }, [pendingRenameProjectId, overview.projects, onPendingRenameConsumed]);

  // Drop stale disclosure state when a project/theme disappears (AC 24.3-4).
  useEffect(() => {
    const live = new Set<string>();
    for (const project of overview.projects) {
      for (const theme of project.themes) {
        // A theme with no Features has no expansion control, so any retained
        // key would re-open a panel that does not exist (AC 24.3-4).
        if (theme.featureCount > 0) live.add(`${project.projectId}:${theme.themeId}`);
      }
    }
    setExpanded((current) => {
      let changed = false;
      const next = new Set<string>();
      for (const key of current) {
        if (live.has(key)) next.add(key);
        else changed = true;
      }
      return changed ? next : current;
    });
  }, [overview.projects]);

  const pendingDeleteProject = overview.projects.find((p) => p.projectId === pendingDeleteId);

  // Story 25.4 AC 25.4-1/-2: after a project is removed, focus falls to <body>
  // because the deleted card's controls (and the confirm button) unmount. Record
  // the deleted project's identity + index so a surviving neighbour's delete
  // control, or the empty-state action, can take focus once the project is
  // actually gone (the overview can refresh more than once during a delete).
  const pendingFocusRef = useRef<{ projectId: string; index: number } | null>(null);
  const newProjectRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (pending === null) return;
    // Wait until the deleted project is no longer in the list, so a transient
    // intermediate refresh cannot consume the focus target.
    if (overview.projects.some((p) => p.projectId === pending.projectId)) return;
    pendingFocusRef.current = null;

    // `offsetParent` alone is null for position:fixed elements, so use a
    // layout-rect check that also covers hidden ancestors.
    const isVisible = (el: HTMLElement): boolean => el.getClientRects().length > 0;
    const focusables = Array.from(
      document.querySelectorAll<HTMLElement>('.pm-project-card .pm-project-card-delete'),
    ).filter(isVisible);
    if (focusables.length > 0) {
      focusables[Math.min(pending.index, focusables.length - 1)]?.focus();
      return;
    }
    // No cards remain (or none are visible): the empty-state action, else the
    // always-present header action, is the surviving target. Query the empty
    // action directly rather than via a ref shared with the header button,
    // which would win the ref assignment (Story 25.4 AC 25.4-2).
    const emptyAction = document.querySelector<HTMLElement>('.pm-workspace-new-project--empty');
    (emptyAction && isVisible(emptyAction) ? emptyAction : newProjectRef.current)?.focus();
  }, [overview.projects]);

  const startEdit = (project: WorkspaceProjectRow): void => {
    setEditingId(project.projectId);
    setEditValue(project.projectName);
  };

  const confirmEdit = (project: WorkspaceProjectRow): void => {
    const trimmed = editValue.trim();
    if (editingId === project.projectId && trimmed.length > 0 && trimmed !== project.projectName) {
      onRenameProject(project.projectId, trimmed);
    }
    setEditingId(null);
    setEditValue('');
  };

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, project: WorkspaceProjectRow): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmEdit(project);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditingId(null);
      setEditValue('');
    }
  };

  const toggleTheme = (projectId: string, themeId: string): void => {
    const key = `${projectId}:${themeId}`;
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <main className="pm-workspace-overview">
      <header className="pm-workspace-header">
        <h1 className="pm-workspace-title">Workspace</h1>
        <button
          type="button"
          className="pm-workspace-new-project"
          ref={newProjectRef}
          onClick={() => onCreateProject('New Project')}
        >
          New project
        </button>
      </header>

      {statusMessage && (
        <p className="pm-workspace-status" role="status">
          {statusMessage}
        </p>
      )}

      {overview.limitWarning && (
        <div className="pm-workspace-limit-warning" role="status">
          {overview.limitWarning.exceededProjectCount &&
            `This workspace has ${overview.limitWarning.observedProjectCount} projects, above the supported limit of ${overview.limitWarning.supportedProjectCount}.`}
          {overview.limitWarning.overLimitNodeProjects.length > 0 &&
            ` ${overview.limitWarning.overLimitNodeProjects
              .map((p) => `"${p.projectId}" has ${itemCountPhrase(p.nodeCount)}, above ${p.supportedNodeCount}.`)
              .join(' ')}`}
        </div>
      )}

      {overview.projects.length === 0 ? (
        <div className="pm-workspace-empty">
          <p className="pm-workspace-empty-copy">No projects yet.</p>
          <p className="pm-workspace-empty-action">Create a project to start planning.</p>
          <button
            type="button"
            className="pm-workspace-new-project pm-workspace-new-project--empty"
            ref={newProjectRef}
            onClick={() => onCreateProject('New Project')}
          >
            New project
          </button>
        </div>
      ) : (
        <div className="pm-workspace-project-grid">
          {overview.projects.map((project) => {
            const isEditing = editingId === project.projectId;
            const hasThemes = project.themes.length > 0;
            const domain: TimelineDomain | null = hasThemes
              ? computeTimelineDomain(
                  project.themes.map((t) => ({
                    spanStartDate: t.spanStartDate,
                    spanEndDate: t.spanEndDate,
                  })),
                )
              : null;
            const axisLabel = domain
              ? `Shared planned timeline for ${project.projectName}, ${domain.start} to ${domain.endInclusive}`
              : `No scheduled themes for ${project.projectName}`;
            const hasScheduledTheme = project.themes.some(
              (t) => classifyTimelineSpan({ spanStartDate: t.spanStartDate, spanEndDate: t.spanEndDate }).kind === 'scheduled',
            );
            const undated = project.themes.filter((t) => {
              const kind = classifyTimelineSpan({ spanStartDate: t.spanStartDate, spanEndDate: t.spanEndDate }).kind;
              return kind === 'not_scheduled' || kind === 'incomplete';
            }).length;
            const invalidCount = project.themes.filter(
              (t) => classifyTimelineSpan({ spanStartDate: t.spanStartDate, spanEndDate: t.spanEndDate }).kind === 'invalid',
            ).length;

            return (
              <article key={project.projectId} className="pm-project-card">
                <header className="pm-project-card-header">
                  <div className="pm-project-card-name-row">
                    {isEditing ? (
                      <input
                        className="pm-project-card-name-input"
                        value={editValue}
                        autoFocus
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={() => confirmEdit(project)}
                        onKeyDown={(e) => handleEditKeyDown(e, project)}
                        aria-label="Project name"
                      />
                    ) : (
                      <span
                        className="pm-project-card-name"
                        role="button"
                        tabIndex={0}
                        onClick={() => startEdit(project)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            startEdit(project);
                          }
                        }}
                      >
                        {project.projectName}
                      </span>
                    )}
                    <button
                      type="button"
                      className="pm-project-card-delete"
                      aria-label={`Delete project ${project.projectName}`}
                      onClick={() => setPendingDeleteId(project.projectId)}
                    >
                      Delete
                    </button>
                  </div>

                  <ProjectDeliverySummary project={project} />

                  <details className="pm-project-card-details">
                    <summary className="pm-project-card-details__summary">Project details</summary>
                    <div className="pm-project-card-details__body">
                      <p className="pm-project-card-details__row">
                        <span className="pm-project-card-details__label">Revision</span>
                        <span className="pm-project-card-details__value">
                          <span className="pm-project-card-revision">v{project.projectRevision}</span>
                          {' '}— increments with every change to this project
                        </span>
                      </p>
                      <p className="pm-project-card-details__row">
                        <span className="pm-project-card-details__label">Coverage</span>
                        <span className="pm-project-card-details__value">
                          {Math.round(
                            (project.coverage.weightCoveragePercentage +
                              project.coverage.effortCoveragePercentage +
                              project.coverage.scheduleCoveragePercentage) /
                              3,
                          )}
                          % — the average across themes of complete strategic weight, effort and schedule inputs.
                        </span>
                      </p>
                    </div>
                  </details>
                </header>

                {hasThemes ? (
                  <div className="pm-theme-table">
                    <div className="pm-theme-row pm-theme-row--header">
                      <span className="pm-theme-col pm-theme-col--name">Delivery by theme</span>
                      <span className="pm-theme-col pm-theme-col--status">Feature status</span>
                      <span className="pm-theme-col pm-theme-col--timeline">
                        {domain ? (
                          <ThemeTimelineAxis domain={domain} todayIso={today} label={axisLabel} />
                        ) : (
                          <span className="pm-theme-col__timeline-empty">{axisLabel}</span>
                        )}
                      </span>
                    </div>

                    {project.themes.map((theme) => {
                      const spanState = classifyTimelineSpan({
                        spanStartDate: theme.spanStartDate,
                        spanEndDate: theme.spanEndDate,
                      });
                      const buckets = deliveryBuckets(theme.statusCounts);
                      const detailKey = `${project.projectId}:${theme.themeId}`;
                      const isOpen = expanded.has(detailKey);
                      return (
                        <div key={theme.themeId} className="pm-theme-row" data-theme-id={theme.themeId}>
                          <div className="pm-theme-col pm-theme-col--name">
                            <span
                              className="pm-theme-name"
                              role="button"
                              tabIndex={0}
                              onClick={() => onOpenTheme(project.projectId, theme.themeId)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  onOpenTheme(project.projectId, theme.themeId);
                                }
                              }}
                            >
                              {theme.themeName}
                            </span>
                            <span className="pm-theme-meta">
                              {theme.featureCount === 0 ? 'No features yet' : featureCountPhrase(theme.featureCount)}
                              {' · '}
                              <CoherenceChips chips={encodeCoherenceChips(theme.findingCounts)} />
                            </span>
                            <ThemeDetailsToggle
                              projectId={project.projectId}
                              theme={theme}
                              open={isOpen}
                              onToggle={toggleTheme}
                            />
                          </div>

                          <div className="pm-theme-col pm-theme-col--status">
                            {theme.featureCount === 0 ? (
                              <span className="pm-theme-status-empty">No features yet</span>
                            ) : (
                              <>
                                <span
                                  className="pm-theme-distribution"
                                  role="img"
                                  aria-label={statusPhrase(theme.statusCounts)}
                                >
                                  {buckets.map((bucket) => (
                                    <span
                                      key={bucket.descriptor.value}
                                      className={`pm-theme-distribution__seg pm-theme-distribution__seg--${bucket.descriptor.modifier}`}
                                      style={{ flexGrow: bucket.count }}
                                    />
                                  ))}
                                </span>
                                <span className="pm-theme-status-counts">
                                  {buckets.map((bucket) => (
                                    <span key={bucket.descriptor.value} className="pm-theme-status-count">
                                      <span
                                        className={`pm-theme-status-dot pm-theme-status-dot--${bucket.descriptor.modifier}`}
                                        aria-hidden="true"
                                      />
                                      {bucket.count} {bucket.descriptor.label}
                                    </span>
                                  ))}
                                </span>
                              </>
                            )}
                          </div>

                          <div className="pm-theme-col pm-theme-col--timeline">
                            {domain ? (
                              <ThemeTimelineLane
                                domain={domain}
                                state={spanState}
                                todayIso={today}
                                themeName={theme.themeName}
                              />
                            ) : (
                              <span className="pm-theme-timeline-lane__state">
                                {spanState.kind === 'not_scheduled'
                                  ? 'Not scheduled'
                                  : spanState.kind === 'incomplete'
                                    ? 'Dates incomplete'
                                    : 'Invalid schedule'}
                              </span>
                            )}
                            {spanState.kind === 'scheduled' && domain && (
                              <button
                                type="button"
                                className="pm-theme-timeline-open"
                                aria-label={`Open the Gantt for ${project.projectName}`}
                                onClick={() => onOpenGantt(project.projectId)}
                              >
                                Open Gantt
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}

                    {undated > 0 && (
                      <div className="pm-theme-absence-note">
                        <span>{undated} theme(s) not fully scheduled</span>
                      </div>
                    )}
                    {invalidCount > 0 && (
                      <div className="pm-theme-absence-note">
                        <span>{invalidCount} theme(s) with an invalid schedule</span>
                      </div>
                    )}
                    {!hasScheduledTheme && (
                      <div className="pm-theme-absence-note">
                        <span>No theme in this project has a complete scheduled span.</span>
                      </div>
                    )}

                    {project.themes
                      .filter((theme) => theme.featureCount > 0)
                      .map((theme) => (
                        <ThemeDetailsPanel
                          key={theme.themeId}
                          projectId={project.projectId}
                          theme={theme}
                          open={expanded.has(`${project.projectId}:${theme.themeId}`)}
                        />
                      ))}
                  </div>
                ) : (
                  <div className="pm-project-card-empty">
                    <span className="pm-absence-text">No themes yet.</span>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {pendingDeleteProject && (
        <DeleteProjectDialog
          projectName={pendingDeleteProject.projectName}
          onConfirm={() => {
            pendingFocusRef.current = {
              projectId: pendingDeleteProject.projectId,
              index: overview.projects.findIndex((p) => p.projectId === pendingDeleteProject.projectId),
            };
            onDeleteProject(pendingDeleteProject.projectId);
            setPendingDeleteId(null);
          }}
          onCancel={() => {
            // A cancelled delete must not leave a stale focus intent that a
            // later unrelated refresh could consume.
            pendingFocusRef.current = null;
            setPendingDeleteId(null);
          }}
        />
      )}
    </main>
  );
}
