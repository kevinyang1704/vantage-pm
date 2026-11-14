import { importProject } from '../application/portable-file/import-project';
import type { PortableProjectSnapshot } from '../contracts/portable-file.schema';
import { localTodayIso } from '../adapters/ui/workspace/use-local-today';

/**
 * The fixture's sprint plan is written relative to its start sprint. Shift it
 * so the first placed sprint is the sprint holding today: the sample board
 * always shows its work from the current sprint on, however old the fixture.
 */
export function shiftDemoSprintPlan(
  snapshot: PortableProjectSnapshot,
  todayIso: string,
): PortableProjectSnapshot {
  const plan = snapshot.forecastPlan;
  const sprintPlan = plan?.sprintPlan;
  if (!plan || !sprintPlan || plan.startDate === null || plan.startSprintOrdinal === null || !plan.sprintLengthDays) {
    return snapshot;
  }
  const elapsed = Math.round(
    (Date.parse(`${todayIso}T00:00:00Z`) - Date.parse(`${plan.startDate}T00:00:00Z`)) / 86_400_000,
  );
  const offset = Number.isFinite(elapsed) && elapsed > 0 ? Math.floor(elapsed / plan.sprintLengthDays) : 0;
  if (offset === 0) return snapshot;
  return Object.freeze({
    ...snapshot,
    forecastPlan: Object.freeze({
      ...plan,
      sprintPlan: Object.freeze({
        placements: Object.freeze(
          sprintPlan.placements.map((p) => Object.freeze({ itemId: p.itemId, sprint: p.sprint + offset })),
        ),
        capacities: Object.freeze(
          Object.fromEntries(
            Object.entries(sprintPlan.capacities).map(([sprint, points]) => [String(Number(sprint) + offset), points]),
          ),
        ),
      }),
    }),
  });
}

/** Load the bundled Lumen Trade portable file; it is precached for offline use. */
export async function loadLumenDemoRaw(): Promise<string> {
  if (typeof document === 'undefined') throw new Error('The demo project is unavailable.');
  const response = await fetch(new URL('demos/lumen-trade.json', document.baseURI));
  if (!response.ok) throw new Error('The demo project could not be loaded.');
  return response.text();
}

/** Each visitor and explicitly requested copy receives independent identities. */
export async function createDemoProject(
  todayIso: string = localTodayIso(),
  loadRaw: () => Promise<string> = loadLumenDemoRaw,
): Promise<PortableProjectSnapshot> {
  const raw = await loadRaw();
  const result = importProject(raw, () => false, { asNewProject: true });
  if (!result.ok) throw new Error('The demo project could not be prepared.');
  return shiftDemoSprintPlan(result.candidate, todayIso);
}
