/**
 * `vat resources query`'s two pure pieces: the document it emits, and the
 * message it substitutes for an engine-level refusal.
 *
 * Both are exported for this reason and no other — the command itself spawns a
 * crawl, opens a database and calls `process.exit`, so a system test can prove
 * it runs but is a poor place to pin field names or the exact wording a user is
 * shown. These are pure: no file system, no clock, no exit.
 */

import { PROJECTION_TABLES } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import {
  buildProjectionQueryOutputData,
  type ProjectionQueryPayloadInput,
} from '../../src/commands/resources/query.js';
import { describeQueryFailure } from '../../src/utils/projection-query.js';

/** A stand-in for whatever a statement selected. Two rows, so a count of 1 cannot pass. */
const ROWS: readonly Record<string, unknown>[] = [
  { path: 'docs/a.md', headingCount: 3 },
  { path: 'docs/b.md', headingCount: 1 },
];

/**
 * One document, with only the fields a given test is about stated.
 *
 * The defaults are deliberately unremarkable and deliberately DISTINCT from one
 * another: no two of them share a value, so a test that pins a field is pinning
 * that field rather than accidentally matching its neighbour. Overriding is how
 * a test says what it is about.
 */
function payloadFor(
  overrides: Partial<ProjectionQueryPayloadInput> = {},
): Record<string, unknown> {
  return buildProjectionQueryOutputData({
    rows: ROWS,
    root: '/corpus',
    population: 'derived',
    durationMs: 1060,
    populationMs: 190,
    ...overrides,
  });
}

describe('the query payload', () => {
  it('reports where its rows came from, which is the only cache tell there is', () => {
    // 🔑 The field this document exists to carry. A correct store hit and a
    // correct re-derivation produce byte-identical rows, so nothing in `rows`
    // can answer "did the cache work" — only this can, and only because the
    // command observes contributor records rather than inspecting the result.
    const served = payloadFor({ population: 'store' });
    const derived = payloadFor({ population: 'derived' });

    expect(served['population']).toBe('store');
    expect(derived['population']).toBe('derived');
    // The discriminator: two documents that differ ONLY in the tell. If the
    // field were dropped these would be equal, and this suite would be pinning
    // a duration.
    expect(served['population']).not.toBe(derived['population']);
  });

  it('says what the population cost, so the tell is a number and not just a label', () => {
    // 🔑 The companion to `population`. On this repository the two origins are
    // roughly 1.06 s derived against 0.19 s warm, so a reader who is told only
    // `population: store` has to take the saving on faith — and the saving is
    // the entire reason the store exists. Reported in seconds, like every other
    // duration in a vat document.
    const served = payloadFor({ population: 'store', populationMs: 194 });
    const derived = payloadFor({ population: 'derived', populationMs: 1060 });

    expect(served['populationSecs']).toBe(0.194);
    expect(derived['populationSecs']).toBe(1.06);
  });

  it('reports the population cost separately from the whole run', () => {
    // 🪤 The two are NOT the same number and must not be wired to the same
    // input. `durationMs` is the wall time of the command; `populationMs` is the
    // shared setup inside it, which is what a per-statement cost has to be read
    // against. Defaults here are distinct so a swap of the two fields is red.
    const payload = payloadFor({ durationMs: 1500, populationMs: 400 });

    expect(payload['durationSecs']).toBe(1.5);
    expect(payload['populationSecs']).toBe(0.4);
  });

  it('keeps a sub-millisecond population non-zero', () => {
    // 🔑 The whole reason the measurement is `performance.now()` and not
    // `Date.now()`. A warm store population can land under a millisecond; a
    // clock with millisecond granularity reports that as `0`, which reads as
    // "not measured" rather than "very fast". `formatDurationSecs` is three
    // SIGNIFICANT figures, so a fractional millisecond survives serialization.
    const payload = payloadFor({ populationMs: 0.4 });

    expect(payload['populationSecs']).toBe(0.0004);
    expect(payload['populationSecs']).not.toBe(0);
  });

  it('places the population cost immediately after the population origin', () => {
    // This document is read by a human first and parsed second, and the pair
    // only reads as a pair when the two fields are adjacent: "served — and here
    // is what that saved you". Field ORDER is therefore part of the shape, not
    // an accident of the object literal.
    const keys = Object.keys(payloadFor());

    expect(keys).toContain('population');
    expect(keys[keys.indexOf('population') + 1]).toBe('populationSecs');
  });

  it('publishes no `engine` field, because there is only one engine now', () => {
    // ⚠️ A deliberate ABSENCE, pinned. An earlier version published
    // `engine: sqlite | ephemeral` to say which database answered the SQL. It is
    // gone because the answer is always the same: the statement runs against a
    // per-run in-memory database holding this tree and nothing else, and the
    // on-disk store is a population cache that is never queried.
    //
    // 🪤 This pin is about the DOCUMENT, and it must not be read as a guard on
    // the defect the field used to describe. `buildProjectionQueryOutputData` is
    // a pure record builder that never sees a database: pointing the SQL back at
    // the store shared by every root on the machine would need no `engine` field
    // and would leave this assertion green all the way through the regression.
    //
    // What can actually fail on that is the two-root system test — two corpora,
    // ONE store directory, warmed from the corpus the question is not about
    // (`test/system/resources-query.system.test.ts`). This one is kept because a
    // re-added field is real drift in a shape consumers parse, which is the only
    // claim a pure builder is entitled to make.
    const payload = payloadFor();

    expect(payload).not.toHaveProperty('engine');
    expect(payload['population']).toBe('derived');
  });

  it('states the row count beside the rows', () => {
    const payload = payloadFor({ durationMs: 5 });

    expect(payload['status']).toBe('success');
    expect(payload['rowCount']).toBe(2);
    expect(payload['rows']).toBe(ROWS);
    expect(payload['root']).toBe('/corpus');
  });

  it('reports a count of zero rather than omitting the count', () => {
    // An empty result is an ANSWER — "nothing matched" — and a document that
    // dropped the field would make it indistinguishable from a build too old to
    // report one.
    const payload = payloadFor({ rows: [], population: 'store', durationMs: 3 });

    expect(payload['rowCount']).toBe(0);
    expect(payload['rows']).toStrictEqual([]);
  });
});

