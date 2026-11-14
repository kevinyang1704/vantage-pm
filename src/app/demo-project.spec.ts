import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { envelopeToSnapshot } from '../application/portable-file/import-project';
import { parsePortableFile, type PortableFileEnvelopeV10 } from '../contracts/portable-file.schema';
import { createDemoProject, shiftDemoSprintPlan } from './demo-project';

const raw = readFileSync('public/demos/lumen-trade.json', 'utf8');

function originalSnapshot() {
  const parsed = parsePortableFile(raw);
  if (!parsed.ok) throw new Error('demo fixture must parse');
  return envelopeToSnapshot(parsed.value as PortableFileEnvelopeV10);
}

describe('Lumen Trade demo preparation', () => {
  it('shifts the hand-planned sprints to the current sprint without changing their order', () => {
    const snapshot = originalSnapshot();
    const shifted = shiftDemoSprintPlan(snapshot, '2027-02-01');
    expect(shifted.forecastPlan?.sprintPlan?.placements).toEqual(
      snapshot.forecastPlan?.sprintPlan?.placements.map((placement) => ({
        ...placement,
        sprint: placement.sprint + 2,
      })),
    );
    expect(shifted.forecastPlan?.sprintPlan?.capacities).toEqual(
      Object.fromEntries(
        Object.entries(snapshot.forecastPlan?.sprintPlan?.capacities ?? {}).map(([sprint, points]) => [
          String(Number(sprint) + 2),
          points,
        ]),
      ),
    );
  });

  it('creates independent project and node identities for each copy', async () => {
    const first = await createDemoProject('2027-01-04', async () => raw);
    const second = await createDemoProject('2027-01-04', async () => raw);
    expect(first.projectId).not.toBe(second.projectId);
    expect(first.nodes).toHaveLength(56);
    const firstIds = new Set(first.nodes.map((node) => node.id));
    expect(second.nodes.every((node) => !firstIds.has(node.id))).toBe(true);
  });
});
