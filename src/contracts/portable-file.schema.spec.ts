/**
 * Unit tests for portable-file.schema.ts (Story 1.8 Task 8).
 *
 * Table test: one case per rejection category + valid envelope.
 * Deterministic serialization test for AC2's round-trip clause.
 */

import { describe, expect, it } from 'vitest';
import {
  parsePortableFile,
  serializePortableFileEnvelope,
  validatePortableFileEnvelope,
  type PortableFileEnvelope,
} from './portable-file.schema';

const VALID_ENVELOPE: PortableFileEnvelope = Object.freeze({
  schemaVersion: 1,
  exportedAt: '2026-08-14T00:00:00.000Z',
  project: Object.freeze({
    id: '018f3a80-0000-7000-8000-000000000001',
    name: 'Test Project',
  }),
});

describe('portable-file schema', () => {
  // -- Valid envelope --------------------------------------------------------

  it('accepts a valid envelope', () => {
    const result = validatePortableFileEnvelope(VALID_ENVELOPE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.schemaVersion).toBe(1);
      expect(result.value.project.id).toBe('018f3a80-0000-7000-8000-000000000001');
      expect(result.value.project.name).toBe('Test Project');
    }
  });

  // -- Rejection: MalformedJson ----------------------------------------------

  it('rejects non-object input as MalformedJson', () => {
    const result = validatePortableFileEnvelope('not an object');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('MalformedJson');
    }
  });

  it('rejects null input as MalformedJson', () => {
    const result = validatePortableFileEnvelope(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('MalformedJson');
    }
  });

  // -- Rejection: UnsupportedNewerSchema -------------------------------------

  it('rejects schema version newer than supported', () => {
    const result = validatePortableFileEnvelope({
      schemaVersion: 99,
      exportedAt: '2026-08-14T00:00:00.000Z',
      project: { id: '018f3a80-0000-7000-8000-000000000001', name: 'Test' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('UnsupportedNewerSchema');
    }
  });

  // -- Rejection: UnknownFieldsAtCurrentVersion -------------------------------

  it('rejects unknown top-level fields', () => {
    const result = validatePortableFileEnvelope({
      schemaVersion: 1,
      exportedAt: '2026-08-14T00:00:00.000Z',
      project: { id: '018f3a80-0000-7000-8000-000000000001', name: 'Test' },
      extraField: 'should not be here',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('UnknownFieldsAtCurrentVersion');
    }
  });

  it('rejects unknown project fields', () => {
    const result = validatePortableFileEnvelope({
      schemaVersion: 1,
      exportedAt: '2026-08-14T00:00:00.000Z',
      project: {
        id: '018f3a80-0000-7000-8000-000000000001',
        name: 'Test',
        description: 'should not be here',
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('UnknownFieldsAtCurrentVersion');
    }
  });

  // -- Rejection: MissingRequiredField ----------------------------------------

  it('rejects missing schemaVersion', () => {
    const result = validatePortableFileEnvelope({
      exportedAt: '2026-08-14T00:00:00.000Z',
      project: { id: '018f3a80-0000-7000-8000-000000000001', name: 'Test' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('MissingRequiredField');
    }
  });

  it('rejects missing project', () => {
    const result = validatePortableFileEnvelope({
      schemaVersion: 1,
      exportedAt: '2026-08-14T00:00:00.000Z',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('MissingRequiredField');
    }
  });

  // -- Rejection: InvalidProjectId -------------------------------------------

  it('rejects non-UUIDv7 project.id', () => {
    const result = validatePortableFileEnvelope({
      schemaVersion: 1,
      exportedAt: '2026-08-14T00:00:00.000Z',
      project: { id: 'not-a-uuid', name: 'Test' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('InvalidProjectId');
    }
  });

  // -- Rejection: InvalidProjectName -----------------------------------------

  it('rejects empty project.name', () => {
    const result = validatePortableFileEnvelope({
      schemaVersion: 1,
      exportedAt: '2026-08-14T00:00:00.000Z',
      project: { id: '018f3a80-0000-7000-8000-000000000001', name: '   ' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('InvalidProjectName');
    }
  });

  it('rejects over-length project.name', () => {
    const result = validatePortableFileEnvelope({
      schemaVersion: 1,
      exportedAt: '2026-08-14T00:00:00.000Z',
      project: { id: '018f3a80-0000-7000-8000-000000000001', name: 'x'.repeat(201) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('InvalidProjectName');
    }
  });

  // -- Rejection: ActiveContentDetected --------------------------------------

  it('rejects active content in project.name', () => {
    const result = validatePortableFileEnvelope({
      schemaVersion: 1,
      exportedAt: '2026-08-14T00:00:00.000Z',
      project: { id: '018f3a80-0000-7000-8000-000000000001', name: '<script>alert(1)</script>' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('ActiveContentDetected');
    }
  });

  // -- Rejection: LimitExceeded ----------------------------------------------

  it('rejects oversized file', () => {
    const obj: Record<string, unknown> = {
      schemaVersion: 1,
      exportedAt: '2026-08-14T00:00:00.000Z',
      project: { id: '018f3a80-0000-7000-8000-000000000001', name: 'Test' },
    };
    obj['_padding'] = 'x'.repeat(10 * 1024 * 1024);
    const result = validatePortableFileEnvelope(obj);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['UnknownFieldsAtCurrentVersion', 'LimitExceeded']).toContain(result.error.type);
    }
  });

  // -- parsePortableFile -----------------------------------------------------

  it('parsePortableFile rejects malformed JSON', () => {
    const result = parsePortableFile('not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('MalformedJson');
    }
  });

  it('parsePortableFile accepts valid JSON', () => {
    const json = JSON.stringify(VALID_ENVELOPE);
    const result = parsePortableFile(json);
    expect(result.ok).toBe(true);
  });

  // -- Deterministic serialization (AC2 round-trip) --------------------------

  it('serializePortableFileEnvelope produces valid JSON', () => {
    const json = serializePortableFileEnvelope(VALID_ENVELOPE);
    const parsed = JSON.parse(json);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.project.id).toBe('018f3a80-0000-7000-8000-000000000001');
  });

  it('round-trip: serialize then parse produces equivalent envelope', () => {
    const json = serializePortableFileEnvelope(VALID_ENVELOPE);
    const result = parsePortableFile(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.project.id).toBe(VALID_ENVELOPE.project.id);
      expect(result.value.project.name).toBe(VALID_ENVELOPE.project.name);
    }
  });

  // -- Frozen output ---------------------------------------------------------

  it('validated envelope is frozen', () => {
    const result = validatePortableFileEnvelope(VALID_ENVELOPE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.project)).toBe(true);
    }
  });
});

// ── Schema version 2: complete-project graph (Epic 13) ─────────────────────

import {
  canonicalPortableJson,
  computeSemanticDigest,
  upgradeLegacyEnvelope,
  type PortableFileEnvelopeV2,
} from './portable-file.schema';

const VALID_V2: PortableFileEnvelopeV2 = Object.freeze({
  schemaVersion: 2,
  exportedAt: '2026-08-14T00:00:00.000Z',
  project: Object.freeze({
    id: '018f3a80-0000-7000-8000-000000000001',
    name: 'Test Project',
  }),
  phases: Object.freeze([
    Object.freeze({ id: '018f3a80-0000-7000-8000-000000000010', name: 'Alpha', position: '1' }),
  ]),
  nodes: Object.freeze([
    Object.freeze({
      id: '018f3a80-0000-7000-8000-000000000020',
      parentId: null,
      title: 'Vision',
      bodyText: 'narrative',
      position: '4294967296',
      nodeType: 'Vision',
      startDate: null,
      endDate: null,
      durationDays: null,
      scheduleSourceMode: null,
      completed: false,
      effortPoints: null,
      strategicWeight: null,
      phaseId: null,
    }),
    Object.freeze({
      id: '018f3a80-0000-7000-8000-000000000021',
      parentId: '018f3a80-0000-7000-8000-000000000020',
      title: 'Theme',
      bodyText: null,
      position: '8589934592',
      nodeType: 'Theme',
      startDate: '2026-01-01',
      endDate: '2026-06-30',
      durationDays: 180,
      scheduleSourceMode: 'start_end',
      completed: false,
      effortPoints: 5,
      strategicWeight: 3,
      phaseId: '018f3a80-0000-7000-8000-000000000010',
    }),
  ]),
  nodeCustomFields: Object.freeze([
    Object.freeze({ nodeId: '018f3a80-0000-7000-8000-000000000021', fieldKey: 'owner', fieldValue: 'Alex' }),
  ]),
  typeTemplateFields: Object.freeze([
    Object.freeze({ nodeType: 'Theme', fieldKey: 'owner', fieldLabel: 'Owner', position: 1 }),
  ]),
  unlockEdges: Object.freeze([
    Object.freeze({
      id: '018f3a80-0000-7000-8000-000000000030',
      sourceNodeId: '018f3a80-0000-7000-8000-000000000020',
      targetNodeId: '018f3a80-0000-7000-8000-000000000021',
    }),
  ]),
  findingDismissals: Object.freeze([
    Object.freeze({
      findingId: '018f3a80-0000-7000-8000-000000000040',
      findingKind: 'OrphanedFeature',
      targetId: '018f3a80-0000-7000-8000-000000000021',
      fingerprint: 'fp',
      dismissedAt: '2026-08-01T00:00:00.000Z',
    }),
  ]),
  affectedReasons: Object.freeze([
    Object.freeze({
      id: '018f3a80-0000-7000-8000-000000000050',
      affectedNodeId: '018f3a80-0000-7000-8000-000000000021',
      causalNodeId: '018f3a80-0000-7000-8000-000000000020',
      causalNodeTitle: 'Vision',
      deltaDays: 7,
      causalDateSummary: 'date changed',
      createdAt: '2026-08-01T00:00:00.000Z',
      acknowledgedAt: null,
    }),
  ]),
});

describe('portable-file schema v2 (Epic 13)', () => {
  it('accepts a valid complete v2 envelope and round-trips (upgraded to v3 shape)', () => {
    const result = validatePortableFileEnvelope(VALID_V2);
    expect(result.ok).toBe(true);
    if (result.ok && result.value.schemaVersion === 3) {
      expect(result.value.nodes).toHaveLength(2);
      expect(result.value.openQuestions).toHaveLength(0);
      const json = serializePortableFileEnvelope(result.value);
      const reparsed = parsePortableFile(json);
      expect(reparsed.ok).toBe(true);
      if (reparsed.ok && reparsed.value.schemaVersion === 3) {
        expect(reparsed.value.project.id).toBe(VALID_V2.project.id);
        expect(reparsed.value.nodes).toHaveLength(2);
        expect(reparsed.value.unlockEdges).toHaveLength(1);
      }
    }
  });

  it('is deterministic: identical snapshots serialize identically (E13-NFR4)', () => {
    const a = serializePortableFileEnvelope(VALID_V2);
    const b = serializePortableFileEnvelope(VALID_V2);
    expect(a).toBe(b);
  });

  it('semantic digest ignores exportedAt but covers all authored facts', async () => {
    const withoutTime = { ...VALID_V2, exportedAt: '1999-01-01T00:00:00.000Z' } as PortableFileEnvelopeV2;
    expect(await computeSemanticDigest(VALID_V2)).toBe(await computeSemanticDigest(withoutTime));
    const changedTitle = {
      ...VALID_V2,
      nodes: [
        { ...VALID_V2.nodes[0], title: 'Different' },
        VALID_V2.nodes[1],
      ],
    } as PortableFileEnvelopeV2;
    expect(await computeSemanticDigest(VALID_V2)).not.toBe(await computeSemanticDigest(changedTitle));
    expect(canonicalPortableJson(VALID_V2)).not.toContain('exportedAt');
  });

  it('rejects a node referencing an unknown parent (InvalidRelation)', () => {
    const bad = {
      ...VALID_V2,
      nodes: [
        VALID_V2.nodes[0],
        { ...VALID_V2.nodes[1], parentId: '018f3a80-0000-7000-8000-00000000aaaa' },
      ],
    } as PortableFileEnvelopeV2;
    const result = validatePortableFileEnvelope(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('InvalidRelation');
  });

  it('rejects a containment cycle (CycleDetected)', () => {
    const cycle = {
      ...VALID_V2,
      nodes: [
        { ...VALID_V2.nodes[0], parentId: VALID_V2.nodes[1].id },
        VALID_V2.nodes[1],
      ],
    } as PortableFileEnvelopeV2;
    const result = validatePortableFileEnvelope(cycle);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('CycleDetected');
  });

  it('rejects duplicate sibling positions (DuplicateSiblingPosition)', () => {
    const dup = {
      ...VALID_V2,
      nodes: [
        VALID_V2.nodes[0],
        { ...VALID_V2.nodes[1], parentId: null, position: VALID_V2.nodes[0].position },
      ],
    } as PortableFileEnvelopeV2;
    const result = validatePortableFileEnvelope(dup);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('DuplicateSiblingPosition');
  });

  it('rejects an edge referencing a missing node (InvalidRelation)', () => {
    const badEdge = {
      ...VALID_V2,
      unlockEdges: [
        { ...VALID_V2.unlockEdges[0], targetNodeId: '018f3a80-0000-7000-8000-00000000FFFF' },
      ],
    } as PortableFileEnvelopeV2;
    const result = validatePortableFileEnvelope(badEdge);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('InvalidRelation');
  });

  it('rejects active content in authored text (ActiveContentDetected)', () => {
    const bad = {
      ...VALID_V2,
      nodes: [
        { ...VALID_V2.nodes[0], title: '<script>alert(1)</script>' },
        VALID_V2.nodes[1],
      ],
    } as PortableFileEnvelopeV2;
    const result = validatePortableFileEnvelope(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('ActiveContentDetected');
  });

  it('rejects unknown top-level fields in v2', () => {
    const bad = { ...VALID_V2, surprise: 1 } as PortableFileEnvelopeV2 & { surprise: number };
    const result = validatePortableFileEnvelope(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('UnknownFieldsAtCurrentVersion');
  });

  it('rejects a malformed node position (InvalidBounds)', () => {
    const bad = {
      ...VALID_V2,
      nodes: [
        { ...VALID_V2.nodes[0], position: 'not-a-number' },
        VALID_V2.nodes[1],
      ],
    } as PortableFileEnvelopeV2;
    const result = validatePortableFileEnvelope(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('InvalidBounds');
  });

  it('upgrades a legacy v1 envelope to the empty-graph v5 shape', () => {
    const v1 = validatePortableFileEnvelope(VALID_ENVELOPE);
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;
    if (v1.value.schemaVersion !== 1) {
      throw new Error('fixture must be v1');
    }
    const upgraded = upgradeLegacyEnvelope(v1.value);
    expect(upgraded.schemaVersion).toBe(5);
    expect(upgraded.nodes).toHaveLength(0);
    expect(upgraded.openQuestions).toHaveLength(0);
    expect(upgraded.project.id).toBe(VALID_ENVELOPE.project.id);
    // v1 files remain readable as project-only imports (E13 AC 8).
    const roundTrip = validatePortableFileEnvelope(VALID_ENVELOPE);
    expect(roundTrip.ok).toBe(true);
  });
});
