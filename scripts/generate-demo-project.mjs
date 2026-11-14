import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';

// Entirely fictional content. Fixed IDs make regeneration and demo resets reproducible.
let sequence = 0;
const id = () => `01a20000-0000-7000-8000-${(++sequence).toString(16).padStart(12, '0')}`;
const exportedAt = '2027-01-18T09:00:00.000Z';
const project = { id: id(), name: 'Lumen Trade — fictional investing app' };
const phases = ['01 · Foundations', '02 · Private beta', '03 · Public launch'].map((name, i) => ({ id: id(), name, position: String((i + 1) * 1024) }));
const nodes = [], unlockEdges = [], openQuestions = [], nodeCustomFields = [];
const keys = {};
function node(key, parent, title, nodeType, bodyText, extra = {}) {
  const value = { id: id(), parentId: parent ? keys[parent] : null, title, bodyText, position: String((nodes.filter(n => n.parentId === (parent ? keys[parent] : null)).length + 1) * 1024), nodeType, startDate: null, endDate: null, durationDays: null, scheduleSourceMode: 'none', completed: false, effortPoints: null, effortPointsDone: null, strategicWeight: null, phaseId: null, deliveryStatus: 'not_started', ...extra };
  keys[key] = value.id; nodes.push(value); return value;
}
node('vision', null, 'Make a first investment feel understandable, controlled, and trustworthy', 'Vision', `> *Fictional planning demo - all personas, cohorts, and target metrics are synthetic.*

## North Star
Help first-time investors move from curiosity to a confident first cash-only trade without hidden settlement traps, mystery fees, or portfolio math they cannot explain. Success is durable, informed participation rather than trading frequency.

## Pillars
- **Honest money clarity:** show settled cash, pending ACH holds, and exact availability dates wherever buying power appears.
- **Transparent order mechanics:** replace blind confirmation with quote-freshness checks, itemised costs, and plain-English order states.
- **Shared financial truth:** ground every screen in one auditable double-entry ledger, idempotent order pipeline, and eligibility service.
- **Accessible trust and recovery:** meet WCAG AA across core journeys and give support the exact ledger and order timeline when someone asks where their money is.

## Launch outcomes
- Verified-to-funded activation: **38% -> 60%**.
- Funded-to-first-order conversion: **25% -> 45%** within seven days.
- Four-week retained funded accounts: **20% -> 35%**.
- Money-status support contacts: **18 -> 7** per 1,000 funded accounts.
All baselines and targets are synthetic.

## Boundaries
Launch supports cash accounts, US stocks, and broad-market ETFs. Margin, options, crypto, and social copy-trading are out of scope. Lumen Trade is fictional; nothing here is investment guidance.

## Demo route
Explore weighted Themes, platform dependencies, briefs, Questions, Criteria, Gantt, and Forecast. Change the ledger schedule to review downstream impact. Compare a smaller launch scope and added capacity as saved scenarios.`);
const themes = [
  ['activation', 'Help 60% of verified customers fund their account', 40],
  ['confidence', 'Help 45% of funded customers place an informed first order', 35],
  ['retention', 'Bring 35% of funded customers back in week four', 25],
  ['platform', 'Build reusable trust and operating foundations', 0],
];
const themeCopy = {
  activation: `## Strategic Objective
Remove the 62% drop-off between verified identity and a funded cash balance by explaining why identity checks exist, validating documents before upload, and showing exact ACH availability before a bank link is submitted.

## Persona
**Maya Chen (29), First-Time Saver** - comfortable with mobile banking, nervous about entering identity and bank credentials into a new brokerage. She abandons a flow when a hold looks broken or unexplained.

## OKRs
- Raise verified-to-funded activation from **38% -> 60%** across synthetic beta cohorts.
- Keep KYC document resubmission below **12%** through inline quality feedback.
- Reach **>= 88%** comprehension of pending versus settled cash in moderated tasks.`,
  confidence: `## Strategic Objective
Turn order discovery and execution from an intimidating leap into a transparent, verifiable interaction where the customer understands estimated cost, cash impact, and execution state before confirming.

## Persona
**Devon Brooks (34), Deliberate Beginner** - follows a handful of familiar companies and broad-market ETFs. He reads carefully before tapping Buy and backs out when a price, fee, or state is ambiguous.

## OKRs
- Raise funded-to-first-order conversion from **25% -> 45%** within seven days.
- Keep stale-quote abandonment below **3%** of initiated order previews.
- Ship **zero** silent duplicate orders across retry and poor-network rehearsals.`,
  retention: `## Strategic Objective
Help every investor reconcile every dollar - deposited, reserved in an open order, invested, or ready to withdraw - and separate their own contributions from investment performance.

## Persona
**Priya Nair (41), Goal-Oriented Indexer** - checks balances weekly, exports records at tax time, and expects total return to distinguish deposits from market gains.

## OKRs
- Raise four-week retained funded accounts from **20% -> 35%**.
- Reach **100%** ledger-to-UI balance parity during settlement and withdrawal rehearsals.
- Resolve the return-calculation method (transfers versus market return) before launch freeze.`,
  platform: `## Strategic Objective
Provide the shared identity, ledger, event, and operational foundations every customer journey depends on, with a single authored truth for eligibility, cash, and order state.

## Scope
Reusable platform capabilities owned by Lumen Trade engineering: identity and eligibility, double-entry cash and holdings, market-data freshness, durable order routing, and operational recovery tooling.

## OKRs
- One eligibility decision per customer, enforced across every money and trading surface.
- Every synthetic cash movement balances to the ledger and survives replay.
- Every order retry resolves to exactly one durable execution state.`,
};
for (const [key, title, strategicWeight] of themes) node(key, 'vision', title, 'Theme', themeCopy[key], { strategicWeight });
const components = [
  ['onboarding', 'activation', 'Account opening and funding'],
  ['discovery', 'confidence', 'Understand and place a trade'],
  ['portfolio', 'retention', 'Portfolio understanding and habit'],
  ['identity', 'platform', 'Identity and entitlement platform'],
  ['money', 'platform', 'Money and order platform'],
  ['operations', 'platform', 'Events, reliability, and service operations'],
];
const componentCopy = {
  onboarding: `## Component Scope
End-to-end account opening: passkey access, identity and eligibility checks, bank linking, first-deposit tracking, and pre-trade orientation.

## Dependencies and Risks
- Identity verification gates funding and depends on the shared **Identity and entitlement platform**.
- First-deposit work overlaps the **Double-entry cash ledger** finish; the ledger reservation contract must be agreed before deposit status can settle.`,
  discovery: `## Component Scope
Search, watchlists, quote inspection, plain-language risk preview, and the first-trade journey from discovery to execution receipt.

## Dependencies and Risks
- Reads quotes from the **Market data gateway** and settled cash from the **Double-entry cash ledger**.
- Order routing is intentionally blocked while the timeout and idempotency behaviour is unresolved, so first-trade work waits in the plan.`,
  portfolio: `## Component Scope
Holdings and cash explanations, daily value movement, opt-in alerts, and downloadable monthly activity statements.

## Dependencies and Risks
- Reads executed orders and ledger cash from shared platform capabilities.
- The return-calculation decision is open: transfers must not be presented as market performance.`,
  identity: `## Component Scope
Reusable identity verification, passkey access, and eligibility decisions consumed by onboarding, funding, and trading.

## Dependencies and Risks
- Verification callbacks must be idempotent; a retry cannot create a second customer or eligibility decision.
- Identity is the earliest platform dependency for every funded journey.`,
  money: `## Component Scope
The double-entry cash ledger, quote-freshness gateway, and idempotent order routing shared by funding, discovery, and portfolio.

## Dependencies and Risks
- Ledger reservations must settle before buying power or withdrawal states can be trusted.
- Order routing is explicitly blocked pending the timeout-recovery decision; downstream first-trade and launch work depends on it.`,
  operations: `## Component Scope
Versioned journey events, support timeline and audit trail, trading kill switch, and public-launch recovery rehearsal.

## Dependencies and Risks
- Operational controls must reuse the same event and ledger contracts as customer surfaces.
- Launch rehearsal needs the order timeout and ledger reconciliation decisions closed first.`,
};
for (const [key, parent, title] of components) node(key, parent, title, 'Component', componentCopy[key]);

