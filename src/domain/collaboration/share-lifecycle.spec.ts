import { describe, expect, it } from 'vitest';
import { capabilitiesFor, initialShareState, reduceShare } from './share-lifecycle';

describe('share-lifecycle (Story 27.6, R7)', () => {
  it('a never-activated operation safely returns to local', () => {
    let s = initialShareState();
    s = reduceShare(s, { type: 'BEGIN_SHARE', operationId: 'op1' });
    expect(s.status).toBe('provisioning');
    s = reduceShare(s, { type: 'RECONCILE_NOT_ACTIVATED' });
    expect(s.status).toBe('local');
    expect(s.operationId).toBeNull();
  });

  it('an activated operation resumes as shared', () => {
    let s = initialShareState();
    s = reduceShare(s, { type: 'BEGIN_SHARE', operationId: 'op1' });
    s = reduceShare(s, { type: 'SERVER_ACTIVATED', projectRevision: 1 });
    s = reduceShare(s, { type: 'RECONCILE_ACTIVATED' });
    expect(s.status).toBe('shared');
  });

  it('retry reuses the operation id and never starts a second share', () => {
    let s = initialShareState();
    s = reduceShare(s, { type: 'BEGIN_SHARE', operationId: 'op1' });
    const again = reduceShare(s, { type: 'BEGIN_SHARE', operationId: 'op2' });
    expect(again.operationId).toBe('op1');
    expect(again.status).toBe('provisioning');
  });

  it('a lost acknowledgement reconciles rather than falsely claiming shared', () => {
    let s = initialShareState();
    s = reduceShare(s, { type: 'BEGIN_SHARE', operationId: 'op1' });
    s = reduceShare(s, { type: 'SERVER_ACTIVATED', projectRevision: 1 });
    expect(s.status).toBe('provisioning-unconfirmed');
    expect(s.status).not.toBe('shared');
  });

  it('stop sharing returns the owner to a normal local project', () => {
    let s = initialShareState();
    s = reduceShare(s, { type: 'BEGIN_SHARE', operationId: 'op1' });
    s = reduceShare(s, { type: 'SERVER_CONFIRMED_SHARED' });
    s = reduceShare(s, { type: 'BEGIN_STOP' });
    s = reduceShare(s, { type: 'STOP_CONFIRMED_LOCAL' });
    expect(s.status).toBe('local');
  });

  it('a viewer is read-only with an explanation; an owner can manage', () => {
    expect(capabilitiesFor('viewer').canEdit).toBe(false);
    expect(capabilitiesFor('viewer').readOnlyExplanation).toBe('View only — ask an owner for edit access');
    expect(capabilitiesFor('owner')).toMatchObject({ canEdit: true, canShare: true, canStopSharing: true, canManageMembers: true });
    expect(capabilitiesFor('editor')).toMatchObject({ canEdit: true, canShare: false });
  });
});
