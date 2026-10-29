import { describe, expect, it } from 'vitest';
import { createNode, type Node } from './node.entity';
import { compareVisualSiblingOrder } from './visual-order.policy';

const P = '019ffe00-0000-7000-8000-000000000001';
const ID_A = '019ffe00-0000-7000-8000-00000000000a';
const ID_B = '019ffe00-0000-7000-8000-00000000000b';
const ID_E = '019ffe00-0000-7000-8000-00000000000e';
const ID_L = '019ffe00-0000-7000-8000-00000000000f';
const ID_X = '019ffe00-0000-7000-8000-00000000000c';

function node(params: {
  id: string;
  startDate?: string | null;
  endDate?: string | null;
  durationDays?: number | null;
  scheduleSourceMode?: 'start_end' | 'start_duration' | 'end_duration' | 'none' | null;
  position?: bigint;
}): Node {
  return createNode({
    id: params.id,
    projectId: P,
    title: params.id,
    position: params.position ?? 1n,
    startDate: params.startDate ?? null,
    endDate: params.endDate ?? null,
    durationDays: params.durationDays ?? null,
    scheduleSourceMode: params.scheduleSourceMode ?? null,
  });
}

describe('visual-order policy (Story 6.1 AC2, AD-11)', () => {
  it('sorts a dated node before an undated node regardless of persisted position', () => {
    const dated = node({ id: ID_A, startDate: '2026-09-10', position: 999n });
    const undated = node({ id: ID_B, position: 1n });
    expect(compareVisualSiblingOrder(dated, undated)).toBe(-1);
    expect(compareVisualSiblingOrder(undated, dated)).toBe(1);
  });

  it('breaks date ties by persisted gap position ascending', () => {
    const earlier = node({ id: ID_A, startDate: '2026-09-10', position: 10n });
    const later = node({ id: ID_B, startDate: '2026-09-10', position: 20n });
    expect(compareVisualSiblingOrder(earlier, later)).toBe(-1);
  });

  it('breaks a position tie by UUID ascending', () => {
    const a = node({ id: ID_A, startDate: '2026-09-10', position: 10n });
    const b = node({ id: ID_B, startDate: '2026-09-10', position: 10n });
    expect(compareVisualSiblingOrder(a, b)).toBe(-1);
  });

  it('sorts by the DERIVED start date for end_duration mode (raw null startDate)', () => {
    const early = node({ id: ID_E, endDate: '2026-09-10', durationDays: 5, scheduleSourceMode: 'end_duration' });
    const late = node({ id: ID_L, endDate: '2026-09-20', durationDays: 5, scheduleSourceMode: 'end_duration' });
    expect(compareVisualSiblingOrder(early, late)).toBe(-1);
  });

  it('returns 0 for identical nodes on all axes', () => {
    const a = node({ id: ID_X, startDate: '2026-09-10', position: 10n });
    const b = node({ id: ID_X, startDate: '2026-09-10', position: 10n });
    expect(compareVisualSiblingOrder(a, b)).toBe(0);
  });
});
