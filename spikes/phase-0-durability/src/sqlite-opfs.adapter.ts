import sqlite3InitModule, { type Database, type SAHPoolUtil } from '@sqlite.org/sqlite-wasm';
import { installRecoverySafeVfs, type RecoverySafeVfs } from './recovery-safe-vfs';
import { SqliteRepositoryLedger, type LedgerInspection, type StartupRecovery } from './repository-ledger';
import { inspectRestart } from './restart-inspector';
import type { ApplyCommandRequest, RepositoryResponse } from './repository-protocol';

const RUN_NAMESPACE = /^\/pmapp-phase0\/run-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Sqlite = Awaited<ReturnType<typeof sqlite3InitModule>>;

export type EffectiveConfiguration = Readonly<{
  sqliteVersion: string;
  sqliteSourceId: string;
  vfs: string;
  recoveryVfs: string;
  wrappedVfs: string | null;
  journalMode: 'delete';
  synchronous: 3;
  foreignKeys: 1;
  quickCheck: 'ok';
  databasePath: string;
}>;

export type AdapterInstrumentation = Readonly<{
  install: (sqlite3: Sqlite, downstreamName: string) => Readonly<{
    name: string;
    setCorrelation?: (correlation: unknown) => void;
    dispose: () => void;
  }>;
}>;

export class SqliteOpfsAdapter {
  #db: Database | null = null;
  #pool: SAHPoolUtil | null = null;
  #ledger: SqliteRepositoryLedger | null = null;
  #recovery: RecoverySafeVfs | null = null;
  #instrumentation: ReturnType<AdapterInstrumentation['install']> | null = null;
  #configuration: EffectiveConfiguration | null = null;
  #fixture: { initialRevision: number; safeStateHash: string } | null = null;

  async open(input: {
    namespace: string;
    projectId: string;
    initialRevision: number;
    safeStateHash: string;
    instrumentation?: AdapterInstrumentation;
    lifecycle?: Readonly<{ sahAcquired: () => void; sqliteOpened: () => void }>;
  }): Promise<EffectiveConfiguration> {
    if (!RUN_NAMESPACE.test(input.namespace)) throw new Error('INVALID_RUN_NAMESPACE');
    if (this.#db) throw new Error('DATABASE_ALREADY_OPEN');
    const sqlite3 = await sqlite3InitModule();
    const suffix = input.namespace.slice(-12).replaceAll('-', '');
    const downstreamName = `pmapp-sah-${suffix}`;
    this.#pool = await sqlite3.installOpfsSAHPoolVfs({
      name: downstreamName,
      directory: input.namespace,
      initialCapacity: 8,
      clearOnInit: false,
    });
    input.lifecycle?.sahAcquired();
    const databasePath = `${input.namespace}/repository.sqlite3`;
    const existingDatabase = this.#pool.getFileNames().includes(databasePath);
    const recoveryName = `pmapp-recovery-${suffix}`;
    this.#recovery = installRecoverySafeVfs({
      sqlite3,
      downstreamName,
      wrapperName: recoveryName,
    });
    this.#instrumentation = input.instrumentation?.install(sqlite3, recoveryName) ?? null;
    const selectedVfs = this.#instrumentation?.name ?? recoveryName;
    this.#db = new sqlite3.oo1.DB(databasePath, 'c', selectedVfs);
    input.lifecycle?.sqliteOpened();
    this.#db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON;');
    this.#ledger = new SqliteRepositoryLedger(this.#db);
    this.#fixture = { initialRevision: input.initialRevision, safeStateHash: input.safeStateHash };
    this.#ledger.initializeFixture(input.projectId, input.initialRevision, input.safeStateHash, existingDatabase);
    const scalar = (sql: string) => this.#db!.exec({ sql, rowMode: 'array', returnValue: 'resultRows' })[0]?.[0];
    const configuration = {
      sqliteVersion: sqlite3.version.libVersion,
      sqliteSourceId: sqlite3.version.sourceId,
      vfs: downstreamName,
      recoveryVfs: recoveryName,
      wrappedVfs: this.#instrumentation?.name ?? null,
      journalMode: String(scalar('PRAGMA journal_mode')).toLowerCase(),
      synchronous: Number(scalar('PRAGMA synchronous')),
      foreignKeys: Number(scalar('PRAGMA foreign_keys')),
      quickCheck: String(scalar('PRAGMA quick_check')),
      databasePath,
    };
    if (
      configuration.journalMode !== 'delete' ||
      configuration.synchronous !== 3 ||
      configuration.foreignKeys !== 1 ||
      configuration.quickCheck !== 'ok'
    ) {
      const mismatch = configuration.quickCheck !== 'ok'
        ? `INTEGRITY_CHECK_FAILED:${configuration.quickCheck}`
        : `EFFECTIVE_CONFIGURATION_MISMATCH:${JSON.stringify(configuration)}`;
      await this.close();
      throw new Error(mismatch);
    }
    this.#configuration = configuration as EffectiveConfiguration;
    return this.#configuration;
  }

  inspectConfiguration(): EffectiveConfiguration {
    if (!this.#configuration) throw new Error('DATABASE_NOT_OPEN');
    return this.#configuration;
  }

  setCorrelation(correlation: unknown): void {
    this.#instrumentation?.setCorrelation?.(correlation);
  }

  apply(request: ApplyCommandRequest): RepositoryResponse {
    if (!this.#ledger) throw new Error('DATABASE_NOT_OPEN');
    return this.#ledger.apply(request);
  }

  inspect(projectId: string, commandId: string): LedgerInspection {
    if (!this.#ledger || !this.#fixture) throw new Error('DATABASE_NOT_OPEN');
    return this.#ledger.inspect(projectId, commandId, this.#fixture);
  }

  async inspectRestart(projectId: string, commandId: string) {
    return inspectRestart(this.inspect(projectId, commandId));
  }

  recoverStartup(projectId: string): StartupRecovery {
    if (!this.#ledger || !this.#fixture) throw new Error('DATABASE_NOT_OPEN');
    return this.#ledger.recoverStartup(projectId, this.#fixture);
  }

  async closeStatements(): Promise<void> {
    if (!this.#ledger) throw new Error('DATABASE_NOT_OPEN');
    this.#ledger.closeStatements();
  }

  async closeDatabase(): Promise<void> {
    if (!this.#db) throw new Error('DATABASE_NOT_OPEN');
    this.#db.close();
    this.#db = null;
    this.#ledger = null;
    this.#configuration = null;
    this.#fixture = null;
  }

  async pauseVfs(): Promise<void> {
    if (!this.#pool) throw new Error('VFS_NOT_OPEN');
    this.#pool.pauseVfs();
    this.#instrumentation?.dispose();
    this.#instrumentation = null;
    this.#recovery?.dispose();
    this.#recovery = null;
    this.#pool = null;
  }

  async close(): Promise<void> {
    if (this.#db) await this.closeDatabase();
    if (this.#pool) await this.pauseVfs();
  }
}
