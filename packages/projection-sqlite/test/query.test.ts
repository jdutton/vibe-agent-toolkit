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

import { mkdtempSync, rmSync } from 'node:fs';

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
