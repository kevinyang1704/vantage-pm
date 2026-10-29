import { describe, expect, it } from 'vitest';
import { DELIVERY_STATUS_OPTIONS, deliveryStatusLabel, deliveryStatusModifier } from './vocabulary';
import { DELIVERY_STATUS_ORDER } from './workspace/delivery-status';

describe('shared delivery-status vocabulary (Story 25.4 AC 25.4-3)', () => {
  it('orders the three statuses canonically', () => {
    expect(DELIVERY_STATUS_OPTIONS.map((o) => o.value)).toEqual([
      'not_started',
      'in_progress',
      'delivered',
    ]);
  });

  it('pins the literal labels and modifiers (catches a silent re-labelling)', () => {
    expect(DELIVERY_STATUS_OPTIONS.map((o) => o.label)).toEqual([
      'Not started',
      'In progress',
      'Delivered',
    ]);
    expect(DELIVERY_STATUS_OPTIONS.map((o) => o.modifier)).toEqual([
      'not-started',
      'in-progress',
      'delivered',
    ]);
    expect(deliveryStatusLabel('in_progress')).toBe('In progress');
    expect(deliveryStatusModifier('delivered')).toBe('delivered');
  });

  it('the overview reuses the shared labels and modifiers (literal, not by construction of the source)', () => {
    // Assert against literals, not against DELIVERY_STATUS_OPTIONS, so a silent
    // re-label/remap in either module fails this test.
    const expected: ReadonlyArray<readonly [string, string, string]> = [
      ['not_started', 'Not started', 'not-started'],
      ['in_progress', 'In progress', 'in-progress'],
      ['delivered', 'Delivered', 'delivered'],
    ];
    expect(DELIVERY_STATUS_ORDER.map((d) => [d.value, d.label, d.modifier])).toEqual(expected);
  });

  it('falls back to the default status label for an unknown value', () => {
    // @ts-expect-error deliberately invalid
    expect(deliveryStatusLabel('bogus')).toBe('Not started');
    // @ts-expect-error deliberately invalid
    expect(deliveryStatusModifier('bogus')).toBe('not-started');
  });
});
