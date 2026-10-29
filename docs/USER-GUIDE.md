# Vantage user guide

Everything Vantage does, screen by screen. New here? Start with the [README](../README.md) for the overview and setup.

## Contents

- [1. The workspace & side navigation](#1-the-workspace--side-navigation)
- [2. Authoring the outline](#2-authoring-the-outline)
- [3. The Node Inspector](#3-the-node-inspector)
- [4. Scheduling, effort, and acceptance criteria](#4-scheduling-effort-and-acceptance-criteria)
- [5. Keyboard shortcuts & the command palette](#5-keyboard-shortcuts--the-command-palette)
- [6. Coherence review](#6-coherence-review)
- [7. Downstream Affected Review](#7-downstream-affected-review)
- [8. Unlock relationships (dependencies)](#8-unlock-relationships-dependencies)
- [9. Visual Tree view](#9-visual-tree-view)
- [10. Gantt view](#10-gantt-view)
- [11. Forecast view](#11-forecast-view)
- [12. Exporting board-ready artifacts](#12-exporting-board-ready-artifacts)
- [13. Native desktop app (Tauri)](#13-native-desktop-app-tauri)

## 1. The workspace & side navigation

The workspace is the app's start screen. It lists every project with live counts (nodes, phases, open coherence flags, acceptance-criteria coverage) and lets you jump straight into any view for that project.

| First launch | Creating a project |
|---|---|
| Workspace on first launch | Creating a new project |

Click **New project** to create one — it's created instantly and dropped into inline rename mode so you can name it right away. Each project card has an **Outline** button to jump into that view (Visual and Gantt are reached from the side navigation once inside), and a **Delete** action (which requires typing the project's name to confirm — destructive actions are never a single click).

The **side navigation rail** (left) is the app's persistent home base, replacing the old authoring toolbar:

- **Workspace control** at the top — a non-modal menu to create, rename, delete, and switch between multiple local workspaces, each with its own project shelf, plus an Overview link.
- A **current-project card** with the four view buttons: Outline (`⌥1`), Visual Tree (`⌥2`), Gantt (`⌥3`), Forecast (`⌥4`).
- A **Projects shelf** at the bottom listing every project in the workspace, and an actions row (**New project**, **Import**, **Export project**, **Share for editing**, and **Recover previous merge** when available). **Import** accepts portable backups and shared-editing files in the browser or desktop app. Choose a standalone project or review a merge into an existing one; the importing person approves the changes. See [Local collaboration](local-collaboration.md).
- A footer with **Jump to item** (`⌘K`) and **Export document**.

## 2. Authoring the outline

Click into a project's Outline. The tree starts blank — press **Enter** (or click **+ Add node** at the bottom of the list) to create your first node and start typing immediately. No type is required to create a node.

Outline authoring with a Theme, Components, Features, and Acceptance Criteria

- **Enter** creates a sibling node; **Tab** / **Shift+Tab** indent/outdent a node to nest it under (or promote it out from) its neighbor. Typed text is committed before any structural key acts on it.
- **Drag** a row by its handle to reorder it or nest it. Drop on the middle of a group to move the row inside it; the row gains that group's depth and appears with its children. Thin top/bottom tracks keep sibling reordering precise, and a **Move inside** cue confirms a nesting drop before release. The domain hierarchy is enforced (a Theme can't be dropped under a Feature, for example).
- The Outline always renders the resulting containment visibly: a Component's Features are indented beneath the Component, so the tree reads like the plan it represents rather than a flat list with hidden parent links.
- Click the type tag (`VISION`, `THEME`, `COMPONENT`, `FEATURE`, `AC`, or blank) to open the type selector and (re)classify a node at any time — classification is always optional and always retroactive.

Node type selector popover

- Node types form the vision-tree hierarchy: **Vision** (optional topmost strategic level) → **Theme** (top-level strategic grouping) → **Component** (a delivery-altitude grouping between Theme and Feature) → **Feature** (a unit of buildable work) → **Acceptance Criterion** (a concrete, checkable condition of "done").
- Rows carry a **delivery-status badge** (Not started / In progress / Delivered). Setting "In progress" or "Delivered" without the matching authored dates opens the schedule editor to prompt you for them.
- Rows are subtly **color-coded by node type** (muted tints, not loud), and a ghost **"Add sibling" cue** follows your focused row so the next insertion point is always visible.

## 3. The Node Inspector

Select any node to open the **Node Inspector** — a docked drawer on the right (drag its left edge to resize on desktop; it overlays on narrow viewports).

At the top, a property list summarises the item: **Type**, **Effort** (edit the points inline), **Phase**, **Dates**, **Status**, **Criteria** met for features (green once all are met), and **Dependencies** ("Unlocks 1 · Waits on 1"). Below it, four tabs:

- **Brief** — a Markdown brief that reads like a document in preview. Switch between preview and editing with the icon button; **Save** and **Discard** appear only once there are unsaved changes (`⌘S` to save, Esc-to-close prompts if unsaved), and empty briefs offer starter templates. Feature nodes get an export button for a Word one-pager.
- **Questions** (Questions & Decisions) — add open questions, record decision notes, resolve them, or "Resolve All".
- **Criteria** (Acceptance Criteria) — add criteria as AC child nodes, check them off, and watch the live met count.
- **Unlocks** — add directional unlock links (this item unlocks / is unlocked by) by picking a target node, and see what it waits on and what it unlocks.

## 4. Scheduling, effort, and acceptance criteria

Hover a row and use its metadata buttons to set a schedule, effort points, or strategic weight. Dates accept natural language:

Natural-language schedule modal

Type a phrase like `2026-09-01 to 2026-09-15`; the modal parses it live and previews the resolved start date, end date, and duration before you apply it. Parent nodes automatically roll up the earliest start / latest end across their descendants — the Outline shows a *derived* span pill on any undated parent with dated descendants, and the Gantt always surfaces the rollup — you never have to compute a Theme's overall span by hand.

Acceptance criteria are checkable child nodes, authored in the Inspector's **Acceptance Criteria** tab — check one off and its parent Feature automatically shows a live `met / total` ratio.

## 5. Keyboard shortcuts & the command palette

Press **Ctrl+K** (or **⌘K**) anywhere to open the command palette — every action in the app is reachable from here, with its keyboard shortcut shown alongside:

Command palette

| Action | Shortcut |
|---|---|
| Command palette | `Ctrl+K` |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Duplicate subtree | `Ctrl+D` |
| Delete subtree | `Ctrl+Backspace` (plain `Backspace` is not a delete — it's for text editing) |
| Zoom into branch / out to parent | `Ctrl+.` / `Ctrl+,` |
| Jump to node (fuzzy search) | `Ctrl+/` |
| Inspect unlock relationships | `Ctrl+U` |
| Open Coherence Review | `Ctrl+Shift+C` |
| Open Downstream Affected Review | `Ctrl+Shift+A` |
| Switch view: Outline / Visual / Gantt / Forecast | `⌥1` / `⌥2` / `⌥3` / `⌥4` |
| Save brief in the Inspector | `⌘S` |
| Move feature up / down in the forecast | `Alt+↑` / `Alt+↓` |
| Group / ungroup parallel work in the forecast | `g` / `u` |

(Use `⌘` in place of `Ctrl` on macOS.)

## 6. Coherence review

The app continuously analyzes your tree in the background — off the main thread, so typing never stalls — and surfaces issues like orphaned features (no parent Theme), sequencing violations, and strategic-effort imbalance. Open the panel any time with **Ctrl+Shift+C**:

Coherence Review panel

A coherent tree (as above) shows a reassuring "no open flags" state. When a flag does exist, it appears both here and as an inline advisory banner on the affected row, with a one-click dismiss.

## 7. Downstream Affected Review

When you're about to change something that has consequences, **Ctrl+Shift+A** opens the Downstream Affected Review — it shows every node that would be affected by the pending change, so you can see the blast radius before you commit to it.

## 8. Unlock relationships (dependencies)

Model directional "this unlocks that" relationships between any two nodes — separate from the containment hierarchy — and inspect a node's full dependency picture with **Ctrl+U** (or the Inspector's **Unlocks** tab):

Edge Inspection panel showing unlock relationships

The panel shows what a node is unlocked by (its prerequisites) and what it unlocks (downstream work it's blocking), and lets you add new unlock links by picking a target node and direction.

## 9. Visual Tree view

Switch to **Visual** to see one Theme's subtree rendered as a literal, accessible flowchart — containment nesting flows top-to-bottom, with a dedicated theme picker along the top to jump between Themes:

Visual Tree view

The canvas is a pannable, zoomable world: **wheel-zoom** toward the pointer, **drag to pan**, **arrow-key pan**, and a compact viewport control overlay (−, live zoom %, +, **Fit**, **Reset**). Your viewport is remembered per project and theme, so you return to exactly where you left off. This view is intentionally scoped to a single Theme at a time (rather than the whole project) — canvas-style diagrams stop being legible well before a few hundred nodes, so Visual trades project-wide breadth for a genuinely readable picture of one strategic area.

## 10. Gantt view

Switch to **Gantt** for a rolled-up timeline of every scheduled node, grouped by its containing Theme/Feature hierarchy:

Gantt view

- **Workstream color-coding.** Each Theme opens a workstream; it and all its descendants share that workstream's hue (a stable 1–6 ramp), so you can read the timeline's strategic structure at a glance. Authored work renders as solid task boxes; derived summary rails use a tinted mix. The same hues carry through to the PPTX export.
- Use the **Week / Month / Quarter** scale toggle and the date range fields (or **Fit**) to zoom the visible window. Nodes without a schedule are called out explicitly ("N undated · excluded") rather than silently omitted.

## 11. Forecast view

Switch to **Forecast** (`⌥4`) for a capacity-based delivery forecast computed from the same tree — no separate planning spreadsheet. It's a three-pane workspace:

Forecast workspace

**Planning level.** The first time you open Forecast, choose **Themes**, **Components**, or **Features**. Each available level gives every row the same altitude, so estimates and capacity are comparable. A level without nodes is shown as unavailable. Changing a configured plan's level is explicit: the confirmation explains that the current ranking and parallel buckets will be cleared.

Confirming a planning-level change

**Backlog (left).** Every item at the chosen level that isn't ranked yet is searchable and can be estimated inline. The Backlog preserves the Outline's hierarchy: a nested item is rendered directly beneath its parent with a matching indent, and parent rows can be expanded or collapsed. **＋** (or drag, or Enter) adds an item to the end of the Priority list; items already in the plan show dimmed with an "in plan" marker. Adding an item that overlaps an already-selected ancestor or descendant is rejected and the reason is shown in context.

**Priority list (center).** Ranked rows with a priority number, per-row effort-points input, and ▲/▼ move buttons (or drag with a drop line, or `Alt+↑`/`Alt+↓`). Expand **▸ Details** to see each feature's sprint window, exact offset, and capacity events. **Mark blocked / Clear blocker** flags a feature that's waiting on something outside the plan. Select contiguous rows and press **`g`** to group them for **parallel work** — the group's capacity is split equally per sprint — or **`u`** to ungroup; group-split moves are rejected with a named reason.

**Forecast rail (right).** The forecast is computed live and reported honestly, section by section:

- **Completion** — the sprint and calendar date the plan finishes, marked "capacity-derived", or **Conditional** when a blocked feature is included (no delay is ever assumed).
- **Coverage** — selected / estimated / known points, with an issue list for anything that can't be estimated.
- **Arithmetic** — total points, capacity per sprint, the exact ratio, occupied sprints, sprint length, and the start anchor.
- **Assumptions** — the policy version, cadence, grouping premise, rounding, and blocker condition behind the numbers.
- **What changed** — typed change attribution vs. the last settled forecast (never a fabricated percentage; if there's no baseline, it says so).
- **Scenarios** — saved historical scenarios you can compare side by side.
- **Configuration** — points-per-sprint, sprint length, start sprint ordinal, and first date, saved atomically as one command.

**Staffing-aware mode.** Switch between **Shared team capacity** (`shared-capacity-v1`) and **Assigned people** (`staffed-capacity-v1`). Manage a project roster of people with relative weights (e.g. 1.00, 0.50), assign one or more people to each priority item, and calculate exact per-person rates and durations. In staffed mode, parallel groups model work executed concurrently by distinct team members with concurrency conflict prevention (one active positive-work item per person per bucket): a rejected assignment names the person and both items. Until every positive-work item has someone assigned, the headline reads **Assignment needed**, names the items and offers an assign action — no date is shown. Bottleneck items and unused idle capacity are surfaced explicitly.

**Scenarios & Staffing trade-offs.** Save a scenario to compare "what if" variants — override scope, order, estimates, capacity-per-sprint, team member weights (entered like live weights, e.g. `1.5`), or per-item assignments. Opening a draft captures the plan once at the current revision; later live edits never change the draft or its preview. If the live plan changed before you save, the save is refused and your edits are kept: **Refresh baseline** re-captures the plan, lists what changed, flags any override that no longer applies and shows the new preview — it never saves on its own. Previews are calculated off the typing path in the analysis worker. Each draft and saved scenario shows the **captured baseline** and the **variant** side by side, the changed levers, point/capacity deltas, and an **Exact item timing** disclosure with every item's assignees, exact rate, exact duration and sprint offsets on both sides. A variant that cannot be calculated is explained with the person and items involved and how to repair it. Cancelling a draft with unsaved changes asks first. Scenarios keep their captured roster, assignments and planning level, so a scenario stays readable after people are renamed or removed, or the live plan moves to another level. A blocked item makes the result **Conditional**: the completion date still computes, while the rail states the blocker instead of inventing a delay.

Scenario draft: captured baseline and variant with exact item timing

## 12. Exporting board-ready artifacts

Click **Export** from any view to generate a PowerPoint or Word document scoped to exactly what's currently visible (the active view's filters, zoom, and scope all carry through). Before anything is generated, you get a one-sentence preview of what will be included:

Export scope preview

Confirming generates the file client-side — nothing is uploaded anywhere. The Word format is a **structured collapsible outline** with a table of contents and acceptance criteria rendered as checklist items; the PowerPoint Gantt export uses the same workstream hues as the on-screen view. In the native desktop app, the file is written through a **native save dialog** instead of a browser download.

## 13. Native desktop app (Tauri)

The Windows desktop app uses the same authoring UI with a local Rust SQLite runtime and native file dialogs. Projects stay in the desktop app's local storage rather than the browser profile.

- **Export project** creates a portable `.pmapp.json` file, compatible with the browser app.
- **Import** offers a standalone copy or a reviewed merge into an existing project.
- **Share for editing** creates a `.vantage-share.json` file for continued collaboration.
- Native save dialogs are used for project files and Office exports.

The browser app remains fully functional. See [desktop setup](run-desktop-from-source.md) for prerequisites.

## 14. Local collaboration and merge recovery

Each teammate edits a local copy. Use **Share for editing**, exchange files through your approved channel, and use **Import → Merge into existing project** to review a contribution. Anyone importing a file is its approver.

Independent edits can combine. Conflicting changes offer **Use incoming**, **Keep mine**, or **Decide later**. Independently created projects can be added as branches beneath a selected item. Nothing applies until you approve, and repeated accepted contributions do not duplicate items.

**Recover previous merge** restores the saved pre-merge plan and its merge history. It replaces intervening edits after confirmation, and saves the replaced plan as the next recovery point. Recovery survives restarting the app.

The [local collaboration guide](local-collaboration.md) covers first-time linked imports, standalone copies, previously declined changes, independent branches, file limits, and recovery.
