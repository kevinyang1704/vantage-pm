import { createUuidV7, assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import { computeForecastFingerprintSync as rawHash } from '../../domain/forecast/forecast-canonical';
import { validateUnlockEdge } from '../../domain/edge/unlock-edge.policy';
import { canParentNodeType } from '../../domain/tree/node-hierarchy.policy';
import { validatePortableFileEnvelope, type PortableProjectSnapshot, type PortableFileEnvelopeV9, type PortableNode } from '../../contracts/portable-file.schema';
import type { BranchLink, LocalFileState, LocalShareBundle, ParsedLocalFile, MergeReview, MergeChange, MergeDecision } from '../../contracts/local-file-collaboration';
import { importProject, envelopeToSnapshot, remapPortableSnapshot } from './import-project';
export type { LocalFileState, LocalShareBundle, ParsedLocalFile, MergeReview, MergeChange, MergeDecision } from '../../contracts/local-file-collaboration';

const immutableHashes=new WeakMap<object,string>();
const hash = (value: unknown): string => {
  const immutable=value!==null&&typeof value==='object'&&Object.isFrozen(value);
  if(immutable) {const cached=immutableHashes.get(value);if(cached) return cached;}
  const digest=rawHash(JSON.parse(JSON.stringify(value??null)));
  if(immutable) immutableHashes.set(value,digest);
  return digest;
};
const snapshotHashes=new WeakMap<PortableProjectSnapshot,string>();
const LIMIT = 30 * 1024 * 1024;
const CHECKPOINT_LIMIT = 32;
// Exhaustive inventories force a policy decision whenever a new portable fact is introduced.
export const LOCAL_SNAPSHOT_POLICIES = {
  projectId:'identity',projectName:'destination',projectRevision:'local',phases:'merge',nodes:'merge',
  nodeCustomFields:'merge',typeTemplateFields:'merge',unlockEdges:'merge',findingDismissals:'recompute',
  affectedReasons:'recompute',openQuestions:'merge',forecastPlan:'group',forecastScenarios:'merge',
} as const satisfies Record<keyof PortableProjectSnapshot,string>;
const NODE_POLICIES = {
  id:'identity',parentId:'placement',position:'placement',title:'field',bodyText:'field',nodeType:'field',
  startDate:'schedule',endDate:'schedule',durationDays:'schedule',scheduleSourceMode:'schedule',
  completed:'status',deliveryStatus:'status',effortPoints:'effort',effortPointsDone:'effort',strategicWeight:'field',phaseId:'field',
} as const satisfies Record<keyof PortableNode,string>;
const FIELD_LABELS:Readonly<Record<string,string>>={title:'Title',bodyText:'Brief',nodeType:'Type',strategicWeight:'Strategic weight',phaseId:'Phase'};
const COLLECTION_LABELS:Readonly<Record<string,string>>={nodes:'Item',phases:'Phase',nodeCustomFields:'Custom field',typeTemplateFields:'Field template',unlockEdges:'Dependency',openQuestions:'Question or decision',forecastScenarios:'Forecast scenario'};
function fieldLabel(fields:readonly string[]):string {
  if(fields.includes('parentId')) return 'Placement';
  if(fields.includes('startDate')) return 'Schedule';
  if(fields.includes('completed')) return 'Delivery status';
  if(fields.includes('effortPoints')) return 'Effort and points done';
  return fields.map(f=>FIELD_LABELS[f]??'Details').join(', ');
}
const collections = ['nodes', 'phases', 'nodeCustomFields', 'typeTemplateFields', 'unlockEdges', 'openQuestions', 'forecastScenarios'] as const;
type Collection = typeof collections[number];
type Row = Record<string, unknown>;
const frozen = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) if (child && typeof child === 'object' && !Object.isFrozen(child)) frozen(child);
  }
  return value;
};
const same = (a: unknown, b: unknown): boolean => hash(a ?? null) === hash(b ?? null);
const uuid = (value: unknown): string => { if (typeof value !== 'string') throw new Error('Invalid collaboration identifier.'); assertUuidV7(value, 'collaboration identifier'); return value; };
function checkJsonDepth(raw:string):void {
  let depth=0;let quoted=false;let escaped=false;
  for(const character of raw) {
    if(quoted) { if(escaped) escaped=false;else if(character==='\\') escaped=true;else if(character==='"') quoted=false;continue; }
    if(character==='"') quoted=true;
    else if(character==='{'||character==='[') { if(++depth>64) throw new Error('The file exceeds the supported nesting depth of 64.'); }
    else if(character==='}'||character===']') depth--;
  }
}
function object(value: unknown): Row { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid collaboration object.'); return value as Row; }
export function snapshotEnvelope(snapshot: PortableProjectSnapshot): PortableFileEnvelopeV9 {
  const { projectId, projectName, projectRevision: _revision, ...content } = snapshot;
  return { schemaVersion: 9, exportedAt: '2026-01-01T00:00:00.000Z', project: { id: projectId, name: projectName }, ...content };
}
export function validateLocalSnapshot(value: unknown): PortableProjectSnapshot {
  const obj = object(value);
  const result = validatePortableFileEnvelope(snapshotEnvelope(obj as unknown as PortableProjectSnapshot));
  if (!result.ok) throw new Error(`Invalid project: ${result.error.type}`);
  const normalized = envelopeToSnapshot(result.value as PortableFileEnvelopeV9);
  const revision = obj.projectRevision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw new Error('Invalid project revision.');
  // Portable validation covers references/containment; also preserve typed hierarchy invariants.
  const nodes = new Map(normalized.nodes.map(n => [n.id, n]));
  for (const node of normalized.nodes) {
    const parent = node.parentId ? nodes.get(node.parentId) : null;
    if (parent && !canParentNodeType(parent.nodeType, node.nodeType)) throw new Error('Selected changes create an invalid typed hierarchy. Choose another parent or resolve the conflicting types.');
  }
  const acceptedEdges: {sourceNodeId:string;targetNodeId:string}[]=[];
  for(const edge of normalized.unlockEdges) {
    const checked=validateUnlockEdge(edge.sourceNodeId,edge.targetNodeId,acceptedEdges,new Set(nodes.keys()));
    if(!checked.ok) throw new Error(checked.error ?? 'Invalid unlock relationship.');
    acceptedEdges.push(edge);
  }
  return frozen({ ...normalized, projectRevision: revision as number });
}
export function localSnapshotHash(snapshot: PortableProjectSnapshot): string {
  if(Object.isFrozen(snapshot)) {const cached=snapshotHashes.get(snapshot);if(cached) return cached;}
  const envelope: Record<string,unknown> = {...snapshotEnvelope(snapshot)};
  for (const key of ['nodes','phases','nodeCustomFields','typeTemplateFields','unlockEdges','findingDismissals','affectedReasons','openQuestions','forecastScenarios']) {
    const list = envelope[key];
    envelope[key]=Array.isArray(list)?list.map(row=>({row,digest:hash(row)})).sort((a,b)=>a.digest.localeCompare(b.digest)).map(entry=>entry.row):[];
  }
  const digest=hash(envelope);if(Object.isFrozen(snapshot)) snapshotHashes.set(snapshot,digest);return digest;
}
// Acknowledged source baselines can temporarily contain dangling references after partial approval.
// They are comparison metadata only: final candidate validation is always strict.
function validateLocalBaseline(value:unknown):PortableProjectSnapshot {
  const row=object(value);
  const result=validatePortableFileEnvelope(snapshotEnvelope(row as unknown as PortableProjectSnapshot));
  if(!result.ok && !['InvalidRelation','CycleDetected','DuplicateSiblingPosition'].includes(result.error.type)) throw new Error(`Invalid source baseline: ${result.error.type}`);
  if(!Number.isSafeInteger(row.projectRevision)||(row.projectRevision as number)<1) throw new Error('Invalid source baseline revision.');
  return frozen(row as unknown as PortableProjectSnapshot);
}
function checkpoint(state: LocalFileState, snapshot: PortableProjectSnapshot): LocalFileState {
  const digest = localSnapshotHash(snapshot);
  if (state.checkpoints.some(c => c.hash === digest)) return state;
  if (state.checkpoints.length >= CHECKPOINT_LIMIT) throw new Error('This project has reached its 32 collaboration checkpoints. Existing ancestry is preserved; create an independent copy to start a new exchange.');
  return frozen({ ...state, checkpoints: [...state.checkpoints, { hash: digest, snapshot }] });
}
export function createLocalFileState(snapshot: PortableProjectSnapshot): LocalFileState {
  return checkpoint(frozen({ version: 1, lineageId: createUuidV7(), replicaId: createUuidV7(), checkpoints: [], decisions: {}, branches: {} }), validateLocalSnapshot(snapshot));
}
export function parseLocalFileState(raw: string, snapshot: PortableProjectSnapshot): LocalFileState {
  if (raw.length > LIMIT) throw new Error('Collaboration metadata exceeds the supported limit.');
  checkJsonDepth(raw);
  const obj = object(JSON.parse(raw));
  if (obj.version !== 1) throw new Error('Unsupported collaboration metadata version.');
  const lineageId = uuid(obj.lineageId); const replicaId = uuid(obj.replicaId);
  const checkpoints = parseCheckpoints(obj.checkpoints, snapshot.projectId);
  const decisions: Record<string, 'accept'|'decline'> = Object.create(null) as Record<string, 'accept'|'decline'>;
  for (const [key, value] of Object.entries(object(obj.decisions))) {
    if (!/^[a-f0-9]{64}$/.test(key) || (value !== 'accept' && value !== 'decline')) throw new Error('Invalid merge receipt.');
    decisions[key] = value;
  }
  const branches: Record<string, BranchLink> = Object.create(null) as Record<string, BranchLink>;
  for (const [key, value] of Object.entries(object(obj.branches))) {
    uuid(key); const b = object(value); const mapping: Record<string,string> = Object.create(null) as Record<string,string>;
    for (const [from,to] of Object.entries(object(b.mapping))) mapping[uuid(from)] = uuid(to);
    branches[key] = { mapping, base: validateLocalBaseline(b.base), parentId: b.parentId === null ? null : uuid(b.parentId) };
  }
  const sources:Record<string,PortableProjectSnapshot>={};
  for(const [key,value] of Object.entries(object(obj.sources ?? {}))) sources[uuid(key)]=validateLocalBaseline(value);
  const exportSequence=sequence(obj.exportSequence??0);
  const sourceSequences:Record<string,number>={};
  for(const [key,value] of Object.entries(object(obj.sourceSequences??{}))) sourceSequences[uuid(key)]=sequence(value);
  const sourceAnchors:Record<string,string>={};
  for(const [key,value] of Object.entries(object(obj.sourceAnchors??{}))) {if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid source checkpoint anchor.');sourceAnchors[uuid(key)]=value;}
  const sourceSeenCheckpoints:Record<string,readonly string[]>={};
  for(const [key,value] of Object.entries(object(obj.sourceSeenCheckpoints??{}))) {
    if(!Array.isArray(value)||value.length>CHECKPOINT_LIMIT||value.some(v=>typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))) throw new Error('Invalid observed source checkpoints.');
    sourceSeenCheckpoints[uuid(key)]=value as string[];
  }
  const declines:Record<string,string>={};
  for(const [key,value] of Object.entries(object(obj.declines??{}))) {if(!/^[a-f0-9]{64}$/.test(key)||typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid declined change index.');declines[key]=value;}
  return frozen({ version: 1, lineageId, replicaId, checkpoints, decisions, branches, sources, exportSequence,sourceSequences,sourceAnchors,sourceSeenCheckpoints,declines });
}
function sequence(value:unknown):number {if(!Number.isSafeInteger(value)||(value as number)<0) throw new Error('Invalid collaboration export sequence.');return value as number;}
function parseCheckpoints(value: unknown, projectId: string): readonly {hash:string;snapshot:PortableProjectSnapshot}[] {
  if (!Array.isArray(value) || value.length > CHECKPOINT_LIMIT || value.length === 0) throw new Error('Invalid collaboration checkpoints.');
  return value.map(raw => { const c = object(raw); const snapshot = validateLocalSnapshot(c.snapshot); const digest = localSnapshotHash(snapshot); if (c.hash !== digest || snapshot.projectId !== projectId) throw new Error('Collaboration checkpoint mismatch.'); return frozen({ hash: digest, snapshot }); });
}
export function createShareBundle(snapshot: PortableProjectSnapshot, state: LocalFileState): Readonly<{json:string;state:LocalFileState}> {
  const checked = validateLocalSnapshot(snapshot); const exportSequence=sequence((state.exportSequence??0)+1);const updated=frozen({...checkpoint(state,checked),exportSequence});
  const bundle: LocalShareBundle = { format: 'vantage-local-share', version: 1, bundleId: createUuidV7(), lineageId: state.lineageId, replicaId: state.replicaId, snapshot: checked, snapshotHash: localSnapshotHash(checked), exportSequence, checkpoints: updated.checkpoints };
  const json = JSON.stringify(bundle);
  if (new TextEncoder().encode(json).length > LIMIT) throw new Error('Collaboration file exceeds the 30 MB supported limit.');
  return frozen({ json, state: updated });
}
export function parseLocalFile(raw: string): ParsedLocalFile {
  if (new TextEncoder().encode(raw).length > LIMIT) throw new Error('This file exceeds the 30 MB collaboration limit.');
  checkJsonDepth(raw);
  const obj = object(JSON.parse(raw));
  if (obj.format !== 'vantage-local-share') {
    const imported = importProject(raw, () => false);
    if (!imported.ok) throw new Error(`Import rejected: ${imported.error.type}`);
    return frozen({ snapshot: validateLocalSnapshot(imported.candidate),fileId:hash(raw) });
  }
  if (obj.version !== 1) throw new Error('This collaboration file requires a newer Vantage version.');
  const allowed = ['format','version','bundleId','lineageId','replicaId','snapshot','snapshotHash','checkpoints','exportSequence'];
  if (Object.keys(obj).some(k => !allowed.includes(k))) throw new Error('Unknown collaboration file fields.');
  const snapshot = validateLocalSnapshot(obj.snapshot);
  if (obj.snapshotHash !== localSnapshotHash(snapshot)) throw new Error('The collaboration file contents do not match their checksum.');
  const bundle: LocalShareBundle = { format: 'vantage-local-share', version: 1, bundleId: uuid(obj.bundleId), lineageId: uuid(obj.lineageId), replicaId: uuid(obj.replicaId), snapshot, snapshotHash: localSnapshotHash(snapshot),exportSequence:sequence(obj.exportSequence), checkpoints: parseCheckpoints(obj.checkpoints, snapshot.projectId) };
  return frozen({ snapshot, bundle,fileId:bundle.bundleId });
}
export function joinSharedProject(file: ParsedLocalFile): Readonly<{snapshot:PortableProjectSnapshot;state:LocalFileState}> {
  if (!file.bundle) throw new Error('This is a backup, not a shared editing file.');
  const snapshot = frozen({ ...file.snapshot, projectRevision: 1 });
  return frozen({ snapshot, state: { version:1, lineageId:file.bundle.lineageId, replicaId:createUuidV7(), checkpoints:file.bundle.checkpoints, decisions:{}, branches:{},sources:{[file.bundle.replicaId]:snapshot},sourceSequences:{[file.bundle.replicaId]:file.bundle.exportSequence},sourceAnchors:{[file.bundle.replicaId]:localSnapshotHash(snapshot)},sourceSeenCheckpoints:{[file.bundle.replicaId]:file.bundle.checkpoints.map(c=>c.hash)} } });
}
function rows(snapshot: PortableProjectSnapshot, collection: Collection): readonly Row[] { return (snapshot[collection] ?? []) as unknown as readonly Row[]; }
function entityKey(row: Row, collection: Collection): string {
  if (collection === 'nodeCustomFields') return `${String(row.nodeId)}:${String(row.fieldKey)}`;
  if (collection === 'typeTemplateFields') return `${String(row.nodeType)}:${String(row.fieldKey)}`;
  return String(row.id ?? row.scenarioId);
}
function groups(collection: Collection, row: Row): readonly (readonly string[])[] {
  if (collection !== 'nodes') return [Object.keys(row).sort()];
  const grouped = [['parentId','position'],['startDate','endDate','durationDays','scheduleSourceMode'],['completed','deliveryStatus'],['effortPoints','effortPointsDone']];
  const taken = new Set(grouped.flat());
  return [...grouped, ...Object.keys(NODE_POLICIES).filter(k => k !== 'id' && !taken.has(k)).sort().map(k => [k])];
}
function values(row: Row | undefined, fields: readonly string[]): unknown { return row ? Object.fromEntries(fields.map(f => [f,row[f] ?? null])) : null; }
function empty(snapshot: PortableProjectSnapshot): PortableProjectSnapshot { return { ...snapshot, nodes:[],phases:[],nodeCustomFields:[],typeTemplateFields:[],unlockEdges:[],openQuestions:[],findingDismissals:[],affectedReasons:[],forecastScenarios:[],forecastPlan:undefined }; }
function mappedUuid(seed: string): string { const h=hash(seed); return `${h.slice(0,8)}-${h.slice(8,12)}-7${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`; }
function branchSnapshot(local: PortableProjectSnapshot, state: LocalFileState, file: ParsedLocalFile, parentId: string|null): { snapshot:PortableProjectSnapshot; branch:BranchLink; key:string; first:boolean } {
  const key = file.bundle?.lineageId ?? file.snapshot.projectId;
  const old = state.branches[key];
  const mapping: Record<string,string> = { ...old?.mapping };
  const remapped = remapPortableSnapshot(file.snapshot, id => {
    if (!id) throw new Error('Missing source identity.');
    if(id===file.snapshot.projectId) return local.projectId;
    return mapping[id] ?? (mapping[id] = mappedUuid(`${state.lineageId}:${key}:${id}`));
  });
  const placement = old?.parentId ?? parentId;
  if (placement !== null && !local.nodes.some(n=> n.id === placement)) throw new Error('Choose an existing destination parent.');
  const sourceRoots = remapped.nodes.filter(n=>n.parentId === null).sort((a,b)=>BigInt(a.position)<BigInt(b.position)?-1:1);
  const existingMax = local.nodes.filter(n=>n.parentId === placement && !sourceRoots.some(r=>r.id===n.id)).reduce((m,n)=>BigInt(n.position)>m?BigInt(n.position):m,0n);
  const previousSlots=old?.base.nodes.filter(n=>n.parentId===null).map(n=>n.position).sort((a,b)=>BigInt(a)<BigInt(b)?-1:1) ?? [];
  const appendStart=previousSlots.reduce((max,p)=>BigInt(p)>max?BigInt(p):max,existingMax);
  const roots = new Map(sourceRoots.map((n,i)=>[n.id, previousSlots[i] ?? (appendStart+BigInt(i-previousSlots.length+1)*4294967296n).toString()]));
  const snapshot = frozen({ ...remapped, projectId:local.projectId, projectName:local.projectName, projectRevision:local.projectRevision, nodes:remapped.nodes.map(n=>roots.has(n.id)?{...n,parentId:placement,position:roots.get(n.id)!}:n), findingDismissals:[],affectedReasons:[],forecastPlan:remapped.forecastPlan });
  return { snapshot, key, first:!old, branch: { mapping, base:old?.base ?? empty(snapshot),parentId:placement } };
}
export function prepareLocalMerge(local: PortableProjectSnapshot, state: LocalFileState, incoming: ParsedLocalFile, targetParentId: string|null = null, includeDeclined = false, forceBranch = false): MergeReview {
  local=validateLocalSnapshot(local);
  let base: PortableProjectSnapshot; let proposed:PortableProjectSnapshot; let mode:'shared'|'branch'; let branch:BranchLink|undefined; let branchKey:string|undefined;
  const bundle = incoming.bundle;
  if (!forceBranch && bundle && bundle.lineageId === state.lineageId && bundle.snapshot.projectId === local.projectId) {
    const hashes = new Set(bundle.checkpoints.map(c=>c.hash));
    const common = [...state.checkpoints].reverse().find(c=>hashes.has(c.hash));
    if (!common) throw new Error('No recorded common ancestor is available. Import as a new branch or independent project.');
    const acknowledged=state.sources?.[bundle.replicaId];
    const seen=new Set(state.sourceSeenCheckpoints?.[bundle.replicaId]??bundle.checkpoints.map(c=>c.hash));
    // Content hashes are identities, not chronological positions. A previously known
    // source checkpoint cannot supersede a later per-field acknowledgement on replay.
    const newlyShared=[...state.checkpoints].reverse().find(c=>hashes.has(c.hash)&&!seen.has(c.hash)&&c.hash!==bundle.snapshotHash);
    base=acknowledged ? newlyShared?.snapshot??acknowledged : common.snapshot;
    proposed=incoming.snapshot; mode='shared';
  } else {
    const mapped=branchSnapshot(local,state,incoming,targetParentId); branch=mapped.branch;branchKey=mapped.key; proposed=mapped.snapshot;mode='branch';base=mapped.first?empty(local):{...branch.base,nodes:branch.base.nodes.map(n=>n.parentId===null?{...n,parentId:branch!.parentId}:n)};
  }
  if(!forceBranch && bundle && bundle.exportSequence<(state.sourceSequences?.[bundle.replicaId]??0)) return frozen({local,state,incoming,changes:[],mode,proposed,base,stale:true,...(branch?{branch,branchKey}:{})});
  const changes:MergeChange[]=[];
  const source = mode === 'shared' ? state.lineageId : branchKey!;
  const add = (collection:string,id:string,fields:readonly string[], before:unknown,after:unknown,conflict:boolean,kind:MergeChange['kind'],label:string,origin:unknown,initialDecision?:MergeDecision):void => {
    const identity={source,replica:incoming.bundle?.replicaId ?? source,collection,id,fields,after};
    const valueId=hash({...identity,origin});
    const groupId=hash({source,replica:identity.replica,collection,id,fields});
    const fileId=incoming.fileId??incoming.bundle?.bundleId??localSnapshotHash(incoming.snapshot);
    const changeId=hash({...identity,fileId});
    // Explicit decisions survive later local edits and replay. Deferred changes have no receipt.
    if (state.decisions[changeId] === 'accept' || state.decisions[valueId] === 'decline' && !includeDeclined) return;
    changes.push(frozen({id:changeId,valueId,groupId,collection,entityId:id,fields,before,after,conflict,kind,label,defaultDecision:state.decisions[valueId] === 'decline' ? 'decline' : initialDecision ?? (conflict?'defer':'accept')}));
  };
  for (const collection of collections) {
    const b=new Map(rows(base,collection).map(r=>[entityKey(r,collection),r]));
    const l=new Map(rows(local,collection).map(r=>[entityKey(r,collection),r]));
    const r=new Map(rows(proposed,collection).map(row=>[entityKey(row,collection),row]));
    const ids=new Set([...b.keys(),...r.keys()]);
    for(const id of [...ids].sort()) {
      const old=b.get(id),mine=l.get(id),theirs=r.get(id);
      const label=String(theirs?.title ?? mine?.title ?? theirs?.name ?? mine?.name ?? theirs?.questionText ?? mine?.questionText ?? id);
      if(same(mine,theirs)) continue;
      if (!old || !mine || !theirs) {
        if(same(old,theirs) && !(mode==='branch' && !mine && theirs)) continue;
        let conflict=!!old && (!mine || !same(old,mine)) || !old && !!mine;
        if(collection==='nodes' && old && !theirs) {
          const connected=(snap:PortableProjectSnapshot):unknown=>({children:snap.nodes.filter(n=>n.parentId===id),questions:snap.openQuestions.filter(q=>q.nodeId===id),fields:snap.nodeCustomFields.filter(f=>f.nodeId===id),edges:snap.unlockEdges.filter(e=>e.sourceNodeId===id||e.targetNodeId===id)});
          if(!same(connected(base),connected(local))) conflict=true;
        }
        add(collection,id,[],mine??null,theirs??null,conflict,theirs?'add':'delete',`${COLLECTION_LABELS[collection]}: ${label}`,old??null);
      } else {
        for(const fields of groups(collection,theirs)) {
          const bv=values(old,fields),lv=values(mine,fields),rv=values(theirs,fields);
          if(same(bv,rv)||same(lv,rv)) continue;
          add(collection,id,fields,lv,rv,!same(bv,lv),fields.includes('parentId')?'move':'edit',`${label} · ${fieldLabel(fields)}`,bv);
        }
      }
    }
  }
  if(mode==='shared' && !same(base.forecastPlan,proposed.forecastPlan) && !same(local.forecastPlan,proposed.forecastPlan)) add('forecastPlan','forecastPlan',[],local.forecastPlan??null,proposed.forecastPlan??null,!same(local.forecastPlan,base.forecastPlan),'edit','Forecast configuration, scope, people and assignments',base.forecastPlan??null);
  if(mode==='branch' && !same(base.forecastPlan,proposed.forecastPlan) && !same(local.forecastPlan,proposed.forecastPlan)) add('forecastPlan','forecastPlan',[],local.forecastPlan??null,proposed.forecastPlan??null,false,'edit','Optional: replace the destination forecast configuration, scope, people and assignments',base.forecastPlan??null,'decline');
  return frozen({local,state,incoming,changes,mode,proposed,base,...(branch?{branch,branchKey}:{})});
}
export function resolveLocalMerge(review:MergeReview,choices:Readonly<Record<string,MergeDecision>>): Readonly<{snapshot:PortableProjectSnapshot;state:LocalFileState;error?:string}> {
  try {
    const {local,state}=review;
    if(review.stale) return frozen({snapshot:local,state});
    const candidate:Row={...local}; const decisions={...state.decisions};const declines={...state.declines};
    const clearDecline=(groupId:string|undefined):void=>{if(groupId&&declines[groupId]) {delete decisions[declines[groupId]];delete declines[groupId];}};
    const source=review.mode==='shared'?state.lineageId:review.branchKey!;
    const groupKey=(collection:string,id:string,fields:readonly string[]):string=>hash({source,replica:review.incoming.bundle?.replicaId??source,collection,id,fields});
    for(const collection of collections) candidate[collection]=rows(local,collection).map(r=>({...r}));
    for(const change of review.changes) {
      const choice=choices[change.id]??change.defaultDecision;
      if(choice==='defer') { if(change.conflict && !Object.hasOwn(choices,change.id)) throw new Error('Resolve each conflict with Keep mine, Use incoming, or explicitly defer it.'); continue; }
      if(choice==='decline') {clearDecline(change.groupId);decisions[change.valueId??change.id]='decline';if(change.groupId) declines[change.groupId]=change.valueId??change.id;continue;}
      clearDecline(change.groupId);
      decisions[change.id]='accept';
      if(change.valueId) delete decisions[change.valueId];
      // An accepted whole entity also acknowledges its field groups, so replay cannot
      // reinterpret the same old addition as fresh edits after later exchanges.
      if(change.fields.length===0 && change.after!==null && change.collection!=='forecastPlan') {
        const after=object(change.after);const source=review.mode==='shared'?state.lineageId:review.branchKey!;
        const fileId=review.incoming.fileId??review.incoming.bundle?.bundleId??localSnapshotHash(review.incoming.snapshot);
        for(const fields of groups(change.collection as Collection,after)) decisions[hash({source,replica:review.incoming.bundle?.replicaId??source,collection:change.collection,id:change.entityId,fields,after:values(after,fields),fileId})]='accept';
      }
      if(change.collection==='forecastPlan') { candidate.forecastPlan=change.after??undefined; continue; }
      const list=candidate[change.collection] as Row[];
      const index=list.findIndex(r=>entityKey(r,change.collection as Collection)===change.entityId);
      if(change.fields.length===0) {
        if(index>=0) list.splice(index,1);
        if(change.after!==null) list.push({...object(change.after)});
      } else {
        if(index<0) throw new Error('A selected edit depends on an item that is not included.');
        list[index]={...list[index],...object(change.after)};
      }
    }
    // Preserve only still-valid destination review state; incoming findings are never copied.
    const ids=new Set((candidate.nodes as Row[]).map(n=>String(n.id)));
    candidate.affectedReasons=local.affectedReasons.filter(r=>ids.has(r.affectedNodeId)&&ids.has(r.causalNodeId));
    candidate.findingDismissals=local.findingDismissals.filter(d=>ids.has(d.targetId));
    const snapshot=validateLocalSnapshot(candidate);
    let next:LocalFileState={...state,decisions,declines,branches:review.branch&&review.branchKey?{...state.branches,[review.branchKey]:review.branch}:state.branches};
    if (review.branch && review.branchKey || review.mode === 'shared' && review.incoming.bundle) {
      const sourceBase:Row={...review.base};
      for(const collection of collections) {
        const baseline=new Map(rows(review.base,collection).map(r=>[entityKey(r,collection),{...r}]));
        const incoming=new Map(rows(review.proposed,collection).map(r=>[entityKey(r,collection),r]));
        const finalRows=new Map(rows(snapshot,collection).map(r=>[entityKey(r,collection),r]));
        for(const id of new Set([...baseline.keys(),...incoming.keys()])) {
          const theirs=incoming.get(id),current=finalRows.get(id),old=baseline.get(id);
          if(same(current,theirs)) {
            clearDecline(groupKey(collection,id,[]));
            if(theirs) {baseline.set(id,{...theirs});for(const fields of groups(collection,theirs)) clearDecline(groupKey(collection,id,fields));}
            else baseline.delete(id);continue;
          }
          if(theirs && current && old) {
            for(const fields of groups(collection,theirs)) if(same(values(current,fields),values(theirs,fields))) {Object.assign(old,object(values(theirs,fields)));clearDecline(groupKey(collection,id,fields));}
          }
        }
        sourceBase[collection]=[...baseline.values()];
      }
      if(same(snapshot.forecastPlan,review.proposed.forecastPlan)) {sourceBase.forecastPlan=review.proposed.forecastPlan;clearDecline(groupKey('forecastPlan','forecastPlan',[]));}
      const sourceNodes=sourceBase.nodes as Row[];
      const ownIds=new Set(sourceNodes.map(n=>String(n.id)));
      if(review.branch) sourceBase.nodes=sourceNodes.map(n=>n.parentId!==null&&!ownIds.has(String(n.parentId))?{...n,parentId:null}:n);
      const acknowledgedBase=validateLocalBaseline(sourceBase);
      if(review.branch && review.branchKey) next=frozen({...next,branches:{...next.branches,[review.branchKey]:{...review.branch,base:acknowledgedBase}}});
      else if(review.incoming.bundle) next=frozen({...next,sources:{...next.sources,[review.incoming.bundle.replicaId]:acknowledgedBase},sourceAnchors:{...next.sourceAnchors,[review.incoming.bundle.replicaId]:localSnapshotHash(snapshot)},sourceSeenCheckpoints:{...next.sourceSeenCheckpoints,[review.incoming.bundle.replicaId]:review.incoming.bundle.checkpoints.map(c=>c.hash)}});
    }
    if(review.incoming.bundle) next=frozen({...next,sourceSequences:{...next.sourceSequences,[review.incoming.bundle.replicaId]:Math.max(next.sourceSequences?.[review.incoming.bundle.replicaId]??0,review.incoming.bundle.exportSequence)}});
    next=checkpoint(next,snapshot);
    return frozen({snapshot,state:next});
  } catch(error) { return frozen({snapshot:review.local,state:review.state,error:error instanceof Error?error.message:'The selected changes are invalid.'}); }
}
