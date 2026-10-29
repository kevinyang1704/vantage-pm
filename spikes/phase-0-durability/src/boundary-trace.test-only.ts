export type FaultBoundary =
  | 'F1_BEFORE_JOURNAL_SYNC'
  | 'F2_AFTER_JOURNAL_SYNC'
  | 'F3_BEFORE_JOURNAL_DELETE_FORWARD'
  | 'F4_AFTER_COMMIT_RETURN'
  | 'F5_AFTER_REPOSITORY_RESULT'
  | 'F6_AFTER_CANDIDATE_BOUNDARY_OBSERVED';

export type BoundaryCorrelation = Readonly<{
  runId: string;
  connectionId: string;
  databasePath: string;
  rollbackJournalPath: string;
  commandId: string;
  commitAttemptId: string;
}>;

export type BoundaryEvent = BoundaryCorrelation & Readonly<{
  type: 'BoundaryObserved';
  boundaryId: FaultBoundary;
  sequence: number;
  forwardedBeforeTermination: false;
  physicalDirectorySync: 'Unobservable';
  downstreamDatabaseSyncReturn?: 'SQLITE_OK';
  nextCall?: 'xDelete';
  doSyncDir?: true;
}>;

export type ForwardingEvent = Readonly<{
  type: 'VfsCallbackForwarded';
  method: string;
  role: 'database' | 'journal' | 'other';
  sequence: number;
  downstreamCalls: 1;
  argumentsEqual: true;
  productionReturnCode: number | 'void';
  instrumentedReturnCode: number | 'void';
}>;

export type QualificationTraceEvent = BoundaryEvent | ForwardingEvent;

export function createBoundaryTraceSink(post: (event: QualificationTraceEvent) => void) {
  const retained: QualificationTraceEvent[] = [];
  return {
    record(event: QualificationTraceEvent) {
      retained.push(structuredClone(event));
      post(event);
    },
    retained: () => structuredClone(retained),
  };
}
