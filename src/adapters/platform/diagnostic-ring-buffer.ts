/**
 * Local diagnostic ring buffer (Story 1.9 Task 6, AC4).
 *
 * Bounded in-memory ring buffer recording diagnostic entries with:
 * - Typed code (recovery causes, backup-verification outcomes, migration-step
 *   transitions, update-gate decisions, normal-path events)
 * - Relevant project/command revision where applicable
 * - Safe technical state (quickCheck result, schema version, transition name)
 *
 * Explicitly EXCLUDES: node titles, project names, command payload content,
 * or any other authored string (AD-15: "Authored content, identifiers,
 * diagnostics, and derived artifacts are never transmitted").
 *
 * Zero network I/O — confirmable via static analysis.
 * In-memory per session (AC4's literal text describes runtime inspection,
 * not restart survival).
 */

/** A single diagnostic entry in the ring buffer. */
export type DiagnosticEntry = Readonly<{
  /** Monotonic sequence number. */
  sequence: number;
  /** ISO 8601 timestamp (injected clock port, AD-8). */
  timestamp: string;
  /** Typed diagnostic code. */
  code: string;
  /** Optional project or command revision. */
  revision: number | null;
  /** Safe technical state — no authored body text. */
  state: Readonly<Record<string, string | number | boolean | null>>;
}>;

/** Maximum number of entries in the ring buffer. */
const DEFAULT_CAPACITY = 1000;

/**
 * A bounded, in-memory ring buffer for diagnostic entries.
 * Oldest entries are evicted when capacity is exceeded.
 */
export class DiagnosticRingBuffer {
  private entries: DiagnosticEntry[] = [];
  private nextSequence = 1;
  private readonly capacity: number;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  /**
   * Record a diagnostic entry.
   * @param code - Typed diagnostic code (e.g., 'INTEGRITY_CHECK_FAILED')
   * @param revision - Optional project/command revision
   * @param state - Safe technical state (no authored body text)
   */
  record(
    code: string,
    revision: number | null,
    state: Readonly<Record<string, string | number | boolean | null>>,
  ): void {
    const entry: DiagnosticEntry = Object.freeze({
      sequence: this.nextSequence++,
      timestamp: new Date().toISOString(),
      code,
      revision,
      state: Object.freeze({ ...state }),
    });

    this.entries.push(entry);

    // Evict oldest entries if over capacity
    while (this.entries.length > this.capacity) {
      this.entries.shift();
    }
  }

  /** Get all entries in insertion order (oldest first). */
  getAll(): readonly DiagnosticEntry[] {
    return Object.freeze([...this.entries]);
  }

  /** Get the most recent N entries. */
  getRecent(count: number): readonly DiagnosticEntry[] {
    return Object.freeze(this.entries.slice(-count));
  }

  /** Get the current entry count. */
  get count(): number {
    return this.entries.length;
  }

  /** Clear all entries. */
  clear(): void {
    this.entries = [];
    this.nextSequence = 1;
  }
}
