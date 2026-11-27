/**
 * The query lane's `blob_references` on a store hit: copied from the store inside SQLite for
 * exactly the keys the hit admitted. Four claims through the real lane and the real backend:
 * no other repository's rows reach the run database from the store both share, the copy holds
 * what a store-off run derives (and ran: every row counted copied), a key evicted between the hit
 * and the copy makes the lane populate again rather than answer short, and that second population
 * hands its own rows, never a second copy, and repeats none of the first's warnings.
 */

import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import type * as ProjectionSqlite from '@vibe-agent-toolkit/projection-sqlite';
import { PROJECTION_STORE_ROWS_EVICTED_CODE, StoredRowsEvictedError } from '@vibe-agent-toolkit/resources';
import { isVatError, readWorkCounters, safePath, VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/utils';
import { __resetWorkCountersForTest, createTempDir, removeTempDir } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { rowsByContent } from '../helpers/cache-differential.js';
import { storeFilesUnder } from '../helpers/projection-store-probe.js';
import { commitTestFixture } from '../test-helpers.js';

/** Set by a test: run once, before the first hydration that copies from the store. */
let beforeFirstCopy: ((source: ProjectionSqlite.StoredRows) => void) | undefined;

vi.mock('@vibe-agent-toolkit/projection-sqlite', async (importOriginal) => {
  const original = await importOriginal<typeof ProjectionSqlite>();
  return {
    ...original,
    hydrateRunDatabase: (hydration: ProjectionSqlite.RunDatabaseHydration) => {
      const stored = [...hydration.relations.values()].find((source) => 'stored' in source);
      if (stored !== undefined && 'stored' in stored && beforeFirstCopy !== undefined) {
        const run = beforeFirstCopy;
        beforeFirstCopy = undefined;
        run(stored.stored);
      }
      return original.hydrateRunDatabase(hydration);
    },
  };
});

const { PROJECTION_STORE_ENV, TEST_EVICT_ROW_SET_ENV } = await import('../../src/utils/projection-store.js');
const { withQueriedProjection } = await import('../../src/utils/projection-query.js');

/** Every reference row, in a fixed order: what the run database answers with. */
const EVERY_REFERENCE = 'SELECT blob, ordinal, syntacticForm, rawRef FROM blob_references ORDER BY blob, ordinal';

const made: string[] = [];

afterEach(() => {
  beforeFirstCopy = undefined;
  vi.unstubAllEnvs();
  for (const dir of made.splice(0)) removeTempDir(dir);
});

/**
 * A committed tree of `files` in a fresh directory.
 *
 * @param files - Root-relative path to content
 * @returns The tree's root
 */
function plantTree(files: Readonly<Record<string, string>>): string {
  const root = createTempDir('vat-stored-copy-tree-');
  made.push(root);
  for (const [name, content] of Object.entries(files)) writeFileSync(safePath.join(root, name), content, 'utf8');
  commitTestFixture(root);
  return root;
}

/**
 * Ask `root` one statement through the query lane.
 *
 * @param root - The tree
 * @param statement - The SQL
 * @param warnings - Where the lane's warnings go, if the caller reads them
 * @returns The rows, and the population's outcome
 */
async function ask(root: string, statement: string, warnings: string[] = []): Promise<{ rows: unknown; population: string }> {
  const noop = (): void => undefined;
  let answer: { rows: unknown; population: string } | undefined;
  await withQueriedProjection(
    { root, verb: 'resources query', logger: { info: noop, warn: (message) => warnings.push(message), error: noop, debug: noop }, statements: [statement], base: undefined },
    (query, provenance) => {
      answer = { rows: query(statement), population: provenance.population };
    },
  );
  if (answer === undefined) throw new Error('the query lane never ran its work');
  return answer;
}

/** A tree with an AST reference (a markdown link) and a lexical one (an `@` import). */
const TREE_A = { 'a.md': '# A\n\nSee [b](./b.md) and @b.md.\n', 'b.md': '# B of tree A\n' };

/** Another repository's tree, its own bytes and its own references. */
const TREE_B = { 'c.md': '# C\n\nSee [d](./d.md) and @d.md.\n', 'd.md': '# D of tree B\n' };

describe('blob_references on a store hit', () => {
  it('holds the run\'s own rows and no other repository\'s, as a store-off run derives them', async () => {
    const cache = createTempDir('vat-stored-copy-cache-');
    made.push(cache);
    vi.stubEnv(VAT_CACHE_DIR_ENV, cache);
    const treeA = plantTree(TREE_A);
    const treeB = plantTree(TREE_B);
    await ask(treeA, EVERY_REFERENCE);
    await ask(treeB, EVERY_REFERENCE);

    __resetWorkCountersForTest();
    const served = await ask(treeA, EVERY_REFERENCE);
    const copied = readWorkCounters()['hydration.rows.copied'];
    vi.stubEnv(PROJECTION_STORE_ENV, 'off');
    const derived = await ask(treeA, EVERY_REFERENCE);

    expect(served.population).toBe('store');
    expect(copied, 'the served run copied every row it answers with').toBe((derived.rows as unknown[]).length);
    expect(derived.population).toBe('derived');
    // The premise: both kinds of form, so a copy that drops either differs.
    expect(JSON.stringify(derived.rows)).toContain('"markdown-link"');
    expect(JSON.stringify(derived.rows)).toContain('"at-prefixed"');
    // By content: the store-on run keys a git member by its object, store-off by its bytes.
    expect(rowsByContent(served.rows as Record<string, unknown>[], treeA)).toEqual(rowsByContent(derived.rows as Record<string, unknown>[], treeA));
  });

  it('populates again when a key the hit admitted is evicted before the copy', async () => {
    const cache = createTempDir('vat-stored-copy-cache-');
    made.push(cache);
    vi.stubEnv(VAT_CACHE_DIR_ENV, cache);
    const tree = plantTree(TREE_A);
    const derived = await ask(tree, EVERY_REFERENCE);
    const evicted: string[] = [];
    beforeFirstCopy = (source) => {
      if (source.tier !== 'blob') throw new Error(`the query lane copies blob_references from the blob tier, not the ${source.tier} tier`);
      const [key] = source.contentKeys;
      const [file] = storeFilesUnder(cache);
      if (key === undefined || file === undefined) throw new Error('the hit admitted no key, or no store was written');
      const database = new DatabaseSync(file);
      try {
        database.prepare('DELETE FROM "blob_keys" WHERE "contentKey" = ?').run(key);
        database.prepare('DELETE FROM "blob_references" WHERE "blob" = ?').run(key);
      } finally {
        database.close();
      }
      evicted.push(key);
    };

    const answered = await ask(tree, EVERY_REFERENCE);

    expect(evicted, 'the eviction ran, between the hit and its copy').toHaveLength(1);
    expect(answered.population, 'the second population misses on the evicted key and derives').toBe('derived');
    expect(answered.rows).toEqual(derived.rows);
  });

  it('populates again from its own rows, warning once, when the copy refuses although the store holds the key', async () => {
    const cache = createTempDir('vat-stored-copy-cache-');
    made.push(cache);
    vi.stubEnv(VAT_CACHE_DIR_ENV, cache);
    // A refused binary member, so each population has a warning to give.
    const tree = plantTree({ ...TREE_A, 'blob.md': '\u0000\u0001\u0002 binary\n' });
    const derived = await ask(tree, EVERY_REFERENCE);
    let refused = 0;
    // The race the retry exists for, seen from the copy: the ledger misses a key a moment after the
    // hit read it, and the key is back (filed again) by the time the lane populates again.
    beforeFirstCopy = () => {
      refused += 1;
      throw new StoredRowsEvictedError({ tier: 'blob', relation: 'blob_references', missing: 1 });
    };
    const warnings: string[] = [];
    __resetWorkCountersForTest();

    const answered = await ask(tree, EVERY_REFERENCE, warnings);

    expect(refused, 'the copy refused once').toBe(1);
    expect(answered.population, 'the second population is served from the store again').toBe('store');
    expect(readWorkCounters()['hydration.rows.copied'], 'and hands its own rows: no second copy to refuse').toBe(0);
    expect(answered.rows).toEqual(derived.rows);
    expect(warnings.length, 'the premise: the population warns').toBeGreaterThan(0);
    expect(warnings, 'each warning once').toEqual([...new Set(warnings)]);
  });
});

/** Every routed data file's node count, in a fixed order: what the run database answers with. */
const NODES_PER_FILE = 'SELECT blob, COUNT(*) AS n FROM data__nodes GROUP BY blob ORDER BY blob';

/** A tree with two routed data files. */
const DATA_TREE = { 'package.json': '{ "name": "seed", "private": true }\n', 'tsconfig.json': '{ // jsonc\n  "compilerOptions": {} }\n' };

/**
 * A fresh cache with {@link DATA_TREE} planted and queried once, then the given query attempts
 * seeded to evict a row set after the data stage's write.
 *
 * @param attempts - The attempts, as the seam's variable lists them (`1`, `1,2`)
 * @returns The tree's root
 */
async function primed(attempts: string): Promise<string> {
  const cache = createTempDir('vat-stored-copy-cache-');
  made.push(cache);
  vi.stubEnv(VAT_CACHE_DIR_ENV, cache);
  const tree = plantTree(DATA_TREE);
  await ask(tree, NODES_PER_FILE);
  vi.stubEnv(TEST_EVICT_ROW_SET_ENV, attempts);
  return tree;
}

describe('data__* row sets on a store hit', () => {
  it('runs the data stage once more when a row set is evicted before the copy, and answers as a store-off run', async () => {
    const tree = await primed('1');
    __resetWorkCountersForTest();
    const answered = await ask(tree, NODES_PER_FILE);
    const extracted = readWorkCounters()['rowSet.extracted'];
    vi.stubEnv(PROJECTION_STORE_ENV, 'off');
    const derived = await ask(tree, NODES_PER_FILE);

    expect(extracted, 'the retry extracted exactly the evicted row set').toBe(1);
    expect((derived.rows as unknown[]).length, 'the premise: both files have nodes').toBe(2);
    // Content identity is per source: the store-on run keys each git member by its object id, the
    // store-off run by its disk checksum, so the two are compared as store-off names the rows.
    expect(rowsByContent(answered.rows as Record<string, unknown>[], tree)).toEqual(rowsByContent(derived.rows as Record<string, unknown>[], tree));
  });

  it('refuses the run when the one retry finds a row set evicted again, naming the concurrent run and what a user can do', async () => {
    const tree = await primed('1,2');
    const refused = await ask(tree, NODES_PER_FILE).catch((error: unknown) => error);

    expect(isVatError(refused, PROJECTION_STORE_ROWS_EVICTED_CODE), String(refused)).toBe(true);
    expect(String(refused)).toMatch(/Another run wrote to the projection store while this query read it/u);
    expect(String(refused)).toMatch(/Run again once the other run has finished, or give concurrent runs separate stores with VAT_CACHE_DIR/u);
    expect(String(refused), 'a row-set eviction names the config that shrinks the tier').toMatch(/resources\.extractors\.data\.exclude/u);
    expect(String(refused), 'never a library constant no CLI user can set').not.toMatch(/DEFAULT_\w+_BUDGET_BYTES/u);
  });
});
