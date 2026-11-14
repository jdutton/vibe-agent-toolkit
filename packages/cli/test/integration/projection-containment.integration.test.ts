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
 * must equal A's no-store run row for row, in the same order, and no row may name a B file.
 *
 * In-process through `withQueriedProjection`; the only process spawned is git, to commit the
 * fixtures and snapshot their trees.
 */

import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { PROJECTION_TABLES } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';
import { createTempDir, removeTempDir, scratchTmpdirEnv } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLogger } from '../../src/utils/logger.js';
import { withQueriedProjection } from '../../src/utils/projection-query.js';
import {
  PROJECTION_STORE_DIR_ENV,
  PROJECTION_STORE_ENV,
  PROJECTION_STORE_OFF,
  PROJECTION_STORE_SQLITE,
} from '../../src/utils/projection-store.js';
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
let repoA: string;
let repoB: string;
let storeDir: string;

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
  vi.stubEnv(PROJECTION_STORE_DIR_ENV, storeDir);
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

beforeAll(() => {
  scratch.enter();
  base = createTempDir('vat-containment-');
  storeDir = safePath.join(base, 'store');
  mkdirSyncReal(storeDir);
  repoA = repository('a', { 'a-one.md': '# A one\n\nSee [two](./a-two.md).\n', 'a-two.md': '# A two\n' });
  repoB = repository('b', {
    [`${B_ONLY}.md`]: '# B\n\nSee [other](./b-other.md).\n',
    'b-other.md': '# B other\n',
    'b-third.md': '# B third\n',
  });
});

afterAll(() => {
  removeTempDir(base);
  scratch.leave();
});

describe('a run database holds the run\'s own rows, however its population was served', () => {
  it('answers A alike with no store, cold beside B\'s rows, and warm from the store — and never with B', async () => {
    const off = await askEveryTable(repoA, false);
    await askEveryTable(repoB, true);
    const cold = await askEveryTable(repoA, true);
    const warm = await askEveryTable(repoA, true);

    // Not vacuous: the warm run was served, and the store holds B's paths beside A's.
    expect([off.population, cold.population, warm.population]).toStrictEqual(['derived', 'derived', 'store']);
    expect(off.tables['resource_realizations']?.length, 'A realized nothing').toBeGreaterThan(0);

    for (const name of Object.keys(STATEMENTS)) {
      expect(cold.tables[name], `${name}: cold differs from no store`).toStrictEqual(off.tables[name]);
      expect(warm.tables[name], `${name}: warm differs from no store`).toStrictEqual(off.tables[name]);
    }
    expect(JSON.stringify([cold.tables, warm.tables]), 'an A answer named a B file').not.toContain(B_ONLY);
  });

  it('illustration: the shared store file itself holds B\'s rows, which no A answer above contained', () => {
    const store = new DatabaseSync(safePath.join(storeDir, 'projection.db'), { readOnly: true });
    try {
      const paths = store.prepare('SELECT path FROM resource_realizations').all().map((row) => String(row['path']));
      expect(paths.some((path) => path.includes(B_ONLY))).toBe(true);
      expect(paths.some((path) => path.includes('a-one'))).toBe(true);
    } finally {
      store.close();
    }
  });
});
