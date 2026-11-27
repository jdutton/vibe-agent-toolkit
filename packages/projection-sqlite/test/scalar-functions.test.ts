/**
 * The scalar functions VAT registers on every run database and compile probe: `sha256(x)`, and
 * `regexp(pattern, text[, flags])` with the `text REGEXP pattern` operator that calls it.
 */

import { createHash } from 'node:crypto';

import { PROJECTION_STATEMENT_REFUSED_CODE } from '@vibe-agent-toolkit/resources';
import { afterEach, describe, expect, it } from 'vitest';

import { hydrateRunDatabase, openProjectionCompileProbe, type RunDatabase } from '../src/run-database.js';

/** A run database holding no relation: the function needs none. */
function emptyRunDatabase(): RunDatabase {
  return hydrateRunDatabase({ rootId: 'root-1', relations: new Map() });
}

/** The lowercase hex SHA-256 of some bytes, by Node's own digest. */
function hexOf(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

let open: RunDatabase | undefined;

afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe('sha256(x)', () => {
  it('hashes a TEXT value as its UTF-8 bytes, as lowercase hex', () => {
    open = emptyRunDatabase();
    expect(open.query("SELECT sha256('x') AS d, sha256('é') AS e")).toEqual([{ d: hexOf('x'), e: hexOf(Buffer.from('é', 'utf8')) }]);
  });

  it('hashes a BLOB value as its bytes, and the empty string as the empty input', () => {
    open = emptyRunDatabase();
    expect(open.query("SELECT sha256(X'00ff') AS d, sha256('') AS e")).toEqual([{ d: hexOf(Uint8Array.of(0, 255)), e: hexOf('') }]);
  });

  it('hashes TEXT holding invalid UTF-8 as its U+FFFD reading, and its BLOB cast as the stored bytes', () => {
    open = emptyRunDatabase();
    expect(open.query("SELECT sha256(CAST(X'61ff' AS TEXT)) AS t, sha256(CAST(CAST(X'61ff' AS TEXT) AS BLOB)) AS b"))
      .toEqual([{ t: hexOf(Uint8Array.of(0x61, 0xef, 0xbf, 0xbd)), b: hexOf(Uint8Array.of(0x61, 0xff)) }]);
  });

  it('answers NULL for NULL', () => {
    open = emptyRunDatabase();
    expect(open.query('SELECT sha256(NULL) AS d')).toEqual([{ d: null }]);
  });

  it('answers NULL for a number, whose text SQLite and JavaScript spell differently, and hashes its CAST', () => {
    open = emptyRunDatabase();
    expect(open.query("SELECT sha256(1) AS i, sha256(1.0) AS r, sha256(9223372036854775807) AS big, sha256(CAST(1.0 AS TEXT)) AS t"))
      .toEqual([{ i: null, r: null, big: null, t: hexOf('1.0') }]);
  });

  it.for([
    ['the type test first', "typeof(v) = 'text' AND sha256(v) = ?"],
    ['the digest first', "sha256(v) = ? AND typeof(v) = 'text'"],
  ] as const)('answers a column of mixed types the same whichever term comes first: %s', ([, where]) => {
    open = emptyRunDatabase();
    const sql = `WITH t(v) AS (VALUES ('a'), (1), (1.5), (9223372036854775807)) SELECT v FROM t WHERE ${where}`;
    expect(open.query(sql, hexOf('a'))).toEqual([{ v: 'a' }]);
  });

  it('compiles in the preflight probe, so a statement using it is not refused before the population', async () => {
    const probe = openProjectionCompileProbe();
    try {
      expect(() => probe.assertCompiles("SELECT sha256('x') AS d", [])).not.toThrow();
    } finally {
      await probe.close();
    }
  });
});

describe('regexp(pattern, text) and X REGEXP Y', () => {
  it('matches with a JavaScript RegExp, as a function and as the REGEXP operator, answering 1 or 0', () => {
    open = emptyRunDatabase();
    expect(open.query(String.raw`SELECT regexp('^@progress/kendo-[\w.-]*$', '@progress/kendo-ui') AS f, 'abc' REGEXP 'B' AS o, 'abc' REGEXP 'b' AS p`))
      .toEqual([{ f: 1, o: 0, p: 1 }]);
  });

  it('reads the pattern under the u flag, so a code point outside the BMP is one character', () => {
    open = emptyRunDatabase();
    const smile = String.fromCodePoint(0x1_f6_00);
    expect(open.query('SELECT regexp(?, ?) AS d', '^.$', smile)).toEqual([{ d: 1 }]);
  });

  it('takes flags i, m and s as an optional third argument, and refuses any other', () => {
    open = emptyRunDatabase();
    const run = open;
    expect(run.query("SELECT regexp('B', 'abc', 'i') AS i, regexp('^b$', 'a' || char(10) || 'b', 'm') AS m, regexp('a.b', 'a' || char(10) || 'b', 's') AS s"))
      .toEqual([{ i: 1, m: 1, s: 1 }]);
    expect(() => run.query("SELECT regexp('a', 'a', 'g') AS d")).toThrow(/regexp.*flags.*i, m, s/);
  });

  it('answers NULL when the pattern or the text is NULL', () => {
    open = emptyRunDatabase();
    expect(open.query("SELECT regexp(NULL, 'a') AS p, regexp('a', NULL) AS t, NULL REGEXP 'a' AS o")).toEqual([{ p: null, t: null, o: null }]);
  });

  it('refuses a malformed pattern or flags even when every text is NULL, so a bad pattern never passes silently', () => {
    open = emptyRunDatabase();
    const run = open;
    expect(() => run.query("SELECT regexp('(', NULL) AS d")).toThrow(/regexp.*"\("/);
    expect(() => run.query("SELECT regexp('a', NULL, 'g') AS d")).toThrow(/regexp.*flags.*i, m, s/);
    expect(() => run.query("SELECT regexp('a', NULL, NULL) AS d")).toThrow(/regexp.*flags.*TEXT/);
    expect(() => run.query("SELECT regexp(1, NULL) AS d")).toThrow(/regexp.*pattern.*TEXT/);
  });

  it('never evaluates a malformed pattern over zero rows', () => {
    open = emptyRunDatabase();
    expect(open.query("WITH t(v) AS (SELECT 'a' WHERE 0) SELECT regexp('(', v) AS d FROM t")).toEqual([]);
  });

  it('refuses a repeated flag, naming the repeat', () => {
    open = emptyRunDatabase();
    const run = open;
    expect(() => run.query("SELECT regexp('a', 'A', 'ii') AS d")).toThrow(/regexp.*flag "i" more than once.*"ii"/);
  });

  it('answers NULL for an integer text past 2^53, and refuses one as the pattern, as the statement\'s fault', () => {
    open = emptyRunDatabase();
    const run = open;
    expect(run.query("SELECT regexp('1', 9223372036854775807) AS d")).toEqual([{ d: null }]);
    expect(() => run.query("SELECT regexp(9223372036854775807, 'a') AS d")).toThrow(expect.objectContaining({ code: PROJECTION_STATEMENT_REFUSED_CODE }) as Error);
  });

  it('refuses a pattern that does not compile, naming it', () => {
    open = emptyRunDatabase();
    const run = open;
    expect(() => run.query("SELECT regexp('(', 'a') AS d")).toThrow(/regexp.*"\("/);
  });

  it('answers NULL for a text that is not TEXT, so a column of mixed types is matched row by row', () => {
    open = emptyRunDatabase();
    expect(open.query("SELECT regexp('1', 1) AS i, regexp('1', 1.5) AS r, regexp('1', X'31') AS b, regexp('1', CAST(1 AS TEXT)) AS t"))
      .toEqual([{ i: null, r: null, b: null, t: 1 }]);
  });

  it('refuses a pattern that is not TEXT', () => {
    open = emptyRunDatabase();
    const run = open;
    expect(() => run.query("SELECT regexp(1, '1') AS d")).toThrow(/regexp.*pattern.*TEXT/);
  });

  it('refuses as the statement\'s fault, under the statement-refusal code', () => {
    open = emptyRunDatabase();
    const run = open;
    let thrown: unknown;
    try {
      run.query("SELECT regexp('(', 'a') AS a");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: PROJECTION_STATEMENT_REFUSED_CODE });
  });

  it('compiles in the preflight probe', async () => {
    const probe = openProjectionCompileProbe();
    try {
      expect(() => probe.assertCompiles("SELECT 'a' REGEXP 'a' AS d", [])).not.toThrow();
    } finally {
      await probe.close();
    }
  });
});
