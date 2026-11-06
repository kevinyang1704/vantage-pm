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
node('vision', null, 'Make a first investment feel understandable, controlled, and trustworthy', 'Vision', '# Lumen Trade\nA fictional, cash-only stock trading app for first-time investors. All names, targets, dates, decisions, and progress are invented demo data.\n\n## Product thesis\nPeople make a confident first investment when identity, funding, market information, and order handling work as one journey. Shared ledger, identity, and event capabilities support multiple customer outcomes.\n\n## Success by 31 March 2027\n- Increase verified-to-funded conversion from a fictional 38% baseline to 60%.\n- Increase funded-to-first-order conversion from 25% to 45% within seven days.\n- Increase four-week retained funded accounts from 20% to 35%.\n\n## Guardrails\nNo duplicate orders; every cash movement reconciles; show stale quotes; explain risk before confirmation. No margin, options, crypto, or investment recommendations in launch scope.\n\n## Demo route\nExplore weighted Themes, platform dependencies, briefs, Questions, Criteria, Gantt, and Forecast. Change the ledger schedule to review downstream impact. Compare a smaller launch scope and added capacity as saved scenarios.');
const themes = [
 ['activation', 'Help 60% of verified customers fund their account', 40, 'Verified-to-funded conversion: 38% → 60% within seven days. Funnel events expose where customers abandon verification or deposits.'],
 ['confidence', 'Help 45% of funded customers place an informed first order', 35, 'Funded-to-first-order conversion: 25% → 45% within seven days. Guardrails: no duplicate executions and clear cash/risk disclosures.'],
 ['retention', 'Bring 35% of funded customers back in week four', 25, 'Four-week retained funded accounts: 20% → 35%. Track portfolio comprehension and repeat use, without rewarding excessive trading.'],
 ['platform', 'Build reusable trust and operating foundations', 0, 'Enabling investment rather than a separate customer conversion target. Identity, ledger, event contracts, and operations unlock work across the three customer outcomes. Trace those relationships through Unlocks.'],
];
for (const [key, title, strategicWeight, brief] of themes) node(key, 'vision', title, 'Theme', `## Intended outcome\n${brief}\n\n## Measurement\nSynthetic targets only. Review the fictional beta cohort weekly; segment by onboarding completion and funding state.`, { strategicWeight });
for (const [key, parent, title] of [
 ['onboarding', 'activation', 'Account opening and funding'], ['discovery', 'confidence', 'Understand and place a trade'], ['portfolio', 'retention', 'Portfolio understanding and habit'], ['identity', 'platform', 'Identity and entitlement platform'], ['money', 'platform', 'Money and order platform'], ['operations', 'platform', 'Events, reliability, and service operations'],
]) node(key, parent, title, 'Component', `## Capability\n${title} is a reusable delivery boundary. Features below carry estimates, acceptance evidence, ownership, and release phases.\n\n## Outcome connection\nFollow cross-branch Unlocks to see how this capability supports customer outcomes.`);

