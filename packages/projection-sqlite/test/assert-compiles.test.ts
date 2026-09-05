/**
 * `SqlQueryableStore.assertCompiles` — the compile-only half of `query`.
 *
 * SQLite resolves every table and column name when a statement is PREPARED, so
 * a typo is knowable before a single row exists. It was not knowable in
 * practice: the only place a statement met the schema was after the caller had
 * populated the projection, so on a real adopter tree `SELECT contentKey,
 * no_such_column FROM blobs` cost 8.3 s — every millisecond of it building rows
 * the statement could never have read.
 *
 * These tests pin the two properties that make this worth having and not merely
 * a second copy of `query`: it REFUSES what `query` refuses, and it does not
 * STEP. The second one is the sharp edge — a preflight that executed would hang
 * on the very statement class the budget exists for.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openEphemeralProjectionStore, type SqlQueryableStore } from '../src/store.js';

import { sampleBlobRows } from './fixtures.js';

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

let store: SqlQueryableStore;

beforeEach(() => {
  store = openEphemeralProjectionStore();
});

afterEach(async () => {
  await store.close();
});

describe('assertCompiles', () => {
  it('accepts a statement the schema can answer, against ZERO rows', () => {
    // The point of the preflight: no population has happened, and the schema is
    // still the whole authority on whether the names resolve.
    expect(() => store.assertCompiles('SELECT path FROM resource_realizations')).not.toThrow();
  });

  it('refuses an unknown column, naming it', () => {
    expect(() => store.assertCompiles('SELECT contentKey, no_such_column FROM blobs'))
      .toThrow(/no such column: no_such_column/);
  });

  it('refuses an unknown table, naming it', () => {
    expect(() => store.assertCompiles('SELECT * FROM no_such_table'))
      .toThrow(/no such table: no_such_table/);
  });

  it('refuses a statement that is not a query, exactly as `query` does', () => {
    // Moving the KIND gate in front of the population is half the win: a
    // statement refused for what it IS should not cost more than one refused for
    // what it names.
    expect(() => store.assertCompiles('ATTACH DATABASE \'evil.db\' AS e')).toThrow();
    expect(() => store.assertCompiles('PRAGMA query_only = 0')).toThrow();
    expect(() => store.assertCompiles('DELETE FROM blobs')).toThrow();
  });

  it('refuses a second statement, exactly as `query` does', () => {
    expect(() => store.assertCompiles('SELECT 1; DELETE FROM blobs')).toThrow();
  });

  it('does NOT step: a non-terminating statement compiles and returns', () => {
    const start = performance.now();
    expect(() => store.assertCompiles(NON_TERMINATING)).not.toThrow();
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(COMPILE_BUDGET_MS);
  });

  it('does NOT step: it returns no rows and cannot be read for an answer', () => {
    // Stated as a type-level fact by the `void` return, and asserted here
    // because a future "helpful" change that returned `.all()`'s rows would
    // silently reintroduce the unbounded step this method exists to avoid.
    expect(store.assertCompiles('SELECT 1 AS n')).toBeUndefined();
  });

  it('leaves the connection WRITABLE, so the next write is not refused', async () => {
    // `query_only` is set for the compile and restored in `finally`. The failure
    // this guards is delayed and confusing: a `writeBlobFacts` failing with
    // "attempt to write a readonly database" with no query in sight.
    store.assertCompiles('SELECT contentKey FROM blobs');
    await expect(store.writeBlobFacts(sampleBlobRows())).resolves.toBeUndefined();
  });

  it('refuses after close, exactly as every other method does', async () => {
    await store.close();
    expect(() => store.assertCompiles('SELECT 1')).toThrow();
  });
});
