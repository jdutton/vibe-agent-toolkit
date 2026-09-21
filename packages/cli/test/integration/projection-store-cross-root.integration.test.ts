/**
 * One store, two repositories: neither may be answered with the other's facts.
 *
 * The blob tier is content-addressed and shared by every root on the machine, so
 * a row in it must be a pure function of the bytes. A `blob_conditions` message
 * that named the path of the repository that first derived it broke that: the
 * second repository holding the same bytes was served the FIRST one's file path —
 * a warm answer that differed from its own derived one, and a disclosure of a
 * path from a repository the reader may not be able to see.
 *
 * Every other equivalence suite runs one corpus, so none of them could see it.
 */

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PROJECTION_STORE_DIR_ENV,
  PROJECTION_STORE_ENV,
  PROJECTION_STORE_OFF,
  PROJECTION_STORE_SQLITE,
} from '../../src/utils/projection-store.js';
import { createSuiteContext, executeCli, join, writeTestFile } from '../system/test-common.js';
import { commitTestFixture } from '../test-helpers.js';

const context = createSuiteContext('vat-store-cross-root-', import.meta.url);

/** A directory only the FIRST repository has. Its appearance in the second is the leak. */
const SECRET_DIR = 'clients/confidential';

/** Where the second repository keeps the same bytes. */
const PUBLIC_DIR = 'docs';

/** The file name the shared bytes carry in each repository's own directory. */
const SHARED_NAME = 'notes.md';

/** Identical bytes in both repositories, declined as binary by the NUL sniff. */
const SHARED_BYTES = `# Notes\n${String.fromCodePoint(0)}\nbody\n`;

const QUESTION = 'SELECT code, message FROM blob_conditions ORDER BY code, message';

let secretRepo: string;
let publicRepo: string;

/**
 * One committed tree holding {@link SHARED_BYTES} in one directory.
 *
 * @param name - The repository's directory name
 * @param dir - The directory inside it that holds the shared bytes
 * @returns The repository root
 */
function repositoryWith(name: string, dir: string): string {
  const root = join(context.createTempDir(), name);
  mkdirSyncReal(join(root, dir), { recursive: true });
  writeTestFile(join(root, dir, SHARED_NAME), SHARED_BYTES);
  commitTestFixture(root);
  return root;
}

/**
 * Ask one repository the question.
 *
 * @param cwd - The repository
 * @param storeDir - The store directory, shared across calls that share it
 * @param store - Whether the store is selected
 * @returns The rows and the population origin the run reported
 */
async function ask(
  cwd: string,
  storeDir: string,
  store: boolean,
): Promise<{ rows: unknown[]; population: unknown }> {
  const result = await executeCli(context.binPath, ['resources', 'query', QUESTION, '--format', 'json'], {
    cwd,
    env: {
      [PROJECTION_STORE_ENV]: store ? PROJECTION_STORE_SQLITE : PROJECTION_STORE_OFF,
      [PROJECTION_STORE_DIR_ENV]: storeDir,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  const document = JSON.parse(result.stdout) as { rows: unknown[]; population: unknown };
  return { rows: document.rows, population: document.population };
}

describe('a projection store shared by two repositories', () => {
  beforeAll(() => {
    context.setup();
    secretRepo = repositoryWith('secret', SECRET_DIR);
    publicRepo = repositoryWith('public', PUBLIC_DIR);
  });

  afterAll(context.cleanup);

  it('serves each repository its own answer, and never the other\'s path', async () => {
    const shared = context.createTempDir();

    const derived = await ask(publicRepo, context.createTempDir(), false);
    // The positive control: the question has an answer at all, so an empty
    // result below cannot pass for a clean one.
    expect(derived.rows).toHaveLength(1);

    // The public repository files its extent; the secret one, deriving the SAME
    // content key, rewrites that key's blob rows; the public one is then served
    // its own stored extent — joined to whatever the key's rows say now.
    await ask(publicRepo, shared, true);
    await ask(secretRepo, shared, true);
    const warm = await ask(publicRepo, shared, true);

    // ⛔ Proves the warm arm was SERVED, not re-derived — a re-derivation would
    // produce the right answer regardless, and this test would be vacuous.
    expect(warm.population).toBe('store');
    expect(warm.rows).toStrictEqual(derived.rows);
    expect(JSON.stringify(warm.rows)).not.toContain(SECRET_DIR);
  });
});
