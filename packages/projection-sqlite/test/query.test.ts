/**
 * Asking the store a question it was not written to answer.
 *
 * Everything else this store does is keyed: `readExtent` hands back one tree's
 * rows, `readBlobFacts` one blob's. Stage 5's whole point is the unkeyed
 * question — *which resources are in this directory*, *which references have no
 * extension*, *how many sections does the deepest file have* — and none of them
 * are expressible as a key lookup.
 *
 * ## Two properties, and the second is the one that bites
 *
 * **Rows come back exactly as SQLite holds them, undecoded.** That is a
 * decision, not an omission: `decodeRows` can only run against a known
 * {@link StoredTableSpec}, and arbitrary SQL has no spec — `SELECT COUNT(*)`,
 * a join, an alias and an expression all produce columns no registry describes.
 * Decoding "where we can" would mean a boolean that arrives as `true` from one
 * query and `1` from another depending on whether the caller happened to select
 * a bare column, which is worse than one honest rule.
 *
 * **A query may not write.** The surface is a read, and a caller who can reach
 * `DELETE` through it can silently empty another process's cache — a store is
 * shared by every `vat` invocation on the machine.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import type { ExtentKey } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { normalizedTmpdir } from '@vibe-agent-toolkit/utils/fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  openEphemeralProjectionStore,
  openSqliteProjectionStore,
  type SqlQueryableStore,
} from '../src/store.js';

import { FIRST_BLOB, SECOND_BLOB, sampleBlobRows, sampleExtentRows } from './fixtures.js';

const KEY: ExtentKey = { rootId: 'root-1', treeHash: 'tree-aaa' };

/** Asked after every refusal, to prove the refusal was real and not just a message. */
const COUNT_BLOBS = 'SELECT COUNT(*) AS n FROM "blobs"';

let store: SqlQueryableStore;

beforeEach(async () => {
  store = openEphemeralProjectionStore();
  await store.writeBlobFacts(sampleBlobRows());
  await store.writeBlobFacts(sampleBlobRows(SECOND_BLOB));
  await store.writeExtent(KEY, sampleExtentRows(FIRST_BLOB));
});

afterEach(async () => {
  await store.close();
});

