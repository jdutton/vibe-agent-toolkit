/**
 * `ProjectionCompileProbe.assertCompiles` — the compile-only half of `query`.
 *
 * SQLite resolves every table and column name when a statement is PREPARED, so
 * a typo is knowable before a single row exists. It was not knowable in
 * practice: the only place a statement met the schema was after the caller had
 * populated the projection, so on a real adopter tree `SELECT contentKey,
 * no_such_column FROM blobs` cost 8.3 s — every millisecond of it building rows
 * the statement could never have read.
 *
 * These tests pin the properties that make this worth having and not merely a
 * second copy of `query`: it REFUSES what `query` refuses, it does not STEP, and
 * it knows EVERY derived relation — which the query store deliberately does not
 * until a lens has been evaluated.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openProjectionCompileProbe, type ProjectionCompileProbe } from '../src/store.js';

/**
 * A statement that COMPILES instantly and never finishes stepping.
 *
 * The negative control for the whole method: if `assertCompiles` ever starts
 * executing, this test stops returning rather than failing, which is why the
 * budget below is asserted rather than left to the runner's default timeout.
 */
const NON_TERMINATING = 'WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c) SELECT count(*) FROM c';

/**
 * Wall-clock ceiling for a compile.
 *
 * Two orders of magnitude above an honest prepare and unboundedly below a step
 * of {@link NON_TERMINATING}, so this measures the defect rather than the
 * machine.
 */
const COMPILE_BUDGET_MS = 250;

let probe: ProjectionCompileProbe;

beforeEach(() => {
  probe = openProjectionCompileProbe();
});

afterEach(async () => {
  await probe.close();
});

describe('assertCompiles', () => {
  it('accepts a statement the schema can answer, against ZERO rows', () => {
    // The point of the preflight: no population has happened, and the schema is
    // still the whole authority on whether the names resolve.
    expect(() => probe.assertCompiles('SELECT path FROM resource_realizations', [])).not.toThrow();
  });

  it('accepts a statement naming a DERIVED relation, which no lens has filled', () => {
    // 🔑 The preflight runs before any lens is evaluated. The query store has no
    // table for an unevaluated relation — that absence is its refusal — so a
    // probe with the query store's schema would reject every check over `edges`.
    expect(() => probe.assertCompiles('SELECT COUNT(*) FROM edges JOIN lens_contexts USING (contextId)', []))
      .not.toThrow();
    expect(() => probe.assertCompiles('SELECT * FROM claude_context_loads', [])).not.toThrow();
  });

  it('refuses an unknown column, naming it', () => {
    expect(() => probe.assertCompiles('SELECT contentKey, no_such_column FROM blobs', []))
      .toThrow(/no such column: no_such_column/);
  });

  it('refuses an unknown table, naming it', () => {
    expect(() => probe.assertCompiles('SELECT * FROM no_such_table', []))
      .toThrow(/no such table: no_such_table/);
  });

  it('refuses a statement that is not a query, exactly as `query` does', () => {
    // Moving the KIND gate in front of the population is half the win: a
    // statement refused for what it IS should not cost more than one refused for
    // what it names.
    expect(() => probe.assertCompiles('ATTACH DATABASE \'evil.db\' AS e', [])).toThrow();
    expect(() => probe.assertCompiles('PRAGMA query_only = 0', [])).toThrow();
    expect(() => probe.assertCompiles('DELETE FROM blobs', [])).toThrow();
  });

  it('refuses a second statement, exactly as `query` does', () => {
    expect(() => probe.assertCompiles('SELECT 1; DELETE FROM blobs', [])).toThrow();
  });

  it('applies the same placeholder count as `query`, before stepping', () => {
    expect(() => probe.assertCompiles('SELECT ? AS x, ? AS y', ['a']))
      .toThrow(/2 placeholders.*1 value was bound/s);
    expect(() => probe.assertCompiles('SELECT ? AS x', ['a'])).not.toThrow();
  });

  it('does NOT step: a non-terminating statement compiles and returns', () => {
    const start = performance.now();
    expect(() => probe.assertCompiles(NON_TERMINATING, [])).not.toThrow();
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(COMPILE_BUDGET_MS);
  });

  it('does NOT step: it returns no rows and cannot be read for an answer', () => {
    // Stated as a type-level fact by the `void` return, and asserted here
    // because a future "helpful" change that returned `.all()`'s rows would
    // silently reintroduce the unbounded step this method exists to avoid.
    expect(probe.assertCompiles('SELECT 1 AS n', [])).toBeUndefined();
  });

  it('refuses after close', async () => {
    await probe.close();
    expect(() => probe.assertCompiles('SELECT 1', [])).toThrow();
  });
});