const features = [
  // key, parent, title, points, phase, start, end, status, owner index
  ['verify', 'identity', 'Reusable identity verification and eligibility', 8, 0, '2027-01-04', '2027-01-15', 'delivered', 0],
  ['events', 'operations', 'Versioned journey events and outcome dashboard', 5, 0, '2027-01-04', '2027-01-15', 'delivered', 3],
  ['ledger', 'money', 'Double-entry cash ledger and reconciliation', 13, 0, '2027-01-11', '2027-01-29', 'in_progress', 1],
  ['quotes', 'money', 'Market data gateway with freshness contracts', 8, 0, '2027-01-18', '2027-01-29', 'in_progress', 2],
  ['signup', 'onboarding', 'Guided account opening with resumable verification', 5, 1, '2027-01-18', '2027-01-29', 'in_progress', 0],
  ['deposit', 'onboarding', 'Link a bank and track a first deposit', 8, 1, '2027-02-01', '2027-02-12', 'not_started', 1],
  ['watchlist', 'discovery', 'Search stocks and build a first watchlist', 5, 1, '2027-02-01', '2027-02-12', 'not_started', 2],
  ['risk', 'discovery', 'Plain-language risk and cash-only order preview', 5, 1, '2027-02-15', '2027-02-26', 'not_started', 0],
  ['orders', 'money', 'Idempotent order routing and execution state', 13, 1, '2027-02-15', '2027-03-05', 'not_started', 1],
  ['firsttrade', 'discovery', 'Place a first trade with a clear execution receipt', 8, 1, '2027-03-08', '2027-03-12', 'not_started', 2],
  ['holdings', 'portfolio', 'Explain holdings, cash, and daily value changes', 8, 2, '2027-03-08', '2027-03-19', 'not_started', 2],
  ['alerts', 'portfolio', 'Opt-in price and execution notifications', 5, 2, '2027-03-15', '2027-03-26', 'not_started', 3],
  ['statements', 'portfolio', 'Download a monthly activity statement', 5, 2, '2027-03-22', '2027-03-31', 'not_started', 1],
  ['controls', 'operations', 'Support timeline, audit trail, and trading kill switch', 8, 1, '2027-02-01', '2027-02-12', 'not_started', 3],
  ['launch', 'operations', 'Public-launch rehearsal and recovery drill', 5, 2, '2027-03-22', '2027-03-31', 'not_started', 3],
];
const featureCopy = {
  verify: {
    brief: `## Problem
Identity checks are where first-time investors abandon. Repeated document uploads and opaque pending states feel risky, especially when the customer cannot tell whether the application is still moving.

## Solution
Deliver reusable identity verification with on-device document quality checks, clear Pending / Approved / Action Needed states, and idempotent eligibility decisions consumed by funding and trading.

## Scope / Non-goals
- **In scope:** US individual cash-account identity checks and eligibility.
- **Non-goals:** Joint accounts, custodial accounts, and international tax-residency workflows.`,
    criteria: [
      'Verification retries resolve to one customer and one eligibility decision.',
      'Pending, approved, and action-needed states explain the next step and preserve the draft.',
    ],
  },
  events: {
    brief: `## Problem
Teams measure different funnel definitions, so activation and retention stories disagree and support cannot reconstruct the customer journey.

## Solution
Define one versioned journey-event contract for verification, funding, first order, and week-four return, and expose a synthetic cohort dashboard built on the same events.

## Scope / Non-goals
- **In scope:** Product analytics, cohort definitions, and a redacted support timeline.
- **Non-goals:** Personal data in analytics, ad tracking, or cross-site identity.`,
    criteria: [
      'A synthetic customer appears once at each funnel stage with no personal data in analytics.',
      'Replaying an event does not duplicate the funnel count or the support timeline.',
    ],
  },
  ledger: {
    brief: `## Problem
Cash states disagree across funding, ordering, and portfolio, so customers cannot tell what is spendable and support cannot explain a balance.

## Solution
Build a double-entry cash ledger with replay-safe deposits, reservations, trades, withdrawals, and reconciliation. Every customer money surface reads the same ledger truth.

## Scope / Non-goals
- **In scope:** Cash deposits, buying-power reservations, executions, withdrawals, and monthly reconciliation.
- **Non-goals:** Margin, credit, multi-currency, or tax-lot accounting.`,
    criteria: [
      'Every synthetic cash movement balances; replaying a deposit does not change the balance twice.',
      'Ledger cash equals the portfolio and statement totals at every settlement cut-off.',
    ],
  },
  quotes: {
    brief: `## Problem
Stale or delayed quotes can look live, leading customers to confirm a price that no longer exists.

## Solution
Serve a shared quote API to discovery, order preview, and portfolio screens with explicit freshness timestamps, market-session badges, and a stale-quote guardrail.

## Scope / Non-goals
- **In scope:** US stocks and broad-market ETFs, quote freshness, and market-session context.
- **Non-goals:** Options, crypto, technical indicators, analyst ratings, or investment recommendations.`,
    criteria: [
      'A quote older than the configured threshold is visibly marked stale everywhere it appears.',
      'Order preview blocks a stale quote and asks for an explicit refresh.',
    ],
  },
  signup: {
    brief: `## Problem
A long identity form loses progress and forces customers to restart, often after they have already shared sensitive information.

## Solution
Offer resumable account opening with passkey access, plain-language rationale for every field, and document checks before submission.

## Scope / Non-goals
- **In scope:** Individual cash-account onboarding with resumable verification.
- **Non-goals:** Joint onboarding or importing identity data from another broker.`,
    criteria: [
      'A customer can resume after restarting without re-entering identity data.',
      'Every requested field explains why it is needed and what happens next.',
    ],
  },
  deposit: {
    brief: `## Problem
Pending ACH cash often appears as zero available, causing panic, duplicate transfers, and avoidable support contacts.

## Solution
Link a bank account with an upfront clearing timeline and explicit Initiated -> Clearing -> Settled states sourced from the ledger. Never present pending cash as spendable.

## Scope / Non-goals
- **In scope:** ACH funding, pending and settled cash states, and rejected-transfer recovery.
- **Non-goals:** Wire transfers, debit-card top-ups, or instant provisional credit.`,
    criteria: [
      'A pending deposit is visible but cannot be spent before the ledger marks it available.',
      'A rejected transfer explains the bank reason and retry path without creating a duplicate debit.',
    ],
  },
  watchlist: {
    brief: `## Problem
Ticker-only search excludes beginners who know a company or fund category by name, while unclear quote states hide whether a price is live.

## Solution
Provide name and ticker search, a saved watchlist, quote timestamps, freshness labels, and market-session badges.

## Scope / Non-goals
- **In scope:** US stocks and ETFs, personal watchlists, and quote-age context.
- **Non-goals:** Social sentiment, analyst ratings, or complex technical charting.`,
    criteria: [
      'Search matches US stocks and ETFs by company name or ticker symbol.',
      'A saved watchlist survives restart and labels every stale quote.',
    ],
  },
  risk: {
    brief: `## Problem
Order tickets hide fees, buying power, and market-hours behaviour until after confirmation.

## Solution
Show a pre-trade receipt with estimated share quantity, reference quote and timestamp, fees, remaining settled cash, volatility notice, and market-hours behaviour.

## Scope / Non-goals
- **In scope:** Cash-only stock and ETF orders during regular market hours.
- **Non-goals:** Margin, options, personalised advice, or extended-hours execution.`,
    criteria: [
      'An order exceeding settled cash is rejected with an explanation before confirmation.',
      'The preview itemises share price, estimated total, fees, and remaining settled cash.',
    ],
  },
  orders: {
    brief: `## Problem
Retrying a slow request can duplicate an order, while generic pending spinners hide whether a trade filled, failed, or remains unknown.

## Solution
Build a durable order state machine with client idempotency keys and explicit Queued -> Working -> Filled / Rejected / Cancelled states.

## Scope / Non-goals
- **In scope:** Regular-hours market orders, retry safety, and an explicit status detail view.
- **Non-goals:** Extended hours, smart routing, or algorithmic execution.
- **Dependency risk:** This work is explicitly blocked while the timeout and unknown-outcome behaviour is unresolved.`,
    criteria: [
      'Repeated confirmation with the same idempotency key creates exactly one broker order.',
      'A timed-out confirmation resolves to an explicit state with a safe next action.',
    ],
  },
  firsttrade: {
    brief: `## Problem
Newly funded customers pause because order types, settlement, and fees feel unfamiliar, and an unclear receipt weakens trust.

## Solution
Offer an optional three-card primer with live read-only examples, then guide the first order and show a receipt that distinguishes submitted, filled, and rejected orders.

## Scope / Non-goals
- **In scope:** Education and the first cash trade, including a clear execution receipt.
- **Non-goals:** Gamified badges, required quizzes, or stock picks.`,
    criteria: [
      'A customer can tell submitted, filled, and rejected orders apart and see final price and fees.',
      'The primer can be skipped, paused, or resumed without blocking trade entry.',
    ],
  },
  holdings: {
    brief: `## Problem
Portfolio totals can disagree with cash and open orders, especially during settlement, and stale valuations can look authoritative.

## Solution
Combine executed positions, ledger cash, and fresh quotes into one holdings view, label stale values, and explain daily movement without conflating deposits with returns.

## Scope / Non-goals
- **In scope:** Cash equities and ETFs, holdings, cash, and daily value explanation.
- **Non-goals:** Tax-lot optimisation, margin balances, or performance promises.`,
    criteria: [
      'Portfolio totals reconcile to ledger cash and executed positions.',
      'Stale valuations are labelled and do not silently change the displayed total.',
    ],
  },
  alerts: {
    brief: `## Problem
Notification opt-ins often become engagement pressure, and duplicate execution events create noise.

## Solution
Use shared events for opt-in price and execution notifications with quiet hours and at-most-once delivery per event.

## Scope / Non-goals
- **In scope:** Informational price and execution alerts with explicit opt-out.
- **Non-goals:** Urgency prompts, promotional pushes, or social feeds.`,
    criteria: [
      'Opting out prevents future alerts; one execution event produces at most one notification.',
      'Quiet hours defer non-urgent alerts and preserve the chosen channel.',
    ],
  },
  statements: {
    brief: `## Problem
Customers cannot reconcile deposits, trades, fees, and ending balances from a readable record.

## Solution
Generate a monthly activity statement from the ledger and order history with a clear cut-off, trade lines, fees, and ending cash.

## Scope / Non-goals
- **In scope:** Cash-account monthly activity statements.
- **Non-goals:** Tax advice or consolidated brokerage documents.`,
    criteria: [
      'Statement closing cash equals the ledger balance for the same cut-off.',
      'Every trade line shows side, quantity, price, fees, and execution time.',
    ],
  },
  controls: {
    brief: `## Problem
Support and engineering lack one auditable timeline when money or orders go wrong, and stopping new orders can destroy evidence if handled carelessly.

## Solution
Provide a redacted journey timeline, an append-only audit trail, and an authorised trading kill switch that preserves all history.

## Scope / Non-goals
- **In scope:** Operational timeline, audit trail, and the trading kill switch.
- **Non-goals:** A customer-facing admin surface or silent data deletion.`,
    criteria: [
      'An authorised operator can halt new submissions while existing history stays readable.',
      'The actor, reason, and timestamp of every control action remain auditable.',
    ],
  },
  launch: {
    brief: `## Problem
Launch readiness depends on untested market-data outage, duplicate-execution, and cash-reconciliation failure paths.

## Solution
Run a public-launch rehearsal that exercises outage, retry, and cash-break scenarios, recording owners, evidence, and follow-ups before the fictional launch decision.

## Scope / Non-goals
- **In scope:** Synthetic outage, retry, and reconciliation drills.
- **Non-goals:** Real customer data or production trading.`,
    criteria: [
      'A synthetic outage recovers with no duplicate orders and no unexplained cash difference.',
      'The drill records owners, evidence, and follow-ups for every failed step.',
    ],
  },
};
const roster = ['Avery Chen · Identity & experience', 'Morgan Vale · Money systems', 'Riley Moss · Trading experience', 'Jordan Pike · Reliability & insights'].map((name, i) => ({ id: id(), name, weightUnits: i === 3 ? 75 : 100 }));
const assignments = {};
for (const [key, parent, title, effortPoints, phase, startDate, endDate, deliveryStatus, owner] of features) {
  const copy = featureCopy[key];
  const n = node(key, parent, title, 'Feature', `${copy.brief}

## Delivery notes
Owner: ${roster[owner].name}. ${effortPoints} illustrative points, not a delivery promise.`, { effortPoints, effortPointsDone: deliveryStatus === 'delivered' ? effortPoints : deliveryStatus === 'in_progress' ? 3 : 0, phaseId: phases[phase].id, startDate, endDate, scheduleSourceMode: 'start_end', deliveryStatus });
  assignments[n.id] = [roster[owner].id];
  node(`${key}-ac`, key, copy.criteria[0], 'AcceptanceCriterion', null, { completed: deliveryStatus === 'delivered' });
  node(`${key}-ac2`, key, copy.criteria[1], 'AcceptanceCriterion', null, { completed: deliveryStatus === 'delivered' });
  nodeCustomFields.push({ nodeId: n.id, fieldKey: 'demo-owner', fieldValue: roster[owner].name }, { nodeId: n.id, fieldKey: 'demo-measure', fieldValue: parent === 'onboarding' ? 'Verified -> funded within 7 days' : parent === 'discovery' ? 'Funded -> first order within 7 days' : parent === 'portfolio' ? 'Week-four retained funded accounts' : 'Shared capability: follow Unlocks to customer outcomes' });
}
for (const [from, to] of [['verify', 'signup'], ['verify', 'deposit'], ['verify', 'orders'], ['ledger', 'deposit'], ['ledger', 'risk'], ['ledger', 'orders'], ['ledger', 'holdings'], ['ledger', 'statements'], ['quotes', 'watchlist'], ['quotes', 'risk'], ['quotes', 'holdings'], ['signup', 'deposit'], ['deposit', 'firsttrade'], ['watchlist', 'firsttrade'], ['risk', 'firsttrade'], ['orders', 'firsttrade'], ['orders', 'holdings'], ['orders', 'statements'], ['events', 'alerts'], ['orders', 'alerts'], ['events', 'launch'], ['controls', 'orders'], ['firsttrade', 'launch'], ['holdings', 'launch'], ['statements', 'launch']]) unlockEdges.push({ id: id(), sourceNodeId: keys[from], targetNodeId: keys[to] });
for (const [key, questionText, decisionText] of [
  ['deposit', 'Should unsettled deposits be available for trading?', 'No. Launch uses settled cash only; prioritize reconciliation and clear expectations.'],
  ['quotes', 'Which stale-quote threshold is understandable in customer testing?', null],
  ['orders', 'How should a timed-out order confirmation explain an unknown outcome?', null],
  ['alerts', 'Should return-rate experiments include urgency prompts?', 'No. Use opt-in informational alerts; measure comprehension alongside retention.'],
  ['launch', 'Who signs off the recovery-drill evidence before public launch?', null],
]) openQuestions.push({ id: id(), nodeId: keys[key], questionText, status: decisionText ? 'DECIDED' : 'OPEN', decisionText, position: String((openQuestions.length + 1) * 1024), resolvedAtISO: decisionText ? exportedAt : null, createdAtISO: exportedAt });
const sprintPlan = {
  // Hand-placed launch runway: platform first, then onboarding, then the
  // discovery path. Blocked order routing deliberately stays in the Backlog.
  placements: [
    { itemId: keys.ledger, sprint: 1 },
    { itemId: keys.signup, sprint: 1 },
    { itemId: keys.quotes, sprint: 2 },
    { itemId: keys.deposit, sprint: 2 },
    { itemId: keys.watchlist, sprint: 3 },
    { itemId: keys.risk, sprint: 3 },
    { itemId: keys.controls, sprint: 3 },
  ],
  capacities: {},
};
const forecastPlan = { selectedFeatureIds: features.map(f => keys[f[0]]), parallelGroups: [{ featureIds: [keys.verify, keys.events] }, { featureIds: [keys.ledger, keys.quotes] }], blockedFeatureIds: [keys.orders], pointsPerSprint: 20, sprintLengthDays: 14, cadence: 'fixed-contiguous', startSprintOrdinal: 1, startDate: '2027-01-04', policyVersion: 'staffed-capacity-v1', planningLevel: 'Feature', roster, assignments, sprintPlan };
const envelope = { schemaVersion: 10, exportedAt, project, phases, nodes, nodeCustomFields, typeTemplateFields: [{ nodeType: 'Feature', fieldKey: 'demo-owner', fieldLabel: 'Demo owner', position: 1024 }, { nodeType: 'Feature', fieldKey: 'demo-measure', fieldLabel: 'Outcome measure', position: 2048 }], unlockEdges, findingDismissals: [], affectedReasons: [], openQuestions, forecastPlan, forecastScenarios: [] };
// Use the application's own fingerprint and schema contracts for historical scenarios.
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { forecastMaterialFacts } = await server.ssrLoadModule('/src/domain/forecast/whole-set.policy.ts');
  const { computeForecastFingerprintSync } = await server.ssrLoadModule('/src/domain/forecast/forecast-canonical.ts');
  const { validatePortableFileEnvelope } = await server.ssrLoadModule('/src/contracts/portable-file.schema.ts');
  const configuration = Object.fromEntries(['pointsPerSprint', 'sprintLengthDays', 'cadence', 'startSprintOrdinal', 'startDate'].map(k => [k, forecastPlan[k]]));
  const factMap = Object.fromEntries(features.map(([key]) => {
    const n = nodes.find(n => n.id === keys[key]);
    const ancestorIds = [];
    let parent = n.parentId;
    while (parent) { ancestorIds.push(parent); parent = nodes.find(n => n.id === parent).parentId; }
    return [n.id, { effortPoints: n.effortPoints, nodeType: n.nodeType, projectId: project.id, ancestorIds }];
  }));
  const baseline = { planningLevel: 'Feature', orderedScope: forecastPlan.selectedFeatureIds, configuration, parallelGroups: forecastPlan.parallelGroups, blockedFeatureIds: forecastPlan.blockedFeatureIds, factMap, roster, assignments };
  const baselineFingerprint = computeForecastFingerprintSync(forecastMaterialFacts({ ...forecastPlan, projectId: project.id, projectRevision: 1, estimates: Object.fromEntries(Object.entries(factMap).map(([id, f]) => [id, f.effortPoints])) }));
  for (const [label, patch] of [
    ['Smaller launch — defer alerts and monthly statements', { orderedScope: forecastPlan.selectedFeatureIds.filter(id => ![keys.alerts, keys.statements].includes(id)) }],
    ['More money-platform capacity — Morgan from 1.0 to 1.5', { weightOverrides: { [roster[1].id]: 150 } }],
  ]) envelope.forecastScenarios.push({ scenarioId: id(), label, baselineRevision: 1, baselineFingerprint, policyVersion: forecastPlan.policyVersion, createdAtISO: exportedAt, baseline, patch });
  const validated = validatePortableFileEnvelope(envelope);
  if (!validated.ok) throw new Error(JSON.stringify(validated.error));
} finally { await server.close(); }
mkdirSync(new URL('../public/demos/', import.meta.url), { recursive: true });
writeFileSync(new URL('../public/demos/lumen-trade.json', import.meta.url), JSON.stringify(envelope, null, 2) + '\n');
console.log(`Generated ${nodes.length} nodes, ${unlockEdges.length} dependencies, ${features.length} forecast items.`);
