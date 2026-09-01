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
  describeQueryFailure,
} from '../../src/commands/resources/query.js';

/** A stand-in for whatever a statement selected. Two rows, so a count of 1 cannot pass. */
const ROWS: readonly Record<string, unknown>[] = [
  { path: 'docs/a.md', headingCount: 3 },
  { path: 'docs/b.md', headingCount: 1 },
];

describe('the query payload', () => {
  it('reports where its rows came from, which is the only cache tell there is', () => {
    // 🔑 The field this document exists to carry. A correct store hit and a
    // correct re-derivation produce byte-identical rows, so nothing in `rows`
    // can answer "did the cache work" — only this can, and only because the
    // command observes contributor records rather than inspecting the result.
    const served = buildProjectionQueryOutputData({
      rows: ROWS, root: '/corpus', population: 'store', engine: 'sqlite', durationMs: 120,
    });
    const derived = buildProjectionQueryOutputData({
      rows: ROWS, root: '/corpus', population: 'derived', engine: 'sqlite', durationMs: 1200,
    });

    expect(served['population']).toBe('store');
    expect(derived['population']).toBe('derived');
    // The discriminator: two documents that differ ONLY in the tell. If the
    // field were dropped these would be equal, and this suite would be pinning
    // a duration.
    expect(served['population']).not.toBe(derived['population']);
  });

  it('reports the engine separately, because an ephemeral run is not a cache miss', () => {
    // The two facts come apart. `ephemeral` is always `derived`, but `sqlite`
    // is either — so collapsing them into one field would make "no store was
    // selected" and "the store was cold" indistinguishable, which is exactly
    // the pair a reader needs to tell apart before trusting a timing.
    const payload = buildProjectionQueryOutputData({
      rows: ROWS, root: '/corpus', population: 'derived', engine: 'ephemeral', durationMs: 900,
    });

    expect(payload['engine']).toBe('ephemeral');
    expect(payload['population']).toBe('derived');
  });

  it('states the row count beside the rows', () => {
    const payload = buildProjectionQueryOutputData({
      rows: ROWS, root: '/corpus', population: 'derived', engine: 'ephemeral', durationMs: 5,
    });

    expect(payload['status']).toBe('success');
    expect(payload['rowCount']).toBe(2);
    expect(payload['rows']).toBe(ROWS);
    expect(payload['root']).toBe('/corpus');
  });

  it('reports a count of zero rather than omitting the count', () => {
    // An empty result is an ANSWER — "nothing matched" — and a document that
    // dropped the field would make it indistinguishable from a build too old to
    // report one.
    const payload = buildProjectionQueryOutputData({
      rows: [], root: '/corpus', population: 'store', engine: 'sqlite', durationMs: 3,
    });

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
