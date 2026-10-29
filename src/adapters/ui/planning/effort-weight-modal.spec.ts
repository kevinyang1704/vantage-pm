import { describe, it, expect } from 'vitest';
import { EffortWeightModal } from './effort-weight-modal';

describe('EffortWeightModal component contract', () => {
  it('exports EffortWeightModal as a valid React component', () => {
    expect(typeof EffortWeightModal).toBe('function');
  });

  it('declares optional onCreatePhase and onOpenPhaseManager in its contract', () => {
    const props: Parameters<typeof EffortWeightModal>[0] = {
      isOpen: false,
      node: null,
      phases: [],
      onClose: () => {},
      onSetEffort: () => {},
      onSetThemeWeight: () => {},
      onSetCustomField: () => {},
      onPromoteFieldToTemplate: () => {},
      onAssignPhase: () => {},
      onCreatePhase: () => {},
      onOpenPhaseManager: () => {},
    };
    expect(props.isOpen).toBe(false);
    expect(typeof props.onCreatePhase).toBe('function');
    expect(typeof props.onOpenPhaseManager).toBe('function');
  });
});
