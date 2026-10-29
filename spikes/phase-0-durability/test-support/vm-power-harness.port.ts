// Story 1.4 (Gate B) — VM power-off and physical power-interruption harness port.
//
// PHASE-0-DURABILITY.md requires 20 forced VM power-offs per branded browser build and app form
// (distributed across commit crash points), and 10 controlled physical-machine power
// interruptions on each current-stable branded browser. Neither is achievable from this
// environment: there is no VM infrastructure to power-cycle and no way to physically interrupt
// power to a real machine from an automated test process.
//
// Following the same convention as createRepositoryWorkerTestPort() in
// spikes/phase-0-durability/src/repository.worker.ts ("Never throw in
// createRepositoryWorkerTestPort() — it intentionally throws REAL_BROWSER_SQLITE_WORKER_REQUIRED
// to enforce that browser-backed SQLite is the only authority", AGENTS.md), this port
// intentionally throws rather than faking a result. See
// procedure a future session with real VM/hardware access must follow instead.
export type VmPowerCaseKind = 'VM_POWER_LOSS' | 'PHYSICAL_POWER_INTERRUPTION';

export type VmPowerCaseRequest = Readonly<{
  kind: VmPowerCaseKind;
  seed: string;
  browserBuild: string;
  appForm: 'browser-tab' | 'installed';
  crashPoint: string;
}>;

/** Intentionally never implemented — see file header. Real VM/physical infrastructure is the only authority for these cases. */
export function createVmPowerHarnessPort(): { runVmPowerOffCase(request: VmPowerCaseRequest): Promise<never> } {
  return {
    async runVmPowerOffCase(): Promise<never> {
      throw new Error('REAL_VM_OR_PHYSICAL_INFRASTRUCTURE_REQUIRED');
    },
  };
}