describe('query', () => {
  it('answers an aggregate no keyed read can express', () => {
    const rows = store.query(COUNT_BLOBS);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.['n'], 'two blobs were written').toBe(2);
  });

  it('answers a predicate over a non-key column', () => {
    const rows = store.query('SELECT "contentKey" FROM "blobs" WHERE "encoding" = ?', 'utf-16le');

    const byText = (a: unknown, b: unknown): number => String(a).localeCompare(String(b));
    expect(rows.map((row) => row['contentKey']).sort(byText))
      .toEqual([FIRST_BLOB, SECOND_BLOB].sort(byText));
  });

  it('returns an empty result rather than throwing when nothing matches', () => {
    expect(store.query('SELECT * FROM "blobs" WHERE "encoding" = ?', 'no-such-encoding')).toEqual([]);
  });

  it('hands back SQLite\'s own values, undecoded', () => {
    // `frontmatter` is a JSON column: stored as text, and it must come back as
    // text rather than as a parsed object. A caller selecting an expression over
    // it would otherwise get a different type than a caller selecting the
    // column, from the same store.
    const rows = store.query('SELECT "frontmatter" FROM "blobs" WHERE "contentKey" = ?', FIRST_BLOB);

    expect(typeof rows[0]?.['frontmatter'], 'a JSON column decoded itself on the way out').toBe('string');
  });

  it('refuses a statement that writes', () => {
    expect(() => store.query('DELETE FROM "blobs"')).toThrow(/read/i);
    // And the refusal is real, not a message: the rows are still there.
    expect(store.query(COUNT_BLOBS)[0]?.['n']).toBe(2);
  });

  it('refuses a write hidden behind a leading comment or extra whitespace', () => {
    expect(() => store.query('  /* just looking */ DROP TABLE "blobs"')).toThrow(/read/i);
    expect(store.query(COUNT_BLOBS)[0]?.['n']).toBe(2);
  });

  it('refuses a second statement smuggled after a legitimate select', () => {
    expect(() => store.query('SELECT 1; DELETE FROM "blobs"')).toThrow();
    expect(store.query(COUNT_BLOBS)[0]?.['n']).toBe(2);
  });

  it('does not mistake a semicolon inside a string literal for a second statement', () => {
    // The separator scan has to understand literals, or every query about text
    // containing a `;` is refused — and headings, link text and frontmatter all
    // contain them.
    expect(store.query("SELECT ';' AS x")[0]?.['x']).toBe(';');
  });

  it("understands SQL's doubled-quote escape inside that literal", () => {
    // `'it''s; fine'` is ONE string. A scanner that ended the literal at the
    // second quote would see the `;` as top-level and refuse a valid query.
    expect(store.query("SELECT 'it''s; fine' AS x")[0]?.['x']).toBe("it's; fine");
  });

  it('does not mistake a semicolon inside a comment for a second statement', () => {
    expect(store.query('SELECT 1 AS x -- trailing ; comment')[0]?.['x']).toBe(1);
  });

  it('allows a single trailing semicolon, which terminates rather than separates', () => {
    expect(store.query('SELECT 1 AS x;')[0]?.['x']).toBe(1);
  });

  it('reports an unknown column as a legible error naming it', () => {
    // Stage 5 binds user text to column names and VAT ships no schema version,
    // so a column that moves simply breaks the caller's SQL. A raw SQLite error
    // reaching the user is what this guards against.
    expect(() => store.query('SELECT "noSuchColumn" FROM "blobs"')).toThrow(/noSuchColumn/);
  });

  it('rejects a closed store rather than answering from a dead connection', async () => {
    const doomed = openEphemeralProjectionStore();
    await doomed.close();

    expect(() => doomed.query('SELECT 1 AS n')).toThrow();
  });
});

/**
 * What a foreign database holds, so a leak is recognisable rather than inferred.
 *
 * The real target is `tmpdir/.vat-cache/<version>/projection-*`, whose rows are
 * link text, heading text and frontmatter from every repository on the machine.
 * A stand-in with one obvious string proves the same reachability without
 * needing that cache to exist.
 */
const FOREIGN_SECRET = 'not-this-repository';

/**
 * A real SQLite file that this store has no business reading.
 *
 * @param directory - Where to put it
 * @returns Its absolute path
 */
function writeForeignDatabase(directory: string): string {
  const path = safePath.join(directory, 'secret.db');
  const foreign = new DatabaseSync(path);
  foreign.exec('CREATE TABLE "secrets" ("k" TEXT, "v" TEXT)');
  foreign.exec(`INSERT INTO "secrets" VALUES ('client', '${FOREIGN_SECRET}')`);
  foreign.close();
  return path;
}

/**
 * Attach, and tolerate the statement-kind gate refusing to.
 *
 * 🪤 Deliberately not an assertion that it throws. Two independent guards stop a
 * foreign schema outliving a call — the kind gate refuses `ATTACH`, and the
 * detach sweep unwinds one that got through — and a test that pinned the first
 * here would go vacuous the moment the second was the one under examination. The
 * assertions that follow the call have to hold either way, which is the whole
 * point of there being two.
 *
 * @param path - The database to try to attach
 */
function attachIfTheGateLetsIt(path: string): void {
  try {
    store.query(`ATTACH DATABASE '${path}' AS smuggled`);
  } catch (error) {
    expect(String(error), 'refused, but for some other reason').toMatch(/SELECT/);
  }
}

