/**
 * `vat resources query`'s two pure pieces: the report it publishes, and the
 * message it substitutes for an engine-level refusal.
 *
 * Both are exported for this reason and no other — the command itself spawns a
 * crawl, opens a database and calls `process.exit`, so a system test can prove
 * it runs but is a poor place to pin field names or the exact wording a user is
 * shown. These are pure: no file system, no clock, no exit.
 */

import { PROJECTION_TABLES, allDerivedSpecs } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import {
  RESOURCES_QUERY_REPORT_SCHEMA,
  type ResourcesQueryReport,
} from '../../src/commands/resources/query-schema.js';
import {
  buildProjectionQueryReport,
  type ProjectionQueryPayloadInput,
} from '../../src/commands/resources/query.js';
import { describeQueryFailure } from '../../src/utils/projection-query.js';

/** A stand-in for whatever a statement selected. Two rows, so a count of 1 cannot pass. */
const ROWS: readonly Record<string, unknown>[] = [
  { path: 'docs/a.md', headingCount: 3 },
  { path: 'docs/b.md', headingCount: 1 },
];

/**
 * One report, with only the fields a given test is about stated.
 *
 * The defaults are deliberately unremarkable and deliberately DISTINCT from one
 * another: no two of them share a value, so a test that pins a field is pinning
 * that field rather than accidentally matching its neighbour. Overriding is how
 * a test says what it is about. Every report is parsed with the published
 * schema, so a field the schema would refuse is red here, not only on stdout.
 */
function reportFor(overrides: Partial<ProjectionQueryPayloadInput> = {}): ResourcesQueryReport {
  const report = buildProjectionQueryReport({
    columns: ['path', 'headingCount'],
    rows: ROWS,
    membersEnumerated: 7,
    root: '/corpus',
    population: 'derived',
    durationMs: 1060,
    populationMs: 190,
    lensMs: 27,
    // Required on the input, and stated here rather than left to a test that
    // happens to override it: a document built without it took the bounds
    // helper's `includes` on `undefined`, which typecheck cannot catch because
    // test files are not typechecked.
    lensesEvaluated: [],
    ...overrides,
  });
  RESOURCES_QUERY_REPORT_SCHEMA.parse(report);
  return report;
}

/** The report's own `data` — the query's part of the envelope. */
function dataOf(overrides: Partial<ProjectionQueryPayloadInput> = {}): Record<string, unknown> {
  return reportFor(overrides).data as unknown as Record<string, unknown>;
}

