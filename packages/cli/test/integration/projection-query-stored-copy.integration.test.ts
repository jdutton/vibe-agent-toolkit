/**
 * The query lane's `blob_references` on a store hit: copied from the store inside SQLite for
 * exactly the keys the hit admitted. Three claims through the real lane and the real backend:
 * no other repository's rows reach the run database from the store both share, the copy holds
 * what a store-off run derives, and a key evicted between the hit and the copy makes the lane
 * populate again rather than answer short.
 */

import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import type * as ProjectionSqlite from '@vibe-agent-toolkit/projection-sqlite';
import { safePath, VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/utils';
import { createTempDir, removeTempDir } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

const { PROJECTION_STORE_ENV } = await import('../../src/utils/projection-store.js');
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
 * @returns The rows, and the population's outcome
 */
async function ask(root: string, statement: string): Promise<{ rows: unknown; population: string }> {
  const noop = (): void => undefined;
  let answer: { rows: unknown; population: string } | undefined;
  await withQueriedProjection(
    { root, logger: { info: noop, warn: noop, error: noop, debug: noop }, statements: [statement], base: undefined },
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

    const served = await ask(treeA, EVERY_REFERENCE);
    vi.stubEnv(PROJECTION_STORE_ENV, 'off');
    const derived = await ask(treeA, EVERY_REFERENCE);

    expect(served.population).toBe('store');
    expect(derived.population).toBe('derived');
    // The premise: both kinds of form, so a copy that drops either differs.
    expect(JSON.stringify(derived.rows)).toContain('"markdown-link"');
    expect(JSON.stringify(derived.rows)).toContain('"at-prefixed"');
    expect(served.rows).toEqual(derived.rows);
  });

  it('populates again when a key the hit admitted is evicted before the copy', async () => {
    const cache = createTempDir('vat-stored-copy-cache-');
    made.push(cache);
    vi.stubEnv(VAT_CACHE_DIR_ENV, cache);
    const tree = plantTree(TREE_A);
    const derived = await ask(tree, EVERY_REFERENCE);
    const evicted: string[] = [];
    beforeFirstCopy = ({ contentKeys }) => {
      const [key] = contentKeys;
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
});
