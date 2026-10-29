import type { PortableProjectSnapshot } from './portable-file.schema';

export type MergeDecision = 'accept' | 'decline' | 'defer';
export type LocalCheckpoint = Readonly<{ hash: string; snapshot: PortableProjectSnapshot }>;
export type BranchLink = Readonly<{
  mapping: Readonly<Record<string, string>>;
  base: PortableProjectSnapshot;
  parentId: string | null;
}>;
export type LocalFileState = Readonly<{
  version: 1;
  lineageId: string;
  replicaId: string;
  checkpoints: readonly LocalCheckpoint[];
  decisions: Readonly<Record<string, 'accept' | 'decline'>>;
  branches: Readonly<Record<string, BranchLink>>;
  sources?: Readonly<Record<string, PortableProjectSnapshot>>;
  exportSequence?: number;
  sourceSequences?: Readonly<Record<string, number>>;
  sourceAnchors?: Readonly<Record<string, string>>;
  sourceSeenCheckpoints?: Readonly<Record<string, readonly string[]>>;
  declines?: Readonly<Record<string, string>>;
}>;
export type LocalShareBundle = Readonly<{
  format: 'vantage-local-share';
  version: 1;
  bundleId: string;
  lineageId: string;
  replicaId: string;
  snapshot: PortableProjectSnapshot;
  snapshotHash: string;
  exportSequence: number;
  checkpoints: readonly LocalCheckpoint[];
}>;
export type ParsedLocalFile = Readonly<{ snapshot: PortableProjectSnapshot; bundle?: LocalShareBundle; fileId?: string }>;
export type MergeChange = Readonly<{
  id: string;
  label: string;
  kind: 'add' | 'edit' | 'delete' | 'move';
  conflict: boolean;
  before: unknown;
  after: unknown;
  defaultDecision: MergeDecision;
  collection: string;
  entityId: string;
  fields: readonly string[];
  valueId?: string;
  groupId?: string;
}>;
export type MergeReview = Readonly<{
  local: PortableProjectSnapshot;
  state: LocalFileState;
  incoming: ParsedLocalFile;
  changes: readonly MergeChange[];
  mode: 'shared' | 'branch';
  proposed: PortableProjectSnapshot;
  base: PortableProjectSnapshot;
  branchKey?: string;
  branch?: BranchLink;
  stale?: boolean;
}>;
