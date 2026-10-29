import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  createLocalFileState, createShareBundle, joinSharedProject, parseLocalFile,
  parseLocalFileState, prepareLocalMerge, resolveLocalMerge,
} from './local-merge';
import { MAX_PORTABLE_NODES, type PortableNode, type PortableProjectSnapshot } from '../../contracts/portable-file.schema';

const id = (number: number): string => `018f3a80-0000-7000-8000-${number.toString(16).padStart(12, '0')}`;
function scaleSnapshot(): PortableProjectSnapshot {
  const nodes: PortableNode[] = Array.from({ length: MAX_PORTABLE_NODES }, (_, index) => ({
    id: id(index + 2), parentId: null, title: `Synthetic item ${index + 1}`, bodyText: null,
    position: (BigInt(index + 1) * 4294967296n).toString(), nodeType: null,
    startDate: null, endDate: null, durationDays: null, scheduleSourceMode: null,
    completed: false, effortPoints: null, effortPointsDone: null, strategicWeight: null,
    phaseId: null, deliveryStatus: 'not_started',
  }));
  return {
    projectId: id(1), projectName: 'Synthetic supported-limit plan', projectRevision: 1,
    nodes, phases: [], nodeCustomFields: [], typeTemplateFields: [], unlockEdges: [],
    findingDismissals: [], affectedReasons: [], openQuestions: [],
  };
}

describe('local file collaboration at the supported project limit', () => {
  it('merges a late incoming edit into 5000 items without losing an independent local edit', () => {
    const base = scaleSnapshot();
    expect(base.nodes).toHaveLength(5000);
    const initial = createShareBundle(base, createLocalFileState(base));
    const teammate = joinSharedProject(parseLocalFile(initial.json));
    const local: PortableProjectSnapshot = {
      ...base, projectRevision: 2,
      nodes: base.nodes.map((node, index) => index === 0 ? { ...node, bodyText: 'Synthetic independent local brief' } : node),
    };
    const incoming: PortableProjectSnapshot = {
      ...teammate.snapshot, projectRevision: 2,
      nodes: teammate.snapshot.nodes.map((node, index) => index === MAX_PORTABLE_NODES - 1 ? { ...node, title: 'Synthetic incoming final item' } : node),
    };
    const contribution = createShareBundle(incoming, teammate.state);
    const parsed = parseLocalFile(contribution.json);
    const prepareStarted = performance.now();
    const review = prepareLocalMerge(local, initial.state, parsed);
    const prepareMilliseconds = performance.now() - prepareStarted;
    expect(review.mode).toBe('shared');
    expect(review.changes).toHaveLength(1);
    expect(review.changes[0]).toMatchObject({
      entityId: id(MAX_PORTABLE_NODES + 1), fields: ['title'], kind: 'edit', conflict: false,
      after: { title: 'Synthetic incoming final item' },
    });
    const resolveStarted = performance.now();
    const applied = resolveLocalMerge(review, {});
    const resolveMilliseconds = performance.now() - resolveStarted;
    expect(applied.error).toBeUndefined();
    expect(applied.snapshot.nodes).toHaveLength(MAX_PORTABLE_NODES);
    expect(applied.snapshot.nodes[0].bodyText).toBe('Synthetic independent local brief');
    expect(applied.snapshot.nodes[MAX_PORTABLE_NODES - 1].title).toBe('Synthetic incoming final item');
    expect(applied.snapshot.nodes[1].title).toBe(base.nodes[1].title);
    const reloadStarted = performance.now();
    const reloaded = parseLocalFileState(JSON.stringify(applied.state), applied.snapshot);
    const reloadMilliseconds = performance.now() - reloadStarted;
    expect(reloaded.lineageId).toBe(initial.state.lineageId);
    expect(reloaded.decisions[review.changes[0].id]).toBe('accept');
    expect(prepareLocalMerge(applied.snapshot, reloaded, parsed).changes).toHaveLength(0);

    // Each retained checkpoint contains a full snapshot. Estimate the size of
    // 32 snapshots before allocating a large string or publishing a bundle.
    const snapshotBytes = new TextEncoder().encode(JSON.stringify(incoming)).length;
    const contributionBytes = new TextEncoder().encode(contribution.json).length;
    const estimated32CheckpointBytes = snapshotBytes * 33; // 32 checkpoints plus the current snapshot.
    expect(contributionBytes).toBeLessThan(30 * 1024 * 1024);
    expect(estimated32CheckpointBytes).toBeGreaterThan(30 * 1024 * 1024);
    console.info('Synthetic local-merge supported-limit benchmark', JSON.stringify({
      nodes: MAX_PORTABLE_NODES,
      prepareMilliseconds: Math.round(prepareMilliseconds),
      resolveMilliseconds: Math.round(resolveMilliseconds),
      reloadMilliseconds: Math.round(reloadMilliseconds),
      contributionBytes,
      retainedCheckpoints: contribution.state.checkpoints.length,
      estimated32CheckpointBytes,
    }));
  }, 60_000);
});

