import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validatePortableFileEnvelope } from './portable-file.schema';

describe('Lumen Trade demo portable project', () => {
  it('imports as a complete graph with resolvable dependencies and staffed scope', () => {
    const demo = JSON.parse(readFileSync('public/demos/lumen-trade.json', 'utf8'));
    const result = validatePortableFileEnvelope(demo);
    expect(result).toMatchObject({ ok: true });
    const ids = new Set(demo.nodes.map((n: { id: string }) => n.id));
    for (const edge of demo.unlockEdges) {
      expect(ids.has(edge.sourceNodeId)).toBe(true);
      expect(ids.has(edge.targetNodeId)).toBe(true);
    }
    expect(demo.forecastPlan.selectedFeatureIds).toHaveLength(15);
    expect(demo.forecastScenarios).toHaveLength(2);
    for (const id of demo.forecastPlan.selectedFeatureIds) {
      expect(ids.has(id)).toBe(true);
      expect(demo.forecastPlan.assignments[id].length).toBeGreaterThan(0);
    }
    const selected = new Set(demo.forecastPlan.selectedFeatureIds);
    expect(demo.forecastPlan.sprintPlan.placements.length).toBeGreaterThan(0);
    for (const placement of demo.forecastPlan.sprintPlan.placements) {
      expect(selected.has(placement.itemId)).toBe(true);
      expect(Number.isSafeInteger(placement.sprint) && placement.sprint > 0).toBe(true);
    }
    for (const key of Object.keys(demo.forecastPlan.sprintPlan.capacities)) {
      expect(/^[1-9][0-9]*$/.test(key)).toBe(true);
      expect(Number.isSafeInteger(demo.forecastPlan.sprintPlan.capacities[key])).toBe(true);
    }

    const vision = demo.nodes.find((n: { nodeType: string }) => n.nodeType === 'Vision');
    expect(vision.bodyText).toContain('## North Star');
    expect(vision.bodyText).toContain('## Pillars');
    for (const theme of demo.nodes.filter((n: { nodeType: string }) => n.nodeType === 'Theme')) {
      if (theme.strategicWeight > 0) expect(theme.bodyText).toContain('## Persona');
      expect(theme.bodyText).toContain('## OKRs');
    }
    for (const component of demo.nodes.filter((n: { nodeType: string }) => n.nodeType === 'Component')) {
      expect(component.bodyText).toContain('## Component Scope');
      expect(component.bodyText).toContain('## Dependencies and Risks');
    }
    for (const featureId of demo.forecastPlan.selectedFeatureIds) {
      const feature = demo.nodes.find((n: { id: string }) => n.id === featureId);
      expect(feature.bodyText).toContain('## Problem');
      expect(feature.bodyText).toContain('## Solution');
      expect(feature.bodyText).toContain('## Scope / Non-goals');
      expect(demo.nodes.filter((n: { parentId: string; nodeType: string }) => n.parentId === featureId && n.nodeType === 'AcceptanceCriterion')).toHaveLength(2);
    }
  });
});
