# Lumen Trade demo project

An entirely fictional cash-only stock trading app. Names, dates, targets, people, progress, and decisions are invented. No customer or private contextual material is used.

## Open the project

Download `/demos/lumen-trade.json` from a running Vantage instance, or use `public/demos/lumen-trade.json` from this repository. In Vantage, select **Import**, choose the file, and select **Import project**. This creates an independent editable project. It does not replace existing projects or change the app's blank-project behavior.

The demo contains 56 nodes: one Vision, four weighted Themes, six Components, fifteen Features, and thirty Acceptance Criteria. It includes three phases, twenty-five dependencies, four fictional people with capacity weights and assignments, custom fields, briefs, progress, open questions, decisions, one explicit forecast blocker, parallel groups, two historical scenarios, and a hand-planned Delivery Board sprint plan.

Opening the demo's Outline in a browser shows a four-step spotlight tour (about 30 seconds). Next and Back move through it; Skip tour or Escape closes it. The browser remembers that the tour has been shown, including after reload. Other projects and the desktop app do not trigger it. Clearing this site's browser storage resets that preference; if persistent storage is unavailable, the tour is remembered for the current session.

## Ten-minute walkthrough

1. **Workspace and Outline:** start with the Vision brief. Customer outcomes are funded activation, an informed first order, and week-four retention. Targets are illustrative, not reported results. Theme weights are 40/35/25; the platform Theme has zero direct outcome weight so enabling work is visible separately.
2. **Platform thinking:** open **Double-entry cash ledger and reconciliation**. Its Unlocks connect to deposits, risk preview, orders, holdings, and statements across outcome branches. Open the market-data gateway for a second shared capability. Structural containment shows ownership; unlock links show dependencies across that structure.
3. **Inspector:** read the ledger brief and custom owner/measure fields. Open verification's Criteria for completed evidence, then order routing's Questions for an unresolved timeout decision. Funding and notifications contain recorded product decisions.
4. **Visual Tree:** explore an outcome branch, then the platform branch. Inspect cross-branch links to show why a platform feature matters beyond its own team.
5. **Gantt and downstream review:** inspect the authored January–March 2027 plan. Move the ledger's end date from January 29 to February 12. Review affected deposits, order readiness, and downstream work; undo the change to reset. Authored schedules are targets, separate from capacity forecasts.
6. **Forecast:** the Delivery Board opens with ledger and onboarding work in Sprint 1, market data and deposits in Sprint 2, and discovery plus controls in Sprint 3. Drag a Backlog item into a sprint or change a sprint's capacity to see the hand-planning rules. Switch to **List view** to inspect the four-person roster, unequal capacity, assignments, parallel groups, and points done. Order routing is explicitly blocked while its timeout behavior is unresolved, so dependent work waits in the Backlog. A blocker is an authored forecast flag, not automatically inferred from dependency links. The baseline is intentionally overcommitted against the March launch target; discuss the conditional projection rather than presenting the target as a promise.
7. **Scenarios:** compare **Smaller launch — defer alerts and monthly statements** with **More money-platform capacity — Morgan from 1.0 to 1.5**. Both preserve the baseline blocker. Historical scenarios retain captured inputs and may be marked historical after import or edits. Neither scenario changes the live plan until the user applies supported edits.
8. **Coherence and trade-offs:** compare strategic weights with planned effort. Delay the ledger to make a sequencing conflict concrete, then inspect Coherence Review and Downstream Affected Review. Do not invent or pre-dismiss findings; the app derives them from the current authored graph.
9. **Exports and collaboration:** export a feature brief, a project document, and Gantt slides. Use **Export project** for a portable snapshot or **Share for editing** to demonstrate the actual shared-file review/merge flow with a second copy. Collaboration history and affected-change records start empty because no real collaboration or schedule change has happened yet.

The plan covers identity, funding, discovery, cash-only order preview, execution, holdings, notifications, statements, analytics, support, and operational recovery. Margin, options, crypto, and recommendations are explicitly out of scope.

## Regenerate

Run `node scripts/generate-demo-project.mjs`, then `npx vitest run src/contracts/demo-project.spec.ts`. Fixed identities and content make regeneration reproducible. The generator validates the complete envelope using the application's import contract and computes scenario fingerprints with the production forecast functions.