const features = [
 // key, parent, title, points, phase, start, end, status, owner index, brief, criterion
 ['verify','identity','Reusable identity verification and eligibility',8,0,'2027-01-04','2027-01-15','delivered',0,'A single verification state gates deposits and orders. Retried callbacks must not create duplicate accounts.','Duplicate verification callbacks produce one customer and one eligibility decision.'],
 ['events','operations','Versioned journey events and outcome dashboard',5,0,'2027-01-04','2027-01-15','delivered',3,'One event contract measures verification, deposit settlement, first order, and week-four return. Product teams reuse the same cohort definitions.','A synthetic customer journey appears once at every funnel stage with no personal data in analytics.'],
 ['ledger','money','Double-entry cash ledger and reconciliation',13,0,'2027-01-11','2027-01-29','in_progress',1,'Shared source of truth for deposits, buying power, trades, and portfolio cash. A delay here affects funding, ordering, and statements.','Every synthetic cash movement balances; replaying a deposit event does not change the balance twice.'],
 ['quotes','money','Market data gateway with freshness contracts',8,0,'2027-01-18','2027-01-29','in_progress',2,'Serve a shared quote API to discovery, order preview, and portfolio screens. Make stale data explicit rather than presenting it as live.','A quote older than the configured threshold is visibly marked stale in every consuming screen.'],
 ['signup','onboarding','Guided account opening with resumable verification',5,1,'2027-01-18','2027-01-29','in_progress',0,'Explain why information is needed and resume an interrupted application. Outcome: reduce verification abandonment.','A customer can resume verification after restarting without submitting identity data again.'],
 ['deposit','onboarding','Link a bank and track a first deposit',8,1,'2027-02-01','2027-02-12','not_started',1,'Show pending versus available cash and explain settlement. Outcome: move verified customers toward funded activation.','A pending deposit is visible but cannot be spent before the ledger marks it available.'],
 ['watchlist','discovery','Search stocks and build a first watchlist',5,1,'2027-02-01','2027-02-12','not_started',2,'Explain company basics, show fresh prices, and save a watchlist. Outcome: help customers understand what they might buy.','A saved watchlist survives a restart and stale prices carry the gateway freshness label.'],
 ['risk','discovery','Plain-language risk and cash-only order preview',5,1,'2027-02-15','2027-02-26','not_started',0,'Show estimated cost, available buying power, volatility notice, and market-hours behavior before confirmation.','An order exceeding available cash is rejected with an explanation before confirmation.'],
 ['orders','money','Idempotent order routing and execution state',13,1,'2027-02-15','2027-03-05','not_started',1,'Reuse buying-power checks and a durable order state machine. Handle retries and out-of-order execution events safely.','Repeated confirmation with the same idempotency key creates exactly one broker order.'],
 ['firsttrade','discovery','Place a first trade with a clear execution receipt',8,1,'2027-03-08','2027-03-12','not_started',2,'Connect discovery, risk preview, routing, and receipts. Outcome: informed first-order conversion rather than trading volume.','A customer can distinguish submitted, filled, and rejected orders and see final price and fees.'],
 ['holdings','portfolio','Explain holdings, cash, and daily value changes',8,2,'2027-03-08','2027-03-19','not_started',2,'Combine executed positions, ledger cash, and quotes with accessible explanations of unrealized movement.','Portfolio totals reconcile to ledger cash and executed positions; stale valuations are labelled.'],
 ['alerts','portfolio','Opt-in price and execution notifications',5,2,'2027-03-15','2027-03-26','not_started',3,'Use shared events for useful notifications with quiet hours and opt-out. Outcome: purposeful return visits without urgency or pressure.','Opting out prevents future alerts; an execution event produces at most one notification.'],
 ['statements','portfolio','Download a monthly activity statement',5,2,'2027-03-22','2027-03-31','not_started',1,'Reuse the ledger and order history for a readable record of deposits, trades, fees, and ending balances.','Statement closing cash equals the ledger balance for the same cut-off.'],
 ['controls','operations','Support timeline, audit trail, and trading kill switch',8,1,'2027-02-01','2027-02-12','not_started',3,'Provide a redacted journey timeline and an audited switch to stop new order submissions while preserving history.','An authorized operator can halt new submissions; the actor, reason, and timestamp remain auditable.'],
 ['launch','operations','Public-launch rehearsal and recovery drill',5,2,'2027-03-22','2027-03-31','not_started',3,'Exercise market-data outage, duplicate execution events, and cash reconciliation before the fictional launch decision.','A synthetic outage is recovered with no duplicate orders and no unexplained cash difference.'],
];
const roster = ['Avery Chen · Identity & experience','Morgan Vale · Money systems','Riley Moss · Trading experience','Jordan Pike · Reliability & insights'].map((name, i) => ({ id: id(), name, weightUnits: i === 3 ? 75 : 100 }));
const assignments = {};
for (const [key,parent,title,effortPoints,phase,startDate,endDate,deliveryStatus,owner,brief,criterion] of features) {
  const n = node(key,parent,title,'Feature',`## Customer / platform value\n${brief}\n\n## Scope\nCash-only stocks in a fictional sandbox. All service providers and test accounts are simulated.\n\n## Evidence and outcome\n${criterion}\nMeasure through the shared journey-event contract; validate correctness before interpreting conversion.\n\n## Delivery notes\nOwner: ${roster[owner].name}. Estimates are illustrative points, not delivery promises.`, { effortPoints, effortPointsDone: deliveryStatus === 'delivered' ? effortPoints : deliveryStatus === 'in_progress' ? 3 : 0, phaseId: phases[phase].id, startDate,endDate,scheduleSourceMode:'start_end',deliveryStatus });
  assignments[n.id] = [roster[owner].id];
  node(`${key}-ac`,key,criterion,'AcceptanceCriterion',null,{ completed:deliveryStatus === 'delivered' });
  node(`${key}-ac2`,key,'Keyboard and screen-reader checks pass; failure and retry paths are demonstrated','AcceptanceCriterion',null,{completed:deliveryStatus === 'delivered'});
  nodeCustomFields.push({nodeId:n.id,fieldKey:'demo-owner',fieldValue:roster[owner].name},{nodeId:n.id,fieldKey:'demo-measure',fieldValue: parent === 'onboarding' ? 'Verified → funded within 7 days' : parent === 'discovery' ? 'Funded → first order within 7 days' : parent === 'portfolio' ? 'Week-four retained funded accounts' : 'Shared capability: follow Unlocks to customer outcomes'});
}
for (const [from,to] of [['verify','signup'],['verify','deposit'],['verify','orders'],['ledger','deposit'],['ledger','risk'],['ledger','orders'],['ledger','holdings'],['ledger','statements'],['quotes','watchlist'],['quotes','risk'],['quotes','holdings'],['signup','deposit'],['deposit','firsttrade'],['watchlist','firsttrade'],['risk','firsttrade'],['orders','firsttrade'],['orders','holdings'],['orders','statements'],['events','alerts'],['orders','alerts'],['events','launch'],['controls','orders'],['firsttrade','launch'],['holdings','launch'],['statements','launch']]) unlockEdges.push({id:id(),sourceNodeId:keys[from],targetNodeId:keys[to]});
for (const [key,questionText,decisionText] of [
 ['deposit','Should unsettled deposits be available for trading?', 'No. Launch uses settled cash only; prioritize reconciliation and clear expectations.'],
 ['quotes','Which stale-quote threshold is understandable in customer testing?', null],
 ['orders','How should a timed-out order confirmation explain an unknown outcome?', null],
 ['alerts','Should return-rate experiments include urgency prompts?', 'No. Use opt-in informational alerts; measure comprehension alongside retention.'],
 ['launch','Who signs off the recovery-drill evidence before public launch?', null],
]) openQuestions.push({id:id(),nodeId:keys[key],questionText,status:decisionText?'DECIDED':'OPEN',decisionText,position:String((openQuestions.length+1)*1024),resolvedAtISO:decisionText?exportedAt:null,createdAtISO:exportedAt});
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
const forecastPlan = {selectedFeatureIds:features.map(f=>keys[f[0]]),parallelGroups:[{featureIds:[keys.verify,keys.events]},{featureIds:[keys.ledger,keys.quotes]}],blockedFeatureIds:[keys.orders],pointsPerSprint:20,sprintLengthDays:14,cadence:'fixed-contiguous',startSprintOrdinal:1,startDate:'2027-01-04',policyVersion:'staffed-capacity-v1',planningLevel:'Feature',roster,assignments,sprintPlan};
const envelope = {schemaVersion:10,exportedAt,project,phases,nodes,nodeCustomFields,typeTemplateFields:[{nodeType:'Feature',fieldKey:'demo-owner',fieldLabel:'Demo owner',position:1024},{nodeType:'Feature',fieldKey:'demo-measure',fieldLabel:'Outcome measure',position:2048}],unlockEdges,findingDismissals:[],affectedReasons:[],openQuestions,forecastPlan,forecastScenarios:[]};
// Use the application's own fingerprint and schema contracts for historical scenarios.
const server = await createServer({server:{middlewareMode:true},appType:'custom'});
try {
  const { forecastMaterialFacts } = await server.ssrLoadModule('/src/domain/forecast/whole-set.policy.ts');
  const { computeForecastFingerprintSync } = await server.ssrLoadModule('/src/domain/forecast/forecast-canonical.ts');
  const { validatePortableFileEnvelope } = await server.ssrLoadModule('/src/contracts/portable-file.schema.ts');
  const configuration = Object.fromEntries(['pointsPerSprint','sprintLengthDays','cadence','startSprintOrdinal','startDate'].map(k=>[k,forecastPlan[k]]));
  const factMap = Object.fromEntries(features.map(([key])=>{
    const n=nodes.find(n=>n.id===keys[key]);
    const ancestorIds=[];
    let parent=n.parentId;
    while(parent){ancestorIds.push(parent);parent=nodes.find(n=>n.id===parent).parentId;}
    return [n.id,{effortPoints:n.effortPoints,nodeType:n.nodeType,projectId:project.id,ancestorIds}];
  }));
  const baseline = {planningLevel:'Feature',orderedScope:forecastPlan.selectedFeatureIds,configuration,parallelGroups:forecastPlan.parallelGroups,blockedFeatureIds:forecastPlan.blockedFeatureIds,factMap,roster,assignments};
  const baselineFingerprint = computeForecastFingerprintSync(forecastMaterialFacts({...forecastPlan,projectId:project.id,projectRevision:1,estimates:Object.fromEntries(Object.entries(factMap).map(([id,f])=>[id,f.effortPoints]))}));
  for(const [label,patch] of [
    ['Smaller launch — defer alerts and monthly statements',{orderedScope:forecastPlan.selectedFeatureIds.filter(id=>![keys.alerts,keys.statements].includes(id))}],
    ['More money-platform capacity — Morgan from 1.0 to 1.5',{weightOverrides:{[roster[1].id]:150}}],
  ]) envelope.forecastScenarios.push({scenarioId:id(),label,baselineRevision:1,baselineFingerprint,policyVersion:forecastPlan.policyVersion,createdAtISO:exportedAt,baseline,patch});
  const validated=validatePortableFileEnvelope(envelope);
  if(!validated.ok) throw new Error(JSON.stringify(validated.error));
} finally { await server.close(); }
mkdirSync(new URL('../public/demos/',import.meta.url),{recursive:true});
writeFileSync(new URL('../public/demos/lumen-trade.json',import.meta.url),JSON.stringify(envelope,null,2)+'\n');
console.log(`Generated ${nodes.length} nodes, ${unlockEdges.length} dependencies, ${features.length} forecast items.`);
