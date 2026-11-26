/**
 * The query lane's containment: SQL answers from the run's own rows, never from the shared store.
 *
 * The projection store is one database shared by every root on the machine. Running a caller's
 * statement against it once answered a two-file repository's `SELECT COUNT(*) FROM
 * resource_realizations` with 5,779 instead of 3, and its `WHERE path LIKE 'packages/%'` with
 * another repository's paths. The run database is hydrated from the run's own populated projection
 * instead; this holds it.
 *
 * Two repositories with distinct file names share one store directory. B is queried first, so the
 * store holds B's rows; then A cold, then A warm (served from the store). Every relation A hydrates
 * must hold A's no-store run's rows, compared by content (a store-on run keys a git member by its
 * object, store-off by its bytes), and no row may name a B file. The four
 * runs happen once, in order, before any assertion; each `it` reads their answers and stands alone.
 *
 * In-process through `withQueriedProjection`; the only process spawned is git, to commit the
 * fixtures and snapshot their trees.
 */

import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { PROJECTION_TABLES } from '@vibe-agent-toolkit/resources';
import { safePath, VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';
import { createTempDir, removeTempDir, scratchTmpdirEnv } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLogger } from '../../src/utils/logger.js';
import { withQueriedProjection } from '../../src/utils/projection-query.js';
import {
  PROJECTION_STORE_ENV,
  PROJECTION_STORE_OFF,
  PROJECTION_STORE_SQLITE,
} from '../../src/utils/projection-store.js';
import { rowsByContent } from '../helpers/cache-differential.js';
import { storeFilesUnder } from '../helpers/projection-store-probe.js';
import { commitTestFixture } from '../test-helpers.js';

/** A file name only repository B holds: its appearance in an A answer is the leak. */
const B_ONLY = 'b-only-confidential';

/** One statement per projection table, so the run hydrates every one. */
const STATEMENTS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.values(PROJECTION_TABLES).map((spec) => [spec.name, `SELECT * FROM "${spec.name}"`]),
);

/** What one run answered: every table's rows, and where the population came from. */
interface RunAnswer {
  readonly tables: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  readonly population: string;
}

const scratch = scratchTmpdirEnv('vat-containment-tmp-');
let base: string;
let storeDir: string;
let repoA: string;

/** A with no store, then A cold beside B's rows, then A warm from the store. */
let off: RunAnswer;
let cold: RunAnswer;
let warm: RunAnswer;

/** A committed repository holding the given files. */
function repository(name: string, files: Readonly<Record<string, string>>): string {
  const root = safePath.join(base, name);
  mkdirSyncReal(safePath.join(root, 'docs'), { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(safePath.join(root, 'docs', file), content, 'utf8');
  commitTestFixture(root);
  return root;
}

/**
 * Ask one repository every table, with the store on or off.
 *
 * @param root - The repository
 * @param store - Whether the shared store is selected
 * @returns What it answered
 */
async function askEveryTable(root: string, store: boolean): Promise<RunAnswer> {
  vi.stubEnv(PROJECTION_STORE_ENV, store ? PROJECTION_STORE_SQLITE : PROJECTION_STORE_OFF);
  vi.stubEnv(VAT_CACHE_DIR_ENV, storeDir);
  try {
    return await withQueriedProjection(
      { root, logger: createLogger(), statements: Object.values(STATEMENTS), base: undefined },
      (ask, provenance) => ({
        tables: Object.fromEntries(Object.entries(STATEMENTS).map(([name, sql]) => [name, ask(sql)])),
        population: provenance.population,
      }),
    );
  } finally {
    vi.unstubAllEnvs();
  }
}

beforeAll(async () => {
  scratch.enter();
  base = createTempDir('vat-containment-');
  storeDir = safePath.join(base, 'store');
  mkdirSyncReal(storeDir);
  repoA = repository('a', { 'a-one.md': '# A one\n\nSee [two](./a-two.md).\n', 'a-two.md': '# A two\n' });
  const repoB = repository('b', {
    [`${B_ONLY}.md`]: '# B\n\nSee [other](./b-other.md).\n',
    'b-other.md': '# B other\n',
    'b-third.md': '# B third\n',
  });
  // In this order: B fills the store before A's cold run, and A's cold run fills it for the warm one.
  off = await askEveryTable(repoA, false);
  await askEveryTable(repoB, true);
  cold = await askEveryTable(repoA, true);
  warm = await askEveryTable(repoA, true);
});

afterAll(() => {
  removeTempDir(base);
  scratch.leave();
});

describe('a run database holds the run\'s own rows, however its population was served', () => {
  it('derived A twice and served it once, so the comparison below is not vacuous', () => {
    expect([off.population, cold.population, warm.population]).toStrictEqual(['derived', 'derived', 'store']);
    expect(off.tables['resource_realizations']?.length, 'A realized nothing').toBeGreaterThan(0);
  });

  it('answers A alike with no store, cold beside B\'s rows, and warm from the store — and never with B', () => {
    // Compared by content: a store-on run keys a git member by its object, store-off by its bytes.
    const byContent = (answer: RunAnswer, name: string): unknown => rowsByContent(answer.tables[name] ?? [], repoA);
    for (const name of Object.keys(STATEMENTS)) {
      expect(byContent(cold, name), `${name}: cold differs from no store`).toStrictEqual(byContent(off, name));
      expect(byContent(warm, name), `${name}: warm differs from no store`).toStrictEqual(byContent(off, name));
    }
    expect(JSON.stringify([cold.tables, warm.tables]), 'an A answer named a B file').not.toContain(B_ONLY);
  });

  it('illustration: the shared store file itself holds B\'s rows, which no A answer above contained', () => {
    const [file] = storeFilesUnder(storeDir);
    expect(storeFilesUnder(storeDir), 'one store under the cache root').toHaveLength(1);
    const store = new DatabaseSync(file ?? '', { readOnly: true });
    try {
      const paths = store.prepare('SELECT path FROM resource_realizations').all().map((row) => String(row['path']));
      expect(paths.some((path) => path.includes(B_ONLY))).toBe(true);
      expect(paths.some((path) => path.includes('a-one'))).toBe(true);
    } finally {
      store.close();
    }
  });
});
