/**
 * Unit tests for diagnostic-ring-buffer.ts (Story 1.9 Task 8).
 */

import { describe, expect, it } from 'vitest';
import { DiagnosticRingBuffer } from './diagnostic-ring-buffer';

describe('diagnostic ring buffer', () => {
  it('starts empty', () => {
    const buf = new DiagnosticRingBuffer();
    expect(buf.count).toBe(0);
    expect(buf.getAll()).toHaveLength(0);
  });

  it('records entries with incrementing sequence numbers', () => {
    const buf = new DiagnosticRingBuffer();
    buf.record('TEST_CODE', null, { key: 'value' });
    buf.record('TEST_CODE_2', 5, { quickCheck: 'ok' });

    const entries = buf.getAll();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.sequence).toBe(1);
    expect(entries[1]!.sequence).toBe(2);
  });

  it('stores code, revision, and state', () => {
    const buf = new DiagnosticRingBuffer();
    buf.record('INTEGRITY_CHECK_FAILED', 3, { quickCheck: 'not ok', schemaVersion: 1 });

    const entry = buf.getAll()[0]!;
    expect(entry.code).toBe('INTEGRITY_CHECK_FAILED');
    expect(entry.revision).toBe(3);
    expect(entry.state.quickCheck).toBe('not ok');
    expect(entry.state.schemaVersion).toBe(1);
  });

  it('includes ISO timestamp', () => {
    const buf = new DiagnosticRingBuffer();
    buf.record('TEST', null, {});

    const entry = buf.getAll()[0]!;
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('evicts oldest entries when capacity exceeded', () => {
    const buf = new DiagnosticRingBuffer(3);
    buf.record('A', null, {});
    buf.record('B', null, {});
    buf.record('C', null, {});
    buf.record('D', null, {});

    const entries = buf.getAll();
    expect(entries).toHaveLength(3);
    expect(entries[0]!.code).toBe('B');
    expect(entries[1]!.code).toBe('C');
    expect(entries[2]!.code).toBe('D');
  });

  it('getRecent returns last N entries', () => {
    const buf = new DiagnosticRingBuffer();
    buf.record('A', null, {});
    buf.record('B', null, {});
    buf.record('C', null, {});

    const recent = buf.getRecent(2);
    expect(recent).toHaveLength(2);
    expect(recent[0]!.code).toBe('B');
    expect(recent[1]!.code).toBe('C');
  });

  it('getRecent with count larger than buffer returns all', () => {
    const buf = new DiagnosticRingBuffer();
    buf.record('A', null, {});

    const recent = buf.getRecent(10);
    expect(recent).toHaveLength(1);
  });

  it('clear removes all entries', () => {
    const buf = new DiagnosticRingBuffer();
    buf.record('A', null, {});
    buf.record('B', null, {});
    buf.clear();

    expect(buf.count).toBe(0);
    expect(buf.getAll()).toHaveLength(0);
  });

  it('entries are frozen', () => {
    const buf = new DiagnosticRingBuffer();
    buf.record('TEST', null, { key: 'value' });

    const entry = buf.getAll()[0]!;
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.state)).toBe(true);
  });

  it('getAll returns frozen array', () => {
    const buf = new DiagnosticRingBuffer();
    buf.record('TEST', null, {});

    expect(Object.isFrozen(buf.getAll())).toBe(true);
  });

  it('handles null revision', () => {
    const buf = new DiagnosticRingBuffer();
    buf.record('TEST', null, {});

    expect(buf.getAll()[0]!.revision).toBeNull();
  });

  it('handles boolean and number state values', () => {
    const buf = new DiagnosticRingBuffer();
    buf.record('TEST', 1, { isCertified: false, count: 42, name: null });

    const entry = buf.getAll()[0]!;
    expect(entry.state.isCertified).toBe(false);
    expect(entry.state.count).toBe(42);
    expect(entry.state.name).toBeNull();
  });
});
