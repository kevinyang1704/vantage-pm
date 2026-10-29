import type sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { WasmPointer, sqlite3_io_methods, sqlite3_vfs } from '@sqlite.org/sqlite-wasm';
import type { BoundaryCorrelation, QualificationTraceEvent } from './boundary-trace.test-only';
import type { FaultControl } from './fault-control.test-only';
import { correlatedBoundary } from './fault-control.test-only';

type Sqlite = Awaited<ReturnType<typeof sqlite3InitModule>>;
type FileRole = 'database' | 'journal' | 'other';
type FileState = { methods: sqlite3_io_methods; role: FileRole; path: string };

export type InterposingVfs = Readonly<{
  name: string;
  setCorrelation: (correlation: BoundaryCorrelation | null) => void;
  dispose: () => void;
}>;

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

export function installInterposingVfs(input: {
  sqlite3: Sqlite;
  downstreamName: string;
  wrapperName: string;
  faultControl: FaultControl;
  trace: (event: QualificationTraceEvent) => void;
}): InterposingVfs {
  const { sqlite3 } = input;
  const { capi, wasm } = sqlite3;
  const downstreamPointer = capi.sqlite3_vfs_find(input.downstreamName);
  if (!downstreamPointer) throw new Error('DOWNSTREAM_VFS_NOT_FOUND');
  const downstream = new capi.sqlite3_vfs(downstreamPointer);
  const wrapper = new capi.sqlite3_vfs();
  const io = new capi.sqlite3_io_methods();
  const fileStates = new Map<WasmPointer, FileState>();
  let correlation: BoundaryCorrelation | null = null;
  let detectedDatabasePath = '';
  let detectedJournalPath = '';
  let sequence = 0;
  let journalSyncReturned = false;
  let databaseSyncReturned = false;

  (wrapper as sqlite3_vfs & { $iVersion: number }).$iVersion = downstream.$iVersion;
  wrapper.$szOsFile = downstream.$szOsFile;
  wrapper.$mxPathname = downstream.$mxPathname;
  (io as sqlite3_io_methods & { $iVersion: number }).$iVersion = 1;

  const callback = (struct: object, method: string): ((...args: unknown[]) => unknown) | undefined => {
    const pointer = (struct as Record<string, unknown>)[`$${method}`];
    if (!pointer) return undefined;
    if (typeof pointer === 'function') return pointer as (...args: unknown[]) => unknown;
    return wasm.functionEntry(pointer as WasmPointer) as ((...args: unknown[]) => unknown) | undefined;
  };

  const roleForFlags = (flags: number): FileRole => {
    if ((flags & capi.SQLITE_OPEN_MAIN_DB) !== 0) return 'database';
    if ((flags & capi.SQLITE_OPEN_MAIN_JOURNAL) !== 0) return 'journal';
    return 'other';
  };
  const stateFor = (file: WasmPointer) => {
    const state = fileStates.get(file);
    if (!state) throw new Error('INTERPOSER_FILE_NOT_REGISTERED');
    return state;
  };
  const forward = <T extends number | void>(file: WasmPointer, method: keyof sqlite3_io_methods, args: readonly unknown[]): T => {
    const state = stateFor(file);
    const downstreamCallback = callback(state.methods, String(method));
    if (!downstreamCallback) throw new Error(`DOWNSTREAM_METHOD_UNAVAILABLE:${String(method)}`);
    const result = downstreamCallback(file, ...args) as T;
    input.trace({
      type: 'VfsCallbackForwarded',
      method: String(method),
      role: state.role,
      sequence: ++sequence,
      downstreamCalls: 1,
      argumentsEqual: true,
      productionReturnCode: result === undefined ? 'void' : result,
      instrumentedReturnCode: result === undefined ? 'void' : result,
    });
    return result;
  };
  const boundary = (id: Parameters<typeof correlatedBoundary>[0], details: Parameters<typeof correlatedBoundary>[3] = {}) => {
    if (!correlation) return;
    input.faultControl.publish(correlatedBoundary(id, ++sequence, correlation, details));
  };
  const ioError = () => capi.SQLITE_IOERR;

  const ioMethods: Partial<Record<keyof sqlite3_io_methods, (...args: never[]) => unknown>> = {
    xClose: ((file: WasmPointer) => {
      try { return forward<number>(file, 'xClose', []); }
      catch { return ioError(); }
      finally {
        fileStates.get(file)?.methods.dispose();
        fileStates.delete(file);
      }
    }) as never,
    xRead: ((file: WasmPointer, buffer: WasmPointer, amount: number, offset: number) => {
      try { return forward<number>(file, 'xRead', [buffer, amount, offset]); } catch { return ioError(); }
    }) as never,
    xWrite: ((file: WasmPointer, buffer: WasmPointer, amount: number, offset: number) => {
      try { return forward<number>(file, 'xWrite', [buffer, amount, offset]); } catch { return ioError(); }
    }) as never,
    xTruncate: ((file: WasmPointer, size: number) => {
      try { return forward<number>(file, 'xTruncate', [size]); } catch { return ioError(); }
    }) as never,
    xSync: ((file: WasmPointer, flags: number) => {
      try {
        const state = stateFor(file);
        if (state.role === 'journal') boundary('F1_BEFORE_JOURNAL_SYNC');
        if (state.role === 'database' && journalSyncReturned) boundary('F2_AFTER_JOURNAL_SYNC');
        const result = forward<number>(file, 'xSync', [flags]);
        if (result === capi.SQLITE_OK && state.role === 'journal') journalSyncReturned = true;
        if (result === capi.SQLITE_OK && state.role === 'database' && journalSyncReturned) databaseSyncReturned = true;
        return result;
      } catch { return ioError(); }
    }) as never,
    xFileSize: ((file: WasmPointer, output: WasmPointer) => {
      try { return forward<number>(file, 'xFileSize', [output]); } catch { return ioError(); }
    }) as never,
    xLock: ((file: WasmPointer, lockType: number) => {
      try { return forward<number>(file, 'xLock', [lockType]); } catch { return ioError(); }
    }) as never,
    xUnlock: ((file: WasmPointer, lockType: number) => {
      try { return forward<number>(file, 'xUnlock', [lockType]); } catch { return ioError(); }
    }) as never,
    xCheckReservedLock: ((file: WasmPointer, output: WasmPointer) => {
      try { return forward<number>(file, 'xCheckReservedLock', [output]); } catch { return ioError(); }
    }) as never,
    xFileControl: ((file: WasmPointer, operation: number, argument: WasmPointer) => {
      try { return forward<number>(file, 'xFileControl', [operation, argument]); } catch { return ioError(); }
    }) as never,
    xSectorSize: ((file: WasmPointer) => {
      try { return forward<number>(file, 'xSectorSize', []); } catch { return 0; }
    }) as never,
    xDeviceCharacteristics: ((file: WasmPointer) => {
      try { return forward<number>(file, 'xDeviceCharacteristics', []); } catch { return 0; }
    }) as never,
  };

  const callVfs = <T>(method: string, args: readonly unknown[]): T => {
    const downstreamCallback = callback(downstream, method);
    if (!downstreamCallback) throw new Error(`DOWNSTREAM_VFS_METHOD_UNAVAILABLE:${method}`);
    return downstreamCallback(downstream.pointer, ...args) as T;
  };

  const vfsMethods = {
    xOpen(wrapperPointer: WasmPointer, name: WasmPointer, file: WasmPointer, flags: number, outputFlags: WasmPointer) {
      try {
        void wrapperPointer;
        const result = callVfs<number>('xOpen', [name, file, flags, outputFlags]);
        if (result !== capi.SQLITE_OK) return result;
        const sqliteFile = new capi.sqlite3_file(file);
        const downstreamMethods = new capi.sqlite3_io_methods(sqliteFile.$pMethods);
        const path = name ? normalizePath(wasm.cstrToJs(name) ?? '') : '';
        const role = roleForFlags(flags);
        fileStates.set(file, { methods: downstreamMethods, role, path });
        if (role === 'database') detectedDatabasePath = path;
        if (role === 'journal') detectedJournalPath = path;
        if (correlation && role === 'database') correlation = { ...correlation, databasePath: path };
        if (correlation && role === 'journal') correlation = { ...correlation, rollbackJournalPath: path };
        sqliteFile.$pMethods = io.pointer;
        sqliteFile.dispose();
        return result;
      } catch { return capi.SQLITE_CANTOPEN; }
    },
    xDelete(wrapperPointer: WasmPointer, name: WasmPointer, syncDir: number) {
      try {
        void wrapperPointer;
        const path = normalizePath(wasm.cstrToJs(name) ?? '');
        if (correlation && databaseSyncReturned && path === correlation.rollbackJournalPath && syncDir === 1) {
          boundary('F3_BEFORE_JOURNAL_DELETE_FORWARD', {
            downstreamDatabaseSyncReturn: 'SQLITE_OK', nextCall: 'xDelete', doSyncDir: true,
          });
        }
        return callVfs<number>('xDelete', [name, syncDir]);
      } catch { return ioError(); }
    },
    xAccess: (_: WasmPointer, name: WasmPointer, flags: number, output: WasmPointer) => callVfs<number>('xAccess', [name, flags, output]),
    xFullPathname: (_: WasmPointer, name: WasmPointer, outputSize: number, output: WasmPointer) => callVfs<number>('xFullPathname', [name, outputSize, output]),
    xRandomness: (_: WasmPointer, size: number, output: WasmPointer) => callVfs<number>('xRandomness', [size, output]),
    xSleep: (_: WasmPointer, microseconds: number) => callVfs<number>('xSleep', [microseconds]),
    xCurrentTime: (_: WasmPointer, output: WasmPointer) => callVfs<number>('xCurrentTime', [output]),
    xGetLastError: (_: WasmPointer, size: number, output: WasmPointer) => callVfs<number>('xGetLastError', [size, output]),
    xCurrentTimeInt64: (_: WasmPointer, output: WasmPointer) => callVfs<number>('xCurrentTimeInt64', [output]),
  };
  const supportedVfsMethods = Object.fromEntries(
    Object.entries(vfsMethods).filter(([method]) => callback(downstream, method)),
  );
  sqlite3.vfs.installVfs({
    io: { struct: io, methods: ioMethods as never },
    vfs: { struct: wrapper, methods: supportedVfsMethods as never, name: input.wrapperName },
  });

  return {
    name: input.wrapperName,
    setCorrelation(next) {
      correlation = next ? {
        ...next,
        databasePath: detectedDatabasePath || next.databasePath,
        rollbackJournalPath: detectedJournalPath || next.rollbackJournalPath,
      } : null;
      journalSyncReturned = false;
      databaseSyncReturned = false;
    },
    dispose() {
      capi.sqlite3_vfs_unregister(wrapper.pointer);
      wrapper.dispose();
      io.dispose();
      downstream.dispose();
      fileStates.clear();
    },
  };
}
