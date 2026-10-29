import type sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { WasmPointer, sqlite3_io_methods, sqlite3_vfs } from '@sqlite.org/sqlite-wasm';

type Sqlite = Awaited<ReturnType<typeof sqlite3InitModule>>;

export type RecoverySafeVfs = Readonly<{
  name: string;
  dispose: () => void;
}>;

export class RecoveryLockState {
  #current: number;
  readonly #ok: number;
  readonly #reserved: number;

  constructor(input: { initial: number; ok: number; reserved: number }) {
    this.#current = input.initial;
    this.#ok = input.ok;
    this.#reserved = input.reserved;
  }

  get current(): number {
    return this.#current;
  }

  forwardLock(target: number, downstream: () => number): number {
    const result = downstream();
    if (result === this.#ok) this.#current = target;
    return result;
  }

  forwardUnlock(target: number, downstream: () => number): number {
    const result = downstream();
    if (result === this.#ok) this.#current = target;
    return result;
  }

  forwardCheckReservedLock(downstream: () => number, writeResult: (reserved: 0 | 1) => void): number {
    const result = downstream();
    if (result === this.#ok) writeResult(this.#current >= this.#reserved ? 1 : 0);
    return result;
  }
}

type FileState = Readonly<{
  methods: sqlite3_io_methods;
  lock: RecoveryLockState;
}>;

/**
 * Restores SQLite's reserved-lock query semantics for the pinned SAH-pool.
 *
 * PMApp acquires an exclusive Web Lock before installing/opening the pool and
 * owns one SQLite connection, so the current handle's successful SQLite lock
 * transitions are the complete writer truth for this VFS instance.
 */
export function installRecoverySafeVfs(input: {
  sqlite3: Sqlite;
  downstreamName: string;
  wrapperName: string;
}): RecoverySafeVfs {
  const { capi, wasm } = input.sqlite3;
  const downstreamPointer = capi.sqlite3_vfs_find(input.downstreamName);
  if (!downstreamPointer) throw new Error('RECOVERY_DOWNSTREAM_VFS_NOT_FOUND');

  const downstream = new capi.sqlite3_vfs(downstreamPointer);
  const wrapper = new capi.sqlite3_vfs();
  const io = new capi.sqlite3_io_methods();
  const fileStates = new Map<WasmPointer, FileState>();
  let ioVersion: number | null = null;

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

  const stateFor = (file: WasmPointer): FileState => {
    const state = fileStates.get(file);
    if (!state) throw new Error('RECOVERY_FILE_NOT_REGISTERED');
    return state;
  };

  const forwardIo = <T extends number | void>(
    file: WasmPointer,
    method: keyof sqlite3_io_methods,
    args: readonly unknown[],
  ): T => {
    const state = stateFor(file);
    const downstreamCallback = callback(state.methods, String(method));
    if (!downstreamCallback) throw new Error(`RECOVERY_DOWNSTREAM_METHOD_UNAVAILABLE:${String(method)}`);
    return downstreamCallback(file, ...args) as T;
  };

  const ioError = () => capi.SQLITE_IOERR;
  const ioMethods: Partial<Record<keyof sqlite3_io_methods, (...args: never[]) => unknown>> = {
    xClose: ((file: WasmPointer) => {
      try { return forwardIo<number>(file, 'xClose', []); }
      catch { return ioError(); }
      finally {
        fileStates.get(file)?.methods.dispose();
        fileStates.delete(file);
      }
    }) as never,
    xRead: ((file: WasmPointer, buffer: WasmPointer, amount: number, offset: number) => {
      try { return forwardIo<number>(file, 'xRead', [buffer, amount, offset]); } catch { return ioError(); }
    }) as never,
    xWrite: ((file: WasmPointer, buffer: WasmPointer, amount: number, offset: number) => {
      try { return forwardIo<number>(file, 'xWrite', [buffer, amount, offset]); } catch { return ioError(); }
    }) as never,
    xTruncate: ((file: WasmPointer, size: number) => {
      try { return forwardIo<number>(file, 'xTruncate', [size]); } catch { return ioError(); }
    }) as never,
    xSync: ((file: WasmPointer, flags: number) => {
      try { return forwardIo<number>(file, 'xSync', [flags]); } catch { return ioError(); }
    }) as never,
    xFileSize: ((file: WasmPointer, output: WasmPointer) => {
      try { return forwardIo<number>(file, 'xFileSize', [output]); } catch { return ioError(); }
    }) as never,
    xLock: ((file: WasmPointer, target: number) => {
      try {
        const state = stateFor(file);
        return state.lock.forwardLock(target, () => forwardIo<number>(file, 'xLock', [target]));
      } catch { return ioError(); }
    }) as never,
    xUnlock: ((file: WasmPointer, target: number) => {
      try {
        const state = stateFor(file);
        return state.lock.forwardUnlock(target, () => forwardIo<number>(file, 'xUnlock', [target]));
      } catch { return ioError(); }
    }) as never,
    xCheckReservedLock: ((file: WasmPointer, output: WasmPointer) => {
      try {
        const state = stateFor(file);
        return state.lock.forwardCheckReservedLock(
          () => forwardIo<number>(file, 'xCheckReservedLock', [output]),
          (reserved) => { wasm.poke32(output, reserved); },
        );
      } catch { return ioError(); }
    }) as never,
    xFileControl: ((file: WasmPointer, operation: number, argument: WasmPointer) => {
      try { return forwardIo<number>(file, 'xFileControl', [operation, argument]); } catch { return ioError(); }
    }) as never,
    xSectorSize: ((file: WasmPointer) => {
      try { return forwardIo<number>(file, 'xSectorSize', []); } catch { return 0; }
    }) as never,
    xDeviceCharacteristics: ((file: WasmPointer) => {
      try { return forwardIo<number>(file, 'xDeviceCharacteristics', []); } catch { return 0; }
    }) as never,
    xShmMap: ((file: WasmPointer, page: number, pageSize: number, extend: number, output: WasmPointer) => {
      try { return forwardIo<number>(file, 'xShmMap', [page, pageSize, extend, output]); } catch { return ioError(); }
    }) as never,
    xShmLock: ((file: WasmPointer, offset: number, count: number, flags: number) => {
      try { return forwardIo<number>(file, 'xShmLock', [offset, count, flags]); } catch { return ioError(); }
    }) as never,
    xShmBarrier: ((file: WasmPointer) => {
      try { return forwardIo<void>(file, 'xShmBarrier', []); } catch { return undefined; }
    }) as never,
    xShmUnmap: ((file: WasmPointer, deleteFlag: number) => {
      try { return forwardIo<number>(file, 'xShmUnmap', [deleteFlag]); } catch { return ioError(); }
    }) as never,
    xFetch: ((file: WasmPointer, offset: number, amount: number, output: WasmPointer) => {
      try { return forwardIo<number>(file, 'xFetch', [offset, amount, output]); } catch { return ioError(); }
    }) as never,
    xUnfetch: ((file: WasmPointer, offset: number, pointer: WasmPointer) => {
      try { return forwardIo<number>(file, 'xUnfetch', [offset, pointer]); } catch { return ioError(); }
    }) as never,
  };

  const callVfs = <T>(method: keyof sqlite3_vfs, args: readonly unknown[]): T => {
    const downstreamCallback = callback(downstream, String(method));
    if (!downstreamCallback) throw new Error(`RECOVERY_DOWNSTREAM_VFS_METHOD_UNAVAILABLE:${String(method)}`);
    return downstreamCallback(downstream.pointer, ...args) as T;
  };

  const vfsMethods: Partial<Record<keyof sqlite3_vfs, (...args: never[]) => unknown>> = {
    xOpen: ((_: WasmPointer, name: WasmPointer, file: WasmPointer, flags: number, outputFlags: WasmPointer) => {
      let openedMethods: sqlite3_io_methods | null = null;
      try {
        const result = callVfs<number>('xOpen', [name, file, flags, outputFlags]);
        if (result !== capi.SQLITE_OK) return result;
        const sqliteFile = new capi.sqlite3_file(file);
        try {
          const downstreamMethods = new capi.sqlite3_io_methods(sqliteFile.$pMethods);
          openedMethods = downstreamMethods;
          const downstreamVersion = (downstreamMethods as sqlite3_io_methods & { $iVersion: number }).$iVersion;
          if (ioVersion !== null && ioVersion !== downstreamVersion) {
            throw new Error('RECOVERY_IO_VERSION_MISMATCH');
          }
          ioVersion = downstreamVersion;
          (io as sqlite3_io_methods & { $iVersion: number }).$iVersion = downstreamVersion;
          fileStates.set(file, {
            methods: downstreamMethods,
            lock: new RecoveryLockState({
              initial: capi.SQLITE_LOCK_NONE,
              ok: capi.SQLITE_OK,
              reserved: capi.SQLITE_LOCK_RESERVED,
            }),
          });
          openedMethods = null;
          sqliteFile.$pMethods = io.pointer;
          return result;
        } finally {
          sqliteFile.dispose();
        }
      } catch {
        if (openedMethods) {
          const downstreamClose = callback(openedMethods, 'xClose');
          try { downstreamClose?.(file); } catch { /* opening already failed; preserve CANTOPEN */ }
          openedMethods.dispose();
        }
        fileStates.delete(file);
        return capi.SQLITE_CANTOPEN;
      }
    }) as never,
    xDelete: ((_: WasmPointer, name: WasmPointer, syncDir: number) => {
      try { return callVfs<number>('xDelete', [name, syncDir]); } catch { return ioError(); }
    }) as never,
    xAccess: ((_: WasmPointer, name: WasmPointer, flags: number, output: WasmPointer) => {
      try { return callVfs<number>('xAccess', [name, flags, output]); } catch { return ioError(); }
    }) as never,
    xFullPathname: ((_: WasmPointer, name: WasmPointer, outputSize: number, output: WasmPointer) => {
      try { return callVfs<number>('xFullPathname', [name, outputSize, output]); } catch { return capi.SQLITE_CANTOPEN; }
    }) as never,
    xDlOpen: ((_: WasmPointer, name: WasmPointer) => callVfs<WasmPointer>('xDlOpen', [name])) as never,
    xDlError: ((_: WasmPointer, size: number, output: WasmPointer) => callVfs<void>('xDlError', [size, output])) as never,
    xDlSym: ((_: WasmPointer, handle: WasmPointer, symbol: WasmPointer) => callVfs<WasmPointer>('xDlSym', [handle, symbol])) as never,
    xDlClose: ((_: WasmPointer, handle: WasmPointer) => callVfs<void>('xDlClose', [handle])) as never,
    xRandomness: ((_: WasmPointer, size: number, output: WasmPointer) => callVfs<number>('xRandomness', [size, output])) as never,
    xSleep: ((_: WasmPointer, microseconds: number) => callVfs<number>('xSleep', [microseconds])) as never,
    xCurrentTime: ((_: WasmPointer, output: WasmPointer) => callVfs<number>('xCurrentTime', [output])) as never,
    xGetLastError: ((_: WasmPointer, size: number, output: WasmPointer) => callVfs<void>('xGetLastError', [size, output])) as never,
    xCurrentTimeInt64: ((_: WasmPointer, output: WasmPointer) => callVfs<number>('xCurrentTimeInt64', [output])) as never,
    xSetSystemCall: ((_: WasmPointer, name: WasmPointer, call: WasmPointer) => callVfs<number>('xSetSystemCall', [name, call])) as never,
    xGetSystemCall: ((_: WasmPointer, name: WasmPointer, call: WasmPointer) => callVfs<WasmPointer>('xGetSystemCall', [name, call])) as never,
    xNextSystemCall: ((_: WasmPointer, name: WasmPointer) => callVfs<WasmPointer>('xNextSystemCall', [name])) as never,
  };

  const supportedVfsMethods = Object.fromEntries(
    Object.entries(vfsMethods).filter(([method]) => callback(downstream, method)),
  );
  input.sqlite3.vfs.installVfs({
    io: { struct: io, methods: ioMethods as never },
    vfs: { struct: wrapper, methods: supportedVfsMethods as never, name: input.wrapperName },
  });

  return Object.freeze({
    name: input.wrapperName,
    dispose() {
      capi.sqlite3_vfs_unregister(wrapper.pointer);
      for (const state of fileStates.values()) state.methods.dispose();
      fileStates.clear();
      wrapper.dispose();
      io.dispose();
    },
  });
}