describe('the failure message', () => {
  it('lists the columns of a table the statement named, when a column was not found', () => {
    // The case this wrapper was written for. VAT ships no schema version, so a
    // renamed column simply breaks a user's SQL; `no such column: contentHash`
    // alone does not say what it is called now, and this is where that is
    // answered.
    const message = describeQueryFailure(
      'SELECT contentHash FROM blobs',
      'no such column: contentHash',
    );

    expect(message).toContain('no such column: contentHash');
    expect(message).toContain(PROJECTION_TABLES.blobs.name);
    expect(message).toContain('contentKey');
    // Only the table that was named — a listing of all twelve would bury it.
    expect(message).not.toContain(PROJECTION_TABLES.blobSections.name);
  });

  it('lists every table when the statement named none of them', () => {
    const message = describeQueryFailure('SELECT * FROM nope', 'no such table: nope');

    expect(message).toContain('no such table: nope');
    for (const spec of Object.values(PROJECTION_TABLES)) {
      expect(message).toContain(spec.name);
    }
  });

  it('leaves a refusal that is not about a name exactly as the engine phrased it', () => {
    // 🪤 A write refusal and a second-statement refusal are not answered by a
    // column list. Appending one says the problem is the schema when the problem
    // is what the caller asked for — and a wrapper that decorates every failure
    // identically teaches the reader to skip the decoration, which costs the
    // case above.
    const write = describeQueryFailure(
      'DELETE FROM blobs',
      'attempt to write a readonly database',
    );

    expect(write).toBe('attempt to write a readonly database');
    expect(write).not.toContain('contentKey');
  });
});
