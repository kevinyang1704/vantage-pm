/**
 * Fixed-output natural-language parser stub.
 *
 * Returns a pre-configured parse result for every input, enabling deterministic
 * tests of scheduling/date-parsing behavior without depending on chrono-node's
 * actual NLP engine. Conforms to the port shape AD-8 defines for the
 * natural-language-parser injection point (Consistency Conventions — Determinism row).
 *
 * This is an interface-first stub — no consumer exists yet (Epic 2+ will define
 * the real port shape). The stub returns a fixed result regardless of input,
 * suitable for testing command handlers that depend on parsed dates.
 *
 * Usage:
 *   const parser = createFixedNlParser([{ start: '2026-06-01', end: '2026-06-30' }]);
 *   parser.parse('next month'); // always returns the fixed result
 */

export type NlDateResult = Readonly<{
  start: string;
  end: string | null;
}>;

export type NlParserTestDouble = Readonly<{
  /** Parse a natural-language date expression, returning the fixed result. */
  parse(_input: string): ReadonlyArray<NlDateResult>;
  /** Return the configured results without consuming input. */
  peek(): ReadonlyArray<NlDateResult>;
}>;

/**
 * Create a fixed-output NL parser that always returns the same results.
 */
export function createFixedNlParser(
  results: ReadonlyArray<NlDateResult>,
): NlParserTestDouble {
  const frozen = Object.freeze(results.map((r) => Object.freeze({ ...r })));

  return Object.freeze({
    parse(_input: string): ReadonlyArray<NlDateResult> {
      return frozen;
    },
    peek(): ReadonlyArray<NlDateResult> {
      return frozen;
    },
  });
}
