# Collaborate through local files

Everyone runs Vantage on their own computer. Exchange files using a channel approved by your workplace. No service, account, deployment, or shared database is needed.

## Start a shared plan

1. Open a project and choose **Share for editing** in the left navigation.
2. Send the downloaded `.vantage-share.json` file to a teammate.
3. They choose **Import**, select the file, and choose **Import as standalone project** with **Keep linked for future file exchanges** checked.
4. They edit their local plan and use **Share for editing** to send their version back.

Shared editing files contain the whole project and its recorded checkpoints, including earlier text. Use an ordinary **Export project** backup if you only want to share the current project snapshot. File identifiers and checksums support merging; they do not authenticate the sender.

## Review a contribution

Choose **Import**, select the returned file, then choose **Merge into existing project** and select the destination.

If shared history is recognized, Vantage compares the contribution with your local plan and their shared base. Independent edits are selected for review. Competing changes need a decision:

- **Use incoming** applies the contributor's value.
- **Keep mine** remembers that you declined that change.
- **Decide later** leaves it pending for the next import.

Expand a change to compare values. Briefs are reviewed as whole fields. Placement, schedules, and forecast configuration are reviewed together where their values depend on one another. A selection that would leave invalid references or hierarchy cannot be applied; include the required related changes or leave the conflicting group for later.

**Approve contribution** applies the selected valid changes together and saves a recovery point. Cancel changes nothing. Reimporting an incorporated contribution does not duplicate it. You can review previously declined changes again. Anyone importing a file approves it; there is no permanent coordinator role.

## Add an independently created branch

An ordinary export or unrelated shared plan can also be merged. Select the destination and **Add branch beneath** location. Vantage gives imported items separate identities and preserves internal references. Matching titles do not combine items. Later imports from the same source update that imported branch rather than adding another copy.

The destination keeps its project name and workspace. Review phase, template, and forecast changes carefully; project-wide forecast settings are not replaced automatically by an unrelated contribution.

To create a completely separate project instead, choose standalone import. For a shared file, uncheck **Keep linked** to make an independent copy. If the linked project already exists on your device, merge into it instead of importing another linked copy.

## Recover a merge

Select **Recover previous merge** to restore the saved plan and its merge history. This also replaces edits made since that merge; the confirmation explains that replacement. The replaced current plan becomes the new recovery point. Recovery remains available after restarting. Keep portable backups for longer-term history: only one recovery point per project is retained.

## Limits

- Files are exchanged manually. Nothing synchronizes in the background.
- Share and merge require pending edits to finish. If a project changes after review, reopen the file and review again.
- Collaboration files are limited to 30 MB and 32 recorded checkpoints. Existing ancestry is never silently discarded. At the checkpoint limit, make an independent copy to begin a new exchange; it starts a new lineage.
- Older `.pmapp.json` backups remain importable as independent projects or branches. They do not supply the shared history needed to reconcile edits to a shared plan.
- Browser projects remain in that browser's local storage. Keep backups before clearing site data or changing browsers.