describe('query cannot reach a database it was not opened on', () => {
  let directory: string;
  let secretPath: string;

  beforeEach(() => {
    directory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-projection-attach-'));
    secretPath = writeForeignDatabase(directory);
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('refuses ATTACH, which the engine itself accepts under query_only', () => {
    const fresh = safePath.join(directory, 'created-by-attach.db');

    expect(() => store.query(`ATTACH DATABASE '${fresh}' AS smuggled`)).toThrow(/SELECT/);
    // A name this test built inside its own `mkdtempSync` directory moments ago.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above
    expect(existsSync(fresh), 'the attach ran and left a file behind').toBe(false);
  });

  it('cannot carry an attached schema from one call into the next', () => {
    // The reproduction that matters: `vat resources check` runs every declared
    // check through ONE connection, so check `a` attaching and check `b` reading
    // is not a contrived sequence — it is the shape of the command.
    attachIfTheGateLetsIt(secretPath);

    expect(() => store.query('SELECT "v" FROM "smuggled"."secrets"')).toThrow(/no such table/i);
    expect(
      store.query('SELECT "name" FROM pragma_database_list').map((row) => row['name']),
      'a foreign schema survived the call that attached it',
    ).toEqual(['main']);
  });
});

describe('query requires a statement that is a query', () => {
  it.each([
    ['ATTACH', "ATTACH DATABASE ':memory:' AS x"],
    ['PRAGMA', 'PRAGMA query_only = 0'],
    ['EXPLAIN', 'EXPLAIN SELECT 1'],
    ['EXPLAIN QUERY PLAN', 'EXPLAIN QUERY PLAN SELECT 1'],
    ['a bare table name', '"blobs"'],
  ])('refuses %s, which cannot fail and so cannot be a check', (_kind, sql) => {
    // A statement SQLite accepts and that yields no rows is indistinguishable
    // from a check that passed, because selecting nothing is what success means
    // on the `resources.checks` surface.
    expect(() => store.query(sql)).toThrow(/SELECT/);
    expect(store.query(COUNT_BLOBS)[0]?.['n']).toBe(2);
  });

  it.each([
    ['SELECT', 'SELECT 1 AS n', 'n'],
    ['a lower-case select', 'select 1 as n', 'n'],
    ['WITH', 'WITH c("n") AS (VALUES (1)) SELECT "n" FROM c', 'n'],
    ['VALUES', 'VALUES (1)', 'column1'],
    ['a leading line comment', '-- looking\nSELECT 1 AS n', 'n'],
    ['a leading block comment', '/* looking */ SELECT 1 AS n', 'n'],
  ])('accepts %s', (_kind, sql, column) => {
    expect(store.query(sql)[0]?.[column]).toBe(1);
  });

  it('leaves query_only carrying the writes a leading token cannot see', () => {
    // `WITH … DELETE` is real SQLite grammar and its first token is `WITH`, so
    // the kind gate passes it and the ENGINE is what refuses (measured on Node
    // 24.13.1). This is the case that makes the two guards layered rather than
    // one of them decoration — do not delete it to "cover" the token gate.
    expect(() => store.query('WITH c(a) AS (VALUES (1)) DELETE FROM "blobs"')).toThrow(/read/i);
    expect(store.query(COUNT_BLOBS)[0]?.['n']).toBe(2);
  });
});

describe('what follows the terminating semicolon', () => {
  it.each([
    ['a line comment', 'SELECT 1 AS n; -- done'],
    ['a block comment', 'SELECT 1 AS n; /* done */'],
    ['both, over several lines', 'SELECT 1 AS n;\n-- see ADR-14\n/* and this */\n'],
  ])('accepts %s, which SQLite would not have run anyway', (_kind, sql) => {
    // A `resources.checks` statement written as a YAML block scalar ending
    // `…;  -- see ADR-14` used to become a "could not run" ERROR finding and
    // fail the adopter's gate over a comment.
    expect(store.query(sql)[0]?.['n']).toBe(1);
  });

  it.each([
    ['a second statement', 'SELECT 1 AS n; DELETE FROM "blobs"'],
    ['a second statement hidden behind a comment', 'SELECT 1 AS n; -- ok\nDELETE FROM "blobs"'],
    ['a stray literal, which SQLite would also discard', "SELECT 1 AS n; 'leftover'"],
  ])('still refuses %s', (_kind, sql) => {
    expect(() => store.query(sql)).toThrow(/single statement/);
    expect(store.query(COUNT_BLOBS)[0]?.['n']).toBe(2);
  });
});

describe('the separator scan agrees with SQLite on all four quoting forms', () => {
  // The guard on the guard. SQLite accepts `'…'`, `"…"`, `` `…` `` and `[…]`,
  // and a scanner that knows only some of them DESYNCHRONISES: it walks into the
  // form it does not know, mistakes a character inside for a delimiter, and
  // swallows the real `;` — so the guard passes and SQLite silently discards the
  // smuggled tail. These cases are chosen for what a refactor would break.
  it.each([
    ['a double-quoted identifier', 'SELECT 1 AS "a;b"', 'a;b'],
    ['a back-quoted identifier', 'SELECT 1 AS `a;b`', 'a;b'],
    ['a bracketed identifier', 'SELECT 1 AS [a;b]', 'a;b'],
    ['a doubled quote inside a double-quoted identifier', 'SELECT 1 AS "a""b;c"', 'a"b;c'],
    ['a doubled back-quote', 'SELECT 1 AS `a``b;c`', 'a`b;c'],
    ['a line-comment opener inside brackets', 'SELECT 1 AS [a--b]', 'a--b'],
    ['a block-comment opener inside brackets', 'SELECT 1 AS [a/*b]', 'a/*b'],
  ])('accepts a legitimate %s holding a semicolon', (_form, sql, column) => {
    expect(store.query(sql)[0]?.[column]).toBe(1);
  });

  it('accepts an unterminated block comment, which really does swallow the rest', () => {
    // Not a hole: SQLite runs the same text the same way (measured on Node
    // 24.13.1 — it returns the one row), so the `DELETE` is a comment to both.
    expect(store.query('SELECT 1 AS n /* still a comment ; DELETE FROM "blobs"')[0]?.['n']).toBe(1);
    expect(store.query(COUNT_BLOBS)[0]?.['n']).toBe(2);
  });

  it.each([
    ['a double-quoted identifier', 'SELECT 1 AS "a;b"; DELETE FROM "blobs"'],
    ['a back-quoted identifier holding an apostrophe', "SELECT 1 AS `a'b`; DELETE FROM \"blobs\""],
    ['a bracketed identifier', 'SELECT 1 AS [a;b]; DELETE FROM "blobs"'],
    ['a string literal', 'SELECT \'x;y\' AS n; DELETE FROM "blobs"'],
    ['a doubled double-quote', 'SELECT 1 AS "a""b"; DELETE FROM "blobs"'],
    ['a doubled back-quote', 'SELECT 1 AS `a``b`; DELETE FROM "blobs"'],
    ['a bracket opener inside a string literal', 'SELECT \'[\' AS n; DELETE FROM "blobs"'],
    ['a bracket SQLite itself ends at the first ]', 'SELECT 1 AS [a]]b]; DELETE FROM "blobs"'],
  ])('refuses a second statement smuggled past %s', (_form, sql) => {
    expect(() => store.query(sql)).toThrow(/single statement/);
    expect(store.query(COUNT_BLOBS)[0]?.['n'], 'the smuggled DELETE ran').toBe(2);
  });
});

describe('query answers identically on the file-backed store', () => {
  let directory: string;
  let onDisk: SqlQueryableStore;

  beforeEach(async () => {
    directory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-projection-query-'));
    onDisk = openSqliteProjectionStore({ directory });
    await onDisk.writeBlobFacts(sampleBlobRows());
    await onDisk.writeBlobFacts(sampleBlobRows(SECOND_BLOB));
    await onDisk.writeExtent(KEY, sampleExtentRows(FIRST_BLOB));
  });

  afterEach(async () => {
    await onDisk.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('gives the same rows for the same SQL', () => {
    const sql = 'SELECT "contentKey", "encoding", "wordCount" FROM "blobs" ORDER BY "contentKey"';

    const fromDisk = onDisk.query(sql);

    expect(fromDisk.length, 'the control returned nothing — the comparison is vacuous').toBeGreaterThan(0);
    expect(store.query(sql)).toEqual(fromDisk);
  });
});
