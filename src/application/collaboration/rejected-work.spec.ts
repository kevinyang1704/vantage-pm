import { describe, expect, it } from 'vitest';
import { describeRejectedWork, rejectionReasonText, retryCommand } from './rejected-work';
import type { ProductCommand } from '../../contracts/repository-commands';
import { PROTOCOL_VERSION } from '../../../spikes/phase-0-durability/src/command-receipt';

const P = '019ffc00-0000-7000-8000-000000000001';
const N = '019ffc00-0000-7000-8000-0000000000a1';
const C = '019ffc00-0000-7000-8000-0000000000b1';
const title: ProductCommand = { type: 'SetNodeTitle', protocolVersion: PROTOCOL_VERSION, commandId: C, projectId: P, baseRevision: 4, expectedRevision: 5, nodeId: N, title: 'My wording' };

describe('rejected work (gate 5)', () => {
  it('names the item, the authored value and a plain reason, with full copy content', () => {
    const view = describeRejectedWork({ commandId: C, command: title, reason: 'REVISION_CONFLICT' }, (id) => (id === N ? 'Checkout' : null));
    expect(view).toMatchObject({ commandId: C, label: 'Title of “Checkout”', yourValue: 'My wording', reason: 'A teammate changed this first.' });
    expect(view.copyText).toContain('My wording');
    expect(view.copyText).toContain(N);
    expect(view.copyText).not.toContain(C);
    expect(view.copyText).not.toContain('baseRevision');
  });

  it('degrades to the action when the item is gone and to a generic reason for unknown codes', () => {
    const view = describeRejectedWork({ commandId: C, command: { type: 'ToggleNodeCompleted', protocolVersion: PROTOCOL_VERSION, commandId: C, projectId: P, baseRevision: 4, expectedRevision: 5, nodeId: N, completed: true } as ProductCommand, reason: 'SOMETHING_NEW' }, () => null);
    expect(view.label).toBe('Done');
    expect(view.yourValue).toBe('Done');
    expect(view.reason).toBe('The team service did not accept this change.');
    expect(rejectionReasonText('NODE_NOT_FOUND')).toBe('The item was deleted by a teammate.');
  });

  it('retries under a new id at the current revision and never reuses the rejected id', () => {
    const retry = retryCommand(title, '019ffc00-0000-7000-8000-0000000000b2', 9);
    expect(retry).toMatchObject({ commandId: '019ffc00-0000-7000-8000-0000000000b2', baseRevision: 9, expectedRevision: 10, title: 'My wording', nodeId: N });
    expect(() => retryCommand(title, C, 9)).toThrow('RETRY_REQUIRES_NEW_ID');
    expect(() => retryCommand(title, '019ffc00-0000-7000-8000-0000000000b3', -1)).toThrow('RETRY_REVISION_INVALID');
  });
});