describe('the query report', () => {
  it('counts the POPULATION as examined, so zero rows over a populated tree is ok', () => {
    // 🔑 The denominator is what the statement ran OVER, never what it
    // selected: "nothing matched" is an answer, and publishing it as a finding
    // would fail every query whose honest answer is empty.
    const report = reportFor({ rows: [], membersEnumerated: 7 });

    expect(report.status).toBe('ok');
    expect(report.examined).toBe(7);
    expect(report.findings).toEqual([]);
    expect((report.data as { rows: unknown[] }).rows).toStrictEqual([]);
  });

  it('publishes the columns even when the statement selected no row', () => {
    // Rows alone cannot carry the shape of an empty answer.
    expect(dataOf({ rows: [], columns: ['path'] })['columns']).toEqual(['path']);
  });

  it('reports where its rows came from, which is the only cache tell there is', () => {
    // 🔑 The field this document exists to carry. A correct store hit and a
    // correct re-derivation produce byte-identical rows, so nothing in `rows`
    // can answer "did the cache work" — only this can, and only because the
    // command observes contributor records rather than inspecting the result.
    const served = dataOf({ population: 'store' });
    const derived = dataOf({ population: 'derived' });

    expect(served['population']).toBe('store');
    expect(derived['population']).toBe('derived');
    // The discriminator: two documents that differ ONLY in the tell.
    expect(served['population']).not.toBe(derived['population']);
  });

  it('says what the population cost, so the tell is a number and not just a label', () => {
    // 🔑 The companion to `population`. Measured on this repository with the
    // parse cache warm, the two origins are 1.16-1.18 s derived against
    // 0.29-0.31 s served, so a reader who is told only `population: store` has
    // to take the saving on faith. The millisecond inputs below are STAND-INS
    // chosen to serialize distinctly, not measurements.
    const served = dataOf({ population: 'store', populationMs: 294 });
    const derived = dataOf({ population: 'derived', populationMs: 1170 });

    // 5e-11 windows: EXACTNESS assertions, not tolerances.
    expect(served['populationSecs']).toBeCloseTo(0.294, 10);
    expect(derived['populationSecs']).toBeCloseTo(1.17, 10);
  });

  it('reports the population cost separately from the whole run', () => {
    // 🪤 The two are NOT the same number and must not be wired to the same
    // input: the run's wall time is the envelope's `durationMs`; the population
    // is the shared setup inside it.
    const report = reportFor({ durationMs: 1500, populationMs: 400 });

    expect(report.durationMs).toBe(1500);
    expect((report.data as { populationSecs: number }).populationSecs).toBeCloseTo(0.4, 10);
  });

  it('keeps a sub-millisecond population non-zero', () => {
    // 🔑 Why the measurement is `performance.now()`: a warm store population
    // can land under a millisecond, and a rounded `0` reads as "not measured".
    const data = dataOf({ populationMs: 0.4 });

    expect(data['populationSecs']).toBeCloseTo(0.0004, 10);
    expect(data['populationSecs']).not.toBe(0);
  });

  it('publishes what the LENS cost, as a field of its own', () => {
    // 🚨 `lensSecs` once shipped with no test naming it. Distinct from
    // `populationMs` in the fixture so wiring the two to one input is red.
    const report = reportFor({ populationMs: 400, lensMs: 27 });
    const data = report.data as { lensSecs: number; populationSecs: number };

    expect(data.lensSecs).toBeCloseTo(0.027, 10);
    expect(data.populationSecs).toBeCloseTo(0.4, 10);
    // 🔑 The two spans are DISJOINT; neither may exceed the run containing both.
    expect((data.populationSecs + data.lensSecs) * 1000).toBeLessThanOrEqual(report.durationMs ?? 0);
  });

  it('places the population cost immediately after the population origin', () => {
    // Field ORDER is part of the shape: the pair reads as a pair only adjacent.
    const keys = Object.keys(dataOf());

    expect(keys[keys.indexOf('population') + 1]).toBe('populationSecs');
  });

  it('publishes no `engine` field, because there is only one engine now', () => {
    // ⚠️ A deliberate ABSENCE, pinned. The statement always runs against a
    // per-run in-memory database; the two-root system test is what can fail on
    // the defect the old field described — this pins only the shape.
    const data = dataOf();

    expect(data).not.toHaveProperty('engine');
    expect(data['population']).toBe('derived');
  });

  it('publishes the rows and the root, and no second count beside `rows`', () => {
    const data = dataOf();

    expect(data['rows']).toEqual(ROWS);
    expect(data['root']).toBe('/corpus');
    // `rows.length` is the count; a `rowCount` beside it is a second answer.
    expect(data).not.toHaveProperty('rowCount');
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
    // Only the table that was named — a listing of all thirteen would bury it.
    expect(message).not.toContain(PROJECTION_TABLES.blobSections.name);
  });

  it('lists every table when the statement named none of them', () => {
    const message = describeQueryFailure('SELECT * FROM nope', 'no such table: nope');

    expect(message).toContain('no such table: nope');
    for (const spec of Object.values(PROJECTION_TABLES)) {
      expect(message).toContain(spec.name);
    }
  });

  it.each([
    ['edges', 'SELECT COUNT(*) FROM edges', 'no such table: edges'],
    ['a schema-qualified spelling', 'SELECT COUNT(*) FROM main.edges', 'no such table: main.edges'],
    ['another case', 'SELECT COUNT(*) FROM EDGES', 'no such table: EDGES'],
  ])('explains a DERIVED relation missing as "not evaluated for this run": %s', (_what, sql, engine) => {
    // 🚨 The query store has no table for a relation no lens filled, so this
    // engine message is the refusal of an unevaluated relation — not a typo. A
    // listing of "what you could have named" would include the very relation
    // SQLite just said is missing, and read as a contradiction.
    const message = describeQueryFailure(sql, engine);

    expect(message).toContain(engine);
    expect(message).toMatch(/edges.*not evaluated for this run/s);
    expect(message).toContain('Declare this statement');
  });

  it('names EVERY derived relation from the registry, not a hand-kept list', () => {
    for (const spec of allDerivedSpecs()) {
      expect(describeQueryFailure(`SELECT * FROM ${spec.name}`, `no such table: ${spec.name}`))
        .toContain('not evaluated for this run');
    }
  });

  it('does not call a missing PROJECTION table unevaluated', () => {
    expect(describeQueryFailure('SELECT * FROM edgesx', 'no such table: edgesx'))
      .not.toContain('not evaluated');
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
